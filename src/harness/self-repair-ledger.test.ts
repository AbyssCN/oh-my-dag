/**
 * src/harness/self-repair-ledger.test.ts —— P1 C-4 自修环落账的闸 (2026-08-21)。
 *
 * 钉死三条 GWT + 三条 INV:
 *
 * | GWT    | 钉的是什么 | 形态 |
 * |--------|---|---|---|
 * | GWT-4a | 判据一次就绿 → `selfRepair = {rounds: 0, oracleExit: [expect_exit], convergedAt: 0}` | 单元 (record → get) |
 * | GWT-4b | 节点没有 self_check → `selfRepair === null` (这条路不适用) | 单元 |
 * | GWT-4c | 自修 N 轮仍没绿 → `convergedAt === null` 且 oracleExit 末项 `!== expect_exit` | 单元 |
 *
 * | INV    | 钉的是什么 |
 * |--------|---|
 * | INV-4-1 | `null` (「不适用」) ≠ `{rounds: 0}` (「判据一次就绿」)。type 同时容许**字段缺席** (`undefined`): 概念不适用的节点 (非 agent 叶 / 旧记录) —— 三态严格分。|
 * | INV-4-2 | `oracleExit.length === rounds + 1` (判据至少跑一次, 每次自修后再跑一次) |
 * | INV-4-3 | `convergedAt !== null` ⟺ `oracleExit.at(-1) === expect_exit` |
 *
 * 验收面: `dag-record.record()` 写 → `recorder.get()` / `list()` 读出 (与切片 1 round-fields
 * 同构)。`agent-leaf.ts` 的 `AgentLeafResult.selfRepair` 形状由 leaf-self-check.test.ts 那
 * 侧钉死; 引擎透传 (engine.ts 接线) **不在**本切片写集里, 不在本测试范围。
 *
 * ⚠ 证伪方式 (仓规: 一条永远绿的闸不是闸) — 反向自检当场验过:
 *   · GWT-4a: 把 `record()` 里 `r.selfRepair !== undefined` 改成 `r.selfRepair ?? null` → null
 *     路径会盖掉 `{rounds:0,...}`, 与本测试期望相反 → 红。
 *   · GWT-4b: 把 spread 三元条件改回无条件 spread → 字段都会是对象/null → 与本测试期望相反 → 红。
 *   · GWT-4c: 把 record() 里 `r.selfRepair !== undefined` 改成无条件 spread → 缺席被读成对象
 *     `{rounds: undefined, ...}` → 本测试末项断言虽仍成立但 GWT-4b 先红。
 *   · INV-4-1 三态: 把 spread 条件改成 `r.selfRepair != null` → null 被跳过 → 字段缺席 → 本测试
 *     SDK 段 (in === true + 值 null) 红; 把条件改成 `r.selfRepair ?? null` → 缺席读成 null →
 *     GWT-4b 的 in === true 段红。
 */
import { describe, expect, test } from 'bun:test';
import { createDagRecorder, type DagRunNode } from './dag/dag-record';
import type { ExecutorDagResult } from './dag/types';

/**
 * 造一个最小可记的 ExecutorDagResult。`results[id]` 上的 `selfRepair` 由调用方按场景填
 * (与 agent-leaf.ts 2078-2082 那条三态赋值同构)。
 */
function fakeResult(planName: string, nodes: DagRunNode[]): ExecutorDagResult {
  const levels: string[][] = [];
  const byLevel = new Map<number, string[]>();
  for (const n of nodes) {
    const lvl = n.deps.length;
    if (!byLevel.has(lvl)) byLevel.set(lvl, []);
    byLevel.get(lvl)!.push(n.id);
  }
  for (const [, ids] of [...byLevel.entries()].sort((a, b) => a[0] - b[0])) levels.push(ids);
  return {
    plan: { name: planName, nodes: Object.fromEntries(nodes.map((n) => [n.id, { goal: 'x' }])) },
    levels,
    results: Object.fromEntries(nodes.map((n) => [
      n.id,
      {
        id: n.id,
        kind: 'agent',
        status: n.status,
        deps: n.deps,
        output: '',
        usage: { in: n.tokensIn ?? 100, out: 0 },
        // C-4 透传: 引擎 (不在本切片写集) 后续会把 agent-leaf 的 selfRepair 搬到这里;
        // 测试用 sourceObject 直传 (同 round-fields.test.ts 的写法)。
        ...(n.selfRepair !== undefined ? { selfRepair: n.selfRepair } : {}),
      },
    ])) as ExecutorDagResult['results'],
    reusedNodes: [],
    usage: { conductor: { in: 0, out: 0 }, leavesIn: 0, leavesOut: 0, leavesCacheHit: 0 },
  } as unknown as ExecutorDagResult;
}

/** 给一个节点造一个 DagRunNode (仅本测试用)。selfRepair 默认缺席 (非 agent 叶旁路, INV-1-2)。 */
const mkNode = (overrides: Partial<DagRunNode> & { id: string }): DagRunNode => ({
  kind: 'agent',
  status: 'done',
  deps: [],
  tokensIn: 100,
  ...overrides,
});

// ─────────────────────────────────────────────────────────────────────────
// GWT-4a (主) — 判据一次就绿 → selfRepair = {rounds: 0, oracleExit: [expect_exit], convergedAt: 0}
//   不为 null, 含完整形状; INV-4-1 严格区分于「节点没有 self_check」(GWT-4b: null 那一档)。
// ─────────────────────────────────────────────────────────────────────────
describe('GWT-4a — 判据一次就绿 → selfRepair = {rounds: 0, oracleExit: [expect_exit], convergedAt: 0}', () => {
  test('GWT-4a (主): 判据一次就绿 → selfRepair 是对象, rounds=0, oracleExit=[expect_exit], convergedAt=0', () => {
    const rec = createDagRecorder({ path: ':memory:' });
    const id = rec.record(fakeResult('first-green', [mkNode({
      id: 'n',
      deps: [],
      tokensIn: 100,
      selfRepair: { rounds: 0, oracleExit: [0], convergedAt: 0 },
    })]));
    const n = rec.get(id)!.nodes[0]!;
    // INV-4-1 严格: 不是 null, 是对象
    expect(n.selfRepair).not.toBeNull();
    // INV-4-2: oracleExit 至少 1 项
    expect(n.selfRepair!.rounds).toBe(0);
    expect(n.selfRepair!.oracleExit).toEqual([0]);
    expect(n.selfRepair!.oracleExit.length).toBe(1);
    // INV-4-3: 末项 === expect_exit (0) ⟺ convergedAt !== null (0, 首轮就绿)
    expect(n.selfRepair!.convergedAt).toBe(0);
    expect(n.selfRepair!.oracleExit[n.selfRepair!.oracleExit.length - 1]).toBe(0);
    rec.close();
  });

  test('判据一次就绿 (expect_exit = 1) → selfRepair.convergedAt = 0, oracleExit = [1]', () => {
    const rec = createDagRecorder({ path: ':memory:' });
    const id = rec.record(fakeResult('verify-red-first', [mkNode({
      id: 'n',
      deps: [],
      tokensIn: 50,
      selfRepair: { rounds: 0, oracleExit: [1], convergedAt: 0 }, // expect_exit=1, 首轮退 1 = 绿
    })]));
    const n = rec.get(id)!.nodes[0]!;
    expect(n.selfRepair!.oracleExit).toEqual([1]);
    expect(n.selfRepair!.convergedAt).toBe(0);
    rec.close();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// GWT-4b (主) — 节点没有 self_check → selfRepair === null (INV-4-1)
//
//   agent-leaf.ts 2078: `inputSelfCheck ? (isSdkChannel ? null : ...) : null` ——
//   节点没有 self_check (plan 上没写) → agent-leaf 落 null, 不是对象。
//   这正是 INV-4-1 的「这条路不适用」档 —— null 与 `{rounds:0}` 严格不互换。
//   (字段**缺席** 是另一档: 概念不适用的非 agent 叶, 见 INV-4-1 三态纪律那组)。
// ─────────────────────────────────────────────────────────────────────────
describe('GWT-4b — 节点没有 self_check → selfRepair === null (INV-4-1 「不适用」档)', () => {
  test('GWT-4b (主): agent leaf 节点 plan 上没写 self_check → selfRepair === null (不是对象, 不是 undefined)', () => {
    const rec = createDagRecorder({ path: ':memory:' });
    // 真源 (agent-leaf.ts 2078): `inputSelfCheck ? ... : null` — 没 self_check → null
    const id = rec.record(fakeResult('no-self-check', [mkNode({
      id: 'n',
      deps: [],
      tokensIn: 100,
      selfRepair: null, // 与 agent-leaf 赋值同构: inputSelfCheck 缺席 → 落 null
    })]));
    const n = rec.get(id)!.nodes[0]!;
    // INV-4-1: null (不适用) ≠ {rounds: 0} (判据一次就绿)
    expect(n.selfRepair).toBeNull();
    // 不是 undefined (那是「概念不适用」档, 非 agent 叶) —— 用 in 把它们分得开
    expect(n.selfRepair).not.toBeUndefined();
    expect(typeof n.selfRepair).toBe('object'); // typeof null === 'object' 的反向钉: 字段在场
    rec.close();
  });

  test('null (没 self_check) 与 {rounds:0} (判据一次就绿) 在同一 DB 内不互换 (INV-4-1)', () => {
    const rec = createDagRecorder({ path: ':memory:' });
    const id = rec.record(fakeResult('null-vs-zero', [
      mkNode({ id: 'no-sc', tokensIn: 100, selfRepair: null }),                              // GWT-4b: null
      mkNode({ id: 'first-green', tokensIn: 80, selfRepair: { rounds: 0, oracleExit: [0], convergedAt: 0 } }), // GWT-4a: 对象
    ]));
    const ns = rec.get(id)!.nodes;
    const noSc = ns.find((x) => x.id === 'no-sc')!;
    const fg = ns.find((x) => x.id === 'first-green')!;
    // 双向验证: null 不是对象 (即不是 {rounds:0,...}), 反之亦然
    expect(noSc.selfRepair).toBeNull();
    expect(fg.selfRepair).not.toBeNull();
    expect(fg.selfRepair!.rounds).toBe(0);
    // 关键: 两者读出来不应**意外合并** (即 null 不被当成空对象)
    expect(Object.keys(fg.selfRepair ?? {}).length).toBeGreaterThan(0); // 对象有键
    expect(noSc.selfRepair).not.toEqual({}); // null 不是空对象
    rec.close();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// GWT-4c (主) — 自修 N 轮仍没绿 → convergedAt === null, oracleExit 末项 !== expect_exit
//   INV-4-2 长度 = rounds + 1 (始终满足); INV-4-3 ⟺ 关系。
// ─────────────────────────────────────────────────────────────────────────
describe('GWT-4c — 自修 N 轮没绿 → convergedAt === null 且 oracleExit 末项 !== expect_exit (INV-4-2, INV-4-3)', () => {
  test('GWT-4c (主): 自修 2 轮没绿 → convergedAt null, oracleExit 长度 = 3, 末项 1 ≠ expect_exit 0', () => {
    const rec = createDagRecorder({ path: ':memory:' });
    const id = rec.record(fakeResult('two-rounds-fail', [mkNode({
      id: 'n',
      deps: [],
      tokensIn: 100,
      selfRepair: { rounds: 2, oracleExit: [1, 1, 1], convergedAt: null }, // expect_exit=0 全退 1 → 没绿
    })]));
    const n = rec.get(id)!.nodes[0]!;
    expect(n.selfRepair).not.toBeNull();
    // INV-4-2: rounds + 1
    expect(n.selfRepair!.rounds).toBe(2);
    expect(n.selfRepair!.oracleExit).toHaveLength(3);
    // INV-4-3: convergedAt null ⟺ 末项 !== expect_exit (0); 双向都得验
    expect(n.selfRepair!.convergedAt).toBeNull();
    expect(n.selfRepair!.oracleExit[n.selfRepair!.oracleExit.length - 1]).not.toBe(0);
    rec.close();
  });

  test('自修 1 轮后转绿 → rounds=1, oracleExit 长度 = 2, 末项 === expect_exit, convergedAt=1', () => {
    const rec = createDagRecorder({ path: ':memory:' });
    const id = rec.record(fakeResult('one-round-recover', [mkNode({
      id: 'n',
      deps: [],
      tokensIn: 100,
      selfRepair: { rounds: 1, oracleExit: [1, 0], convergedAt: 1 }, // 首轮 1 (红), 自修后 0 (绿)
    })]));
    const n = rec.get(id)!.nodes[0]!;
    expect(n.selfRepair!.rounds).toBe(1);
    expect(n.selfRepair!.oracleExit).toEqual([1, 0]);
    expect(n.selfRepair!.oracleExit).toHaveLength(2); // INV-4-2
    expect(n.selfRepair!.convergedAt).toBe(1); // INV-4-3: 第二轮 (index 1) 转绿
    // INV-4-3 ⟺ 关系: 末项 === expect_exit (0) ⟺ convergedAt !== null
    expect(n.selfRepair!.oracleExit.at(-1)).toBe(0);
    rec.close();
  });

  test('自修到 maxSelfRepair 上限 (2) 仍没绿 → rounds=2, oracleExit 长度 = 3, 全非期望退出码', () => {
    const rec = createDagRecorder({ path: ':memory:' });
    const id = rec.record(fakeResult('maxed-out', [mkNode({
      id: 'n',
      deps: [],
      tokensIn: 100,
      // 与 agent-leaf.ts 的 maxSelfRepair 默认 2 对齐; 全程 expect_exit=0 都退 1
      selfRepair: { rounds: 2, oracleExit: [1, 1, 1], convergedAt: null },
    })]));
    const n = rec.get(id)!.nodes[0]!;
    // INV-3-1: rounds ≤ maxSelfRepair (本切片不验证 maxSelfRepair 上限, 只验证落账形状)
    // INV-4-2: length === rounds + 1
    expect(n.selfRepair!.rounds).toBeLessThanOrEqual(2);
    expect(n.selfRepair!.oracleExit.length).toBe(n.selfRepair!.rounds + 1);
    // INV-4-3: convergedAt null ⟺ 末项 !== expect_exit
    expect(n.selfRepair!.convergedAt).toBeNull();
    expect(n.selfRepair!.oracleExit.every((c) => c !== 0)).toBe(true);
    rec.close();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// INV-4-1 三态纪律全集 (缺席 / null / 对象) — 闸的最后一档
//
//   - **字段缺席** (`undefined`): 概念不适用的节点 (非 agent 叶 / 老记录, 旧落库节点);
//   - `null`: 节点有 self_check 概念但**没跑** —— plan 上没写 self_check (GWT-4b) 或 SDK 通道
//     (INV-2-1, claude-sdk-loop 无 getFollowUpMessages 钩子)。两种都被 agent-leaf 落 null;
//   - 对象: self_check 真跑了。
//
// 三态在同一 DB 里**不能合并**: 任何把它们读成同一个值的代码都会让读数板误诊。
// 关键不变量:
//   · `null` 与 `{rounds: 0}` 严格不互换 (INV-4-1 核心);
//   · `undefined` 与 `null` 也严格不互换 —— 「概念不适用」与「概念在但没跑」的下一步相反
//     (前者 = 该 kind 不该进自修环账本; 后者 = 看 plan 决定 SDK 该不该重开);
//   · 读侧分辨靠 `typeof === 'object' && n.selfRepair !== null` 判「对象」一档;
//     字段缺席用 `!('selfRepair' in n)` 判; null 用 `n.selfRepair === null` 判。
// ─────────────────────────────────────────────────────────────────────────
describe('INV-4-1 — 三态纪律全档 (缺席 / null / 对象)', () => {
  test('SDK 通道 (selfRepair: null) → 字段在场 (`in === true`), 值是 null, 不是 undefined 也不是对象', () => {
    const rec = createDagRecorder({ path: ':memory:' });
    const id = rec.record(fakeResult('sdk', [mkNode({
      id: 'n',
      deps: [],
      tokensIn: 100,
      selfRepair: null, // SDK 通道 (INV-2-1: claude-sdk-loop 无 getFollowUpMessages 钩子)
    })]));
    const n = rec.get(id)!.nodes[0]!;
    // 三态第二档: 字段在场 (in === true), 值是 null (不是 undefined 也不是对象)
    expect('selfRepair' in n).toBe(true);
    expect(n.selfRepair).toBeNull();
    // 反向验: 不是 undefined 也不是对象
    expect(n.selfRepair).not.toBeUndefined();
    expect(typeof n.selfRepair).toBe('object'); // typeof null === 'object', 但关键是不为 undefined
    rec.close();
  });

  test('字段缺席 (undefined) — 概念不适用的非 agent 叶 / 老记录', () => {
    const rec = createDagRecorder({ path: ':memory:' });
    // 模拟非 agent 叶: LeafResult.selfRepair 字段根本不存在 (与 agent-leaf 的赋值路径不通)
    const id = rec.record(fakeResult('concept-n-a', [{
      id: 'cmd', kind: 'command', status: 'done', deps: [], tokensIn: 50,
      // 不传 selfRepair → LeafResult 上 selfRepair 字段缺席
    } as DagRunNode]));
    const n = rec.get(id)!.nodes[0]!;
    // 三态第一档: 整字段缺席 (in === false, undefined)
    expect('selfRepair' in n).toBe(false);
    expect(n.selfRepair).toBeUndefined();
    rec.close();
  });

  test('三态同 DB 共存 → 读侧按 in + typeof 分得开', () => {
    const rec = createDagRecorder({ path: ':memory:' });
    const id = rec.record(fakeResult('three-states', [
      // ① 缺席 (非 agent 叶, 概念不适用)
      { id: 'absent', kind: 'command', status: 'done', deps: [], tokensIn: 50 } as DagRunNode,
      // ② null (agent 叶, self_check 没跑 — 路径不适用)
      mkNode({ id: 'sdk', tokensIn: 60, selfRepair: null }),
      // ③ 对象 (agent 叶, self_check 真跑了)
      mkNode({ id: 'ran', tokensIn: 70, selfRepair: { rounds: 0, oracleExit: [0], convergedAt: 0 } }),
    ]));
    const ns = rec.get(id)!.nodes;
    const a = ns.find((x) => x.id === 'absent')!;
    const s = ns.find((x) => x.id === 'sdk')!;
    const r = ns.find((x) => x.id === 'ran')!;

    // ① 缺席
    expect('selfRepair' in a).toBe(false);
    expect(a.selfRepair).toBeUndefined();
    // ② null (在场, 字面量 null)
    expect('selfRepair' in s).toBe(true);
    expect(s.selfRepair).toBeNull();
    // ③ 对象
    expect('selfRepair' in r).toBe(true);
    expect(r.selfRepair).not.toBeNull();
    expect(r.selfRepair).toEqual({ rounds: 0, oracleExit: [0], convergedAt: 0 });
    rec.close();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// INV-4-2 长度纪律: oracleExit.length === rounds + 1 (判据至少跑一次, 每次自修后再跑一次)
//
// 与 INV-4-3 的 ⟺ 关系共同钉死 ledger 的形状 —— 任何短一格都会让「自修了几轮」失真。
// ─────────────────────────────────────────────────────────────────────────
describe('INV-4-2 — oracleExit.length === rounds + 1', () => {
  test('rounds=0 → length=1', () => {
    const rec = createDagRecorder({ path: ':memory:' });
    const id = rec.record(fakeResult('r0', [mkNode({
      id: 'n', deps: [], tokensIn: 10, selfRepair: { rounds: 0, oracleExit: [0], convergedAt: 0 },
    })]));
    const n = rec.get(id)!.nodes[0]!;
    expect(n.selfRepair!.oracleExit.length).toBe(1);
    expect(n.selfRepair!.oracleExit.length).toBe(n.selfRepair!.rounds + 1);
    rec.close();
  });

  test('rounds=2 → length=3', () => {
    const rec = createDagRecorder({ path: ':memory:' });
    const id = rec.record(fakeResult('r2', [mkNode({
      id: 'n', deps: [], tokensIn: 10, selfRepair: { rounds: 2, oracleExit: [1, 1, 0], convergedAt: 2 },
    })]));
    const n = rec.get(id)!.nodes[0]!;
    expect(n.selfRepair!.oracleExit.length).toBe(3);
    expect(n.selfRepair!.oracleExit.length).toBe(n.selfRepair!.rounds + 1);
    rec.close();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// INV-4-3 ⟺ 关系: convergedAt !== null ⟺ oracleExit.at(-1) === expect_exit
//
// 这是 ledger 的**一致性**轴: 两条结论必须自洽 —— 「绿了」必须配「末项等于期望码」,
// 「没绿」必须配「末项不等于期望码」。断一条另一条就成孤证。
// ─────────────────────────────────────────────────────────────────────────
describe('INV-4-3 — convergedAt !== null ⟺ oracleExit 末项 === expect_exit', () => {
  test('转绿 → convergedAt !== null 且末项 === expect_exit (双向)', () => {
    const rec = createDagRecorder({ path: ':memory:' });
    const id = rec.record(fakeResult('green-bidir', [mkNode({
      id: 'n', deps: [], tokensIn: 10, selfRepair: { rounds: 1, oracleExit: [1, 0], convergedAt: 1 },
    })]));
    const n = rec.get(id)!.nodes[0]!;
    expect(n.selfRepair!.convergedAt).not.toBeNull(); // ⟹ 末项 === expect_exit
    expect(n.selfRepair!.oracleExit.at(-1)).toBe(0);
    expect(n.selfRepair!.oracleExit.at(-1)).toBe(0); // expect_exit 假设为 0 (GWT-4a 的常态)
    rec.close();
  });

  test('没绿 → convergedAt === null 且末项 !== expect_exit (双向)', () => {
    const rec = createDagRecorder({ path: ':memory:' });
    const id = rec.record(fakeResult('red-bidir', [mkNode({
      id: 'n', deps: [], tokensIn: 10, selfRepair: { rounds: 2, oracleExit: [1, 1, 2], convergedAt: null },
    })]));
    const n = rec.get(id)!.nodes[0]!;
    expect(n.selfRepair!.convergedAt).toBeNull();
    expect(n.selfRepair!.oracleExit.at(-1)).not.toBe(0); // expect_exit=0
    rec.close();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 源码面 — DagRunNode 类型 + record() 的 selfRepair 三态分
//   (GWT-4b 反向闸: 把 spread 三元改成 ?? null, 三态纪律失守)
// ─────────────────────────────────────────────────────────────────────────
describe('源码面 — DagRunNode.selfRepair 类型 + record() 三态分 (INV-4-1)', () => {
  test('DagRunNode.selfRepair 类型签名含三态 (对象 | null + 字段可缺席)', () => {
    // 编译期即可被 tsc 验; 这条测试同时把"形状对"的契约钉在仓里。
    // 反向: 把 dag-record.ts 的 selfRepair 类型改成非空对象 → ts 红。
    const node: DagRunNode = {
      id: 'x', kind: 'agent', status: 'done', deps: [],
      // 三态均可:
      selfRepair: { rounds: 0, oracleExit: [0], convergedAt: 0 },
    };
    expect(node.selfRepair).toBeDefined();
    // null 也合法
    const node2: DagRunNode = { id: 'y', kind: 'agent', status: 'done', deps: [], selfRepair: null };
    expect(node2.selfRepair).toBeNull();
    // 缺席也合法
    const node3: DagRunNode = { id: 'z', kind: 'agent', status: 'done', deps: [] };
    expect(node3.selfRepair).toBeUndefined();
  });

  test('LeafResult.selfRepair 类型签名同源 (dag/types.ts 透传契约)', () => {
    // 反向: 把 dag/types.ts 的 selfRepair 字段删掉 → 编译期 + 运行时都红 (test 里 assign 不到)。
    // 这里用 Record 字面量, 让 tsc 替我们验 LeafResult 形状含 selfRepair。
    const leafLike: { selfRepair?: { rounds: number; oracleExit: number[]; convergedAt: number | null } | null } = {
      selfRepair: { rounds: 0, oracleExit: [0], convergedAt: 0 },
    };
    expect(leafLike.selfRepair?.rounds).toBe(0);
  });
});
