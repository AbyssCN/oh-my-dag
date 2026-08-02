/**
 * terminal-verify —— detached worker 退出前的**终态写穿核验** (S-12 的灯, 2026-08-02)。
 *
 * ## 为什么存在
 *
 * 两次 live (2026-08-02 30min goal · 2026-08-02 35min dag_run) 在终态时刻**同时**丢了
 * runs.db 的状态写穿与 dag-runs.db 的账本行: worker 内存已是终态并据此打印退出, 盘上永远
 * 停在 running, 而 persist/put 两层 lamp (console 同步) **零命中** —— 说明失效不是"写抛了
 * 异常", 是写路径整体静默失效 (根因至今 Unobserved)。对 detached run, 盘上那条就是唯一出口。
 *
 * 既然失效点在 worker 自己的长命连接上, 核验就必须用**全新的连接**读盘 —— 用同一个连接
 * 自查等于让运动员当裁判。修复同理: 新开写连接直写, 不经过可能已坏的 store 实例。
 *
 * ## 契约
 *
 * - 只在 worker 观察到内存终态之后调用; 它不判断"该不该是终态", 只判断"盘上是不是"。
 * - 不一致 → console.error 响亮标记 `[omd/terminal-verify]` + 直写修复 + 复核。
 * - 返回三态: 'consistent' (盘上已终态) · 'repaired' (不一致但修好了) · 'unrecoverable'
 *   (修复写入后复核仍不对, 或库根本打不开)。调用方按此定退出码。
 */
import { Database } from 'bun:sqlite';

export type TerminalVerifyOutcome = 'consistent' | 'repaired' | 'unrecoverable';

const TERMINAL = new Set(['done', 'failed', 'cancelled']);

/** 用全新只读连接读一个 run 的盘上状态; 库/表/行不存在 → null。 */
function readDiskStatus(dbPath: string, runId: string): string | null {
  let db: Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    const row = db.query('SELECT status FROM omd_runs WHERE run_id = ?').get(runId) as { status: string } | null;
    return row?.status ?? null;
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch { /* 关不上不值得抛 */ }
  }
}

/**
 * 核验并按需修复。`expected` 是 worker 内存里观察到的终态 (done/failed/cancelled)。
 * 非终态的 expected 直接抛 —— 调错了地方, 这不是运行时条件。
 */
export function verifyTerminalPersisted(dbPath: string, runId: string, expected: string): TerminalVerifyOutcome {
  if (!TERMINAL.has(expected)) throw new Error(`terminal-verify: expected 必须是终态, 收到 ${expected}`);

  const onDisk = readDiskStatus(dbPath, runId);
  if (onDisk !== null && TERMINAL.has(onDisk)) return 'consistent';

  console.error(
    `[omd/terminal-verify] 🔴 终态写穿丢失: runId=${runId} 内存=${expected} 盘上=${onDisk ?? '无此行/库不可读'} — ` +
      '这是 S-12 那条 (两库同丢·灯零命中) 的现场; 正在用新连接直写修复',
  );

  let db: Database | null = null;
  try {
    db = new Database(dbPath);
    // 行在 → 只补终态三列; 行不在 (连 register 都丢了) → 插一条最小行, 缺的列如实留白。
    const now = new Date().toISOString();
    if (onDisk === null) {
      db.run(
        `INSERT OR REPLACE INTO omd_runs (run_id, status, goal, meta, error, created_at, updated_at, owner_pid)
         VALUES (?, ?, '', '{}', NULL, ?, ?, NULL)`,
        [runId, expected, now, now],
      );
    } else {
      db.run(`UPDATE omd_runs SET status = ?, updated_at = ?, owner_pid = NULL WHERE run_id = ?`, [expected, now, runId]);
    }
  } catch (e) {
    console.error(`[omd/terminal-verify] 修复写入失败: ${(e as Error).message}`);
    return 'unrecoverable';
  } finally {
    try { db?.close(); } catch { /* 同上 */ }
  }

  const after = readDiskStatus(dbPath, runId);
  if (after !== null && TERMINAL.has(after)) {
    console.error(`[omd/terminal-verify] ✅ 已修复: runId=${runId} 盘上=${after}`);
    return 'repaired';
  }
  console.error(`[omd/terminal-verify] 🔴 修复后复核仍不对: 盘上=${after ?? '无'} — unrecoverable`);
  return 'unrecoverable';
}
