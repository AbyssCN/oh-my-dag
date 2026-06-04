/**
 * src/valar/learning/confidence-adjuster.ts — 复利自学习的"升级开关 + 熔断器"。
 *
 * WHY 这是闭环真闭的关键: dream-pump 只写 agent_tentative; behavioral-grounding 的置信路由隔离
 * 只把 agent_confident+ 注入行为 → tentative 不驱动行为。ConfidenceAdjuster 是把"反复验证的教训"
 * 从印象层升进行为层的唯一闸。研究稿 valar-compounding-self-learning-v2 §闸门 III/V + ds fanout 合成
 * + 两轮对抗审查校正 (2026-06-03)。
 *
 * 两段式 (解 reflexivity 死锁):
 *   1. 升级闸 (升级**前**, shouldUpgrade): 只看**源证据** (跨 session 独立复现)。因为 tentative 不驱动
 *      行为, grounding 效果此刻不可能因它变 (鸡生蛋)。**不**用"源 drift 占比"当闸 —— 当前唯一信号源
 *      就是 drift_stuck, 占比恒 1.0 (审查 B-P0-1); 且"教训反复从卡住里浮现"正是要学的, 不是 disqualifier。
 *   2. 熔断器 (升级**后**, evaluateObservations): fact 已 confident、已 grounding 注入驱动行为 → 此刻
 *      drift **率** (drift/turns, 有真实分母) 前后比较才是真信号。变坏 → 回滚 + cooldown + 高水位防重升。
 *
 * 关键: drift "率" 而非 "占比"。runtime_events 只存 drift 事件 (分子), turns 表存活动总量 (分母);
 * rate = drift/turns 才可比 (审查 B-P0-1/2/3)。窗口按 upgraded_at 时间过滤 (只算升级后的)。
 *
 * Schema 约束 (R6): agent_tentative.source_event_ids 上限 2, agent_confident 下限 3 → minEvents clamp ≥3
 * (审查 A-P1-2); 证据不堆 fact 上, 用历史 (含 tombstoned) facts 的 source_event_ids 并集当账本。
 */
import type { ValidatedFact, Confidence } from '../../memory/safeguards/namespaces';
import type { WriteFactResult } from '../memory/types';

// ── 阈值 (中道, 全 env 可覆盖; mock 证机制, 真实 drift 数据后校准) ───────────────────
function envInt(name: string, def: number): number {
  const v = process.env[name];
  if (v === undefined) return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

export interface ConfidenceConfig {
  /** 升级最少独立证据事件数。clamp ≥3 (confident schema 下限)。 */
  minEvents: number;
  /** 升级最少 distinct session 数 (跨 session = 时间维独立性, 防同-session 伪复利)。 */
  minSessions: number;
  /** 熔断: 升级后 drift率 > 升级前 baseline率 × 此因子 才算变坏 (>1 留裕度)。 */
  breakerWorseFactor: number;
  /** 熔断绝对裕度: 还要求 afterRate - beforeRate ≥ 此值 (防 baseline≈0 时一次抖动就误杀, 审查 B-P1-1)。 */
  breakerAbsoluteMargin: number;
  /** 熔断最小观察 turns: 升级后活跃窗口不足这么多 turn → 信息不足, 不评 (留 pending)。 */
  breakerMinObserveTurns: number;
  /** 回滚后冷却天数 (防 upgrade→rollback→upgrade 死循环, 审查 A-P1-1)。 */
  cooldownDays: number;
  /** 同 identity 回滚累计达此数 → 永久 demote 不再自动升 (振荡硬上限, 审查 A-P1-1)。 */
  maxRollbacks: number;
  /** 永不自动升 confident 的 namespace (硬边界只能 human_verified)。 */
  safeNamespaces: ReadonlySet<string>;
}

export function resolveConfig(overrides: Partial<ConfidenceConfig> = {}): ConfidenceConfig {
  // minEvents clamp ≥3: confident schema 强制 source_event_ids ≥3, 配更低会让升级静默全失败 (审查 A-P1-2)。
  const minEvents = Math.max(3, overrides.minEvents ?? envInt('VALAR_CONF_MIN_EVENTS', 3));
  return {
    minEvents,
    minSessions: overrides.minSessions ?? envInt('VALAR_CONF_MIN_SESSIONS', 2),
    breakerWorseFactor: overrides.breakerWorseFactor ?? envInt('VALAR_CONF_BREAKER_FACTOR', 1.5),
    breakerAbsoluteMargin: overrides.breakerAbsoluteMargin ?? envInt('VALAR_CONF_BREAKER_MARGIN', 0.1),
    breakerMinObserveTurns: overrides.breakerMinObserveTurns ?? envInt('VALAR_CONF_MIN_OBSERVE_TURNS', 5),
    cooldownDays: overrides.cooldownDays ?? envInt('VALAR_CONF_COOLDOWN_DAYS', 30),
    maxRollbacks: overrides.maxRollbacks ?? envInt('VALAR_CONF_MAX_ROLLBACKS', 2),
    safeNamespaces: overrides.safeNamespaces ?? new Set(['valar.limit']),
  };
}

// ── 注入式依赖 (memory + event-store 查询; 测试用 fake) ───────────────────────────
export interface UpgradeMemory {
  liveTentativeFacts(): { id: string; namespace: string; identityKey: string; fact: ValidatedFact }[];
  collectIdentityEvidence(namespace: string, identityKey: string): string[];
  writeFact(input: unknown, opts?: { scanSecrets?: boolean }): Promise<WriteFactResult>;
}

/** drift/turns 计数 (rate = drift/turns; turns=0 → rate 0)。 */
export interface DriftCounts {
  drift: number;
  turns: number;
}

/** 升级闸只需"这些 event 落哪些 session"。 */
export interface UpgradeEventQuery {
  getSessionsForEvents(eventIds: number[]): string[];
}

/** 熔断器额外需要的归因查询 (按 upgraded_at 时间过滤, drift率有真分母)。 */
export interface BreakerEventQuery extends UpgradeEventQuery {
  /** fact (identity) 被注入行为的 session (来自 grounding_applied)。 */
  getSessionsWhereFactActive(identity: string): string[];
  /** 全局 baseline: created_at ≤ at 的 drift 数 + turns 数。 */
  countsBefore(at: string): DriftCounts;
  /** 这些 session 内 created_at > at 的 drift 数 + turns 数 (升级后窗口)。 */
  countsInSessionsAfter(sessionIds: string[], at: string): DriftCounts;
}

/** observation/cooldown/回滚高水位 持久层。 */
export interface ObservationStore {
  recordUpgrade(rec: { identityKey: string; namespace: string; factId: string; upgradedAt: string; beforeRate: number }): void;
  pendingObservations(): { identityKey: string; namespace: string; factId: string; upgradedAt: string; beforeRate: number }[];
  markObserved(identityKey: string, namespace: string): void;
  /** 回滚: 标 observed + cooldown 截止 + 累加回滚次数 + 记当时证据高水位 (防重升需新证据)。 */
  recordRollback(identityKey: string, namespace: string, cooldownUntil: string, evidenceAtRollback: number): void;
  inCooldown(identityKey: string, namespace: string, now: string): boolean;
  /** identity 的回滚历史 (从无 → null)。升级闸据此要求"新证据"才重升。 */
  rollbackInfo(identityKey: string, namespace: string): { rollbackCount: number; evidenceAtRollback: number } | null;
}

const rate = (c: DriftCounts): number => (c.turns > 0 ? c.drift / c.turns : 0);

// ── 升级闸 ────────────────────────────────────────────────────────────────────────
export interface UpgradeDecision {
  upgrade: boolean;
  reason: string;
  distinctSessions: number;
  evidenceCount: number;
}

/** 纯判定: 给定证据 event_ids 决定 tentative→confident 是否够格 (只看证据量 + 跨 session)。 */
export function shouldUpgrade(
  fact: { namespace: string },
  evidenceIds: string[],
  q: UpgradeEventQuery,
  config: ConfidenceConfig,
): UpgradeDecision {
  const base = { distinctSessions: 0, evidenceCount: evidenceIds.length };
  if (config.safeNamespaces.has(fact.namespace)) {
    return { upgrade: false, reason: `safe-namespace:${fact.namespace}`, ...base };
  }
  if (evidenceIds.length < config.minEvents) {
    return { upgrade: false, reason: `too-few-events:${evidenceIds.length}<${config.minEvents}`, ...base };
  }
  const numericIds = evidenceIds.map((s) => Number(s)).filter((n) => Number.isFinite(n));
  const distinctSessions = new Set(q.getSessionsForEvents(numericIds)).size;
  if (distinctSessions < config.minSessions) {
    return { upgrade: false, reason: `too-few-sessions:${distinctSessions}<${config.minSessions}`, ...base, distinctSessions };
  }
  return { upgrade: true, reason: 'evidence-sufficient', ...base, distinctSessions };
}

/** 把 tentative fact 升级成 confident fact 的 payload (carry 所有 namespace 字段, 换 confidence)。 */
function toConfidentFact(tentative: ValidatedFact, evidenceIds: string[], now: Date): Record<string, unknown> {
  const { confidence: _drop, ...rest } = tentative as Record<string, unknown> & { confidence: Confidence };
  return {
    ...rest,
    confidence: { level: 'agent_confident' as const, source_event_ids: evidenceIds, created_at: now },
  };
}

export interface UpgradeScanResult {
  scanned: number;
  upgraded: { identityKey: string; namespace: string; reason: string; distinctSessions: number }[];
  skipped: { identityKey: string; namespace: string; reason: string }[];
}

/**
 * 扫所有 live tentative fact, 够格的升 confident。低频单用户全扫成本可忽略。
 * obs 传则记 observation (供熔断器) + 跳过 cooldown 内 / 永久 demote / 需新证据未到的 identity。
 */
export async function runUpgradeScan(
  mem: UpgradeMemory,
  q: BreakerEventQuery,
  config: ConfidenceConfig,
  opts: { obs?: ObservationStore; now?: Date } = {},
): Promise<UpgradeScanResult> {
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();
  const res: UpgradeScanResult = { scanned: 0, upgraded: [], skipped: [] };

  for (const { namespace, identityKey, fact } of mem.liveTentativeFacts()) {
    res.scanned++;
    if (opts.obs?.inCooldown(identityKey, namespace, nowIso)) {
      res.skipped.push({ identityKey, namespace, reason: 'cooldown' });
      continue;
    }
    const evidenceIds = mem.collectIdentityEvidence(namespace, identityKey);

    // 回滚历史: 熔断器已证它有害 → 不靠同一批 stale 证据重升 (审查 A-P1-1 防 30 天振荡)。
    const rb = opts.obs?.rollbackInfo(identityKey, namespace) ?? null;
    if (rb) {
      if (rb.rollbackCount >= config.maxRollbacks) {
        res.skipped.push({ identityKey, namespace, reason: `rolled-back-permanent:${rb.rollbackCount}` });
        continue;
      }
      if (evidenceIds.length <= rb.evidenceAtRollback) {
        res.skipped.push({ identityKey, namespace, reason: 'awaiting-new-evidence' });
        continue;
      }
    }

    const decision = shouldUpgrade(fact, evidenceIds, q, config);
    if (!decision.upgrade) {
      res.skipped.push({ identityKey, namespace, reason: decision.reason });
      continue;
    }
    const write = await mem.writeFact(toConfidentFact(fact, evidenceIds, now));
    if (write.status !== 'written') {
      res.skipped.push({ identityKey, namespace, reason: `write-rejected:${write.reason}` });
      continue;
    }
    // baseline = 升级时全局 drift率 (fact 还没驱动行为前世界有多坏)。
    opts.obs?.recordUpgrade({ identityKey, namespace, factId: write.id, upgradedAt: nowIso, beforeRate: rate(q.countsBefore(nowIso)) });
    res.upgraded.push({ identityKey, namespace, reason: decision.reason, distinctSessions: decision.distinctSessions });
  }
  return res;
}

// ── 熔断器 ────────────────────────────────────────────────────────────────────────
export interface BreakerResult {
  evaluated: number;
  rolledBack: { identityKey: string; namespace: string; beforeRate: number; afterRate: number }[];
  confirmed: { identityKey: string; namespace: string }[];
}

/**
 * 升级后熔断: 对每个 pending observation, 比 fact 升级**后**活跃 session 的 drift**率** vs 升级前 baseline率。
 * 变坏 (afterRate > beforeRate×factor 且绝对裕度够) → 回滚成 tentative + cooldown + 记高水位。否则确认。
 *
 * 归因 session 级 + 时间过滤 (countsInSessionsAfter 只算 created_at>upgradedAt)。粗但量纲可比 (drift/turn)。
 * 活跃 turns 不足 minObserveTurns → 信息不足, 留 pending 待下次。无活跃 session 同理 (从没被注入)。
 */
export async function evaluateObservations(
  mem: UpgradeMemory & { liveByIdentity(namespace: string, identityKey: string): ValidatedFact | null },
  q: BreakerEventQuery,
  obs: ObservationStore,
  config: ConfidenceConfig,
  opts: { now?: Date } = {},
): Promise<BreakerResult> {
  const now = opts.now ?? new Date();
  const res: BreakerResult = { evaluated: 0, rolledBack: [], confirmed: [] };

  for (const o of obs.pendingObservations()) {
    const live = mem.liveByIdentity(o.namespace, o.identityKey);
    if (!live || live.confidence.level !== 'agent_confident') {
      obs.markObserved(o.identityKey, o.namespace);
      continue;
    }
    const activeSessions = q.getSessionsWhereFactActive(o.identityKey);
    if (activeSessions.length === 0) continue; // 从没被注入 → 信息不足

    const afterCounts = q.countsInSessionsAfter(activeSessions, o.upgradedAt);
    if (afterCounts.turns < config.breakerMinObserveTurns) continue; // 观察样本不足 → 留 pending

    res.evaluated++;
    const afterRate = rate(afterCounts);
    const worse = afterRate > o.beforeRate * config.breakerWorseFactor && afterRate - o.beforeRate >= config.breakerAbsoluteMargin;
    if (worse) {
      const cooldownUntil = new Date(now.getTime() + config.cooldownDays * 86400_000).toISOString();
      const evidenceCount = mem.collectIdentityEvidence(o.namespace, o.identityKey).length;
      await mem.writeFact(toTentativeRollback(live, now)); // checkEvolve: confident→evolve → tombstone+insert tentative = 降级
      obs.recordRollback(o.identityKey, o.namespace, cooldownUntil, evidenceCount);
      res.rolledBack.push({ identityKey: o.identityKey, namespace: o.namespace, beforeRate: o.beforeRate, afterRate });
    } else {
      obs.markObserved(o.identityKey, o.namespace);
      res.confirmed.push({ identityKey: o.identityKey, namespace: o.namespace });
    }
  }
  return res;
}

/** confident → tentative 回滚 payload (source_event_ids slice 到 tentative schema 上限 2)。 */
function toTentativeRollback(confident: ValidatedFact, now: Date): Record<string, unknown> {
  const { confidence, ...rest } = confident as Record<string, unknown> & { confidence: Confidence };
  const ids =
    confidence.level === 'agent_confident' || confidence.level === 'agent_tentative'
      ? confidence.source_event_ids.slice(0, 2)
      : [String((rest as { source_event_id?: string }).source_event_id ?? '0')];
  return {
    ...rest,
    confidence: { level: 'agent_tentative' as const, source_event_ids: ids.length ? ids : ['0'], created_at: now },
  };
}
