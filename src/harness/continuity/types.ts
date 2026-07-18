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
  leafKind: 'inproc' | 'agent' | 'command' | 'map';
  /** 只有 done 的节点写 checkpoint。failed 节点不落。 */
  status: 'done';
  /**
   * 该节点写入的产物路径 (相对于 repo root)。
   * agent-leaf 从 tool-call 事件收集 Edit/Write file_path。
   * inproc/command leaf → []。
   */
  outputPaths: string[];
  /** 每个 outputPath → sha256 前 16 hex 字符。轻量产物完整性检验。 */
  artifactHashes: Record<string, string>;
  /** 模型用量。command leaf = null。 */
  tokenUsage: ModelUsage | null;
  /** LeafResult.output 截断, ≤800 字符。 */
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
