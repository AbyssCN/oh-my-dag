/**
 * src/harness/continuity/types.ts — W2 omd 侧 session continuity 类型定义 (SDD §2 C1).
 *
 * 所有 checkpoint/Judge/Halt 类型归口此处。消费方:
 *   - checkpoint-manager.ts (C2)
 *   - halt-judge.ts (C6)
 *   - executor-dag.ts (C4 集成)
 *   - noun-gate.ts (C5)
 *   - scripts/continuity-writer.ts (W1 回灌)
 */
import type { ModelUsage } from '../../model/gateway';

/**
 * 单个 DAG 节点的 checkpoint 快照。
 * schemaVersion=1 以支撑未来迁移 (字段增删不改旧读)。
 */
export interface NodeCheckpoint {
  nodeId: string;
  leafKind: 'inproc' | 'agent' | 'command' | 'map' | 'primitive' | 'research';
  /**
   * done = 成功节点; failed = 失败节点 (issue #4: 留败因痕供事后诊断); skipped = 依赖未达
   * quorum 级联跳过 (D-7v2, 零执行)。resume 语义只认 done —— loadAllGreen / shouldSkip 均
   * 过滤 status==='done', 故 failed/skipped checkpoint 永不被当绿跳过, 只作审计留痕。
   */
  status: 'done' | 'failed' | 'skipped';
  /**
   * 失败节点 (issue #4) 的败因分类: 'stall' = 早期心跳闸判 provider 挂起 (issue #5) |
   * 'failed' = 通用失败 (具体原因见 summary) | 'dep-skip' = 依赖失败级联跳过 (D-7v2)。
   * done 节点 undefined。
   */
  failureKind?: 'stall' | 'failed' | 'dep-skip';
  /** 实际所用模型坐标 (失败归因; inproc/agent leaf 有, command/无模型 → undefined)。 */
  model?: string;
  /**
   * 该节点写入的产物路径 (相对于 repo root)。
   * agent-leaf 从 tool-call 事件收集 Edit/Write file_path。
   * inproc/command leaf / 失败节点 → []。
   */
  outputPaths: string[];
  /** 每个 outputPath → sha256 前 16 hex 字符。轻量产物完整性检验。 */
  artifactHashes: Record<string, string>;
  /** 模型用量。command leaf = null。 */
  tokenUsage: ModelUsage | null;
  /** LeafResult.output 截断, ≤800 字符。失败节点 = 错误消息/最后输出截断 (issue #4 败因)。 */
  summary: string;
  /** U1 map 节点: spec hash (INV-U3 两级 resume; spec 变 → 子树作废)。optional。 */
  expansionHash?: string;
  /** noun-gate 注释标签 (W2: 注释 only; W1: 硬闸)。optional。 */
  nounAnnotations?: string[];
  /** 节点执行耗时 ms。 */
  durationMs: number;
  /** ISO-8601 创建时间。 */
  createdAt: string;
  /**
   * W4 SHADOW-3/4: checkpoint 落盘时的 DAG 代数签名 (computeDagGeneration)。
   * resume 时 currentGeneration 对不上 → 该 checkpoint 是过期 DAG 形态的, 丢弃重执行
   * (防"过期切点乱截"); 对得上 → 安全跳过 (幂等)。optional = 向后兼容旧 checkpoint。
   */
  generation?: string;
  /** 当前版本 = 1。迁移用。 */
  schemaVersion: 1;
}

/** DAG 维度元数据, 落 _dag.json。 */
export interface DagMetadata {
  runId: string;
  specSlug: string;
  goal: string;
  /** 按拓扑序排列的 nodeId 列表。 */
  nodeIds: string[];
  /** 节点依赖: nodeId → 上游 nodeId[]。 */
  deps: Record<string, string[]>;
  /** ISO-8601 创建时间。 */
  createdAt: string;
  /** W4 SHADOW-3: 本 DAG 形态的代数签名 (goal+nodeIds+deps)。resume 一致性校验锚。 */
  generation?: string;
  /**
   * plan-memory (SDD 2026-07-21 缺口①): 完整 ConductorPlan 全量 (节点 goal/executor/depends_on/
   * template/model)。此前只存骨架 (nodeIds+deps), 图的"肉"随进程丢弃 → 无法重放。
   * optional = 向后兼容旧 _dag.json (缺此字段 → 不可重放, 仅 resume)。
   * 类型用结构面而非 import ConductorPlan — continuity 层不依赖 conductor-plan 模块 (层次单向)。
   */
  plan?: { name: string; description?: string; nodes: Record<string, unknown> };
  /** plan-memory: 用户任务原文 (family 聚类的匹配键; resume/预构造路径可缺)。 */
  taskText?: string;
}

/**
 * **外层 fixpoint 轮journal** (INV-P2-6), 落 `_fixpoint.json`。
 *
 * `_dag.json` + per-node checkpoint 记的是**一张内层图**;外层 fixpoint (iterateExecutorDag) 的轮次、
 * 跨轮复用源、D-4 毒集此前全是进程内闭包变量 —— 进程一死全丢, 重跑从第 1 轮起、毒集清零
 * (**被拒的产出会因此复活**, 比不复用更坏)。这个文件就是那份缺失的外层状态。
 *
 * 写入时机 = **每轮 judge 判完之后**。死在一轮中途 → 该轮没有 journal, resume 重跑该轮;
 * 但该轮内部的绿节点仍由 per-node checkpoint 兜住, 不是从零。
 *
 * 类型用结构面而非 import ConductorPlan / LeafResult —— continuity 层不依赖 harness 上层 (层次单向,
 * 同 DagMetadata.plan 的处理)。
 */
export interface FixpointJournal {
  runId: string;
  /** 已判完的外层轮数; resume 从 completedRounds+1 起跑。 */
  completedRounds: number;
  /** D-4 指纹毒集 (累积不撤)。丢了它 = 复活被拒产出。 */
  poisoned: string[];
  /** 上一轮的 {plan, results} —— 跨轮复用 (D-21) 的匹配源。 */
  lastRound?: {
    plan: { name: string; description?: string; nodes: Record<string, unknown> };
    results: Record<string, unknown>;
  };
  /** judge 判未收敛却开不出一张可解析的票 → 上一轮整体不可信 (D-4 fail-closed)。 */
  distrustLastRound?: boolean;
  /** 上一轮的失败原因 (enrich 注入下一轮 input)。 */
  prevReason?: string;
  /** 上一轮是否已判收敛 (收敛后 resume 无事可做)。 */
  converged?: boolean;
  updatedAt: string;
  schemaVersion: 1;
}

/**
 * **goal 前置阶段 journal** (2026-07-29), 落 `_goal.json`。
 *
 * `dag_goal` 的前四段 (classify / survey / research / spec) 是**编排代码**不是图 —— 它们不经 conductor、
 * 不进 DAG、没有 per-node checkpoint。于是崩在任何一段, resume 都得从 classify 重跑一遍:
 * research 是真联网 (实测 104s + token), spec 写的文件会被覆盖重写。**最贵的两段白烧。**
 *
 * 修法承 Claude Code `/loop` 的形状: **不造状态机, 靠幂等再入** —— 每段把结论写进世界,
 * 入口先看世界。于是 "resume" 不是一条特殊代码路径, 就是"再跑一遍, 已经有的自然跳过"
 * (与 `shouldSkip` 同一纪律: 存在 ∧ 有效 → 跳)。
 *
 * ⚠ `goal` 字段是**防误用闸**: 同一个 runId 换个 goal 再跑, 上次的仓内事实/研究证据对新 goal 无效,
 * 复用它们等于拿错证据写契约。goal 文本不匹配 → 整份 journal 作废。
 */
export interface GoalStageJournal {
  runId: string;
  /** 产出这批制品的 goal 原文 (不匹配则整份作废)。 */
  goal: string;
  tier?: 'simple' | 'complex';
  /** survey 阶段的仓内事实 (file:line 行)。 */
  repoContext?: string;
  /** research 证据正文 (零来源时为空 —— 与"假 grounded 不进 spec"同判据)。 */
  evidence?: string;
  sources?: string[];
  /** spec 落盘路径 (未落盘则无)。 */
  specPath?: string;
  updatedAt: string;
  schemaVersion: 1;
}

/**
 * 停机闸栈 (L1-L3) 判定结果。
 * - continue: 继续执行下一节点/轮。
 * - stop: 停机, 携带原因与可选证据。
 */
export type HaltVerdict =
  | { kind: 'continue'; reason?: string }
  | {
      kind: 'stop';
      reason:
        | 'all_green'
        | 'hard_fail'
        | 'judge_ok'
        | 'judge_impossible'
        | 'cap_exhausted'
        | 'degraded';
      /** 可选证据文本 (如 judge reason / oracle 输出片段)。 */
      evidence?: string;
    };

/**
 * L2 goal judge 模型输出 (responseSchema 强制校验用, INV-3 validated parse)。
 */
export interface JudgeVerdict {
  /** true = goal 已达到, 可收敛; false = 仍需继续。 */
  ok: boolean;
  /** true = agent 自称 goal 不可达 (如"无法完成"), judge 独立确认。 */
  impossible: boolean;
  /** 必须引用输入中的事实。禁提输入外的路径/符号。 */
  reason: string;
}
