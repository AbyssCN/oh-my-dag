/**
 * src/harness/learning/event-store — runtime_events SQLite store (drift-only signal persistence).
 *
 * Mirrors dag-record.ts / session-store.ts pattern: factory fn, bun:sqlite, WAL,
 * injectable `db` for test (`:memory:`), default file `.omd/runtime-events.db`.
 *
 * Two tables:
 *   runtime_events   — event_id AUTOINCREMENT PK, session_id, type, payload (JSON),
 *                      created_at (RFC 3339 ISO)
 *   runtime_watermark — singleton row: watermark INTEGER DEFAULT 0 (monotonic, LRN-4)
 *
 * LRN-4: watermark is ->event_id not ->ROWID. event_id is the downstream DreamEvent
 * number-space; consolidate runs on event_id > watermark. If a pump fails the watermark
 * stays (setWatermark only called on success), so retry replays the same window.
 */
import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { EventStore, RuntimeEventRow, RuntimeSignal } from './types';
import type { BreakerEventQuery, ObservationStore } from './confidence-adjuster';

/** instrumentation 写入侧 (behavioral-grounding 调 recordGroundingApplied; scheduler 调 recordTurn)。 */
export interface GroundingRecorder {
  recordGroundingApplied(sessionId: string, factIdentities: string[]): void;
  /** 每 agent_end 留一行 = drift率的分母。createdAt 可选 (测试注入确定性时间)。 */
  recordTurn(sessionId: string, createdAt?: string): void;
}

/** 整 event-store 表面 = runtime events + 升级证据查询 + grounding 归因 + observation/cooldown。 */
export type FullEventStore = Omit<EventStore, 'record'> & BreakerEventQuery & ObservationStore & GroundingRecorder & {
  /** record 接受可选 createdAt (测试注入确定性时间; 生产省略=真 now)。覆盖 EventStore.record 1-arg 签名。 */
  record(signal: RuntimeSignal, createdAt?: string): number;
};

/** SQLite `IN (?, ?, …)` 占位符 (空集返回不可命中的 `(NULL)`)。 */
function placeholders(n: number): string {
  return n === 0 ? '(NULL)' : `(${Array(n).fill('?').join(',')})`;
}

interface EventRow {
  event_id: number;
  session_id: string;
  type: string;
  payload: string;
  created_at: string;
}

function rowToRow(r: EventRow): RuntimeEventRow {
  return {
    eventId: r.event_id,
    sessionId: r.session_id,
    type: r.type,
    payload: JSON.parse(r.payload),
    createdAt: r.created_at,
  };
}

/**
 * Create a runtime event store. path default `.omd/runtime-events.db`;
 * `:memory:` or injected `db` for ephemeral/test.
 */
export function createEventStore(
  opts: { path?: string; db?: Database } = {},
): FullEventStore {
  const path = opts.path ?? '.omd/runtime-events.db';
  if (!opts.db && path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = opts.db ?? new Database(path);
  db.run('PRAGMA journal_mode = WAL');
  db.run(`
    CREATE TABLE IF NOT EXISTS runtime_events (
      event_id   INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      type       TEXT NOT NULL,
      payload    TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS runtime_watermark (
      id        INTEGER PRIMARY KEY CHECK (id = 1),
      watermark INTEGER NOT NULL DEFAULT 0
    )
  `);
  // Ensure the singleton watermark row exists.
  db.run(
    `INSERT OR IGNORE INTO runtime_watermark (id, watermark) VALUES (1, 0)`,
  );
  // grounding_applied — 每次 confident fact 被 behavioral-grounding 注入行为留痕 (熔断器 session 级归因)。
  // 刻意独立于 runtime_events: 不进 dream watermark 窗口 (它是 instrumentation 不是可学信号)。
  db.run(`
    CREATE TABLE IF NOT EXISTS grounding_applied (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id    TEXT NOT NULL,
      fact_identity TEXT NOT NULL,
      created_at    TEXT NOT NULL
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS grounding_applied_identity ON grounding_applied (fact_identity)`);
  // turns — 活动总量 = drift率的分母 (审查 B-P0-1: runtime_events 只有 drift 分子, 算不出率)。
  // 每 agent_end 留一行 → drift_rate(window) = drift_stuck 数 / turns 数。
  db.run(`
    CREATE TABLE IF NOT EXISTS turns (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
  // confidence_observations — 升级留痕 (熔断器扫) + 回滚 cooldown (防振荡) + 回滚高水位 (防同证据重升)。
  // 一行/identity: observed=0 待评, rolled_back_until 非空 = cooldown 截止, rollback_count 累计回滚次数。
  db.run(`
    CREATE TABLE IF NOT EXISTS confidence_observations (
      identity_key         TEXT NOT NULL,
      namespace            TEXT NOT NULL,
      fact_id              TEXT NOT NULL,
      upgraded_at          TEXT NOT NULL,
      before_rate          REAL NOT NULL,
      observed             INTEGER NOT NULL DEFAULT 0,
      rolled_back_until    TEXT,
      rollback_count       INTEGER NOT NULL DEFAULT 0,
      evidence_at_rollback INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (identity_key, namespace)
    )
  `);

  const ins = db.query(
    `INSERT INTO runtime_events (session_id, type, payload, created_at)
     VALUES (?, ?, ?, ?)`,
  );
  const wmGet = db.query(
    `SELECT watermark FROM runtime_watermark WHERE id = 1`,
  );
  const since = db.query(
    `SELECT * FROM runtime_events WHERE event_id > ? ORDER BY event_id ASC LIMIT ?`,
  );
  const wmSet = db.query(
    `UPDATE runtime_watermark SET watermark = ? WHERE id = 1`,
  );

  return {
    record(signal: RuntimeSignal, createdAt?: string): number {
      const at = createdAt ?? new Date().toISOString();
      const { lastInsertRowid } = ins.run(signal.sessionId, signal.type, JSON.stringify(signal.payload), at);
      return Number(lastInsertRowid);
    },

    sinceWatermark(watermark: number, limit = 50): RuntimeEventRow[] {
      return (since.all(watermark, limit) as EventRow[]).map(rowToRow);
    },

    getWatermark(): number {
      const row = wmGet.get() as { watermark: number } | undefined;
      return row?.watermark ?? 0;
    },

    setWatermark(eventId: number): void {
      wmSet.run(eventId);
    },

    // ── GroundingRecorder + turns: instrumentation 写入 ──────────────────────────
    recordGroundingApplied(sessionId: string, factIdentities: string[]): void {
      if (factIdentities.length === 0) return;
      const at = new Date().toISOString();
      const ins = db.query(`INSERT INTO grounding_applied (session_id, fact_identity, created_at) VALUES (?, ?, ?)`);
      const tx = db.transaction(() => {
        for (const id of factIdentities) ins.run(sessionId, id, at);
      });
      tx();
    },

    recordTurn(sessionId: string, createdAt?: string): void {
      db.query(`INSERT INTO turns (session_id, created_at) VALUES (?, ?)`).run(sessionId, createdAt ?? new Date().toISOString());
    },

    // ── UpgradeEventQuery / BreakerEventQuery: 证据 + drift率 归因 ─────────────────
    getSessionsForEvents(eventIds: number[]): string[] {
      if (eventIds.length === 0) return [];
      const rows = db
        .query(`SELECT DISTINCT session_id FROM runtime_events WHERE event_id IN ${placeholders(eventIds.length)}`)
        .all(...eventIds) as { session_id: string }[];
      return rows.map((r) => r.session_id);
    },

    getSessionsWhereFactActive(identity: string): string[] {
      const rows = db
        .query(`SELECT DISTINCT session_id FROM grounding_applied WHERE fact_identity = ?`)
        .all(identity) as { session_id: string }[];
      return rows.map((r) => r.session_id);
    },

    countsBefore(at: string) {
      const drift = (db
        .query(`SELECT COUNT(*) AS n FROM runtime_events WHERE type = 'drift_stuck' AND created_at <= ?`)
        .get(at) as { n: number }).n;
      const turns = (db.query(`SELECT COUNT(*) AS n FROM turns WHERE created_at <= ?`).get(at) as { n: number }).n;
      return { drift, turns };
    },

    countsInSessionsAfter(sessionIds: string[], at: string) {
      if (sessionIds.length === 0) return { drift: 0, turns: 0 };
      const ph = placeholders(sessionIds.length);
      const drift = (db
        .query(
          `SELECT COUNT(*) AS n FROM runtime_events
             WHERE type = 'drift_stuck' AND created_at > ? AND session_id IN ${ph}`,
        )
        .get(at, ...sessionIds) as { n: number }).n;
      const turns = (db
        .query(`SELECT COUNT(*) AS n FROM turns WHERE created_at > ? AND session_id IN ${ph}`)
        .get(at, ...sessionIds) as { n: number }).n;
      return { drift, turns };
    },

    // ── ObservationStore: 升级留痕 + cooldown + 回滚高水位 ────────────────────────
    recordUpgrade(rec): void {
      // ON CONFLICT 重置 observed/cooldown 让重升重入 pending, 但**保留** rollback_count/evidence_at_rollback
      // (熔断器学到的回滚历史不被重升抹掉, 审查 A-P1-1)。
      db.query(
        `INSERT INTO confidence_observations
           (identity_key, namespace, fact_id, upgraded_at, before_rate, observed, rolled_back_until)
         VALUES (?, ?, ?, ?, ?, 0, NULL)
         ON CONFLICT(identity_key, namespace) DO UPDATE SET
           fact_id = excluded.fact_id, upgraded_at = excluded.upgraded_at,
           before_rate = excluded.before_rate, observed = 0, rolled_back_until = NULL`,
      ).run(rec.identityKey, rec.namespace, rec.factId, rec.upgradedAt, rec.beforeRate);
    },

    pendingObservations() {
      const rows = db
        .query(
          `SELECT identity_key, namespace, fact_id, upgraded_at, before_rate
             FROM confidence_observations WHERE observed = 0 AND rolled_back_until IS NULL`,
        )
        .all() as { identity_key: string; namespace: string; fact_id: string; upgraded_at: string; before_rate: number }[];
      return rows.map((r) => ({
        identityKey: r.identity_key,
        namespace: r.namespace,
        factId: r.fact_id,
        upgradedAt: r.upgraded_at,
        beforeRate: r.before_rate,
      }));
    },

    markObserved(identityKey: string, namespace: string): void {
      db.query(`UPDATE confidence_observations SET observed = 1 WHERE identity_key = ? AND namespace = ?`).run(identityKey, namespace);
    },

    recordRollback(identityKey: string, namespace: string, cooldownUntil: string, evidenceAtRollback: number): void {
      db.query(
        `UPDATE confidence_observations
           SET observed = 1, rolled_back_until = ?, rollback_count = rollback_count + 1, evidence_at_rollback = ?
           WHERE identity_key = ? AND namespace = ?`,
      ).run(cooldownUntil, evidenceAtRollback, identityKey, namespace);
    },

    inCooldown(identityKey: string, namespace: string, now: string): boolean {
      const row = db
        .query(
          `SELECT rolled_back_until FROM confidence_observations
             WHERE identity_key = ? AND namespace = ? AND rolled_back_until IS NOT NULL`,
        )
        .get(identityKey, namespace) as { rolled_back_until: string } | null;
      return row != null && now < row.rolled_back_until;
    },

    rollbackInfo(identityKey: string, namespace: string) {
      const row = db
        .query(
          `SELECT rollback_count, evidence_at_rollback FROM confidence_observations
             WHERE identity_key = ? AND namespace = ? AND rollback_count > 0`,
        )
        .get(identityKey, namespace) as { rollback_count: number; evidence_at_rollback: number } | null;
      return row == null ? null : { rollbackCount: row.rollback_count, evidenceAtRollback: row.evidence_at_rollback };
    },
  };
}
