/**
 * test/core/hud-load.test.ts — omd-hud 读侧单测 (磁盘新鲜度闸)。
 *
 * 覆盖: 无文件→null · running 在 TTL→live · running 超 TTL→stalled · done 在 grace→finished ·
 * done 超 grace→null(收起) · schema 不符→null · fog total=0→null · mirror→load 往返一致 · 坏时戳→stalled。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DONE_GRACE_MS, RUNNING_TTL_MS, readDagView, readFog } from '../../src/hud/load';
import { HudMirror } from '../../src/hud/mirror';
import { compactFog } from '../../src/hud/fog';
import type { HudDagSnapshot } from '../../src/hud/types';

const NOW = Date.parse('2026-07-21T12:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

const baseSnap = (over: Partial<HudDagSnapshot>): HudDagSnapshot => ({
  schema: 1,
  runId: 'r1',
  goal: 'g',
  status: 'running',
  updatedAt: iso(NOW),
  levels: null,
  planned: [{ id: 'a', kind: 'leaf' }],
  started: ['a'],
  startedAt: { a: iso(NOW) },
  settled: [],
  ...over,
});

describe('readDagView — 新鲜度闸', () => {
  let cwd: string;
  let savedHome: string | undefined;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'hud-load-'));
    savedHome = process.env.OMD_DATA_HOME;
    delete process.env.OMD_DATA_HOME;
    mkdirSync(join(cwd, '.omd', 'hud'), { recursive: true });
  });
  afterEach(() => {
    if (savedHome === undefined) delete process.env.OMD_DATA_HOME;
    else process.env.OMD_DATA_HOME = savedHome;
    rmSync(cwd, { recursive: true, force: true });
  });

  const writeDag = (snap: HudDagSnapshot) => writeFileSync(join(cwd, '.omd', 'hud', 'dag.json'), JSON.stringify(snap), 'utf-8');

  test('无文件 → null', () => {
    expect(readDagView(cwd, NOW)).toBeNull();
  });

  test('running 在 TTL 内 → live', () => {
    writeDag(baseSnap({ updatedAt: iso(NOW - 5_000) }));
    expect(readDagView(cwd, NOW)?.phase).toBe('live');
  });

  test('running 超 TTL → stalled', () => {
    writeDag(baseSnap({ updatedAt: iso(NOW - RUNNING_TTL_MS - 1_000) }));
    expect(readDagView(cwd, NOW)?.phase).toBe('stalled');
  });

  test('done 在 grace 内 → finished', () => {
    writeDag(baseSnap({ status: 'done', started: [], updatedAt: iso(NOW - 3_000) }));
    expect(readDagView(cwd, NOW)?.phase).toBe('finished');
  });

  test('done 超 grace → null (收起)', () => {
    writeDag(baseSnap({ status: 'done', started: [], updatedAt: iso(NOW - DONE_GRACE_MS - 1_000) }));
    expect(readDagView(cwd, NOW)).toBeNull();
  });

  test('schema 不符 → null (前向兼容闸)', () => {
    writeDag(baseSnap({ schema: 999 }));
    expect(readDagView(cwd, NOW)).toBeNull();
  });

  test('坏时戳 → 当极旧 → stalled', () => {
    writeDag(baseSnap({ updatedAt: 'not-a-date' }));
    expect(readDagView(cwd, NOW)?.phase).toBe('stalled');
  });

  test('mirror.write → readDagView 往返一致', () => {
    new HudMirror(cwd, () => new Date(NOW)).write('r9', {
      goal: 'roundtrip',
      status: 'running',
      updatedAt: iso(NOW),
      progress: { planned: [{ id: 'x', kind: 'leaf' }], started: ['x'], startedAt: { x: iso(NOW) }, settled: [] },
    });
    const view = readDagView(cwd, NOW + 1000);
    expect(view?.phase).toBe('live');
    expect(view?.snap.runId).toBe('r9');
    expect(view?.snap.goal).toBe('roundtrip');
  });
});

describe('readFog', () => {
  let cwd: string;
  let savedHome: string | undefined;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'hud-fog-'));
    savedHome = process.env.OMD_DATA_HOME;
    delete process.env.OMD_DATA_HOME;
  });
  afterEach(() => {
    if (savedHome === undefined) delete process.env.OMD_DATA_HOME;
    else process.env.OMD_DATA_HOME = savedHome;
    rmSync(cwd, { recursive: true, force: true });
  });

  test('writeFog → readFog 往返 + bar 一致', () => {
    const map = {
      destination: 'MCP-first',
      tickets: [
        { status: 'delivered' }, { status: 'ruled' }, { status: 'open' }, { status: 'open' }, { status: 'blocked' },
      ],
    };
    new HudMirror(cwd).writeFog(compactFog(map));
    const fog = readFog(cwd);
    expect(fog?.destination).toBe('MCP-first');
    expect(fog?.ruled).toBe(2);
    expect(fog?.total).toBe(5);
    expect(fog?.bar).toHaveLength(10);
  });

  test('无 fog 文件 → null', () => {
    expect(readFog(cwd)).toBeNull();
  });

  test('total=0 → null (空图不显示)', () => {
    new HudMirror(cwd).writeFog(compactFog({ destination: 'empty', tickets: [] }));
    expect(readFog(cwd)).toBeNull();
  });
});
