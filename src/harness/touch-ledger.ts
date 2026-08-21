/**
 * src/harness/touch-ledger —— SDD S3「碰撞台账」写入面 (docs/plan/2026-08-09-claude-驱动-omd-conductor-远程指挥接缝-执行契约-sdd.md §1-S3)。
 *
 * **只记不拦, 第一刀**: 台账只负责把「谁在哪个工作根碰过哪个文件」记下来, 不做拦截、不做读侧
 * hash 校验、不做跨进程判断。碰撞的**发现** (crossSessionPairs / findings) 是查询面, 提示送达是
 * 后面的刀 (本文件不碰)。
 *
 * 锚定纪律 (总账 §3.6 / §6.1): 库文件落**触碰发生的工作根**的 `.omd/touch.db` (gitignored), 路径列存
 * **绝对路径**。worktree 各写各的 `.omd/touch.db`, **不**走 repo-root 的 worktree→主仓归并 —— 隔离档下
 * 两个 worktree 各写各的不算撞。
 *
 * 存储: bun:sqlite + WAL, 风格照 plan-ledger.ts。台账是可重建投影, 写失败一律 fail-open (warn 留痕),
 * 绝不让调用方 (工具出口) 因此失败。
 *
 * NULL≠0 纪律: `hash` 没算 = NULL, 与空串 hash 是两回事 —— 空串表示「算过, 是空内容的 hash」,
 * NULL 表示「没算」。查询侧区分两者, 不许把 NULL 落成 ''。
 */
import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { isAbsolute, join, normalize, resolve } from 'node:path';
import { logger } from './logger';

/** 触碰操作。read = 读侧证据 (hash 校验是后面刀, 现在只记); write = 碰撞判据里「至少一侧」的那一侧。 */
export type TouchOp = 'read' | 'write';

/**
 * 证据档位 (⑧.6 同一条纪律, 两档分列不合并):
 * - strict: 受控写工具 (write/edit) 的**事实**档 —— 我们知道内容, hash = sha256(写入内容)。
 * - inferred: bash 写嗅探的**推断**档 —— 只是「疑似写了」, hash 恒 NULL。
 * - cli: 命令行手动写面 (omd touch), 调用方自己说写了什么。
 */
export type TouchSource = 'strict' | 'inferred' | 'cli';

export interface RecordTouchInput {
  /** 文件路径: 相对路径对 root 解析成绝对; 绝对路径原样 (normalize) 落库。 */
  path: string;
  /** 会话标识 (runId 或 runId+节点维度内稳定的会话 id)。 */
  session: string;
  op: TouchOp;
  /** sha256 hex; 没算 → 省略 (落 NULL, 不是空串 —— NULL≠0 纪律)。 */
  hash?: string | null;
  /** 证据档位, 默认 'strict'。 */
  source?: TouchSource;
}

export interface CrossSessionPair {
  absPath: string;
  sessionA: string;
  sessionB: string;
  /** pair 里存在 source='strict' 的证据 (两档分开报, 不合并成一个数)。 */
  strict: boolean;
  /** pair 里存在 source='inferred' 的证据。 */
  inferred: boolean;
  /** 该 pair 最近一次触碰的 ts (ms)。 */
  lastTs: number;
}

export interface TouchFinding {
  absPath: string;
  /** 触碰过该文件的 session 数 (含只读的)。 */
  sessions: number;
  /** 写过该文件的 session 数 (≥1 才进 findings)。 */
  writeSessions: number;
  strictWrites: number;
  inferredWrites: number;
  firstTs: number;
  lastTs: number;
}

export interface TouchLedger {
  /** 记一笔触碰。相对路径对 root 解析成绝对。fail-open: 写失败 warn 留痕, 不抛。 */
  recordTouch(input: RecordTouchInput): void;
  /** 碰撞 pair: 同 abs_path、≥2 个不同 session、至少一侧 op='write'; strict/inferred 分两列。 */
  crossSessionPairs(): CrossSessionPair[];
  /** write 参与的碰撞发现 (按 abs_path 聚合), 与 pairs 分开读。 */
  findings(): TouchFinding[];
  /** TTL 清理: 过期行删除 + 证据 (warn 日志 + prunes 摘要记录)。返清理条数。 */
  pruneExpired(opts?: { ttlMs?: number; now?: number }): number;
  close(): void;
}

// ---------------------------------------------------------------------------
// 纯函数 (导出可测, db 注入) — ledger 方法只是把 db 绑进去的薄壳
// ---------------------------------------------------------------------------

/**
 * 落一笔触碰。`root` 给定时相对路径对它解析; 不给 (测试注入 db) 时相对路径对 cwd 解析。
 * **fail-open 不吞证据**: 任何写失败 → logger.warn 带原因, 调用方照常返回。
 */
export function recordTouch(db: Database, input: RecordTouchInput & { root?: string }): void {
  const absPath = isAbsolute(input.path) ? normalize(input.path) : resolve(input.root ?? process.cwd(), input.path);
  try {
    db.query('INSERT INTO touches (abs_path, session, op, hash, source, ts) VALUES (?, ?, ?, ?, ?, ?)').run(
      absPath, input.session, input.op, input.hash ?? null, input.source ?? 'strict', Date.now(),
    );
  } catch (e) {
    // 台账写失败不许扰动工具调用主路径; 但证据不许吞 —— warn 带原因。
    logger.warn({ err: (e as Error).message, absPath, session: input.session, op: input.op }, '[omd/touch-ledger] recordTouch 失败 (fail-open)');
  }
}

/**
 * 碰撞 pair: 同一 abs_path、≥2 个不同 session、**至少一侧 op='write'** 的 pair。
 * strict 与 inferred 分两列报, 绝不合并 (⑧.6): 同一 pair 两边证据都有 → 两列都为 true,
 * 但不会折成一个「不知道哪档」的数。read-read 永不进 pair (WHERE 里 write 过滤)。
 */
export function crossSessionPairs(db: Database): CrossSessionPair[] {
  const rows = db
    .query(
      `SELECT t1.abs_path AS abs_path,
              min(t1.session, t2.session) AS session_a,
              max(t1.session, t2.session) AS session_b,
              max(CASE WHEN t1.source = 'strict' OR t2.source = 'strict' THEN 1 ELSE 0 END) AS strict,
              max(CASE WHEN t1.source = 'inferred' OR t2.source = 'inferred' THEN 1 ELSE 0 END) AS inferred,
              max(max(t1.ts, t2.ts)) AS last_ts
       FROM touches t1 JOIN touches t2
         ON t1.abs_path = t2.abs_path AND t1.session <> t2.session
       WHERE t1.op = 'write' OR t2.op = 'write'
       GROUP BY t1.abs_path, session_a, session_b`,
    )
    .all() as Array<{ abs_path: string; session_a: string; session_b: string; strict: number; inferred: number; last_ts: number }>;
  return rows.map((r) => ({
    absPath: r.abs_path, sessionA: r.session_a, sessionB: r.session_b,
    strict: r.strict === 1, inferred: r.inferred === 1, lastTs: r.last_ts,
  }));
}

/**
 * write 参与的碰撞发现 (按 abs_path 聚合, 与 pairs 分开读): 被 ≥2 个 session 触碰过且至少一个写过。
 * 给「提示送达」那刀当数据源; 本文件只负责产出, 不送达。
 */
export function findings(db: Database): TouchFinding[] {
  const rows = db
    .query(
      `SELECT abs_path,
              count(DISTINCT session) AS sessions,
              count(DISTINCT CASE WHEN op = 'write' THEN session END) AS write_sessions,
              sum(CASE WHEN op = 'write' AND source = 'strict' THEN 1 ELSE 0 END) AS strict_writes,
              sum(CASE WHEN op = 'write' AND source = 'inferred' THEN 1 ELSE 0 END) AS inferred_writes,
              min(ts) AS first_ts,
              max(ts) AS last_ts
       FROM touches
       GROUP BY abs_path
       HAVING count(DISTINCT session) >= 2 AND count(DISTINCT CASE WHEN op = 'write' THEN session END) >= 1`,
    )
    .all() as Array<{ abs_path: string; sessions: number; write_sessions: number; strict_writes: number; inferred_writes: number; first_ts: number; last_ts: number }>;
  return rows.map((r) => ({
    absPath: r.abs_path, sessions: r.sessions, writeSessions: r.write_sessions,
    strictWrites: r.strict_writes, inferredWrites: r.inferred_writes,
    firstTs: r.first_ts, lastTs: r.last_ts,
  }));
}

/** TTL 默认 7 天 (tentative —— SDD §1-S3 没给数值, 先钉 7 天, 按碰撞检测实际召回率再调)。 */
const DEFAULT_PRUNE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * TTL 清理。照 session-lock.ts 先例「过期 ≠ 没记」: 清理必须留证据 ——
 * ① logger.warn 带清理条数与依据 (ts 超过 now-ttl 多少) ② 库里 prunes 表留一条摘要记录。
 * 不许静默 DELETE。返清理条数。
 */
export function pruneExpired(opts: { db: Database; ttlMs?: number; now?: number }): number {
  const { db } = opts;
  const now = opts.now ?? Date.now();
  const ttlMs = opts.ttlMs ?? DEFAULT_PRUNE_TTL_MS;
  const cutoff = now - ttlMs;
  // INV-8: 数一遍再删再记 = check-then-write。裸着跑, 两个进程会各自读到同一个 doomed,
  // 各删各的 (第二个删到 0 条) 而 prunes 表落**两条**摘要 —— 台账把一次清理记成两次。
  // 所以 SELECT 与两条写必须同在 BEGIN IMMEDIATE 里 (先拿写锁再读)。
  let doomed = 0;
  db.transaction(() => {
    doomed = (db.query('SELECT count(*) AS n FROM touches WHERE ts < ?').get(cutoff) as { n: number }).n;
    if (doomed > 0) {
      db.query('DELETE FROM touches WHERE ts < ?').run(cutoff);
      db.query('INSERT INTO prunes (ts, pruned, ttl_ms, reason) VALUES (?, ?, ?, ?)').run(
        now, doomed, ttlMs, `ts < ${cutoff} (超过 TTL ${ttlMs}ms)`,
      );
    }
  }).immediate();
  // 留证在事务外 —— 日志是副作用, 不该跟着回滚重放。
  if (doomed > 0) {
    logger.warn(
      { pruned: doomed, ttlMs, cutoff, 依据: `ts < ${cutoff} (now ${now} - ttl ${ttlMs}ms)` },
      '[omd/touch-ledger] pruneExpired 清理过期 touch 记录',
    );
  }
  return doomed;
}

// ---------------------------------------------------------------------------
// ledger
// ---------------------------------------------------------------------------

export interface OpenTouchLedgerOpts {
  /**
   * 触碰发生的工作根。给 root → 库文件落 <root>/.omd/touch.db (目录自动建)。
   * 锚定纪律: 库锚在**触碰发生的工作根**, 不是主仓根 (隔离档下 worktree 各写各的)。
   */
  root?: string;
  /** 注入 db (测试 ':memory:')。给 db 时 root 只用于相对路径解析, 不建文件。 */
  db?: Database;
}

export function openTouchLedger(opts: OpenTouchLedgerOpts = {}): TouchLedger {
  const root = opts.root;
  const db =
    opts.db ??
    (() => {
      if (!root) throw new Error('openTouchLedger 需要 root 或 db 之一');
      const dir = join(root, '.omd');
      mkdirSync(dir, { recursive: true });
      return new Database(join(dir, 'touch.db'));
    })();
  db.run('PRAGMA busy_timeout = 20000');
  db.run('PRAGMA journal_mode = WAL');
  db.run(`
    CREATE TABLE IF NOT EXISTS touches (
      abs_path TEXT NOT NULL,
      session TEXT NOT NULL,
      op TEXT NOT NULL,        -- 'read' | 'write'
      hash TEXT,               -- NULL = 没算 hash (≠ 空串), NULL≠0 纪律
      source TEXT NOT NULL,    -- 'strict' | 'inferred' | 'cli'
      ts INTEGER NOT NULL      -- ms epoch
    )
  `);
  db.run('CREATE INDEX IF NOT EXISTS idx_touches_path ON touches(abs_path, session)');
  db.run(`
    CREATE TABLE IF NOT EXISTS prunes (
      ts INTEGER NOT NULL,
      pruned INTEGER NOT NULL,
      ttl_ms INTEGER NOT NULL,
      reason TEXT NOT NULL
    )
  `);

  return {
    recordTouch(input) {
      recordTouch(db, { ...input, root });
    },
    crossSessionPairs() {
      return crossSessionPairs(db);
    },
    findings() {
      return findings(db);
    },
    pruneExpired(inner) {
      return pruneExpired({ db, ...inner });
    },
    close() {
      db.close();
    },
  };
}
