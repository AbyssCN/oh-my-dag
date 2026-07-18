/**
 * src/harness/plan/session-store —— plan mode 的 **session 结晶库** (F crystallize 的跨-session 持久层)。
 *
 * 独立轻量 SQLite (mirror dag-record 模式)。crystallize 把审议态 (目标/决策/refs) 落 session-keyed 行,
 * 跨 session 可检索 → 下个 session 召回上次结论, 且喂 /handoff (session-end 取本 session 的 crystal 当原料)。
 *
 * **跟 domain OmdMemory (V2-MEM, 18 会计 namespace + SAFEGUARD reject-by-default) 分开**:
 * 那是审计级业务 fact 层, 不收 session/plan 元内容 (会被 reject); 这是 session 操作态, 两层不污染。
 */
import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface SessionRef {
  url: string;
  title?: string;
  relevance?: string;
}

export interface SessionCrystal {
  id: string;
  createdAt: number;
  /** pi session 名 (分组键, 同 session 多次 crystallize 聚一起 → 喂 handoff)。 */
  sessionId: string;
  title: string;
  goal: string;
  decisions: string[];
  refs: SessionRef[];
}

export interface SessionStore {
  /** 落一次 crystallize, 返回 id。 */
  record(c: Omit<SessionCrystal, 'id' | 'createdAt'> & { id?: string; now?: number }): string;
  /** 本 session 的全部 crystal (按时间) — /handoff 取它当 session-end 原料。 */
  bySession(sessionId: string): SessionCrystal[];
  /** 跨 session 文本检索 (title/goal/decisions LIKE) — 下个 session 召回上次结论。 */
  search(query: string, limit?: number): SessionCrystal[];
  /** 最近 N 条 (默认 50)。 */
  list(limit?: number): SessionCrystal[];
  close(): void;
}

interface Row {
  id: string;
  created_at: number;
  session_id: string;
  title: string;
  goal: string;
  decisions: string;
  refs: string;
}

function rowTo(row: Row): SessionCrystal {
  return {
    id: row.id,
    createdAt: row.created_at,
    sessionId: row.session_id,
    title: row.title,
    goal: row.goal,
    decisions: JSON.parse(row.decisions),
    refs: JSON.parse(row.refs),
  };
}

/** 造 session 结晶库。path 默认 '.omd/session-crystals.db'; ':memory:' 或注入 db = 瞬时/测试。 */
export function createSessionStore(opts: { path?: string; db?: Database } = {}): SessionStore {
  const path = opts.path ?? '.omd/session-crystals.db';
  if (!opts.db && path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = opts.db ?? new Database(path);
  db.run('PRAGMA journal_mode = WAL');
  db.run(`
    CREATE TABLE IF NOT EXISTS omd_session_crystals (
      id         TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      title      TEXT NOT NULL,
      goal       TEXT NOT NULL,
      decisions  TEXT NOT NULL,
      refs       TEXT NOT NULL
    )
  `);
  db.run('CREATE INDEX IF NOT EXISTS idx_crystals_session ON omd_session_crystals (session_id, created_at)');
  const ins = db.query(
    `INSERT INTO omd_session_crystals (id, created_at, session_id, title, goal, decisions, refs)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const bySess = db.query(`SELECT * FROM omd_session_crystals WHERE session_id = ? ORDER BY created_at ASC`);
  const like = db.query(
    `SELECT * FROM omd_session_crystals
     WHERE title LIKE ? OR goal LIKE ? OR decisions LIKE ?
     ORDER BY created_at DESC LIMIT ?`,
  );
  const recent = db.query(`SELECT * FROM omd_session_crystals ORDER BY created_at DESC LIMIT ?`);

  return {
    record(c) {
      const id = c.id ?? crypto.randomUUID();
      const createdAt = c.now ?? Date.now();
      ins.run(
        id,
        createdAt,
        c.sessionId,
        c.title,
        c.goal,
        JSON.stringify(c.decisions),
        JSON.stringify(c.refs),
      );
      return id;
    },
    bySession(sessionId) {
      return (bySess.all(sessionId) as Row[]).map(rowTo);
    },
    search(query, limit = 20) {
      const q = `%${query}%`;
      return (like.all(q, q, q, limit) as Row[]).map(rowTo);
    },
    list(limit = 50) {
      return (recent.all(limit) as Row[]).map(rowTo);
    },
    close() {
      db.close();
    },
  };
}
