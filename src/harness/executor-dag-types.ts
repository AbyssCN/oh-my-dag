import type { ContentPart, ModelUsage } from '../model/gateway';
import type * as Gateway from '../model/gateway';
import type { AgentTemplate } from './agent-templates';
import type { ConductorPlan } from './conductor-plan';
import type { CavemanLevel } from './caveman';
import type { AgentLeafRunner, CommandLeafRunner, LeafModelRouter, ResearchLeafRunner, ShellRun } from './leaf-runners';
import type { CheckpointManager } from './continuity/checkpoint-manager';
import type { VerifierFn } from './verifier';
import type { FaninSummaryConfig } from './fanin-summary';
import type { ArtifactBudget } from './plan/judge-artifacts';
import type { NodeFailureKind } from './node-failure';

/** omd 本体编排的注入式模型调用 (单一注入点; 默认 callModel, 测试传 fake)。 */
export type GenerateFn = (req: {
  /**
   * content 常态 string; D-14v2 attach_media 媒体注入时为 ContentPart[] (与 gateway ModelMessage
   * 同构 — 媒体走标准消息形状而非旁路字段, 不认 parts 的 transport 大声失败, 不静默丢图)。
   */
  messages: { role: 'system' | 'user'; content: string | ContentPart[] }[];
  model: string;
  /** 推理档 (conductor=分解器 high / inproc leaf=high; → deepseek reasoning_effort)。省略=模型默认。 */
  thinkingLevel?: 'off' | 'low' | 'medium' | 'high' | 'xhigh';
  /** 输出 token 预算 (→ send maxTokens)。省略 = transport 默认 (4096)。conductor plan 输出随任务规模涨, 必须给足。 */
  maxTokens?: number;
  /**
   * **这一发是谁打的** (2026-07-31): 进可观测面的观测名, 形如 `conductor:execute` / `leaf:write-a`。
   *
   * 加它的原因是第一条真 trace 就暴露了问题: 默认 generate 把 `role` 写死成 `'omd-leaf'`,
   * 于是 Langfuse 上 conductor 的那一发和干活 leaf 的那一发**同名**, 分不出谁是谁、更看不出
   * 是哪个节点 —— 而"每个节点的 prompt 可审查"正是接观测的全部目的。
   *
   * 省略 = 回落调用方的默认名 (零回归)。**只进观测, 不进 prompt** —— 它不该改变模型看见的东西。
   */
  traceName?: string;
  /**
   * **这一发属于哪个 DAG 节点** (2026-07-31)。给了 → 观测面上挂到那个节点的 span 下;
   * 省略 → 挂 trace 根。
   *
   * 与 {@link traceName} 分开是因为**名字里切不出这件事**: `conductor:<nodeId>` (子图展开,
   * 后缀是节点) 与 `conductor:plan` (规划整张图, 后缀不是节点) 形状一模一样。此前靠切名字倒推,
   * 于是 `conductor:plan` 在 live trace 上挂了个叫 `plan` 的父 —— 而那个 span 从未存在过。
   *
   * 所以: **run 级调用(规划/修补/分类/halt-judge)一律不给**, 节点作用域的调用点才给。
   */
  traceNodeId?: string;
}) => Promise<{ text: string; usage: ModelUsage }>;

export interface ExecutorDagConfig {
  /** conductor 模型 'provider:modelId' (规划用, 我们=mimo:mimo-v2.5-pro)。**必填, 无硬默认。** */
  conductorModel: string;
  /** inproc leaf 模型 'provider:modelId' (生成/判断单发)。**必填, 无硬默认** —— 装配层由 'leaf' 座位解析。 */
  leafModel: string;
  /**
   * agent leaf 模型 (带工具改文件)。省略 = 同 leafModel; 装配层由 'agent' 座位解析。
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
   * 干活 leaf 的 caveman 压缩级 (省 output token)。默认 'full' (2026-07-21: 从 ultra 降 —— ultra 的边际
   * 压缩是弱模型削 substance 的风险位且无 per-node 出口, 省 token 大头改由 fan-in 定向摘要接管)。
   * 设 'ultra' opt-in (已知纯叙述且省 token 吃紧时压到底)。创意节点 (node.creative) 恒 'off' (护交付物)。
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
  /**
   * 每个 leaf 的 prompt 是否携带**原始任务全文** (默认 true, 见 buildLeafPrompt 的注)。
   *
   * 补的是图的一条结构缺口而不是加上下文: 节点的世界原本只有「自己的 goal + 上游输出」,
   * 而 conductor 看着任务写 goal, 会写出「从可信任务上下文复制题目」这种节点根本做不到的话。
   * agent 档靠工具自己去翻任务文件把这个洞盖住了 (实测老跑 5-6 个节点真去读了任务文件),
   * g1 换成 command+leaf 后洞就露出来: 33 节点全绿而交付物是「未提供题义」。
   * 设 false = 回到旧行为 (逃生口, 不建议)。
   */
  leafTaskContext?: boolean;
  /**
   * g1 leaf 档位闸 (图「引擎墙钟与 leaf 档位」#9, 2026-08-04): 计划落地前拒
   * 「executor:'agent' 读确定路径 + 无写意图 + 结构化产出」的节点/map 模板, 带改写建议重问
   * conductor (有界), 用尽 fail-open 放行并响亮留证。判据本体 plan/leaf-tier-gate.ts。
   * 缺省关 (引擎中立); 生产装配层 (mcp/assemble) 开, OMD_LEAF_TIER_GATE=0 关。
   */
  leafTierGate?: boolean;
  /**
   * g1「塞得下单 leaf prompt」阈值 (字节), 决定改写建议走「单 cat+leaf」还是「conductor 展开
   * per-item 对」。按座位实测定 (2026-08-04 探针: deepseek-v4-flash 收 3.04MB=56 万 token 未撞限),
   * 装配层给实测值之半; 缺省不做体量分支 (建议文案给两条路)。
   */
  leafTierThresholdBytes?: number;
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
  /**
   * conductor system prompt 档位 (SDD v2, 2026-07-25): 'full' (默认, 弱 conductor 教练全量) |
   * 'lean' (只留环境事实, 顶级 conductor 如 k3 用 — 教练是保守偏置疑压平分解)。
   * 省略 → env OMD_CONDUCTOR_PROMPT ('lean'/'full') → 'full'。档位由 A/B eval 定, 见 conductor-plan。
   */
  conductorPromptProfile?: 'full' | 'lean';
  /**
   * conductor 输出 token 预算 (plan JSON 随任务规模涨; thinking conductor 的推理可计入 completion)。
   * 省略 → env OMD_CONDUCTOR_MAX_TOKENS → 8192 (deepseek 系安全顶)。k3 大 plan 建议 32768。
   */
  conductorMaxTokens?: number;
  /** inproc leaf 推理档 (默认 high; mass fan-out 省成本, 不走 max — 那是 omd 设计 / best-of-N 的档)。 */
  inprocThinkingLevel?: 'off' | 'low' | 'medium' | 'high' | 'xhigh';
  /**
   * S-T 座位推理档查询 (坐标 → 档): auto-assign 把「模型 + 推理档」成对下发, 执行期按节点已钉的
   * 坐标反查该座位的档。接线层注入 (读 .omd/config.json 是接线层的活, 执行器不碰 IO);
   * 省略 / 返 undefined → 回落原有默认, 老 config 行为不变 (向后兼容)。
   * 优先序 (同 TPL-3 哲学: 显式永远赢): node.thinking > 本 config 的显式档 > 座位档 > 硬默认。
   */
  seatThinking?: (coord: string) => 'off' | 'low' | 'medium' | 'high' | 'xhigh' | undefined;
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
   * per-channel 并发闸 (SDD v2 D-23, TFFInfer 多 Stream 同构): key = provider 前缀
   * (调度期由 node.model ?? kind 静态模型推出), value = 该渠道并发上限。多模型 stamp 后
   * 争用单元从 kind 变渠道 (Allegretto/Lite/Go 各有额度限速) — 一个渠道饱和不阻塞其它
   * 渠道就绪节点 (非严格 FIFO 让位逻辑原样适用)。省略/未列渠道 = 不限。channels 熔断是
   * 事后, 此闸是事前限流, 互补。
   */
  channelFanout?: Record<string, number>;
  /**
   * primitive 候选模型池 (SDD v2 D-8v2, INV-7): judge/parallel/tournament 原语的 N 路
   * attempts 按此池轮转分配 (跨家族多样性; 接线层从 stamp pools 注入)。省略 = 全部
   * attempts 用 leafModel (旧行为, 零回归)。
   */
  primitiveCandidates?: string[];
  /**
   * fan-in **定向摘要** (引擎接缝, 2026-07-21): 一个 producer 的输出被 ≥2 个下游 consumer 消费时,
   * 不再把全文复制 ≥2 份灌进各 consumer, 而是跑 1 发定向摘要 (按下游目标提炼) + 全文落盘留指针,
   * 各 consumer 的 fan-in 上下文注入摘要而非全文 (省 token + 护 prompt-cache; 强制 conductor-plan
   * "Fan-in carries SUMMARIES" 纪律)。省略 = 引擎内默认 ON (minChars=1800, minFanout=2; 同 caveman
   * 的行为旋钮惯例——默认档由引擎给); `{ enabled: false }` 关闭。fail-open: 摘要失败 → 回退全文注入。
   */
  faninSummary?: FaninSummaryConfig;
  /**
   * command-kind leaf 的执行器 (确定性 CLI, 零 LLM, 方案 A)。给则 `executor:'command'` 节点经此跑
   * node.command (经 fail-closed 闸 + 白名单)。省略 → command 节点失败 (无 runner)。
   * codegraph / piolium 等"方法论+CLI工具"型能力的并行检索底座。
   */
  commandRunner?: CommandLeafRunner;
  /**
   * **冻结判据进环**(2026-08-01)。给了 → conductor 内环**每轮**跑一次这条确定性命令;
   * 退出码对上 = 这一轮定为最后一轮。省略 = 旧行为(判据只在环外跑一次)。
   *
   * ## 为什么要进环
   *
   * 此前它是环外节点 (`accept`, depends_on: ['execute']) —— 也就是说**必须先把轮数烧完**,
   * 那道 30 秒就能判出来的确定性闸才第一次被问到。实测撞过更坏的一档: judge 因为配置错
   * 恒抛错, 环永远拿不到裁决, 于是判据一次都没跑成, 而它本可以在第 1 轮就判绿。
   * **确定性判据不该排在不确定的东西下游。**
   *
   * ## 三条护栏(缺一条这个改动就会造出更难发现的问题)
   *
   * ① **它不进 judge 的视野。** 在环里直接跑, 不作为子节点 —— `renderRoundForJudge` 渲染的是
   *    children, 而 command 子节点通过时 facts 会写「命令退出码符合预期」。judge 一旦看得见
   *    判据结论就会**抄答案**: 两条判据永远一致, 而"判据轴"量的恰恰是它们的不一致。
   *    独立性此前是**结构白给的**(环外够不着), 现在改成**构造上钉住的**(压根不当 child)。
   * ② **绿了仍然问一次 judge**, 只记录、不改变停止决定。不问的话「judge 太紧」那一格
   *    (judge 说没成而判据过了) 永远观测不到 —— 从另一头把同一条轴杀掉。
   *    代价是每**跑**多一发 judge, 不是每轮。
   * ③ **只有可执行判据配这个字段。** 非可执行判据的 `oracleOk` 恒 true, 给了它就等于第一轮必停。
   */
  freezeCriterion?: { command: string; expectExit?: number };
  /**
   * research-kind leaf 的执行器 (真 web 检索 + 有界内环, D-6)。给则 `executor:'research'` 节点经此跑。
   * 省略 → research 节点失败 —— **刻意不降级成 inproc**: 无 web 的 leaf 只会拿模型记忆编引用,
   * 那是假 grounded (与"写文件节点无 agentRunner → 失败"同一条纪律: 拒绝静默假成功)。
   */
  researchRunner?: ResearchLeafRunner;
  /**
   * oracle 命令 (如 "bun run typecheck && bun test"): plan 中 command 与之等价的节点
   * 在执行前被确定性过滤 (空白规范化后精确匹配, 最小无害边重连)。
   * 选型理由: oracle 已跑过该命令, conductor 重规划出等价节点 = 浪费 token + 时间。
   * 省略 = 不过滤 (向后兼容)。
   */
  oracleCmd?: string;
  /**
   * SDD v2 pass 管线 (plan-passes/): oracle 过滤之后、执行之前依序应用的确定性 plan 变换
   * (接线层组装 prune → dedup → stamp; INV-8 pass 纯函数, 配置由接线层闭包注入)。
   * 每轮 plan (conductor 首轮 + escalation 重规划轮) 都过同一管线。省略 = 不变换 (零回归)。
   * 抛错上抛 fail-closed — 坏 pass 不静默跳过 (与 parsePlan 校验同哲学)。
   */
  planFilters?: Array<(plan: ConductorPlan) => ConductorPlan>;
  /**
   * 收敛 judge 的模型坐标。两个消费方:
   *  - 外层 fixpoint (`plan/iterate` 的默认 LLM judge);
   *  - **conductor 节点的内环 judge** (D-A, `max_rounds > 1` 时) —— 缺省回落 conductorModel
   *    (判"goal 达成没有"与"怎么分解"同属大脑簇, 回落到 leaf 档会让判决比分解还弱)。
   */
  judgeModel?: string;
  /**
   * 注入式 judge 调用 (测试)。默认真 `model/gateway.send` —— 内环 judge 走 `responseSchema`
   * 强制结构化, 与只回文本的 `generate` 不是同一个接口, 故单开一个注入口。
   */
  judgeSend?: typeof Gateway.send;
  /**
   * 跨模型校验器 (model-agnostic skeptic, 见 verifier.ts)。省略 = 不校验 (back-compat 老行为)。
   * 给则 DAG 跑完用它审结果 → fail 且配了可用升级模型时触发 conductor 静默升级重规划。
   */
  verifier?: VerifierFn;
  /**
   * conductor 升级模型 'provider:modelId' (verifier fail 时用更强模型重规划重跑)。
   * **provider 未注册 (没配对应 API key) → 自动不升级, 维持弱模型** (Nick: 没配 SOTA API 就维持弱)。
   * 省略 = 永不升级。
   *
   * 三个消费方: ① executor-dag 内部 verifier-fail 升级; ② 外层 fixpoint 的轮级升级
   * (`plan/iterate`); ③ **conductor 节点内环的轮级升级** (D-F 之后 —— 撤外层不该顺手把
   * "多轮不收敛就换更强的脑子"这个能力一起撤掉)。
   */
  conductorEscalationModel?: string;
  /**
   * 从第几轮起用 `conductorEscalationModel` 重画 (默认 2 = 第 1 轮弱 conductor, 后续升级)。
   * 外层 fixpoint 与 conductor 节点内环共用这一个旋钮 —— 两处各写一份默认值就会漂。
   * 仅在 `conductorEscalationModel` 给定且其 provider 已注册时生效。
   */
  escalateAfterRound?: number;
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
   * **产物内容进 judge 视图** (S1, 2026-08-03)。省略/`true` = 默认预算 (**缺省开**);
   * 给对象 = 自定预算; `false` = 关。
   *
   * 补的洞: `[引擎实测]` 只给存在性 (`写入文件: X`), 而验收在**内容**上的目标要的是"文件里
   * 写了什么" —— judge 被要求裁决它看不见的东西 → fail-closed → **交付物全对也判未收敛**
   * (2026-07-30 两次带种 live 都是这个形状)。产物内容由引擎**读盘**补进来, 不让 leaf 自述
   * (自述就是自证, 而自证正是反捏造判词要杀的)。
   *
   * ⚠ **为什么是预算不是布尔**: 它进的是**每一次** judge 调用, 无界即无界成本。
   *
   * **读数** (`scripts/eval-judge-artifacts.ts`, deepseek-v4-pro, 4 段 × 16 次 × 2 臂):
   * 假阴性 16/16 → **0/16** · 假阳性 0/48 → **0/48** · prompt token **+11%**。
   * ⚠ 单座位读数, 换 judge 座位必须重跑。⚠ 点名召回 87.5% → 77% (方向一致但 p≈0.29, 在噪声内, 待观察)。
   */
  judgeArtifacts?: boolean | ArtifactBudget;
  /**
   * **环的预算上限**(2026-07-31)—— Loop Engineering 四条停止轴里我们唯一缺的那条。
   *
   * 另外三条早就有:轮数上限(`max_rounds`)· 空转(D-Q 确定性判据)· 完成检查(judge ∧ 环外
   * `accept`)。缺预算轴的后果很具体:judge 每轮说"还不行",环就一路烧到轮数上限,**全程没有
   * 任何一处问过"这已经花了多少"**。而实测一次 goal 的执行段 leafIn 是 43 万 token 量级。
   *
   * 在**轮边界**上查(与 D-P 取消同一个接缝):不打断在飞的一轮 —— 半轮的钱已经花了,
   * 打断只是把产出也扔掉。省略 = 不设限(老语义,零回归)。
   *
   * ⚠ 这是**软停不是硬杀**:超了就不开下一轮,已跑完的全保留,`resume` 时给个更大的预算就能接着跑。
   */
  /**
   * **owner 指令通道** (S3, 2026-07-31 / D-S)。每开一轮调一次, 返回**已渲染**的一段;
   * 空串 = 本轮没有 owner 指令。消费记账 (哪条被哪一轮吃掉了) 由实现方做, 引擎不认识收件箱。
   *
   * ⚠ 它与失败原因、图外观察**共用同一条运输管道** (环唯一的信息通道), 但**渲染成独立的块**:
   * 观察者说"我算出一个事实", owner 说"照我说的做" —— 可错性完全不同, 合成一段之后下一轮的
   * conductor 就分不清哪句必须服从。
   *
   * ⚠ 引擎**逐字**把它拼进 prompt, 一个字都不加工 (有测试钉住)。
   *
   * `nonce` = 本次运行的**信任 token** (A8, 2026-07-31)。owner 块是 prompt 里**唯一带 token 的块**,
   * 因为它是唯一真可信的那条通道 —— 抓回来的网页正文可以逐字复制这个块的文案 (探针实证过),
   * 但复制不了一个它写那张网页时还不存在的值。渲染方须用它, 见 `renderOwnerDirectives`。
   */
  ownerDirectives?: (round: number, nonce: string) => string;
  loopBudget?: {
    /** 累计 leaf+conductor token(in+out)上限。 */
    tokens?: number;
    /** 该节点内环的墙钟毫秒上限。 */
    ms?: number;
  };
  /**
   * **§8.4 动作级熔断**的阈值 (缺省 2)。同一条命令以**逐字相同**的方式失败到这个次数 →
   * 内环走 BLOCKED 出口。
   *
   * ⚠ 判据里"逐字相同"那一半不是可选的优化, 是它能开着跑的**前提**: omd 里失败的 command
   * 节点常常就是 oracle (`bun test` 红 = 活没干完), 而修复环的正常形态就是"红→改→再红→再改→绿"。
   * 只按"同一条命令失败 N 次"熔断会把整个修复回路掐死。判据见 `plan/repeated-action.ts`。
   *
   * 设 0 或 1 = 关闭本闸 (阈值 1 等于一失败就熔断, 那不是熔断)。
   */
  repeatedActionThreshold?: number;
  /**
   * 节点级进度事件 (2026-07-20, MCP 派发简报/活体 status 的数据源):
   *   planned = 图定型 (全部节点 id+kind, 每轮 plan/escalation 重规划各发一次)
   *   start   = 节点起跑 (含 map 展开出的子节点)
   *   settle  = 节点定局 (done/failed + 实际模型)
   * fail-open: 回调抛错被吞, 永不影响执行 (观察者不许扰动被观察者)。
   */
  onNodeEvent?: (e: DagNodeEvent) => void;
  /**
   * **协作式取消** (D-P): 叫停这次 run。给了就在每个**调度接缝**上查一次。
   *
   * "协作式"是字面意思 —— **不杀在飞的节点**: 已经起跑的 leaf 跑到它自己结束 (它的产物、
   * checkpoint、账本一样不少), 引擎只是**不再派新活**。理由是杀进程救不回半个产物, 却会
   * 把一个正在写文件的 agent 留在半路上; 而"停止派新活"这件事在 ready-set 调度器里是免费的。
   *
   * 查的四个接缝: ① 外层 pump 派新节点前 ② conductor 内环 pump 派新子节点前 ③ 内环开新一轮前
   * ④ verifier-fail 升级重规划前。接缝之外一律不查 —— 中途插一刀等于回到"杀"。
   *
   * 收尾语义: `ExecutorDagResult.cancelled` 留痕 + `notRun` 列出一个都没起跑过的节点。
   * **同一个 runId 可以直接 resume** (已绿节点全跳过) —— 这才是"已跑完的节点全保留"的兑现处。
   */
  cancelSignal?: AbortSignal;
}

/**
 * 节点进度事件 (onNodeEvent 载荷)。kind 与 LeafResult.kind 同词表 + 'map'/'primitive'。
 *
 * `expanded` (2026-07-30): map/conductor 节点**运行时**把子节点挂进图的那一刻发一次。此前观察面
 * 到此为止就窄了一截 —— 子节点逐个发 start/settle, 但没有任何事件说过"图上多了这些点",
 * 于是 `dag_status` 的静态图上执行段永远只有一个点 (见 DagMetadata.runtimeNodes 的同款修补)。
 */
export type DagNodeEvent =
  | { type: 'planned'; nodes: Array<{ id: string; kind: string }> }
  | { type: 'expanded'; parent: string; nodes: Array<{ id: string; kind: string; deps: string[] }> }
  | { type: 'start'; id: string; kind: string }
  | { type: 'settle'; id: string; status: 'done' | 'failed' | 'skipped'; kind: string; model?: string };

/**
 * **图外只读观察者**的一条产出 (P3 D-Q)。
 *
 * DAG 里的节点只看得见自己的 `depends_on` —— 谁写了什么、谁读了什么、这一轮和上一轮是不是在
 * 原地打转, 没有节点站得到那个视角。观察者住在图外, 拿引擎手上现成的事实确定性地算 (零模型调用),
 * 产出这个。producer 见 `plan/observers.ts`。
 *
 * 出口有两个, 都是**前馈**: ① 进 `ExecutorDagResult.observations` 给调用方 ② 进下一轮重展开的
 * prompt (环的信息通道)。观察者**不铸毒票、不改路由、不改结果** —— 唯一的例外是确定性的
 * `loop-no-progress` 会让环提前 BLOCKED 退出 (再转一圈按构造不可能有新东西)。
 */
export interface DagObservation {
  /**
   * `undeclared-artifact-dep` = B 读了 A 写的文件但图上无边 (D-12/INV-P2-4);
   * `loop-no-progress` = 内环重展开得到同一张子图且 judge 拒的还是同一批 (D-Q BLOCKED 判据);
   * `write-race` / `missing-input` / `missing-command-target` = **跑之前**就能确定性判死的坏 plan
   * (A4, 2026-07-31, 补 Fowler 2×2 里最空的那格 computational feedforward; 后者是 command 节点
   * 引用 cwd 内不存在的脚本或未定义的 package script)。前两个是事后传感, 这些是事前拦。
   */
  /**
   * `loop-no-artifact-change` (2026-07-31, G5 正解) = 两轮下来**盘上的产物逐字节没变**。
   * 与 `loop-no-progress` 的区别是**判据键在哪**: 后者键在「agent 有没有重复自己」(而 LLM
   * conductor 每轮重画, 从不逐字重复 → D-AD 诊断的死路), 前者键在「盘上有没有位移」——
   * 产物是 agent 不重新生成的东西, 是这个环里唯一稳定的信号。**只报不拦**, 见 detectNoArtifactChange。
   */
  /**
   * `leaf-spin` (2026-08-03, G5 频率读数) = 一个 agent leaf 在自己的工具循环里**反复发同一个动作**
   * (drift-detector 的 spinning 判据: 同一签名在环里 ≥threshold 次)。
   *
   * ⚠ **它与 `loop-no-progress` 键在不同的层上, 这正是它的价值**: 后者键在**外环** ——
   * conductor 每轮重画, 从不逐字重复, 所以那条判据在 live 上恒 0 (D-AD 诊断的死路, 也是 G5
   * 三跑 0 样本的原因)。而 `leaf-spin` 键在**内环**, 同样的键在那一层**工作得很好**:
   * 2026-08-03 单次 live 命中 16 个回合, 最高同签名重复 39 次。
   * 也就是说 G5 的 0 未必是"这类检测器天然失效", 更可能是**信号在错的层上被观察**。
   *
   * `novelty-collapse` (r1 片3, 2026-08-04) = 修复轮发现文本的**簇数连续 K 轮不增** —— 环在原地打转。
   * 只报不拦 (INV-R1-3: 判据是第三票, 终止权归轮数/预算/冻结判据); 警告行经 prevReason 进下一轮 prompt。
   *
   * **只报不拦**(与 `loop-no-artifact-change` 同档): 要不要把它升成 BLOCKED、K 取几,
   * 取决于它在真跑上多久命中一次 —— 先有读数再谈判据, 别反过来。
   */
  /**
   * `scheduled-artifact` (2026-08-03, R3 前置) = 这张图要改的某个文件**会被自动执行**
   * (package script / CI workflow / cron / owner 声明的外部调度器)。
   *
   * 为什么值一条观察: 三臂 eval 实测, 模型判「这个岔口的后果可不可逆」时缺的正是这条事实 ——
   * 它停在"改动落在工作树里"就下结论, 漏标 25–33%; 补上这条结构事实后 **0%**,
   * 且**只要结构关系那一环就够**(不需要因果链)。**只报不拦**, 出口是下一轮的 prompt。
   */
  /**
   * `verbatim-drop` (#13, 2026-08-04, r2 逐跳取证) = **汇总节点把上游的逐字引文转述没了**。
   *
   * 出处: F2 三对复测里 11 个失分**无一例外**是「关键词✗ 出处✓」—— 而关键词是从英文原文
   * 逐字核过的锚点。沿链查(run 02971fc7): `answer_q5` 产出含 `budget` 原句 ✓,
   * 紧邻的 `assemble_draft`(8→1 汇总)✗,之后三跳皆无。**图在第 2 跳已经拿到带锚点的
   * 正确答案,又用汇总跳把它丢了** —— 对逐字接地类任务,每次 fan-in 都是一次有损重编码。
   *
   * 判据刻意保守(拿不准不报,同 static-lint):只在**上游确有引文、而本节点一条都不剩**时报。
   * **只报不拦** —— 转述在多数任务上是正当的(摘要就是要转述),它只在"下游要逐字定位"时才是错。
   * 引擎判不了任务性不性质,所以这条只把事实说出来,让下一轮 conductor 自己权衡。
   */
  /**
   * `unsupported-claim` (2026-08-05) = 某个子节点的产出**声称引擎已校验通过**
   * (「已由引擎实测通过」/「测试全部通过」/「已过 verifier 复核」),而引擎记录里
   * **没有对应事实** —— 求的是差集,不是判断题。判据在 `plan/claimed-actions.ts`。
   *
   * 为什么要一条确定性判据: 生产座实测 judge 在这条失效模式上召回 **0/64**,而矛盾就在
   * 相邻两行(`[引擎实测] 写入文件…` vs 产物里「已由引擎实测通过」)。往 judge prompt 加规则
   * 已被排除过两次(「讲道理拦不住」)。
   *
   * **只报不拦(report-only)**,三条出口都不进控制流: judge 视图 / 本账本 / 下一轮 prompt。
   * ⚠ 升成硬拦是**单独的拨闸决定**,前置条件是良性语域误伤面先被量掉 ——
   * 当前判据靠词形,已知会误伤指令句(「确保测试通过」)与整改回执(「已按 verifier 意见修改」)。
   * 本条的记数就是那次决定的依据: 活体基率(命中频次)与活体误伤率(逐条人工核对原句)。
   */
  /**
   * `detector-wrote` (D4 / §7.3, 2026-08-06) = **图内检测者自己动手改了盘**。
   *
   * D-Q 检测者是图内节点, 与被它检查的兄弟共享同一棵 worktree; conductor 把它排成
   * `executor:'agent'` 时它手里**就是有写工具的**。实测 54 跑: 23 个 detector 里 7 个是 agent (记了 writeCounts 的 4 个),
   * 而那 4 个一次都没写 —— 也就是说这条纪律今天成立, 但成立的方式是**运气不是不变量**,
   * 而且一旦有一个真写了, 此前**没有任何一处会知道**。
   *
   * **只报不拦** (同上面几条): 要不要真把检测者的写工具收掉是单独的拨闸决定, 而今天 n=4,
   * 离读得出基率还差得远。判据与分母见 `plan/observers.detectDetectorWrites`。
   */
  kind: 'undeclared-artifact-dep' | 'loop-no-progress' | 'write-race' | 'missing-input' | 'missing-command-target' | 'loop-no-artifact-change' | 'leaf-spin' | 'scheduled-artifact' | 'novelty-collapse' | 'verbatim-drop' | 'unsupported-claim' | 'detector-wrote';
  /** 涉及的节点 id (lint = [reader, writer]; 空转 = 被反复拒绝的那批)。 */
  nodes: string[];
  /** 人与模型都读的一句话 (进 prompt 的就是它)。 */
  message: string;
}

export interface LeafResult {
  id: string;
  /**
   * 'skipped' (D-7v2 quorum) = 依赖失败未达 requires 判据 → 级联跳过, 零 LLM 零 worker 槽。
   * 与 resume 的 `skipped?: boolean` (已绿跳过, status 仍 'done') 是两个正交概念, 不混用。
   */
  status: 'done' | 'failed' | 'skipped';
  /**
   * **没过的成因** (P1, 2026-07-31)。词表与每格的直接判据见 `node-failure.ts`。
   *
   * 为什么是**加一位**而不是把 `status` 拆宽: 现有读 `status === 'done'` 的地方有二十多处,
   * 而它们问的都是同一个粗问题("这个节点算成了吗")—— 那个问题的答案没变。粗态由细态推出
   * (任何 failureKind 都伴随 `status` 为 `'failed'` 或 `'skipped'`), 反过来不成立, 这才是
   * 细化该走的方向。把 `failed` 拆成五个字面量会让每一处消费者都得改, 且改的是它们**不关心**的那一层。
   *
   * ⚠ 恒非空当且仅当 `status !== 'done'` —— settle 出口过 `withFailureKind` 归一化, 没人标的
   * 显式记 `'unclassified'`。**整个字段缺席 = 早于本次改动的记录**, 与 `'unclassified'`
   * (记了但归不了类) 是两件事, 读数板必须分开念。
   */
  failureKind?: NodeFailureKind;
  /**
   * 实际执行模式: inproc 单发 / agent 带工具 / command CLI / map 动态扇出 (U1) /
   * primitive 约束选择 (SDD 0013) / research 真 web (D-6) / conductor 运行时异构展开 (P3 D-B/C/D)。
   */
  kind: 'inproc' | 'agent' | 'command' | 'map' | 'primitive' | 'research' | 'conductor';
  /** 实际所用模型坐标 (inproc/agent leaf; command 无模型 → undefined)。bandit reward 归因 + 审计用。 */
  model?: string;
  output: string;
  deps: string[];
  usage: ModelUsage;
  /** W2 continuity: resume 命中 checkpoint 跳过执行 (output=checkpoint.summary)。 */
  skipped?: boolean;
  /** agent leaf 触碰的文件 (来自 AgentLeafResult.filesTouched, checkpoint 产物锚)。 */
  filesTouched?: string[];
  /**
   * `filesTouched` 里**相对路径的解析根** (2026-07-31)。
   *
   * 为什么它必须跟着路径一起走: 一组相对路径**离开它的根就没有意义**了。产物闸在节点里用的是
   * `r.cwd ?? repoRoot ?? process.cwd()` —— 而 R2 隔离档下 leaf 跑在一棵 worktree 里,
   * 那个 cwd 与引擎进程的 cwd **不是同一个**。此前这一位没往外传, 于是任何在节点之外
   * 重新解析 `filesTouched` 的人都在拿错的根去找文件。
   *
   * 抓住这条的是「产物没变」检测器的端到端用例: 单元测试全绿, 而真跑一遍**恒命中不了** ——
   * 因为每个文件都 hash 成 null (在错的根下当然找不到)。fail-open 的方向救了它不误报,
   * 但它也就此**在最该用它的那个配置里静默失效**。缺席 = 非 agent 节点 / leaf 没报 cwd。
   */
  artifactRoot?: string;
  /**
   * **§8.5 效果指标的压缩形** (2026-07-31): `[总写次数, 其中 no-op 的次数]`。
   *
   * 为什么压成两个数而不是把 `FileWriteEffect[]` 原样带上来: 这条链的下游是**留痕库**,
   * 而留痕库该存的是能长期归组统计的东西。逐条效果里的 `lineDelta` 对单次排障有用, 对
   * "no-op 写占多少" 这个真问题没用 —— 而后者才是决定"要不要从**报**升成**判**"的那个数。
   * 逐条仍在日志里(`executor-dag` 的 warn/info), 排障够得着。
   *
   * ⚠ **两个数都是 0 与整个字段缺席不是一回事**: 前者 = 这个节点跑了但一次文件都没写;
   * 后者 = 这条链上没人报(inproc/command 节点, 或早于本次改动的 checkpoint)。
   * 读数板必须把这两种分开念, 否则"没记"会被读成"没跑过"。
   */
  writeCounts?: [total: number, noop: number];
  /**
   * `executor:'command'` 节点的退出码。**负数 = command-leaf 的闸拒**(白名单/元字符/git 写/
   * 危险命令),不是被执行命令的退出码。
   *
   * 为什么值得单记一位(2026-07-31,第四跑逼出来的):「节点没过」有**两种成因,后续动作相反** ——
   *   · 普通失败(exit ≠ want):断言没成立 → 再试一轮可能就好了(`STALLED`)
   *   · **闸拒**(exit < 0):Harness 拒绝了这个操作 → **再试也没用**,白名单不会因为重试而放行
   * 书 §4.4 的五态表里,后者正是 `BLOCKED` 的教科书定义(「触碰范围禁区或权限边界 ·
   * Harness 层拒绝了某个操作 · 停止自动重试,直接升级给人」),而我们今天把它降格成"节点 failed",
   * 与普通失败混成一堆 —— 连"这一跑被闸拒了几次"都要去读日志。
   *
   * ⚠ **本字段只记不判**:是否该据它走 BLOCKED 出口, 取决于「连续几轮找不到一条合法命令」这个数,
   * 而那个数今天是 0 读数(第三跑实测 conductor 会从闸拒里自愈:拒→拒→过)。先记,再定 K。
   */
  exitCode?: number;
  /**
   * agent leaf **读过**的文件 (D-12, 来自 AgentLeafResult.filesRead)。图外数据流的观察面 ——
   * `plan/observers.lintArtifactEdges` 据它报「未声明的制品依赖」, 复用滤镜据它拦「读过被拒制品的
   * 消费方」(INV-P2-4/5)。resume 跳过的节点从 checkpoint 的 `inputPaths` 还原, 观察面不因续跑变窄。
   */
  filesRead?: string[];
  /**
   * research leaf 真抓到正文的 URL (INV-GOAL-2 证据面)。零来源的 research 节点在引擎里已判 failed,
   * 故 done 的 research 结果这里恒非空 —— 下游 gate/审计据此判"这份研究是否真落地过网页"。
   */
  sources?: string[];
  /** agent leaf 的工具调用次数 (来自 AgentLeafResult.toolCalls; prompt 档的路由效率读数)。 */
  toolCalls?: number;
  /**
   * agent leaf 经 **bash 工具**跑过的命令 + 退出码 (2026-08-05, 来自 AgentLeafResult.shellRuns)。
   *
   * 它补的是**「诚实自验」这条记录通道**: agent 手里有 bash,「我跑了 `bun test`,3/3 通过」
   * 是合法自验的主要形状 —— 而引擎此前只记 `toolCalls` 的**次数**, 数不出跑的是什么、过没过。
   * 于是 `plan/claimed-actions` 那个谓词 (「声称的引擎校验动作 ⊆ 引擎记录的动作」) 的**记录集
   * 缺了主要合法元素**, 真跑过测试的节点与顺手编一句的节点在 facts 上分不开。
   *
   * ⚠ 缺席 = 这条链上没人报 (inproc leaf / 旧 runner), 与 `[]` (跑了但一次没用 bash) 是两件事。
   */
  shellRuns?: ShellRun[];
  /** 早期心跳闸判停摆 (issue #5): provider 挂起, 未等满硬超时即中止 → settle 记 failureKind='stall'。 */
  stalled?: boolean;
  /**
   * **引擎推断的写目标**(2026-08-06):命令原文点名要写、且那个文件在本节点执行窗口内变过。
   * 与 `filesTouched` 同一个 `artifactRoot` 根。
   *
   * ## 为什么它与 `filesTouched` 刻意是两位
   *
   * `filesTouched` 是**事实**(受控写工具 write/edit/hashline 的记录);这一位含**推断** ——
   * `a && b > x` 里 `a` 失败时 `x` 并没有被写,而同窗口另一个节点写了它就会被认领。
   * 证据强度不同的两类压成一个字段之后,「这条 finding 是真的还是推出来的」就永久分不开了。
   *
   * ## 它补的是哪个盲点
   *
   * `filesTouched` 只认受控写工具,于是 ① `command` 节点那一路**从不填这一位**
   * ② agent leaf 既用受控工具又用 bash 写时,bash 那部分隐形(产物闸的救援② 只在
   * `filesTouched` **空**时才跑)。⑧.6 运行时写竞争的机会分母因此长期够不着。
   *
   * ⚠ **它只进可见性,不参与任何判定** —— 产物闸、节点成败、judge 一律不看它。
   *   放宽产物闸是另一件事(那条闸的安全性质是「没有盘上证据就不救」,挡的是 empty-done);
   *   这一位要的是**看见**,不是**放行**。两者刻意不共用一条通道。
   *
   * ⚠ 缺席 = 这条链上没人报(inproc leaf / 没跑过 shell / 旧记录),与 `[]`(跑了 shell 但
   *   一个写目标都没核实过)是两件事。
   *
   * ⚠ **command 节点的根是仓根**:`CommandLeafResult` 不报 cwd,所以相对目标一律按
   *   `repoRoot ?? process.cwd()` 解析。一条 `cd 别处 && > x.md` 的相对目标会解析到仓根、
   *   核不过、于是**不产候选** —— 漏认不误认,方向与整条通道一致(agent leaf 有 `cwd`,
   *   走 `artifactRoot`,没有这个问题)。
   */
  writeCandidates?: string[];
  /** conductor 节点实跑的内环轮数 (D-A)。其它 kind 缺席。 */
  rounds?: number;
  /**
   * conductor 节点内环 judge 的最终裁决 (D-F)。
   *
   * ⚠ **缺席 ≠ 未收敛**: 缺席意思是**没人判过** —— 最后一轮默认不请 judge (省一次贵座调用),
   * 要裁决得在节点上显式写 `judge_final: true`。调用方拿它当"整体目标成了吗"的答案时,
   * `converged ?? false` 是对的读法 (没人判过就不许算成), 但别把它读成"judge 说没成"。
   */
  converged?: boolean;
  /**
   * **BLOCKED 异步出口** (D-Q): 环停在这里不是因为失败, 是因为**没有外部输入就推不动**。
   *
   * 与 `converged=false` 的区别在于该怎么办: 未收敛 = 再来一轮可能就好了; blocked = 再来多少轮
   * 都一样 (判据是确定性的, 见 `plan/observers.detectLoopNoProgress` 与 detector 节点的
   * `BLOCKED:` 协议), 该由 owner 看一眼。**blocked 恒不算收敛** —— 两个字段一起出现时,
   * `converged` 必为 false (fail-closed: 阻塞更不该被读成成功)。
   */
  blocked?: string;
  /**
   * **环因预算停的**(2026-07-31, 承 Loop Engineering 的第四条停止轴)。
   *
   * 四条停止轴里我们本来只有三条:轮数上限 · 空转 · 完成检查。缺的是**预算与时间** ——
   * 于是一个目标只要 judge 每轮都说"还不行",就会一路烧到 `max_rounds` 才停,而没有任何一处
   * 问过"这已经花了多少"。
   *
   * ⚠ 它与 `blocked` 的下一步**不一样**,所以是两个字段不是一个:
   *   - `blocked` = 判据是确定性的,**再多轮/再多钱都一样**,该 owner 去看;
   *   - `budgetStopped` = 只是钱/时间用完了,**加预算 resume 很可能就成**。
   * 混成一个词会让两个完全不同的下一步读同一句话(D-P 给 `cancelled` 单独立词的同一条理由)。
   * 恒与 `converged: false` 同时出现(fail-closed:没跑完就不是成)。
   */
  budgetStopped?: string;
  /**
   * **引擎自己出事导致环提前退出**的原因(2026-07-31)。今天唯一的来源: judge 调不通
   * (`ModelError` —— 传输/配置层的确定性故障, 如 codex 拒 temperature)。
   *
   * 与 {@link blocked} 分开的理由是**下一步相反**(同 N5 词表): blocked = 要人给外部输入,
   * 再多轮都一样; infraStopped = **引擎该修**, 而它此前被念成 `not-converged` ——
   * 于是读的人会去加轮数, 而加轮数恰恰是最没用的那个动作。实测: 一个改配置一分钟能修的事,
   * 烧掉了全部轮数, 症状看起来像"任务太难"。
   */
  infraStopped?: string;
  /**
   * **judge 自己那一票**(2026-08-01),与 {@link LeafResult.converged} 分开带。
   *
   * 冻结判据进环之后 `converged` 是**判据**说的(D-I 以判据为准),不再等于 judge 说的。
   * 两者混在一起, 判据轴就会把「判据绿」误记成「judge 也说绿」—— 而那正是它要量的那一格
   * (judge 太紧: 判据过了而 judge 说没成)。
   *
   * 缺席 = 这一跑没走环内判据那条路, 或 judge 调不通(**没投过票, 不是投了反对票**)。
   */
  judgeConverged?: boolean;
}

/**
 * 上一轮执行的 {plan, results} —— D-21 跨轮语义复用的输入。
 * 轮内 escalation 与外层 fixpoint (iterateExecutorDag) 共用同一形状。
 */
export interface PriorExec {
  plan: ConductorPlan;
  results: Record<string, LeafResult>;
  /**
   * D-4b 指纹毒集: 被 review/judge 点名拒绝过的节点**语义指纹**。命中者不进复用池。
   *
   * 为什么锚在指纹而非节点 id: 外层每轮把 plan 扔掉让 conductor 重画, id 跨轮无意义 (且指纹刻意
   * 不含 id)。票在**铸它的那一轮的 id 空间**里生成, 当场翻成指纹再往下一轮带 —— 见 plan/iterate。
   *
   * 没有它, 被拒节点 (status 仍是 'done' —— 拒的是质量不是状态) 会被指纹匹配原样复用进修复轮,
   * 修复轮能否修对就全看 conductor 从散文里猜没猜中该改哪个节点。
   */
  poisoned?: ReadonlySet<string>;
}

export interface ExecutorDagResult {
  plan: ConductorPlan;
  /**
   * 本次 run 的**跨平面关联键** (= config.sessionId 或内部生成的)。
   *
   * 2026-07-31 起它同时是 **Langfuse 的 traceId + sessionId** —— 一次 run 的全部模型调用
   * (conductor / leaf / judge / verifier / research) 都经 `gateway.send()` 归到这一条 trace 上。
   * ⚠ 在此之前这句话写的是"Langfuse session id"而实际没有任何导出器, 那是**声明面与执行面
   * 对不上**; 现在为真, 但**仅当配了 LANGFUSE_* 三个 env** (不配 = 这一位仍只是个关联键)。
   */
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
  /**
   * D-21 跨轮语义复用命中的节点 id (本轮零 LLM 直接注入上轮输出)。空 = 无复用 (首轮 / 全变了)。
   * INV-GOAL-3 的"可证"面: 修复轮跑完看这个数, 而不是猜"应该复用了吧"。
   */
  reusedNodes?: string[];
  /**
   * **图外只读观察者**本次 run 的全部产出 (D-Q)。空/缺席 = 没观察到异常。
   * 它们已经在引擎内被前馈进下一轮的重展开 prompt; 这里是给调用方 (与事后审计) 的同一份。
   */
  observations?: DagObservation[];
  /**
   * 「声称 vs 引擎记录」检出器这一跑查了多少、检出多少 —— **两道分开记**(2026-08-05)。
   *
   * ⚠ 两道的**面宽度不同,合并即错**:
   *   - `conductor` = 内环那道,面 = output + facts + **产物内容**(judge 视图读盘的那份);
   *   - `flat`      = 整图那道,面 = output + facts,**不读产物内容**(读盘是 judge 视图专有预算)。
   * 两个分母**不重叠**:内环检过的子节点被平铺那道跳过。
   *
   * 加 `flat` 的理由是一次真跑撞出来的:那条判据原本只活在 conductor 内环,而 `dag_run` 那条路
   * 整张图可以一个 conductor 节点都没有 —— 检出器结构上够不着,账本却记成"零检出"。
   * 按 entry 数约一半流量走那条路 → 活体基率会被算低近一倍。
   * `flat` 那道**只进账本、不进任何 prompt**(纯测量,零行为风险);要不要让它也喂 DAG 级
   * verifier 是**单独的拨闸决定**,不在这里顺手做。
   *
   * ⚠ 缺席 = 早于本次改动的记录(不是"零检出")。
   */
  claimCheck?: {
    conductor: { rounds: number; nodes: number; findings: number };
    flat: { nodes: number; findings: number };
  };
  /**
   * 「产物没变」判据(`loop-no-artifact-change`)这一跑**有过多少次判得了的机会**(2026-08-06)。
   *
   * 加它是因为读数板 ⑧ 段一直在拿**错的分母**读那个 0:53 跑 0 次命中被当成"活体基率 ≈ 0",
   * 而这条判据的机会单位不是"一次运行" —— 它住在 conductor 内环, 一次比较要同时满足
   * ① 内环真转到了第二圈(`max_rounds > 1` 且首轮没收敛)② 两轮都有产物信号 ③ 两侧都读得到。
   * 单轮档的 `dag_run` 与首轮即绿的 goal **一次机会都没有**, 于是那个 0 是「够不着」。
   *
   * 三个数的关系(读的时候别相加):
   *   `transitions` = 有上一轮可比的轮转次数(首轮不算 —— 那不是一次跨轮);
   *   `unobserved`  = 其中**判不了**的(population 空 / 有读不到的文件)—— 不进基率分母;
   *   `findings`    = 其中判成"没位移"的。
   *   → 基率分母 = `transitions - unobserved`;分子 = `findings`。
   *
   * ⚠ 缺席 = 早于本次改动的记录(**不是** transitions:0)。`transitions: 0` 是"这一跑确实
   *   一次跨轮比较都没发生", 与"没记"的下一步不同: 前者要问环为什么只转一圈, 后者只是老数据。
   */
  artifactMove?: { transitions: number; unobserved: number; findings: number };
  /**
   * **运行时**写竞争这一跑撞得上几次、真撞了几次(2026-08-06;判据见 `detectRuntimeWriteRace`)。
   *
   * ⚠ 与 `static-lint` 那条 `write-race` **同名不同义**,而两者的下一步相反:那一条是**跑之前**
   * 按 `output_path` 声明判死的坏 plan(改法是改图),这一条是**真跑时**两个并发 leaf 撞在同一条
   * (谁都没声明过的)路径上。台账此前拿前者的 4 次读数当后者的证据 —— 而后者的通道当时根本不存在。
   *
   * 三个数别互相替代:
   *   `overlaps` = 执行窗口真重叠过的节点**对**数(有没有并发本身);
   *   `pairs`    = 其中**两侧都报过写**的对数 —— **只有它是"撞得上"的机会**;
   *   `findings` = 其中路径真相交的对数。
   * `overlaps - pairs` 是看不见的那部分(一侧没报写:可能真没写,也可能写了而 `filesTouched`
   * 够不着,如 command 节点走 shell)。两者今天分不开,所以**不进机会分母**。
   *
   * ⚠ 缺席 = 早于本次改动的记录;`overlaps: 0` = 这一跑压根没有并发(常见:窄图/链式图)。
   */
  writeRace?: {
    overlaps: number;
    pairs: number;
    findings: number;
    /**
     * 把**推断**的写目标(`DagNodeResult.writeCandidates`)并进来之后的机会 / 命中数
     * (2026-08-06 补)。缺席 = 早于本次改动的记录。
     *
     * ⚠ 与严格那两个**不许相加也不许互相替代**:严格口径是受控写工具的事实,这两个含推断
     *   (`a && b > x` 里 a 失败时 x 并没有被写)。`pairsInferred - pairs` 是**只有推断才看得见**
     *   的那一块 —— 要把这条升成闸的人必须先知道那一块有多大。
     *   而 `overlaps - pairsInferred` 才是今天两条判据都够不着的那部分。
     */
    pairsInferred?: number;
    findingsInferred?: number;
  };
  /**
   * **协作式取消** (D-P) 的留痕: 给了就说明本次 run 是被叫停的, 不是自然跑完的。
   *
   * ⚠ 调用方**不许把它读成失败, 也不许读成成功**: 已跑完的节点全在 `results` 里、checkpoint 全在盘上,
   * 该 run 用同一个 runId `resume` 就接着跑。`notRun` 是"一个都没起跑过"的节点 (no-silent-caps:
   * 少跑了什么必须说出来, 否则调用方会把一份残图当全图读)。
   */
  cancelled?: { reason: string; at: string; notRun: string[] };
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
