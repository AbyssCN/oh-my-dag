import type { ModelUsage } from '../model/gateway';
import type { AgentTemplate } from './agent-templates';
import type { ConductorPlan } from './conductor-plan';
import type { CavemanLevel } from './caveman';
import type { AgentLeafRunner, CommandLeafRunner, LeafModelRouter } from './leaf-runners';
import type { CheckpointManager } from './continuity/checkpoint-manager';
import type { VerifierFn } from './verifier';

/** omd 本体编排的注入式模型调用 (单一注入点; 默认 callModel, 测试传 fake)。 */
export type GenerateFn = (req: {
  messages: { role: 'system' | 'user'; content: string }[];
  model: string;
  /** 推理档 (conductor=分解器 high / inproc leaf=high; → deepseek reasoning_effort)。省略=模型默认。 */
  thinkingLevel?: 'off' | 'low' | 'medium' | 'high' | 'xhigh';
}) => Promise<{ text: string; usage: ModelUsage }>;

export interface ExecutorDagConfig {
  /** conductor 模型 'provider:modelId' (规划用, 我们=mimo:mimo-v2.5-pro)。**必填, 无硬默认。** */
  conductorModel: string;
  /** inproc leaf 模型 'provider:modelId' (生成/判断单发)。**必填, 无硬默认。** 我们: 烧 MiMo 沉没额度时=mimo:mimo-v2.5, 耗尽=deepseek:deepseek-v4-flash。 */
  leafModel: string;
  /**
   * agent leaf 模型 (带工具改文件)。省略 = 同 leafModel。我们=deepseek:deepseek-v4-flash
   * (MiMo agentic flaky + 无 cache, 不适合工具循环 → agent leaf 走 DeepSeek; inproc 才用 MiMo 烧额度)。
   */
  agentLeafModel?: string;
  /** 内层 fan-out 并发上限 (传给 primitives.parallel)。省略 → primitives 的 OMD_MAX_FANOUT/CPU 兜底。 */
  maxFanout?: number;
  /**
   * 暖发调度 (契约 §10.2): 全局先串行暖 1 发(写 cache)→ 再并行轰其余(命中共享冻结前缀)。
   * 关 = 同时轰(thundering herd, 共享前缀全 miss)。默认 false(单/双节点不值那一发串行延迟)。
   * ⚠ 2026-07-06 修正: agent leaf **同样受益** —— pi system + 工具 schema + DISCIPLINE_CORE +
   * TOOL_ROUTING 是跨 leaf 字节稳定共享前奏(数 k tokens), [omd leaf: id] 之后才分叉;
   * 旧注释"仅对 inproc 有意义"系误判(mimo 控制台实测 41% hit, thundering herd 成分可治)。
   */
  warmThenFanout?: boolean;
  /**
   * 干活 leaf 的 caveman 压缩级 (省 output token)。默认 'ultra' (output=叙述扔掉, 实测零正确性成本)。
   * 创意节点 (node.creative) 恒 'off' 不受此影响 (护交付物)。设 'off' 全关。
   */
  cavemanLevel?: CavemanLevel;
  /**
   * inproc leaf 的共享冻结 system 前缀 (字节稳定 → 暖发后跨 leaf 命中 prompt-cache)。
   * 省略 = 内置精简指令 (~80 token, 对 DeepSeek cache 粒度偏短, 命中≈0)。要真省 input, 设成
   * 大前缀 (如 VALAR_IDENTITY + 指令, ~800+ token) —— 既给 leaf omd 灵魂 (VAL-DAG-6) 又过 cache 阈值。
   */
  leafSystemPrefix?: string;
  /**
   * 给 leaf (构建相位) 注入 ponytail 反过度工程倾向 — 降生成代码量, 维二红线 (不变量/法定值/防丢错误处理/安全) 不在砍范围。
   * 默认 off (opt-in): 正确性敏感 build 由 caller 决定开关, 质量靠现有闸 (tsc/test/GroundingVerifier) 兜底。
   * 只挂 leaf 不挂 conductor — 规划相位要发散 (拆得对), 构建相位才收敛 (建得少)。见 ponytail plan/build 相位分离。
   */
  leafPonytail?: boolean;
  /** conductor 规划无效输出的有界重试 (默认 2 → ≤3 次)。 */
  maxPlanRetries?: number;
  /** 限定 conductor 可派的 agent roster (进规划 system prompt)。 */
  agents?: string[];
  /**
   * Agent 模板注册表 (name → 角色卡, 见 agent-templates.ts)。省略 = loadAgentTemplates()
   * (内置 5 卡 + cwd/.omd/agents/*.md 项目卡覆盖)。传 Map 注入 (测试 fake / 宿主定制);
   * 传空 Map = 关闭模板机制 (conductor prompt 无注册表段, 行为回退纯 persona)。
   */
  agentTemplates?: ReadonlyMap<string, AgentTemplate>;
  /** 注入式模型调用 (inproc leaf, 默认 callModel)。 */
  generate?: GenerateFn;
  /**
   * 本次 run 的 Langfuse trace 分组 session id (conductor+leaf 全部经 send 归此 session)。
   * 省略 → 内部生成 randomUUID (current behavior)。给则**调用方可拿同一 id 做跨平面关联** (如派活
   * 飞轮把 dispatch_outcome ↔ Langfuse session 用此 id join → 按 pattern-class 归因成本/调试 mined skill)。
   */
  sessionId?: string;
  /** conductor 分解推理档 (high 默认/复杂 plan 升 max; conductor 是分解器不需深推理, 见 fleet 注释)。 */
  conductorThinkingLevel?: 'off' | 'low' | 'medium' | 'high' | 'xhigh';
  /** inproc leaf 推理档 (默认 high; mass fan-out 省成本, 不走 max — 那是 omd 设计 / best-of-N 的档)。 */
  inprocThinkingLevel?: 'off' | 'low' | 'medium' | 'high' | 'xhigh';
  /**
   * agent-kind leaf 的执行器 (带工具子 agent, 能改文件)。给则 `executor:'agent'` 节点经此跑;
   * 省略 → agent 节点降级为 inproc 单发 (无工具, 只生成文本) + warn。默认 createAgentLeafRunner。
   */
  agentRunner?: AgentLeafRunner;
  /**
   * W2 continuity (SDD C4): 节点级 checkpoint 落盘 + 崩溃恢复跳过。
   * manager+runId 给则启用: done 节点写 `.omd/continuity/<runId>/<nodeId>.json` (fail-open, 写挂不阻断);
   * resume=true 时, checkpoint 存在 ∧ 产物 hash 匹配的节点跳过执行 (LeafResult.skipped=true)。
   * repoRoot 供 noun-gate 注释 + 产物路径相对化 (省略 = process.cwd())。
   */
  continuity?: { manager: CheckpointManager; runId: string; resume?: boolean; repoRoot?: string };
  /**
   * per-kind 并发闸 (fanout 最大化设计, 2026-07-21): inproc 叶纯 API 等待、无本地足迹 →
   * 默认不限 (只受 maxFanout/图宽/provider 池); agent 叶 (本地工具调用) 与 command 叶
   * (本地 CLI) 物理共享本机 CPU/磁盘 → 各自独立小闸。省略的 kind = 不限。
   * 调度期按节点声明的 executor 记账 (运行期 leaf→agent 提升不改变记账桶 — 提升是罕见纠错路径)。
   */
  kindFanout?: { agent?: number; command?: number; inproc?: number };
  /**
   * command-kind leaf 的执行器 (确定性 CLI, 零 LLM, 方案 A)。给则 `executor:'command'` 节点经此跑
   * node.command (经 fail-closed 闸 + 白名单)。省略 → command 节点失败 (无 runner)。
   * codegraph / piolium 等"方法论+CLI工具"型能力的并行检索底座。
   */
  commandRunner?: CommandLeafRunner;
  /**
   * oracle 命令 (如 "bun run typecheck && bun test"): plan 中 command 与之等价的节点
   * 在执行前被确定性过滤 (空白规范化后精确匹配, 最小无害边重连)。
   * 选型理由: oracle 已跑过该命令, conductor 重规划出等价节点 = 浪费 token + 时间。
   * 省略 = 不过滤 (向后兼容)。
   */
  oracleCmd?: string;
  /**
   * 跨模型校验器 (model-agnostic skeptic, 见 verifier.ts)。省略 = 不校验 (back-compat 老行为)。
   * 给则 DAG 跑完用它审结果 → fail 且配了可用升级模型时触发 conductor 静默升级重规划。
   */
  verifier?: VerifierFn;
  /**
   * conductor 升级模型 'provider:modelId' (verifier fail 时用更强模型重规划重跑)。
   * **provider 未注册 (没配对应 API key) → 自动不升级, 维持弱模型** (Nick: 没配 SOTA API 就维持弱)。
   * 省略 = 永不升级。仅在 config.verifier 存在时有意义。
   */
  conductorEscalationModel?: string;
  /** verifier-fail → 升级重规划的最大次数 (默认 1)。每次升级 = 一整轮重规划 + 重跑 leaves。 */
  maxEscalations?: number;
  /**
   * executor leaf 模型选型路由器 (B-2 bandit, 见 model-router.ts)。省略 = 静态 (leafModel/agentLeafModel)。
   * 给则 inproc/agent leaf 经 router.select(bucket, 静态) 选模型, DAG 校验后按 reward 回更新。
   * pool 未配 → router no-op = 静态 (ship 安全)。node.model 显式给时仍最高优先 (绕过 router)。
   */
  router?: LeafModelRouter;
  /**
   * 运行完成钩子 (留痕层接口)。每次 runExecutorDag 结束前调用一次, 传完整 result (含升级后的最终态)。
   * 传 createDagRecorder().record 的闭包 → 自动落 SQLite 运行记录 (node 图谱可回溯)。抛错不阻断返回。
   */
  onComplete?: (result: ExecutorDagResult) => void | Promise<void>;
  /**
   * 节点级进度事件 (2026-07-20, MCP 派发简报/活体 status 的数据源):
   *   planned = 图定型 (全部节点 id+kind, 每轮 plan/escalation 重规划各发一次)
   *   start   = 节点起跑 (含 map 展开出的子节点)
   *   settle  = 节点定局 (done/failed + 实际模型)
   * fail-open: 回调抛错被吞, 永不影响执行 (观察者不许扰动被观察者)。
   */
  onNodeEvent?: (e: DagNodeEvent) => void;
}

/** 节点进度事件 (onNodeEvent 载荷)。kind 与 LeafResult.kind 同词表 + 'map'/'primitive'。 */
export type DagNodeEvent =
  | { type: 'planned'; nodes: Array<{ id: string; kind: string }> }
  | { type: 'start'; id: string; kind: string }
  | { type: 'settle'; id: string; status: 'done' | 'failed'; kind: string; model?: string };

export interface LeafResult {
  id: string;
  status: 'done' | 'failed';
  /** 实际执行模式: inproc 单发 / agent 带工具 / command CLI / map 动态扇出 (U1) / primitive 约束选择 (SDD 0013)。 */
  kind: 'inproc' | 'agent' | 'command' | 'map' | 'primitive';
  /** 实际所用模型坐标 (inproc/agent leaf; command 无模型 → undefined)。bandit reward 归因 + 审计用。 */
  model?: string;
  output: string;
  deps: string[];
  usage: ModelUsage;
  /** W2 continuity: resume 命中 checkpoint 跳过执行 (output=checkpoint.summary)。 */
  skipped?: boolean;
  /** agent leaf 触碰的文件 (来自 AgentLeafResult.filesTouched, checkpoint 产物锚)。 */
  filesTouched?: string[];
  /** 早期心跳闸判停摆 (issue #5): provider 挂起, 未等满硬超时即中止 → settle 记 failureKind='stall'。 */
  stalled?: boolean;
}

export interface ExecutorDagResult {
  plan: ConductorPlan;
  /** 本次 run 的 Langfuse session id (= config.sessionId 或内部生成的)。回显供调用方做跨平面关联。 */
  sessionId: string;
  /** 拓扑层级 (level 0 = 无依赖根; 每 level 内并行)。 */
  levels: string[][];
  results: Record<string, LeafResult>;
  usage: {
    /** conductor 规划用量 (升级时跨所有尝试累加)。 */
    conductor: ModelUsage;
    /** 所有 leaf 的 input/output token 合计 (output 永远全价, cache 只省 input — 见 contract §10.2)。升级时累加。 */
    leavesIn: number;
    leavesOut: number;
    /** 所有 inproc leaf 命中 prompt-cache 的 input token 合计 (⊆ leavesIn, 按 ~10% 价)。 */
    leavesCacheHit: number;
    /** 校验器用量 (跨所有 verify 轮累加)。仅 config.verifier 存在时有值。 */
    verifier?: ModelUsage;
  };
  /** 校验结果 (仅 config.verifier 存在时有值)。escalated=是否触发过 conductor 升级。 */
  verification?: {
    pass: boolean;
    reason: string;
    /** plan+exec 尝试次数 (1 = 未升级 / 首轮即过 / 无可用升级模型)。 */
    attempts: number;
    escalated: boolean;
    /** 最终采用的 conductor 模型 (升级后 = 升级模型)。 */
    conductorModel: string;
  };
}
