/**
 * test/core/hud-mirror.test.ts — HudMirror 写侧单元测试 (omd-hud 数据源)。
 *
 * 铁律验证: 原子写 (无残留 .tmp) · fail-open (坏 record 不抛) · null record 静默跳过 ·
 * OMD_DATA_HOME 未设 → 落 repoRoot/.omd/hud/dag.json · levels 透传 · goal 截 120。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HudMirror, type HudRunRecordLike } from '../../src/hud/mirror';
import type { HudDagSnapshot } from '../../src/hud/types';

const runningRecord = (): HudRunRecordLike => ({
  goal: 'ship omd-hud',
  status: 'running',
  updatedAt: '2026-07-21T10:00:00.000Z',
  progress: {
    planned: [
      { id: 'a', kind: 'leaf' },
      { id: 'b', kind: 'agent' },
    ],
    started: ['b'],
    startedAt: { b: '2026-07-21T10:00:05.000Z' },
    settled: [{ id: 'a', status: 'done', kind: 'leaf', model: 'k3' }],
  },
});

describe('HudMirror', () => {
  let repoRoot: string;
  let savedDataHome: string | undefined;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'hud-mirror-'));
    // 强制走 repoRoot 分支 (未设 OMD_DATA_HOME), 与 checkpoint-manager legacy 语义一致。
    savedDataHome = process.env.OMD_DATA_HOME;
    delete process.env.OMD_DATA_HOME;
  });

  afterEach(() => {
    if (savedDataHome === undefined) delete process.env.OMD_DATA_HOME;
    else process.env.OMD_DATA_HOME = savedDataHome;
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const readSnap = (): HudDagSnapshot =>
    JSON.parse(readFileSync(join(repoRoot, '.omd', 'hud', 'dag.json'), 'utf-8')) as HudDagSnapshot;

  test('write 落 repoRoot/.omd/hud/dag.json + 快照形状完整', () => {
    new HudMirror(repoRoot).write('run-1', runningRecord());
    const snap = readSnap();
    expect(snap.schema).toBe(1);
    expect(snap.runId).toBe('run-1');
    expect(snap.goal).toBe('ship omd-hud');
    expect(snap.status).toBe('running');
    expect(snap.updatedAt).toBe('2026-07-21T10:00:00.000Z');
    expect(snap.planned).toHaveLength(2);
    expect(snap.started).toEqual(['b']);
    expect(snap.startedAt.b).toBe('2026-07-21T10:00:05.000Z');
    expect(snap.settled[0]).toMatchObject({ id: 'a', status: 'done', kind: 'leaf', model: 'k3' });
  });

  test('levels 传入 → 快照带 topo 层级; 省略 → null', () => {
    const m = new HudMirror(repoRoot);
    m.write('run-1', runningRecord(), [['a'], ['b']]);
    expect(readSnap().levels).toEqual([['a'], ['b']]);
    m.write('run-1', runningRecord());
    expect(readSnap().levels).toBeNull();
  });

  test('原子写: dag.json 存在且无残留 .tmp', () => {
    new HudMirror(repoRoot).write('run-1', runningRecord());
    const dir = join(repoRoot, '.omd', 'hud');
    const entries = readdirSync(dir);
    expect(entries).toContain('dag.json');
    expect(entries.filter((e) => e.endsWith('.tmp'))).toHaveLength(0);
  });

  test('null record → 静默跳过 (不写不抛)', () => {
    new HudMirror(repoRoot).write('run-1', null);
    expect(existsSync(join(repoRoot, '.omd', 'hud', 'dag.json'))).toBe(false);
  });

  test('goal 截断到 120 字', () => {
    const rec = runningRecord();
    rec.goal = 'x'.repeat(300);
    new HudMirror(repoRoot).write('run-1', rec);
    expect(readSnap().goal).toHaveLength(120);
  });

  test('progress 缺失 → 空数组兜底 (刚 register 未出事件)', () => {
    new HudMirror(repoRoot).write('run-1', { goal: 'g', status: 'pending', updatedAt: '2026-07-21T10:00:00.000Z' });
    const snap = readSnap();
    expect(snap.planned).toEqual([]);
    expect(snap.started).toEqual([]);
    expect(snap.settled).toEqual([]);
  });

  test('fail-open: home 目录路径被文件占位 → 不抛 (WARN 吞掉)', () => {
    // repoRoot/.omd 写成文件 → mkdir .omd/hud 失败; mirror 必须吞掉不冒泡。
    const omdAsFile = join(repoRoot, '.omd');
    require('node:fs').writeFileSync(omdAsFile, 'not a dir', 'utf-8');
    expect(() => new HudMirror(repoRoot).write('run-1', runningRecord())).not.toThrow();
  });
});
