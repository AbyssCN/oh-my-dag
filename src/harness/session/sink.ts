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
 * ⚠️ **无 memory 注入时才是 no-op**(函数体自 W4 起就是真实装,别再照着这段读成"整个模块没实装")。
 *    两条静默失效路径,`{ok:false}` 的 `error` 字段是唯一痕迹:
 *      ① 调用方不传 `deps.memory` → 直接跳过(2026-08-19 之前 `scripts/session-writer.ts` 就是这样);
 *      ② `continuity` 未注册进 safeguard → 记忆层 REJECT-by-default 闸掉每一次写
 *         (注册在 `src/memory/safeguards/continuity-namespace.ts`,#206)。
 *
 * @module
 */
import { logger } from '../logger';
import type { OmdMemory } from '../memory';
import type { ValidatedFact } from '../../memory/safeguards/namespaces';

// ─── 契约类型(W4 交付时不改)────────────────────────────────────────────────

export interface CheckpointSinkInput {
  sessionId: string;
  mode: 'rolling' | 'final' | 'precompact';
  /**
   * 全 checkpoint markdown。**不进 fact**(#206,理由见 `sinkCheckpoint` 内注)——
   * 调用方从它切 §1/§2 与降级标记,真源是磁盘上那个文件,地址走 `checkpointPath`。
   */
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

// ─── W4 实装:continuity fact 镜像(真闸真库;namespace 注册属 W5 接线)────────────

/** fact → CheckpointRow(loose ValidatedFact 安全提取, 缺字段降级 null/'')。 */
function rowOf(fact: ValidatedFact): CheckpointRow {
  const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const created = (fact.confidence as { created_at?: unknown }).created_at;
  return {
    sessionId: str(fact.id) ?? '',
    mode: str(fact.mode) ?? '',
    intent: str(fact.intent),
    ctxTokens: num(fact.ctxTokens),
    degraded: fact.degraded === true,
    checkpointPath: str(fact.checkpointPath),
    ts: created instanceof Date ? created.toISOString() : String(created ?? ''),
  };
}

/**
 * 写完一条就顺手回收一次过期的(2026-08-28)。
 *
 * ## 为什么在这里, 而且为什么非有不可
 *
 * `OmdMemory.prune()` 的三个调用点(`mcp/assemble.ts:420` 的 6 小时清扫 · dream 的 promote ·
 * `chat/memory-inject.ts`)开的**全都是 `memory.db`**。continuity 分库之后 `handoff.db`
 * **一个清扫者都没有** —— 也就是说分库这一步顺手把它的回收路径切断了。这是那次改动的回归,
 * 不是新需求。
 *
 * 挂在写入侧的理由:让**把它撑大的那条路**同时负责收 —— 不新起定时器(定时器要管生命周期,
 * 而 hook 派出去的 writer 是个短命进程,挂上去也没机会跑第二次)。
 *
 * 回收判据仍是 fact 自己的 TTL(`agent_tentative` 闲置 30 天)。**没有另加条数上限**:
 * 上限是给"会被扫描的库"用的, 而今天没有任何生产路径读 handoff.db(`listCheckpoints` 零生产
 * 调用方, L3 读的是 sidecar 文件不是这个库)。它涨大只费磁盘, 不再拖慢任何召回 —— 那正是分库
 * 要解决的东西。**改变这个判断的条件**: 哪天有生产读面开始扫它, 那时再谈上限。
 */
function pruneHandoffStore(memory: OmdMemory): void {
  try {
    const n = memory.prune();
    if (n > 0) logger.info({ pruned: n }, '[session-sink] 交接库 TTL 回收');
  } catch (err) {
    // fail-open 吞异常, 不吞证据(仓规坑②): 交接已经写成了, 回收失败不该让它变成失败。
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      '[session-sink] 交接库 TTL 回收失败 (交接本身已写成, 不影响返回值)',
    );
  }
}

/**
 * checkpoint → omd SQLite 镜像(fail-open)。
 * 无 memory 注入 → 静默跳过(markdown 已落,不报错)。
 * 有 memory → `writeFact({ namespace:'continuity', id:sessionId, ... })`:同 session 多写
 * = 演化更新一行(supersede), 供语义召回"历史相关 session";resume 真理源仍是 markdown。
 */
export async function sinkCheckpoint(
  input: CheckpointSinkInput,
  deps?: SinkDeps,
): Promise<CheckpointSinkResult> {
  if (!deps?.memory) {
    return { ok: false, error: 'no OmdMemory injected — skip SQLite sink (markdown 已落)' };
  }
  try {
    // agent_tentative(单源事件):同 session 再写 = replace(廉价 supersede);闲置 30 天过期
    // (prune 清陈旧快照,不堆积)。source_event_id 锚 checkpoint 写事件。
    // md 全文**不进 fact**(#206): `CheckpointRow` 零消费者 · markdown 文件才是真源且
    // `checkpointPath` 已经存了它的地址(存副本正是本轮退役要去掉的东西) · `factToText` 会把
    // 每个声明字段拼进 embedding/FTS,几 KB markdown 会把 intent 那点召回信号淹掉。
    // 契约字段 `input.md` 保留:调用方从它切 §1/§2,且降级判定读它。
    const res = await deps.memory.writeFact({
      namespace: 'continuity',
      id: input.sessionId,
      mode: input.mode,
      intent: input.intent,
      next: input.next,
      ctxTokens: input.ctxTokens ?? null,
      degraded: input.degraded ?? false,
      checkpointPath: input.checkpointPath,
      source_event_id: `session-checkpoint:${input.sessionId}`,
      confidence: {
        level: 'agent_tentative',
        source_event_ids: [`session-checkpoint:${input.sessionId}`],
        created_at: new Date(),
      },
    });
    if (res.status === 'written') {
      pruneHandoffStore(deps.memory);
      return { ok: true, factStatus: res.action === 'insert' ? 'created' : 'updated' };
    }
    return { ok: false, factStatus: 'rejected', error: `fact rejected: ${res.reason}` };
  } catch (e) {
    return { ok: false, error: `sink threw (fail-open): ${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * 查 checkpoint 时间线(read-only,不写库)。
 * 无 memory 注入 → 空列表(fail-open)。
 */
export async function listCheckpoints(
  opts?: ListCheckpointsOpts,
  deps?: SinkDeps,
): Promise<CheckpointRow[]> {
  if (!deps?.memory) return [];
  try {
    // read-only:live 快照(每 session 最新一行), 按 ts 倒序, recent 截断。
    let rows = deps.memory.liveFactsByNamespace('continuity').map(({ fact }) => rowOf(fact));
    if (opts?.sessionId) rows = rows.filter((r) => r.sessionId === opts.sessionId);
    rows.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
    return rows.slice(0, opts?.recent ?? 20);
  } catch {
    return []; // 检索失败 → 空列表(fail-open, 不抛)
  }
}
