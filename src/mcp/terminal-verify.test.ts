/**
 * terminal-verify 的可执行契约: 一致放行 · 不一致修复 · 行缺席也修 · 修不动如实报。
 * 夹具用真临时库文件 (不是 :memory:) —— 这个模块的全部意义就是"跨连接看盘上", 内存库无盘可看。
 */
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyTerminalPersisted } from './terminal-verify';

const makeDb = (): { path: string; done: () => void } => {
  const dir = mkdtempSync(join(tmpdir(), 'omd-tverify-'));
  const path = join(dir, 'runs.db');
  const db = new Database(path);
  db.run(`CREATE TABLE omd_runs (
    run_id TEXT PRIMARY KEY, status TEXT NOT NULL, goal TEXT NOT NULL, meta TEXT NOT NULL,
    error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, owner_pid INTEGER
  )`);
  db.run(`INSERT INTO omd_runs VALUES ('r1', 'running', 'g', '{}', NULL, 't0', 't0', 12345)`);
  db.close();
  return { path, done: () => rmSync(dir, { recursive: true, force: true }) };
};

const diskStatus = (path: string, runId: string): string | null => {
  const db = new Database(path, { readonly: true });
  const r = db.query('SELECT status FROM omd_runs WHERE run_id = ?').get(runId) as { status: string } | null;
  db.close();
  return r?.status ?? null;
};

describe('terminal-verify', () => {
  test('盘上已终态 → consistent, 不动任何行', () => {
    const { path, done } = makeDb();
    const db = new Database(path);
    db.run(`UPDATE omd_runs SET status='done' WHERE run_id='r1'`);
    db.close();
    expect(verifyTerminalPersisted(path, 'r1', 'done')).toBe('consistent');
    expect(diskStatus(path, 'r1')).toBe('done');
    done();
  });

  test('盘上停在 running (S-12 现场) → repaired, 行被直写成终态且 owner_pid 清空', () => {
    const { path, done } = makeDb();
    expect(verifyTerminalPersisted(path, 'r1', 'failed')).toBe('repaired');
    const db = new Database(path, { readonly: true });
    const r = db.query(`SELECT status, owner_pid FROM omd_runs WHERE run_id='r1'`).get() as { status: string; owner_pid: number | null };
    db.close();
    expect(r.status).toBe('failed');
    expect(r.owner_pid).toBeNull();
    done();
  });

  test('行整个缺席 (连 register 都丢了) → 插最小行, repaired', () => {
    const { path, done } = makeDb();
    expect(verifyTerminalPersisted(path, 'r-ghost', 'done')).toBe('repaired');
    expect(diskStatus(path, 'r-ghost')).toBe('done');
    done();
  });

  test('库不可写 (路径不存在的目录) → 重试尽后 unrecoverable, 不抛', () => {
    // ⚠ 这条同时是重试路径的网: 三次尝试全失败才判死 (瞬态失效不该一次判死, 见模块头注)。
    const t0 = Date.now();
    expect(verifyTerminalPersisted('/nonexistent-dir-omd/x.db', 'r1', 'done')).toBe('unrecoverable');
    // 两次退避 1s + 3s ⇒ 真的重试过 (不是一次就返回)。放宽下界防慢机器抖动。
    expect(Date.now() - t0).toBeGreaterThanOrEqual(3500);
  });

  test('expected 非终态 → 抛 (调用错误不是运行时条件)', () => {
    const { path, done } = makeDb();
    expect(() => verifyTerminalPersisted(path, 'r1', 'running')).toThrow();
    done();
  });
});
