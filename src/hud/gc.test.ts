/**
 * src/hud/gc.test —— 三条归档判据各自证伪一次, 外加「不该挪的不挪」的反向自检。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DONE_GRACE_MS } from './load';
import { HUD_SCHEMA } from './types';
import { STALE_RUNNING_ARCHIVE_MS, decideHudArchive, sweepHudSnapshots } from './gc';

const NOW = Date.parse('2026-09-02T12:00:00.000Z');
const iso = (agoMs: number) => new Date(NOW - agoMs).toISOString();

let cwd = '';
let hud = '';
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'omd-hud-gc-'));
  hud = join(cwd, '.omd', 'hud');
  mkdirSync(hud, { recursive: true });
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

function shard(id: string, status: string, updatedAt: string): string {
  const p = join(hud, `dag-${id.slice(0, 8)}.json`);
  writeFileSync(p, JSON.stringify({ schema: HUD_SCHEMA, runId: id, goal: 'g', status, updatedAt, levels: null, planned: [], started: [], startedAt: {}, settled: [] }));
  return p;
}

describe('decideHudArchive · 三条判据', () => {
  const opts = { terminalRunIds: new Set(['dead-run']) };
  test('终态且超收起窗 → finished-expired; 窗内 → 留', () => {
    expect(decideHudArchive({ runId: 'a', status: 'done', updatedAt: iso(DONE_GRACE_MS + 1) }, NOW, opts)).toBe('finished-expired');
    expect(decideHudArchive({ runId: 'a', status: 'failed', updatedAt: iso(DONE_GRACE_MS - 1) }, NOW, opts)).toBeNull();
  });
  test('running 但 runs.db 已终态 → running-but-run-terminal (不看年龄)', () => {
    expect(decideHudArchive({ runId: 'dead-run', status: 'running', updatedAt: iso(1_000) }, NOW, opts)).toBe('running-but-run-terminal');
  });
  test('running 不在终态表, 超 24h → running-stale; 未超 → 留 (活 run 不许被挪)', () => {
    expect(decideHudArchive({ runId: 'x', status: 'running', updatedAt: iso(STALE_RUNNING_ARCHIVE_MS + 1) }, NOW, opts)).toBe('running-stale');
    expect(decideHudArchive({ runId: 'x', status: 'pending', updatedAt: iso(STALE_RUNNING_ARCHIVE_MS - 1) }, NOW, opts)).toBeNull();
    expect(decideHudArchive({ runId: 'x', status: 'running', updatedAt: iso(5_000) }, NOW, opts)).toBeNull();
  });
  test('坏时戳当极旧', () => {
    expect(decideHudArchive({ runId: 'x', status: 'running', updatedAt: 'not-a-date' }, NOW, opts)).toBe('running-stale');
  });
});

describe('sweepHudSnapshots · 真挪文件', () => {
  test('命中的进 archive/, 活的留在顶层; dag.json 不碰', () => {
    const live = shard('live-run-0001', 'running', iso(2_000));
    const zombie = shard('dead-run-0001', 'running', iso(3600_000));
    const old = shard('doneold1-0001', 'done', iso(DONE_GRACE_MS * 2));
    const fresh = shard('donenew1-0002', 'failed', iso(1_000));
    const statusline = join(hud, 'dag.json');
    writeFileSync(statusline, '{"schema":1,"runId":"dead-run-0001","status":"running"}');

    const r = sweepHudSnapshots(cwd, NOW, { terminalRunIds: new Set(['dead-run-0001']) });
    expect(r.scanned).toBe(4);
    expect(r.failed).toEqual([]);
    expect(r.archived.map((a) => a.reason).sort()).toEqual(['finished-expired', 'running-but-run-terminal']);
    expect(existsSync(live)).toBe(true);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(statusline)).toBe(true);
    expect(existsSync(zombie)).toBe(false);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(join(hud, 'archive', 'dag-dead-run.json'))).toBe(true);
    expect(existsSync(join(hud, 'archive', 'dag-doneold1.json'))).toBe(true);
  });
  test('dryRun 只判不挪', () => {
    const zombie = shard('dead-run-0001', 'running', iso(3600_000));
    const r = sweepHudSnapshots(cwd, NOW, { terminalRunIds: new Set(['dead-run-0001']), dryRun: true });
    expect(r.archived).toHaveLength(1);
    expect(existsSync(zombie)).toBe(true);
  });
  test('坏 JSON / 未知 schema 跳过不崩', () => {
    writeFileSync(join(hud, 'dag-bad.json'), '{half');
    writeFileSync(join(hud, 'dag-v9.json'), JSON.stringify({ schema: 99, runId: 'v9', status: 'running', updatedAt: iso(0) }));
    const r = sweepHudSnapshots(cwd, NOW, { terminalRunIds: new Set() });
    expect(r.scanned).toBe(0);
    expect(r.archived).toEqual([]);
  });
});
