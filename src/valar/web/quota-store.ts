/**
 * src/valar/web/quota-store —— per-provider 额度计数器 (轮换/失效的事实层)。
 *
 * 镜像 session-store/dag-record 的轻量 SQLite 模式 (可注入 db = 测试瞬时)。
 * 核心: 按**时间窗**(day|month) 计 provider 调用数 → Pool 据此 ① 跳过耗尽的 key
 * ② rotate 模式挑用得最少的 key (3 个 key 各自额度独立, 不共享)。
 *
 * 不存 limit (limit 是 provider 配置, 在 Pool 持有) — 这里只记 used。
 * 窗口 key 用 UTC 派生 (跨时区一致); 新窗口自动从 0 起算 (无需主动 reset)。
 */
import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type QuotaPeriod = 'day' | 'month';

export interface QuotaStore {
  /** provider 调用 +1 (当前窗口)。 */
  record(provider: string, now?: number): void;
  /** provider 当前窗口已用次数 (无记录 = 0)。 */
  used(provider: string, now?: number): number;
  close(): void;
}

/** UTC 派生窗口键: month → '2026-06', day → '2026-06-03'。 */
export function periodKey(period: QuotaPeriod, ms: number): string {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  if (period === 'month') return `${y}-${m}`;
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function createQuotaStore(
  opts: { path?: string; db?: Database; period?: QuotaPeriod } = {},
): QuotaStore {
  const period = opts.period ?? 'month';
  const path = opts.path ?? '.valar/web-quota.db';
  if (!opts.db && path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = opts.db ?? new Database(path);
  db.run('PRAGMA journal_mode = WAL');
  db.run(`
    CREATE TABLE IF NOT EXISTS valar_web_quota (
      provider   TEXT NOT NULL,
      period_key TEXT NOT NULL,
      used       INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (provider, period_key)
    )
  `);
  const inc = db.query(`
    INSERT INTO valar_web_quota (provider, period_key, used) VALUES (?, ?, 1)
    ON CONFLICT(provider, period_key) DO UPDATE SET used = used + 1
  `);
  const get = db.query(`SELECT used FROM valar_web_quota WHERE provider = ? AND period_key = ?`);

  return {
    record(provider, now = Date.now()) {
      inc.run(provider, periodKey(period, now));
    },
    used(provider, now = Date.now()) {
      const row = get.get(provider, periodKey(period, now)) as { used: number } | null;
      return row?.used ?? 0;
    },
    close() {
      db.close();
    },
  };
}
