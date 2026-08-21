/**
 * L2:DagTree.loadSnapshot —— 切片 3 闸 (2026-08-22 SDD 片 3 · #216 读得回来)。
 *
 * 核心判据:**INV-HUD-6 双通路等价** —— 同一组事实, 事件驱动与 loadSnapshot hydrate
 * 必须产出逐字段相等的 `snapshot()`。这是本片唯一不许放宽的闸, 也是 #216 价值的源头:
 * 「同一张图, 换一条数据通路, 画出来一样」。
 *
 * ## 闸的覆盖
 *   - ★ INV-HUD-6: 双通路等价闸 (planned + start/settle, 同 now() 注入)
 *   - ★ INV-HUD-4: 加宽字段缺席 = undefined (deps / durationMs / usage / failureKind / startedAt)
 *   - ★ INV-HUD-5: planned 节点无 deps → parent=null, 树是平铺的
 *   - ★ 切片 3 规则: deps[0] 认树父 (按 SDD 逐字; 与 apply 的 expanded 分支**不同**:
 *     apply 用 e.parent, snapshot 没存 e.parent 这条边, 只剩 deps 这一条可用信号 —
 *     见 § 「与 apply 差异」)
 *   - ★ 清空契约: loadSnapshot 不与已有节点混图 (P-1: 不清 = 两图混在一起看不出谁是谁)
 *   - ★ runLabel: loadSnapshot 之后 snapshot().runLabel = snap.goal (与 beginRun 同形)
 *   - ★ 宽度闸: 大宽度下 render 与事件驱动 render 逐行相等
 *
 * 不在本片:跑事件进 RunProgress 再读盘再 loadSnapshot 的端到端 (那是屏 4 DAG 屏的事,
 * 本片只钉「同形 hydrate 出来」这一条闸)。端到端在屏 4 自测。
 *
 * 反向自检:每条 INV 都钉了一条用例 + 证伪方式在注释里。临时改实现 → 该条当场红 → 还原。
 */
import { describe, expect, test } from 'bun:test';
import type { DagNodeEvent } from '../../harness/dag/types';
import { HUD_SCHEMA, type HudDagSnapshot } from '../../hud/types';
import { DagTree } from './dag-tree';
import { createTheme } from '../theme';

const theme = createTheme({ color: false });

/** 钉死的 now: 让事件驱动与 hydrate 走同一个墙钟 (events 触发 endAt=now, hydrate 也用 now)。
 *  选 1234 因为不是 0, 也不是大数, 跑出来 if (n.startAt === null) 那条边不会撞边界。 */
const FROZEN_NOW = 1234;
const frozenNow = (): number => FROZEN_NOW;
/** FROZEN_NOW 的 ISO 形式 —— 等价闸的 snap.startedAt 用这个, 让 hydrate parse 回来 = FROZEN_NOW。 */
const FROZEN_NOW_ISO = new Date(FROZEN_NOW).toISOString();

/** 把一组事件喂给一棵新树, 跑出 `snapshot()` —— 测试用的小工具。 */
const fromEvents = (label: string, events: DagNodeEvent[]): DagTree => {
  const t = new DagTree(theme, frozenNow);
  t.beginRun(label);
  for (const e of events) t.apply(e);
  return t;
};

/* ─────────────────────────────────────────────────────────────────────────
 * ★ INV-HUD-6 双通路等价闸 —— 本片的核心契约。
 * ───────────────────────────────────────────────────────────────────────── */

/** 一组「planned → start → settle」的事件序列 (无 expanded, 无 deps, 全根节点)。 */
const basicEvents = (label = 'test-run'): DagNodeEvent[] => [
  { type: 'planned', nodes: [
    { id: 'a', kind: 'agent' },
    { id: 'b', kind: 'agent' },
  ] },
  { type: 'start', id: 'a', kind: 'agent' },
  { type: 'settle', id: 'a', status: 'done', kind: 'agent', durationMs: 5000, usage: { in: 100, out: 200 } },
];

/** 与上面一组事件**等价**的 HudDagSnapshot —— 手构, 按 run-registry 的写侧契约
 *  (planned 由 planned/expanded 事件聚合; settled 收集 done/failed/skipped;
 *  started = 还在跑的; startedAt = 还在跑的起点)。 */
const basicSnap = (label = 'test-run'): HudDagSnapshot => ({
  schema: HUD_SCHEMA,
  runId: 'aaaaaaaa-1111-2222-3333-444444444444',
  goal: label,
  status: 'done',
  updatedAt: '2026-08-22T10:00:00.000Z',
  levels: null,
  planned: [
    { id: 'a', kind: 'agent' },
    { id: 'b', kind: 'agent' },
  ],
  started: [],
  startedAt: {},
  settled: [
    {
      id: 'a',
      status: 'done',
      kind: 'agent',
      startedAt: FROZEN_NOW_ISO,
      durationMs: 5000,
      usage: { in: 100, out: 200 },
    },
  ],
});

describe('★ INV-HUD-6 双通路等价闸 (本片的核心契约)', () => {
  // 反向自检: 把 loadSnapshot 的 clear() 注释掉 → t2 还留着上一次的内容, snapshot.nodes 不等, 红;
  //          把 deps[0] 改成 `''` 或 `null` 顶默认 → parent 不对, 红;
  //          把 settled 的 endAt 写成 `startAt` (零长) → durationMs 字段对, 但 endAt 不等, 红。
  test('同组事实 → 事件驱动 vs loadSnapshot 的 snapshot() 逐字段相等', () => {
    const t1 = fromEvents('test-run', basicEvents());
    const t2 = new DagTree(theme, frozenNow);
    t2.loadSnapshot(basicSnap());

    const s1 = t1.snapshot();
    const s2 = t2.snapshot();

    expect(s2.runLabel).toBe(s1.runLabel);
    expect(s2.runLabel).toBe('test-run'); // = snap.goal, 与 beginRun(label) 同形

    // 节点集合逐字段相等
    expect(s2.nodes).toHaveLength(s1.nodes.length);
    expect(s2.nodes).toHaveLength(2);
    for (let i = 0; i < s1.nodes.length; i++) {
      const a = s1.nodes[i]!;
      const b = s2.nodes[i]!;
      expect(b).toEqual(a); // id/kind/status/parent/deps/seq/startAt/endAt/durationMs/usage/failureKind 全等
    }
  });

  test('多条 settled + 失败节点 + failureKind + 加宽字段 — 双通路逐字段相等', () => {
    // 故意覆盖: done/failed/skipped 三种 status, usage / failureKind / durationMs 全用上;
    // 一条没报 usage (旧发射点的窄快照), 验证 hydrate 不补 0 (INV-HUD-4)。
    const events: DagNodeEvent[] = [
      { type: 'planned', nodes: [
        { id: 'root', kind: 'conductor' },
        { id: 'leaf1', kind: 'agent' },
        { id: 'leaf2', kind: 'agent' },
        { id: 'leaf3', kind: 'agent' },
      ] },
      { type: 'start', id: 'leaf1', kind: 'agent' },
      { type: 'settle', id: 'leaf1', status: 'done', kind: 'agent', durationMs: 4200, usage: { in: 50, out: 80 } },
      { type: 'start', id: 'leaf2', kind: 'agent' },
      { type: 'settle', id: 'leaf2', status: 'failed', kind: 'agent', durationMs: 1500, usage: { in: 30, out: 40 }, failureKind: 'empty-artifact' },
      { type: 'start', id: 'leaf3', kind: 'agent' },
      // 故意不给 usage / failureKind / durationMs → 老发射点的窄字段形态
      { type: 'settle', id: 'leaf3', status: 'skipped', kind: 'agent' },
    ];
    const t1 = fromEvents('full', events);

    const snap: HudDagSnapshot = {
      schema: HUD_SCHEMA,
      runId: 'aaaaaaaa-1111-2222-3333-444444444444',
      goal: 'full',
      status: 'failed',
      updatedAt: '2026-08-22T10:00:00.000Z',
      levels: null,
      planned: [
        { id: 'root', kind: 'conductor' },
        { id: 'leaf1', kind: 'agent' },
        { id: 'leaf2', kind: 'agent' },
        { id: 'leaf3', kind: 'agent' },
      ],
      started: [],
      startedAt: {},
      settled: [
        { id: 'leaf1', status: 'done', kind: 'agent', startedAt: FROZEN_NOW_ISO, durationMs: 4200, usage: { in: 50, out: 80 } },
        { id: 'leaf2', status: 'failed', kind: 'agent', startedAt: FROZEN_NOW_ISO, durationMs: 1500, usage: { in: 30, out: 40 }, failureKind: 'empty-artifact' },
        // 窄字段: 不写 startedAt / durationMs / usage / failureKind (INV-HUD-4: 缺席 = undefined)
        { id: 'leaf3', status: 'skipped', kind: 'agent' },
      ],
    };
    const t2 = new DagTree(theme, frozenNow);
    t2.loadSnapshot(snap);

    const s1 = t1.snapshot();
    const s2 = t2.snapshot();
    expect(s2.nodes).toHaveLength(s1.nodes.length);
    for (let i = 0; i < s1.nodes.length; i++) {
      expect(s2.nodes[i]).toEqual(s1.nodes[i]);
    }

    // 顺手验一下 INV-HUD-4 (缺席 = undefined, 不是 0 / 不是 'unclassified')
    const leaf3 = s2.nodes.find((n) => n.id === 'leaf3')!;
    expect(leaf3.status).toBe('skipped');
    expect(leaf3.durationMs).toBeUndefined();
    expect(leaf3.usage).toBeUndefined();
    expect(leaf3.failureKind).toBeUndefined();
  });

  test('正在跑的节点 (started[] 非空) 也走双通路 — settledAt/startAt/endAt 三位对齐', () => {
    // 跑 a, 起 b, 还没 settle b → 双边应都是 a=done, b=running。
    const events: DagNodeEvent[] = [
      { type: 'planned', nodes: [{ id: 'a', kind: 'agent' }, { id: 'b', kind: 'agent' }] },
      { type: 'start', id: 'a', kind: 'agent' },
      { type: 'settle', id: 'a', status: 'done', kind: 'agent', durationMs: 1000, usage: { in: 10, out: 20 } },
      { type: 'start', id: 'b', kind: 'agent' },
    ];
    const t1 = fromEvents('live', events);

    const startedAtIso = FROZEN_NOW_ISO;
    const snap: HudDagSnapshot = {
      schema: HUD_SCHEMA,
      runId: 'aaaaaaaa-1111-2222-3333-444444444444',
      goal: 'live',
      status: 'running',
      updatedAt: '2026-08-22T10:00:02.000Z',
      levels: null,
      planned: [{ id: 'a', kind: 'agent' }, { id: 'b', kind: 'agent' }],
      started: ['b'],
      startedAt: { b: startedAtIso },
      settled: [
        { id: 'a', status: 'done', kind: 'agent', startedAt: FROZEN_NOW_ISO, durationMs: 1000, usage: { in: 10, out: 20 } },
      ],
    };
    const t2 = new DagTree(theme, frozenNow);
    t2.loadSnapshot(snap);

    const s1 = t1.snapshot();
    const s2 = t2.snapshot();
    expect(s2.nodes).toHaveLength(s1.nodes.length);
    for (let i = 0; i < s1.nodes.length; i++) {
      expect(s2.nodes[i]).toEqual(s1.nodes[i]);
    }

    // 显式验: a=done, b=running, b.startAt=parseISO(startedAtIso)
    const a2 = s2.nodes.find((n) => n.id === 'a')!;
    const b2 = s2.nodes.find((n) => n.id === 'b')!;
    expect(a2.status).toBe('done');
    expect(b2.status).toBe('running');
    expect(b2.startAt).toBe(Date.parse(startedAtIso));
    expect(b2.endAt).toBeNull();
  });
});

/* ─────────────────────────────────────────────────────────────────────────
 * ★ INV-HUD-5 planned 节点无 deps → parent=null, 树平铺
 * ───────────────────────────────────────────────────────────────────────── */

describe('★ INV-HUD-5 planned 节点无 deps → parent=null, 树是平铺的', () => {
  test('只有 planned 节点 + 一条 start → 全是根 (没父子边)', () => {
    const t = new DagTree(theme, frozenNow);
    t.loadSnapshot({
      schema: HUD_SCHEMA,
      runId: 'aaaaaaaa-1111-2222-3333-444444444444',
      goal: 'flat',
      status: 'running',
      updatedAt: '2026-08-22T10:00:00.000Z',
      levels: null,
      planned: [
        { id: 'p1', kind: 'agent' },
        { id: 'p2', kind: 'agent' },
        { id: 'p3', kind: 'agent' },
      ],
      started: ['p1'],
      startedAt: { p1: '2026-08-22T10:00:00.000Z' },
      settled: [],
    });
    const lines = t.render(80).join('\n');
    // 全是根: 都在顶层 (没有 ├─ / └─ 前缀)
    expect(lines).toContain('· p1 agent');
    expect(lines).toContain('○ p2 agent');
    expect(lines).toContain('○ p3 agent');
    expect(lines).not.toContain('├─');
    expect(lines).not.toContain('└─');
  });
});

/* ─────────────────────────────────────────────────────────────────────────
 * ★ 切片 3 规则: deps[0] 认树父
 *
 *  与 apply 的 expanded 分支**差异** (P-1 风险, 已记在用例注释): apply 的 expanded 用
 *  e.parent (引擎的"分裂那一刻"显式给的); snapshot 没存 e.parent, 只剩 deps 这一条
 *  可用信号。所以本片按 SDD 逐字用 deps[0], **前提** 是 deps[0] 在生产里碰巧 == 父
 *  (chain-shaped 展开 / planner 把父列进 depends_on)。当 deps 与 e.parent 不一致时,
 *  snapshot 路径必然少一条边 —— 这是「观察者看不全」的那一类代价, 不是实现 bug。
 * ───────────────────────────────────────────────────────────────────────── */

describe('★ 切片 3 规则: deps[0] 认树父', () => {
  test('deps 非空 → parent = deps[0]; deps 为空 → parent = null', () => {
    // 用 deps 模拟 expanded (这是 snapshot 唯一拿得到的父子信号)。
    const t = new DagTree(theme, frozenNow);
    t.loadSnapshot({
      schema: HUD_SCHEMA,
      runId: 'aaaaaaaa-1111-2222-3333-444444444444',
      goal: 'chain',
      status: 'running',
      updatedAt: '2026-08-22T10:00:00.000Z',
      levels: null,
      planned: [
        { id: 'map', kind: 'map' },                       // 根: deps undefined → parent null
        { id: 'child1', kind: 'agent', deps: ['map'] },    // parent = map (deps[0])
        { id: 'child2', kind: 'agent', deps: ['map'] },    // parent = map
        { id: 'orphan', kind: 'agent', deps: [] },         // parent = null (deps 空 → 根)
      ],
      started: [],
      startedAt: {},
      settled: [],
    });
    const snap = t.snapshot();
    const byId = (id: string): { parent: string | null } => {
      const n = snap.nodes.find((x) => x.id === id);
      if (!n) throw new Error(`node ${id} missing`);
      return { parent: n.parent };
    };
    expect(byId('map').parent).toBeNull();
    expect(byId('child1').parent).toBe('map');
    expect(byId('child2').parent).toBe('map');
    expect(byId('orphan').parent).toBeNull();

    // 渲染层也认: child1/child2 挂在 map 下 (├─ / └─)
    const lines = t.render(80).join('\n');
    expect(lines).toContain('○ map map');
    expect(lines).toMatch(/[├└]─○ child[12]/);
  });

  test('★ 边界:deps=[] 与 deps=undefined 在 hydrate 出的树上行为相同 (都 → parent null)', () => {
    // INV-HUD-5: planned 节点**没有** deps 是真值 (不是 mirror 编的)。hydrate 时 deps 缺席
    // 与 deps=[] 同义 → 两条路径都父归 null。这条防有人偷偷给 deps 缺席节点补一个虚拟父。
    const t = new DagTree(theme, frozenNow);
    t.loadSnapshot({
      schema: HUD_SCHEMA,
      runId: 'aaaaaaaa-1111-2222-3333-444444444444',
      goal: 'edge',
      status: 'running',
      updatedAt: '2026-08-22T10:00:00.000Z',
      levels: null,
      // 故意一个 deps 缺席, 一个 deps=[], 一个 deps=['x'] (x 不存在)
      planned: [
        { id: 'no-deps-field', kind: 'agent' },         // deps 字段不存在 (JSON 不写)
        { id: 'empty-deps', kind: 'agent', deps: [] },   // deps: [] 显式空
        { id: 'dangling-deps', kind: 'agent', deps: ['x'] }, // deps 指向不存在的 id
      ],
      started: [],
      startedAt: {},
      settled: [],
    });
    const snap = t.snapshot();
    for (const id of ['no-deps-field', 'empty-deps', 'dangling-deps']) {
      const n = snap.nodes.find((x) => x.id === id)!;
      expect(n.parent).toBe(id === 'dangling-deps' ? 'x' : null);
    }
  });
});

/* ─────────────────────────────────────────────────────────────────────────
 * ★ 清空契约 + runLabel + 端到端小渲染闸
 * ───────────────────────────────────────────────────────────────────────── */

describe('★ 清空契约: loadSnapshot 不与已有节点混图', () => {
  // 反向自检: 注释掉 loadSnapshot 第一行的 this.nodes.clear() → 第二次 load 的节点叠在第一次的上面,
  //          snapshot.nodes.length 比期望大, 两条断言都红。
  test('loadSnapshot 之前已有的节点被清空, 不混入新树', () => {
    const t = new DagTree(theme, frozenNow);
    t.beginRun('first');
    t.apply({ type: 'planned', nodes: [{ id: 'old1', kind: 'agent' }, { id: 'old2', kind: 'agent' }] });
    expect(t.size).toBe(2);

    t.loadSnapshot({
      schema: HUD_SCHEMA,
      runId: 'bbbbbbbb-1111-2222-3333-444444444444',
      goal: 'second',
      status: 'running',
      updatedAt: '2026-08-22T10:00:00.000Z',
      levels: null,
      planned: [{ id: 'new1', kind: 'agent' }],
      started: [],
      startedAt: {},
      settled: [],
    });
    expect(t.size).toBe(1);
    expect(t.snapshot().runLabel).toBe('second'); // runLabel 也覆盖, 不是「两个 run 拼一张图」
    expect(t.snapshot().nodes[0]?.id).toBe('new1');
  });

  test('空快照 → 空树 (size=0, snapshot().nodes=[])', () => {
    const t = new DagTree(theme, frozenNow);
    t.beginRun('placeholder'); // 先加点东西, 验证真的清
    t.apply({ type: 'planned', nodes: [{ id: 'leftover', kind: 'agent' }] });
    t.loadSnapshot({
      schema: HUD_SCHEMA,
      runId: 'aaaaaaaa-1111-2222-3333-444444444444',
      goal: '',
      status: 'done',
      updatedAt: '2026-08-22T10:00:00.000Z',
      levels: null,
      planned: [],
      started: [],
      startedAt: {},
      settled: [],
    });
    expect(t.size).toBe(0);
    expect(t.snapshot().runLabel).toBe('');
    expect(t.snapshot().nodes).toEqual([]);
    expect(t.render(40)).toEqual([]); // 无源恒缺席 (与 dag-tree.test.ts 同一条)
  });
});

describe('★ 渲染层: 同源 snapshot 在大宽度下 render 与事件驱动 render 逐行相等', () => {
  // 这条钉的是「同形 hydrate 出来之后, 屏幕上的字也得一样」—— 比 snapshot() 更接近真实观感。
  test('planned + start + settle 的事件驱动 vs loadSnapshot → render(120) 逐行相等', () => {
    const events = basicEvents('render-test');
    const t1 = fromEvents('render-test', events);
    const t2 = new DagTree(theme, frozenNow);
    t2.loadSnapshot(basicSnap('render-test'));
    // 宽到不截断 (120 列)
    expect(t2.render(120)).toEqual(t1.render(120));
  });
});

/* ─────────────────────────────────────────────────────────────────────────
 * ★ INV-HUD-4 缺席 ≠ 0 ≠ 不适用 (字段层面)
 * ───────────────────────────────────────────────────────────────────────── */

describe('★ INV-HUD-4 hydrate 出的 TreeNode: 缺席字段是 undefined, 不补 0 / 不补 unclassified', () => {
  // 反向自检: 在 loadSnapshot 里给 settled 的 durationMs/usage/failureKind 加 `?? 0`/`?? 'unclassified'`
  //          → 下面几条全红。
  test('窄字段快照 (deps / usage / durationMs / failureKind 都没有) → hydrate 后这些字段 undefined', () => {
    const t = new DagTree(theme, frozenNow);
    t.loadSnapshot({
      schema: HUD_SCHEMA,
      runId: 'aaaaaaaa-1111-2222-3333-444444444444',
      goal: 'narrow',
      status: 'running',
      updatedAt: '2026-08-22T10:00:00.000Z',
      levels: null,
      planned: [{ id: 'p', kind: 'agent' }], // deps 字段不写 (镜像 serialize 时本就缺省)
      started: [],
      startedAt: {},
      settled: [{ id: 'p', status: 'done', kind: 'agent' }], // startedAt / durationMs / usage / failureKind 都不写
    });
    const n = t.snapshot().nodes[0]!;
    expect(n.id).toBe('p');
    expect(n.status).toBe('done');
    expect(n.deps).toEqual([]); // 没 deps → 默认 [], 不是 undefined (与 apply 同形)
    expect(n.durationMs).toBeUndefined();
    expect(n.usage).toBeUndefined();
    expect(n.failureKind).toBeUndefined();
    // settled 里没 startedAt → 与 apply 同形: startAt=endAt=now (settle 先于 start 的零长条语义)
    expect(n.startAt).toBe(FROZEN_NOW);
    expect(n.endAt).toBe(FROZEN_NOW);
  });

  test('宽字段快照 (deps / usage / durationMs / failureKind 全在) → hydrate 后这些字段值原样', () => {
    const t = new DagTree(theme, frozenNow);
    t.loadSnapshot({
      schema: HUD_SCHEMA,
      runId: 'aaaaaaaa-1111-2222-3333-444444444444',
      goal: 'wide',
      status: 'failed',
      updatedAt: '2026-08-22T10:00:00.000Z',
      levels: null,
      planned: [
        { id: 'a', kind: 'agent' },
        { id: 'b', kind: 'agent', deps: ['a'] },
      ],
      started: [],
      startedAt: {},
      settled: [
        {
          id: 'b',
          status: 'failed',
          kind: 'agent',
          startedAt: '2026-08-22T10:00:00.000Z',
          durationMs: 4321,
          usage: { in: 123, out: 456 },
          failureKind: 'empty-artifact',
        },
      ],
    });
    const s = t.snapshot();
    const b = s.nodes.find((n) => n.id === 'b')!;
    expect(b.durationMs).toBe(4321);
    expect(b.usage).toEqual({ in: 123, out: 456 });
    expect(b.failureKind).toBe('empty-artifact');
    expect(b.startAt).toBe(Date.parse('2026-08-22T10:00:00.000Z'));
    // endAt: 有 durationMs → startAt + durationMs (比 `now()` 准, 也稳)
    expect(b.endAt).toBe(Date.parse('2026-08-22T10:00:00.000Z') + 4321);
    // deps 也下来了
    expect(b.deps).toEqual(['a']);
  });
});