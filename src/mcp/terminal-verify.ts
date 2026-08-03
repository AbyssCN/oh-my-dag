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

/**
 * 修复重试 (2026-08-03 灯的第一次 live 抓到的读数): t5a 那次修复写入报的是 **`disk I/O error`**,
 * 而**同一个库 40 秒后手工写入成功**(integrity_check ok · 盘 32% · inode 9%)——
 * 也就是说这一族失效是**瞬态**的,一次性判 `unrecoverable` 会把本可救回的终态白白丢掉。
 *
 * 头号嫌疑是同文件上并发连接的 WAL/shm 生命周期竞争(那次现场:`-wal` 已被截到 0 而
 * worker 仍在跑,`-shm` 还在被改)。**不去猜具体机理**——重试是不依赖机理也成立的做法。
 * 间隔取秒级:竞争窗口是"另一个连接正在 checkpoint/关闭"的量级,毫秒级重试打不出窗口。
 */
const REPAIR_ATTEMPTS = 3;
const REPAIR_BACKOFF_MS = [1000, 3000];

/** 同步睡眠 (worker 退出路径上不引入异步:调用方是同步的,而这里最多等 4 秒)。 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * 一次盘上读的三种结局。**分开是刚需, 不是洁癖** (2026-08-03 第二次复现付的学费):
 * 「行不在」指向写路径, 「库读不了」指向并发/文件系统 —— **诊断方向相反**。
 *
 * 原实现两者都返回 `null`, 且 `catch` 是空的 (异常连同它的消息一起丢掉),
 * 报错行只好印成 `无此行/库不可读` 这样一句带斜杠的话。
 * ⚠ **那正是 S-12 自己的形状** —— 这盏灯是为抓「fail-open 吞掉的不是异常是证据」而建的,
 * 而它在读盘这一步吞掉了唯一能定方向的那条证据。
 *
 * t9b-6008b42 那次现场: 事后查 `omd_runs` 里**行在**(status=running, 属主 pid 已死),
 * 库也读得动 —— 所以当时的 `null` 只可能来自**读失败**。那条被扔掉的异常就是全部诊断。
 */
type DiskRead =
  | { kind: 'row'; status: string }
  | { kind: 'no-row' }
  | { kind: 'unreadable'; error: string };

/** 用全新只读连接读一个 run 的盘上状态。 */
function readDiskStatus(dbPath: string, runId: string): DiskRead {
  let db: Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    const row = db.query('SELECT status FROM omd_runs WHERE run_id = ?').get(runId) as { status: string } | null;
    return row ? { kind: 'row', status: row.status } : { kind: 'no-row' };
  } catch (e) {
    return { kind: 'unreadable', error: e instanceof Error ? e.message : String(e) };
  } finally {
    try { db?.close(); } catch { /* 关不上不值得抛 */ }
  }
}

/** 报错行里那一格 —— 三种结局各说各的, 不再压成一个 null。 */
function describeDiskRead(r: DiskRead): string {
  if (r.kind === 'row') return r.status;
  if (r.kind === 'no-row') return '无此行 (库读得动, 指向写路径)';
  return `库读不了: ${r.error} (指向并发/文件系统, 不是写路径)`;
}

/**
 * 核验并按需修复。`expected` 是 worker 内存里观察到的终态 (done/failed/cancelled)。
 * 非终态的 expected 直接抛 —— 调错了地方, 这不是运行时条件。
 */
export function verifyTerminalPersisted(dbPath: string, runId: string, expected: string): TerminalVerifyOutcome {
  if (!TERMINAL.has(expected)) throw new Error(`terminal-verify: expected 必须是终态, 收到 ${expected}`);

  const onDisk = readDiskStatus(dbPath, runId);
  if (onDisk.kind === 'row' && TERMINAL.has(onDisk.status)) return 'consistent';

  console.error(
    `[omd/terminal-verify] 🔴 终态写穿丢失: runId=${runId} 内存=${expected} 盘上=${describeDiskRead(onDisk)} — ` +
      '这是 S-12 那条 (两库同丢·灯零命中) 的现场; 正在用新连接直写修复',
  );

  // 重试而不是一次判死: 这一族失效实测是瞬态的 (见 REPAIR_ATTEMPTS 的注)。
  // 每次都**新开连接** —— 上一次失败的那个连接本身可能就是坏的那个。
  let lastErr = '';
  for (let attempt = 1; attempt <= REPAIR_ATTEMPTS; attempt++) {
    let db: Database | null = null;
    try {
      db = new Database(dbPath);
      // 行在 → 只补终态三列; 行不在 (连 register 都丢了) → 插一条最小行, 缺的列如实留白。
      //
      // ⚠ 一条 upsert 而不是「先读再二选一」(2026-08-03): 原实现按上面那次读的结果分支,
      // 而那次读**可能是失败的**——读不到不等于行不在。旧写法在读失败时走 `INSERT OR REPLACE`,
      // 于是一条真行的 goal/meta/created_at 会被空值覆盖掉。upsert 在两种情形下都对,
      // 且不依赖"上一次读是准的"这个前提。
      const now = new Date().toISOString();
      db.run(
        `INSERT INTO omd_runs (run_id, status, goal, meta, error, created_at, updated_at, owner_pid)
         VALUES (?, ?, '', '{}', NULL, ?, ?, NULL)
         ON CONFLICT(run_id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at, owner_pid = NULL`,
        [runId, expected, now, now],
      );
      lastErr = '';
      break;
    } catch (e) {
      lastErr = (e as Error).message;
      const wait = REPAIR_BACKOFF_MS[attempt - 1];
      console.error(
        `[omd/terminal-verify] 修复写入失败 (第 ${attempt}/${REPAIR_ATTEMPTS} 次): ${lastErr}` +
          (wait === undefined ? '' : ` — ${wait}ms 后重试`),
      );
      if (wait !== undefined) sleepSync(wait);
    } finally {
      try { db?.close(); } catch { /* 同上 */ }
    }
  }
  if (lastErr) return 'unrecoverable';

  const after = readDiskStatus(dbPath, runId);
  if (after.kind === 'row' && TERMINAL.has(after.status)) {
    console.error(`[omd/terminal-verify] ✅ 已修复: runId=${runId} 盘上=${after.status}`);
    return 'repaired';
  }
  console.error(`[omd/terminal-verify] 🔴 修复后复核仍不对: 盘上=${describeDiskRead(after)} — unrecoverable`);
  return 'unrecoverable';
}
