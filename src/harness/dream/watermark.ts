/**
 * src/harness/dream/watermark —— dream SDD §S1 dirty 水位。
 *
 * memory.db 同库加表 `dream_watermark`(裁决 4:不是 JSON 文件、不是 fact)。
 * 用**列结构**表达三态(坑 #1:不许用魔法值抹平):
 *
 * | 态 | 存法 | 互斥可区分 |
 * |---|---|---|
 * | 缺 key | 行不存在 | `get(key) === null` |
 * | clean | `skipped=0, dirty=0` | `{ lastCursor, dirty:0, skipped:false }` |
 * | dirty(瞬态) | `skipped=0, dirty>0` | `{ lastCursor, dirty:N, skipped:false }` |
 * | skip | `skipped=1` | `{ skipped:true, skipReason }` |
 *
 * 库路径解析走 `resolveMemoryDbPath`(harness/memory/db-path.ts,与 assemble.ts
 * createDefaultMemory 同一解析点)—— 不新写路径解析。
 */
import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { resolveMemoryDbPath } from '../memory/db-path';

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 水位三态(互斥可区分,见文件头表)。 */
export type WatermarkState =
  | { lastCursor: string; dirty: number; skipped: false }
  | { skipped: true; skipReason: string };

export interface Watermark {
  /**
   * 取一个 source key 的水位。
   * - null → 从未固化过(行不存在)
   * - { lastCursor, dirty, skipped:false } → 有游标(dirty=0 = clean)
   * - { skipped:true, skipReason } → 显式排除
   */
  get(key: string): WatermarkState | null;

  /** 记 clean 态(游标推进,dirty 归零,skipped=0)。 */
  setClean(key: string, cursor: string): void;

  /** 记 dirty 态(游标推进,带脏计数,skipped=0)。 */
  setDirty(key: string, cursor: string, dirty: number): void;

  /** 记 skip 态(显式排除,带理由)。 */
  skip(key: string, reason: string): void;

  /** 删一条水位(测试用)。 */
  delete(key: string): void;

  close(): void;
}

// ---------------------------------------------------------------------------
// 工厂
// ---------------------------------------------------------------------------

export interface WatermarkOpts {
  /**
   * db 文件路径。默认 = `process.env.OMD_MEMORY_PATH ?? '.omd/memory.db'`
   * (与 createDefaultMemory 同一条路,不新写路径解析)。
   */
  path?: string;
  /** 注入 db(测试 `:memory:`)。给了就忽略 path。 */
  db?: Database;
}

export function createWatermark(opts: WatermarkOpts = {}): Watermark {
  const path = opts.path ?? resolveMemoryDbPath();
  if (!opts.db && path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = opts.db ?? new Database(path);
  db.run('PRAGMA journal_mode = WAL');

  db.run(`
    CREATE TABLE IF NOT EXISTS dream_watermark (
      source_key  TEXT PRIMARY KEY,
      last_cursor TEXT NOT NULL DEFAULT '',
      dirty       INTEGER NOT NULL DEFAULT 0,
      skipped     INTEGER NOT NULL DEFAULT 0,
      skip_reason TEXT NOT NULL DEFAULT '',
      updated_at  TEXT NOT NULL DEFAULT ''
    )
  `);

  const qGet = db.query(
    'SELECT last_cursor, dirty, skipped, skip_reason FROM dream_watermark WHERE source_key = ?',
  );
  const qUpsert = db.query(`
    INSERT INTO dream_watermark (source_key, last_cursor, dirty, skipped, skip_reason, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_key) DO UPDATE SET
      last_cursor = excluded.last_cursor,
      dirty       = excluded.dirty,
      skipped     = excluded.skipped,
      skip_reason = excluded.skip_reason,
      updated_at  = excluded.updated_at
  `);
  const qDelete = db.query('DELETE FROM dream_watermark WHERE source_key = ?');

  return {
    get(key) {
      const row = qGet.get(key) as {
        last_cursor: string;
        dirty: number;
        skipped: number;
        skip_reason: string;
      } | null;
      if (!row) return null;
      if (row.skipped) {
        return { skipped: true as const, skipReason: row.skip_reason };
      }
      return { lastCursor: row.last_cursor, dirty: row.dirty, skipped: false as const };
    },

    setClean(key, cursor) {
      qUpsert.run(key, cursor, 0, 0, '', new Date().toISOString());
    },

    setDirty(key, cursor, dirty) {
      qUpsert.run(key, cursor, dirty, 0, '', new Date().toISOString());
    },

    skip(key, reason) {
      qUpsert.run(key, '', 0, 1, reason, new Date().toISOString());
    },

    delete(key) {
      qDelete.run(key);
    },

    close() {
      db.close();
    },
  };
}
