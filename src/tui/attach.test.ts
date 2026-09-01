/**
 * src/tui/attach.test.ts —— **外部 run 附身通道的读侧契约**(SDD 202D 片 1 TEST)。
 *
 * 真源:`docs/plan/2026-09-01-实现-pathfinder-票-t-tui-attach-外部-run-附身-tui-上一发-1.md`。
 *
 * ## 纪律
 *
 * - value-import `./dag-hud-attach`(`import type` 绿测试什么都不证)。
 * - 不动既有文件,绝不动实装/接线。
 * - **每个接触 `createExternalRunChannel` 的测试都用 `try { ... } finally { dispose() }`** —
 *   通道内部可能持 interval / fs watcher;漏 dispose Bun 不会退出。
 *
 * ## 反向自检锚(SDD §反向自检 #2,本片不许改)
 *
 * - 哨兵行:`export const ATTACH_SUITE_MARKER = 't-tui-attach-r2';`
 */

/* ─── 哨兵行(SDD 反向自检锚)─── */
export const ATTACH_SUITE_MARKER = 't-tui-attach-r2';

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createExternalRunChannel,
  mergePlannedDeps,
  selectExternalRun,
} from './dag-hud-attach';
import type { DagView } from '../hud/load';
import { DONE_GRACE_MS, RUNNING_TTL_MS, readDagShard } from '../hud/load';
import { HUD_SCHEMA, type HudDagSnapshot } from '../hud/types';
import { DagHud } from './components/dag-hud';
import { DagTree } from './components/dag-tree';
import { createTheme } from './theme';

const theme = createTheme({ color: false });

const RUN_A = 'aaaaaaaa-1111-2222-3333-444444444444';
const RUN_B = 'bbbbbbbb-1111-2222-3333-444444444444';
const NOW_T0 = 1_700_000_000_000;
const TICK_MS = 1000;

const dirs: string[] = [];
const freshRoot = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'omd-attach-r2-'));
  dirs.push(d);
  return d;
};
beforeEach(() => {
  delete process.env.OMD_DATA_HOME;
});
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const narrowSnap = (over: Partial<HudDagSnapshot> = {}): HudDagSnapshot => ({
  schema: HUD_SCHEMA,
  runId: RUN_A,
  goal: 'g',
  status: 'running',
  updatedAt: new Date(0).toISOString(),
  levels: null,
  planned: [{ id: 'p1', kind: 'agent' }],
  started: [],
  startedAt: {},
  settled: [],
  ...over,
});

const writeShard = (root: string, runId: string, s: HudDagSnapshot): void => {
  const hudDir = join(root, '.omd', 'hud');
  if (!existsSync(hudDir)) mkdirSync(hudDir, { recursive: true });
  writeFileSync(join(hudDir, `dag-${runId.slice(0, 8)}.json`), JSON.stringify(s), 'utf-8');
};

const writeRaw = (root: string, file: string, body: string): void => {
  const hudDir = join(root, '.omd', 'hud');
  mkdirSync(hudDir, { recursive: true });
  writeFileSync(join(hudDir, file), body, 'utf-8');
};

const asView = (snap: HudDagSnapshot, phase: DagView['phase'] = 'live'): DagView => ({
  snap,
  phase,
  ageMs: 0,
});

type Bundle = {
  hud: DagHud;
  tree: DagTree;
  render: { calls: number };
  now: { t: number };
  tick: () => void;
  bound: () => boolean;
  dispose: () => void;
};

const mkChannel = (opts: {
  cwd: string;
  runId: string;
  readShard?: (cwd: string, runId: string, nowMs: number) => DagView | null;
}): Bundle => {
  const hud = new DagHud(theme, () => 'fake:con');
  const tree = new DagTree(theme, () => NOW_T0);
  const render = { calls: 0 };
  const now = { t: NOW_T0 };
  const channel = createExternalRunChannel({
    cwd: opts.cwd,
    runId: opts.runId,
    hud,
    tree,
    now: () => now.t,
    requestRender: () => {
      render.calls++;
    },
    ...(opts.readShard ? { readShard: opts.readShard } : {}),
  });
  return {
    hud,
    tree,
    render,
    now,
    tick: () => channel.tick(),
    bound: () => channel.bound(),
    dispose: () => channel.dispose(),
  };
};

/* ─── L1 · 纯函数(零组件,零 fs)─── */

describe('★ L1 selectExternalRun', () => {
  const vA = asView(narrowSnap({ runId: RUN_A, goal: 'A' }));
  const vB = asView(narrowSnap({ runId: RUN_B, goal: 'B' }));
  const views = [vA, vB];

  test('命中 → views[index].snap.runId', () => {
    expect(selectExternalRun(views, 0)).toBe(RUN_A);
    expect(selectExternalRun(views, 1)).toBe(RUN_B);
  });

  test('越界 / 负 / 空 → null', () => {
    expect(selectExternalRun(views, -1)).toBeNull();
    expect(selectExternalRun(views, 2)).toBeNull();
    expect(selectExternalRun([], 0)).toBeNull();
  });
});

describe('★ L1 mergePlannedDeps', () => {
  type Planned = HudDagSnapshot['planned'][number];
  const findById = (id: string) => (x: Planned) => x.id === id;

  test('null meta → 入参原样, 不抛', () => {
    const snap: HudDagSnapshot = narrowSnap({
      planned: [
        { id: 'A', kind: 'agent' },
        { id: 'B', kind: 'agent', deps: ['A'] },
      ],
    });
    const out = mergePlannedDeps(snap, null);
    expect(out).toBe(snap);
    expect(out.planned.find(findById('A'))?.deps).toBeUndefined();
    expect(out.planned.find(findById('B'))?.deps).toEqual(['A']);
  });

  test('缺席 deps 被填上;已带 deps 原样;不污染入参', () => {
    const snap: HudDagSnapshot = narrowSnap({
      planned: [
        { id: 'B', kind: 'agent' },
        { id: 'C', kind: 'agent' },
        { id: 'X', kind: 'agent', deps: ['Z'] },
      ],
    });
    const out = mergePlannedDeps(snap, { deps: { B: ['A'], C: ['A'] } });
    expect(out).not.toBe(snap);
    expect(out.planned.find(findById('B'))?.deps).toEqual(['A']);
    expect(out.planned.find(findById('C'))?.deps).toEqual(['A']);
    expect(out.planned.find(findById('X'))?.deps).toEqual(['Z']);
    expect(snap.planned[0]!.deps).toBeUndefined();
    expect(snap.planned[1]!.deps).toBeUndefined();
  });
});

/* ─── L2 · 通道状态机(每测 try/finally dispose, 不留句柄)─── */

describe('★ L2 AC-2 状态推进:tick 一拍 → hud/tree 跟进', () => {
  test('v1 → tick(hud.size=3);v2 → tick(2 done + 1 running)', () => {
    const root = freshRoot();
    writeShard(root, RUN_A, narrowSnap({
      runId: RUN_A,
      planned: [
        { id: 'A', kind: 'agent' },
        { id: 'B', kind: 'agent' },
        { id: 'C', kind: 'agent' },
      ],
      settled: [{ id: 'A', status: 'done', kind: 'agent' }],
      started: ['B'],
      startedAt: { B: new Date(NOW_T0).toISOString() },
      updatedAt: new Date(NOW_T0).toISOString(),
    }));
    const b = mkChannel({ cwd: root, runId: RUN_A });
    try {
      b.tick();
      expect(b.bound()).toBe(true);
      expect(b.hud.size).toBe(3);
      const snap = b.tree.snapshot();
      const byId = new Map(snap.nodes.map((n) => [n.id, n]));
      expect(byId.get('A')?.status).toBe('done');
      expect(byId.get('B')?.status).toBe('running');
      expect(byId.get('C')?.status).toBe('pending');

      writeShard(root, RUN_A, narrowSnap({
        runId: RUN_A,
        planned: [
          { id: 'A', kind: 'agent' },
          { id: 'B', kind: 'agent' },
          { id: 'C', kind: 'agent' },
        ],
        settled: [
          { id: 'A', status: 'done', kind: 'agent' },
          { id: 'B', status: 'done', kind: 'agent' },
        ],
        started: ['C'],
        startedAt: { C: new Date(NOW_T0 + TICK_MS).toISOString() },
        updatedAt: new Date(NOW_T0 + TICK_MS).toISOString(),
      }));
      b.now.t = NOW_T0 + TICK_MS;
      b.tick();
      const ns = b.tree.snapshot();
      expect(ns.nodes.filter((n) => n.status === 'done')).toHaveLength(2);
      expect(ns.nodes.filter((n) => n.status === 'running')).toHaveLength(1);
    } finally {
      b.dispose();
    }
  });
});

describe('★ L2 AC-4 重放去重:同内容连拍 → render 不增', () => {
  test('两次 tick(同视图) → render 仅第一拍 +1; snapshot 不变', () => {
    const root = freshRoot();
    const snap: HudDagSnapshot = narrowSnap({
      runId: RUN_A,
      planned: [{ id: 'A', kind: 'agent' }, { id: 'B', kind: 'agent' }],
      settled: [{ id: 'A', status: 'done', kind: 'agent' }],
      started: ['B'],
      startedAt: { B: new Date(NOW_T0).toISOString() },
      updatedAt: new Date(NOW_T0).toISOString(),
    });
    const b = mkChannel({
      cwd: root,
      runId: RUN_A,
      readShard: () => asView(snap),
    });
    try {
      b.tick();
      const after1 = b.render.calls;
      b.tick();
      expect(b.render.calls).toBe(after1);
    } finally {
      b.dispose();
    }
  });
});

describe('★ L2 AC-5 乱序不回退 + 坏时戳 SKIP', () => {
  test('已施加 v2(t₂), 再注入 v_old(t₁) → render 不增, 屏态保留', () => {
    const root = freshRoot();
    let cur: HudDagSnapshot = narrowSnap({
      runId: RUN_A,
      planned: [{ id: 'A', kind: 'agent' }, { id: 'B', kind: 'agent' }],
      settled: [
        { id: 'A', status: 'done', kind: 'agent' },
        { id: 'B', status: 'done', kind: 'agent' },
      ],
      started: [],
      updatedAt: new Date(NOW_T0 + 200).toISOString(),
    });
    const b = mkChannel({
      cwd: root,
      runId: RUN_A,
      readShard: () => asView(cur),
    });
    try {
      b.tick();
      const rendersAfterV2 = b.render.calls;

      cur = narrowSnap({
        runId: RUN_A,
        planned: [{ id: 'A', kind: 'agent' }, { id: 'B', kind: 'agent' }],
        settled: [{ id: 'A', status: 'done', kind: 'agent' }],
        started: [],
        updatedAt: new Date(NOW_T0 + 100).toISOString(), // 老于已施加 t₂
      });
      b.tick();

      expect(b.render.calls).toBe(rendersAfterV2);
      expect(b.tree.snapshot().nodes.find((n) => n.id === 'B')?.status).toBe('done');
    } finally {
      b.dispose();
    }
  });

  test('updatedAt 非有限 → tick 不抛, bound 保持, render 不增', () => {
    const root = freshRoot();
    const b = mkChannel({
      cwd: root,
      runId: RUN_A,
      readShard: () => asView({ ...narrowSnap({ runId: RUN_A }), updatedAt: 'not-a-date' }),
    });
    try {
      expect(() => b.tick()).not.toThrow();
      expect(b.bound()).toBe(true);
      expect(b.render.calls).toBe(0);
    } finally {
      b.dispose();
    }
  });
});

describe('★ L2 AC-6 坏 JSON → DETACH', () => {
  test('分片改写为 `{bad` → tick 不抛, hud.render 返 [], 不自动重绑', () => {
    const root = freshRoot();
    writeShard(root, RUN_A, narrowSnap({
      runId: RUN_A,
      planned: [{ id: 'A', kind: 'agent' }],
      updatedAt: new Date(NOW_T0).toISOString(),
    }));
    const b = mkChannel({ cwd: root, runId: RUN_A });
    try {
      expect(b.bound()).toBe(true);
      writeRaw(root, 'dag-aaaaaaaa.json', '{bad');
      b.tick();
      expect(b.bound()).toBe(false);
      expect(b.hud.render(80)).toEqual([]);
      expect(b.tree.snapshot().nodes).toEqual([]);

      b.tick();
      expect(b.bound()).toBe(false);
      expect(b.hud.render(80)).toEqual([]);
    } finally {
      b.dispose();
    }
  });
});

describe('★ L2 AC-7 顶名 → DETACH', () => {
  test('RUN_A 短名被改写为 RUN_B 的内容 → DETACH', () => {
    const root = freshRoot();
    writeShard(root, RUN_A, narrowSnap({
      runId: RUN_A,
      planned: [{ id: 'a-1', kind: 'agent' }],
      updatedAt: new Date(NOW_T0).toISOString(),
    }));
    const b = mkChannel({ cwd: root, runId: RUN_A });
    try {
      writeShard(root, RUN_A, narrowSnap({
        runId: RUN_B, goal: 'B',
        planned: [{ id: 'b-1', kind: 'agent' }],
        updatedAt: new Date(NOW_T0 + 100).toISOString(),
      }));
      b.tick();
      expect(b.bound()).toBe(false);
      expect(b.hud.render(80)).toEqual([]);
    } finally {
      b.dispose();
    }
  });
});

describe('★ L2 AC-8 重绑清旧', () => {
  test('同 hud/tree, RUN_A → RUN_B, hud 只含 B 的节点', () => {
    const root = freshRoot();
    writeShard(root, RUN_A, narrowSnap({
      runId: RUN_A, goal: 'A',
      planned: [{ id: 'a-1', kind: 'agent' }, { id: 'a-2', kind: 'agent' }],
      updatedAt: new Date(NOW_T0).toISOString(),
    }));
    writeShard(root, RUN_B, narrowSnap({
      runId: RUN_B, goal: 'B',
      planned: [{ id: 'b-1', kind: 'agent' }, { id: 'b-2', kind: 'agent' }, { id: 'b-3', kind: 'agent' }],
      updatedAt: new Date(NOW_T0 + TICK_MS).toISOString(),
    }));

    const hud = new DagHud(theme, () => 'fake:con');
    const tree = new DagTree(theme, () => NOW_T0);
    const render = { calls: 0 };

    const chA = createExternalRunChannel({
      cwd: root, runId: RUN_A, hud, tree,
      now: () => NOW_T0,
      requestRender: () => { render.calls++; },
    });
    try {
      chA.tick();
      expect(hud.size).toBe(2);
    } finally {
      chA.dispose();
    }

    const chB = createExternalRunChannel({
      cwd: root, runId: RUN_B, hud, tree,
      now: () => NOW_T0 + TICK_MS,
      requestRender: () => { render.calls++; },
    });
    try {
      chB.tick();
      expect(hud.size).toBe(3);
      const snap = tree.snapshot();
      expect(snap.nodes.map((n) => n.id).sort()).toEqual(['b-1', 'b-2', 'b-3']);
      expect(snap.nodes.find((n) => n.id === 'a-1')).toBeUndefined();
    } finally {
      chB.dispose();
    }
  });
});

describe('★ L2 AC-9 continuity _dag.json 树结构', () => {
  test('planned 无 deps + _dag.json 有 deps{B,C → A} → B/C parent=A', () => {
    const root = freshRoot();
    writeShard(root, RUN_A, narrowSnap({
      runId: RUN_A, goal: 'A',
      planned: [
        { id: 'A', kind: 'agent' },
        { id: 'B', kind: 'agent' },
        { id: 'C', kind: 'agent' },
      ],
      settled: [{ id: 'A', status: 'done', kind: 'agent' }],
      started: [],
      updatedAt: new Date(NOW_T0).toISOString(),
    }));
    mkdirSync(join(root, '.omd', 'continuity', RUN_A), { recursive: true });
    writeFileSync(
      join(root, '.omd', 'continuity', RUN_A, '_dag.json'),
      JSON.stringify({ schema: 1, runId: RUN_A, deps: { B: ['A'], C: ['A'] }, runtimeNodes: [] }),
      'utf-8',
    );

    const hud = new DagHud(theme, () => 'fake:con');
    const tree = new DagTree(theme, () => NOW_T0);
    const channel = createExternalRunChannel({
      cwd: root, runId: RUN_A, hud, tree,
      now: () => NOW_T0,
      requestRender: () => {},
      continuityHomes: (cwd: string) => [join(cwd, '.omd', 'continuity')],
    });
    try {
      channel.tick();
      const snap = tree.snapshot();
      expect(snap.nodes.find((n) => n.id === 'B')?.parent).toBe('A');
      expect(snap.nodes.find((n) => n.id === 'C')?.parent).toBe('A');
      expect(snap.nodes.find((n) => n.id === 'A')?.parent).toBeNull();
    } finally {
      channel.dispose();
    }
  });
});

describe('★ L2 AC-10 continuity checkpoint 败因', () => {
  test('X failed + summary=boom + durationMs=5 → tree X.failReason=boom, durationMs=5', () => {
    const root = freshRoot();
    writeShard(root, RUN_A, narrowSnap({
      runId: RUN_A,
      planned: [{ id: 'X', kind: 'agent' }],
      settled: [{ id: 'X', status: 'failed', kind: 'agent' }],
      started: [],
      updatedAt: new Date(NOW_T0).toISOString(),
    }));
    mkdirSync(join(root, '.omd', 'continuity', RUN_A), { recursive: true });
    writeFileSync(
      join(root, '.omd', 'continuity', RUN_A, 'X.json'),
      JSON.stringify({ schema: 1, status: 'failed', summary: 'boom', durationMs: 5 }),
      'utf-8',
    );

    const hud = new DagHud(theme, () => 'fake:con');
    const tree = new DagTree(theme, () => NOW_T0);
    const channel = createExternalRunChannel({
      cwd: root, runId: RUN_A, hud, tree,
      now: () => NOW_T0,
      requestRender: () => {},
      continuityHomes: (cwd: string) => [join(cwd, '.omd', 'continuity')],
    });
    try {
      channel.tick();
      const X = tree.snapshot().nodes.find((n) => n.id === 'X');
      expect(X?.status).toBe('failed');
      expect(X?.failReason).toBe('boom');
      expect(X?.durationMs).toBe(5);
    } finally {
      channel.dispose();
    }
  });
});

describe('★ L2 AC-11 终态 + 超龄收起', () => {
  test('done 状态已施加;now 推过 DONE_GRACE_MS → DETACH', () => {
    const root = freshRoot();
    writeShard(root, RUN_A, narrowSnap({
      runId: RUN_A, status: 'done',
      planned: [{ id: 'A', kind: 'agent' }],
      settled: [{ id: 'A', status: 'done', kind: 'agent' }],
      started: [],
      updatedAt: new Date(NOW_T0).toISOString(),
    }));
    const b = mkChannel({ cwd: root, runId: RUN_A });
    try {
      b.tick();
      expect(b.bound()).toBe(true);
      expect(b.hud.size).toBe(1);
      b.now.t = NOW_T0 + DONE_GRACE_MS + 1;
      b.tick();
      expect(b.bound()).toBe(false);
      expect(b.hud.render(80)).toEqual([]);
      expect(b.tree.snapshot().nodes).toEqual([]);
    } finally {
      b.dispose();
    }
  });
});

describe('★ L2 AC-12 stalled 保留', () => {
  test('running age > RUNNING_TTL_MS → bound 保持, 屏态在', () => {
    const root = freshRoot();
    const staleAt = NOW_T0 - (RUNNING_TTL_MS + 5000);
    writeShard(root, RUN_A, narrowSnap({
      runId: RUN_A, status: 'running',
      planned: [{ id: 'A', kind: 'agent' }],
      settled: [],
      started: ['A'],
      startedAt: { A: new Date(staleAt).toISOString() },
      updatedAt: new Date(staleAt).toISOString(),
    }));
    const b = mkChannel({ cwd: root, runId: RUN_A });
    try {
      b.tick();
      expect(b.bound()).toBe(true);
      expect(b.hud.size).toBe(1);
      expect(b.tree.snapshot().nodes.find((n) => n.id === 'A')?.status).toBe('running');
    } finally {
      b.dispose();
    }
  });
});

describe('★ L2 AC-13 纯读:tick N 次后 .omd/ 文件清单与内容字节级不变 + mtime 不变', () => {
  test('5 次 tick → 盘面零变化', () => {
    const root = freshRoot();
    writeShard(root, RUN_A, narrowSnap({
      runId: RUN_A, status: 'running',
      planned: [{ id: 'A', kind: 'agent' }, { id: 'B', kind: 'agent' }],
      settled: [{ id: 'A', status: 'done', kind: 'agent' }],
      started: ['B'],
      startedAt: { B: new Date(NOW_T0).toISOString() },
      updatedAt: new Date(NOW_T0).toISOString(),
    }));

    const hudDir = join(root, '.omd', 'hud');
    const snapshot = (): Map<string, { body: string; mtimeMs: number }> => {
      const { readdirSync, statSync } = require('node:fs');
      const out = new Map<string, { body: string; mtimeMs: number }>();
      for (const f of readdirSync(hudDir)) {
        const p = join(hudDir, f);
        out.set(p, { body: readFileSync(p, 'utf-8'), mtimeMs: statSync(p).mtimeMs });
      }
      return out;
    };
    const before = snapshot();

    const b = mkChannel({ cwd: root, runId: RUN_A });
    try {
      for (let i = 0; i < 5; i++) b.tick();
    } finally {
      b.dispose();
    }

    const after = snapshot();
    expect(after.size).toBe(before.size);
    for (const [k, v] of before.entries()) {
      expect(after.get(k)?.body).toBe(v.body);
      expect(after.get(k)?.mtimeMs).toBe(v.mtimeMs);
    }
  });
});

describe('★ L2 AC-14 重绘由 caller + dispose 幂等', () => {
  test('APPLY → render +1;同内容第二拍 → render 不增;dispose 幂等', () => {
    const root = freshRoot();
    writeShard(root, RUN_A, narrowSnap({
      runId: RUN_A,
      planned: [{ id: 'A', kind: 'agent' }],
      updatedAt: new Date(NOW_T0).toISOString(),
    }));
    const b = mkChannel({ cwd: root, runId: RUN_A });
    try {
      b.tick();
      expect(b.render.calls).toBe(1);
      b.tick();
      b.tick();
      expect(b.render.calls).toBe(1);
    } finally {
      b.dispose();
      expect(() => b.dispose()).not.toThrow(); // dispose 幂等
    }
  });
});

describe('★ L2 audit:模块装载拿到的是真函数 + 哨兵行不变', () => {
  test('selectExternalRun / mergePlannedDeps / createExternalRunChannel 都是真函数', () => {
    expect(typeof selectExternalRun).toBe('function');
    expect(typeof mergePlannedDeps).toBe('function');
    expect(typeof createExternalRunChannel).toBe('function');
  });

  test('ATTACH_SUITE_MARKER === "t-tui-attach-r2"(反向自检锚 #2 不变锚点)', () => {
    expect(ATTACH_SUITE_MARKER).toBe('t-tui-attach-r2');
  });

  test('readDagShard 可被 SUT 引用(read-side 真源)', () => {
    expect(typeof readDagShard).toBe('function');
  });
});
