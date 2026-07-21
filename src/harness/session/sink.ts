/**
 * src/harness/session/sink —— W4 session-checkpoint → omd SQLite 记忆镜像(D1 · g2 裁决)。
 *
 * W1 session/writer 写完 checkpoint.md **之后**调本模块:把最新快照镜像进 omd 现有
 * `OmdMemory`(namespace='continuity', identity_key=sessionId → 同 session 多写=演化更新一行),
 * 供语义召回"历史相关 session"。markdown 是 resume 真理源;本镜像是**额外**可查层。
 *
 * ┌─────────────────────────── 契约(W4 交付时保持签名不变)───────────────────────────┐
 * │ 铁律(承重接缝):                                                                   │
 * │  - 全程 fail-open:永不抛,失败只回 {ok:false, error}(markdown 已落,不阻断 hook 链)。│
 * │  - resume 仍走 markdown:本写入不改 resume 注入路径,只是额外召回层。                 │
 * │  - 无 memory 注入(hook 环境未装配)→ 静默跳过,返回 {ok:false},不报错。            │
 * └────────────────────────────────────────────────────────────────────────────────────┘
 *
 * ⚠️ 当前为 no-op 默认(W1 独立可跑)。真实 SQLite 实装 = pathfinder 票 t2(W4),经 omd DAG 交付:
 *    - sinkCheckpoint: 调 OmdMemory.writeFact({ namespace:'continuity', id:sessionId, ... })。
 *    - listCheckpoints: 读回时间线(read-only)。
 *    交付时**保持下列导出类型与函数签名逐字不变**(W1 依赖它们),只填函数体 + 加 bun test。
 *
 * @module
 */
import type { OmdMemory } from '../memory';

// ─── 契约类型(W4 交付时不改)────────────────────────────────────────────────

export interface CheckpointSinkInput {
  sessionId: string;
  mode: 'rolling' | 'final' | 'precompact';
  /** 全 checkpoint markdown(落 payload,供重放/显示)。 */
  md: string;
  /** §1 摘要(fact text + 召回/显示用)。 */
  intent?: string;
  /** §2 下一步(并入 fact text)。 */
  next?: string;
  /** checkpoint 时 ctx 真值(ledger),无则 null。 */
  ctxTokens?: number | null;
  /** 机械降级版标记(md 以 <!-- DEGRADED 起)。 */
  degraded?: boolean;
  /** checkpoint.md 绝对路径(落 payload,resume 真理源指针)。 */
  checkpointPath?: string;
}

export interface CheckpointSinkResult {
  /** 快照 fact 是否写成 — 主 durability 信号。 */
  ok: boolean;
  /** fact(latest-snapshot)写入状态。 */
  factStatus?: 'created' | 'updated' | 'rejected';
  /** fail-open 捕获的错误摘要(诊断用,不阻断)。 */
  error?: string;
}

export interface CheckpointRow {
  sessionId: string;
  mode: string;
  intent: string | null;
  ctxTokens: number | null;
  degraded: boolean;
  /** checkpoint.md 绝对路径(payload 里的指针)。 */
  checkpointPath: string | null;
  /** ISO 时间戳。 */
  ts: string;
}

export interface ListCheckpointsOpts {
  /** 限近 N 条(按 ts 倒序);默认 20。 */
  recent?: number;
  /** 限定单 session。 */
  sessionId?: string;
}

/** 注入点:W1/CLI 装配好 OmdMemory 时传入;测试注假 memory;缺省 = 无镜像层。 */
export interface SinkDeps {
  memory?: OmdMemory;
}

// ─── no-op 默认(W4 交付后替换函数体)───────────────────────────────────────

/**
 * checkpoint → omd SQLite 镜像(fail-open)。
 * 无 memory 注入 → 静默跳过(markdown 已落,不报错)。
 */
export async function sinkCheckpoint(
  _input: CheckpointSinkInput,
  deps?: SinkDeps,
): Promise<CheckpointSinkResult> {
  if (!deps?.memory) {
    return { ok: false, error: 'no OmdMemory injected — skip SQLite sink (markdown 已落)' };
  }
  // W4(票 t2)交付真实实装:memory.writeFact({ namespace:'continuity', id:sessionId, ... })。
  return { ok: false, error: 'session sink not yet wired (W4 pending)' };
}

/**
 * 查 checkpoint 时间线(read-only,不写库)。
 * 无 memory 注入 → 空列表(fail-open)。
 */
export async function listCheckpoints(
  _opts?: ListCheckpointsOpts,
  _deps?: SinkDeps,
): Promise<CheckpointRow[]> {
  // W4(票 t2)交付真实实装:memory 检索 namespace='continuity' 的快照。
  return [];
}
