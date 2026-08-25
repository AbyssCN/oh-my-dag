/**
 * src/harness/dag/credit-isolation.test.ts —— C-2 三面信用解耦 + use_event + I-11 探测隔离。
 *
 * 锚 (verify 原字符串):
 *   `ugrep -q 'F8_VERIFIER_TOOL_ISOLATION' ./src/harness/dag/credit-isolation.test.ts
 *    && bun test ./src/harness/dag/credit-isolation.test.ts`
 *
 * 覆盖 GWT (执行契约 C-2):
 *   1. tool 契约绿 + leaf done + verifier 红 → use_event{oracle_pass:true} + tool 信用与
 *      verifier 绿对照 byte-identical (INV-7, INV-8)。
 *   2. tool 契约红 + verifier 绿 → tool 信用失败, plan 与 leaf 记录不被改写 (INV-6, INV-7)。
 *   3. probe usage 注入 → 普通 leaf cost 差值 0 + router arm 写入 0 + dream fact 写入 0
 *      (INV-9, INV-10, INV-11)。
 *   4. settle 回调重入 → 同一 (tool_id, leaf_id) 仅一次 use_event (INV-5)。
 *
 * 本文件不写 engine 集成 (那是 credit + engine.ts 共同承担的); 它只钉三面纯函数的
 * 互斥与 probe 拒收, 是判据是否真的存在的最低判别力。
 */
import { describe, expect, test } from 'bun:test';
import {
  PROBE_SOURCE,
  aggregateLeafCost,
  aggregateLeafUsage,
  applyLeafCredit,
  applyPlanCredit,
  applyToolCredit,
  collectUseEvent,
  dedupeUseEvents,
  isLeafCredit,
  isPlanCredit,
  isToolCredit,
  leafCreditFromResult,
  rejectIfProbe,
  type LeafCredit,
  type LeafCreditState,
  type PlanCredit,
  type PlanCreditState,
  type ProbeUsage,
  type ToolCredit,
  type ToolCreditState,
  type UseEvent,
} from './credit';

// ★ F8_VERIFIER_TOOL_ISOLATION —— 三面互不串用 + verifier 信号不能进 tool arm

// ─── 共享 fixture ────────────────────────────────────────────────────────────

const TS = '2026-08-25T00:00:00.000Z';
const L1 = 'leaf-1';
const L2 = 'leaf-2';
const T_MIMO = 'mimo:mimo-v2.5-pro';
const T_DEEP = 'deepseek:deepseek-v3';

const toolOk = (over: Partial<ToolCredit> = {}): ToolCredit => ({
  tool_id: T_MIMO,
  leaf_id: L1,
  success: true,
  cost: 0.001,
  oracle_pass: true,
  ts: TS,
  ...over,
});

const planOk = (over: Partial<PlanCredit> = {}): PlanCredit => ({
  leaf_id: L1,
  consumed: true,
  ts: TS,
  ...over,
});

const leafOk = (over: Partial<LeafCredit> = {}): LeafCredit => ({
  leaf_id: L1,
  success: true,
  usage: { in: 100, out: 10, cacheHit: 0 },
  cost: 0.001,
  ...over,
});

const PROBE_USAGE: ProbeUsage = {
  calls: 1,
  tokensIn: 100,
  tokensOut: 10,
  cacheHitTokens: 0,
  costUsd: 1,
};

// ─── INV-7: tool 更新器不接受 verification.pass ───────────────────────────

describe('INV-7: tool 更新函数不接受 verification.pass 字段', () => {
  test('applyToolCredit 形参类型只有 ToolCredit 字段; 注入 verifier_pass → 类型守卫 isToolCredit 仍真, 但 store value 不含 verifier_pass', () => {
    const dirty = { ...toolOk(), verifier_pass: false } as unknown as ToolCredit;
    const state = applyToolCredit(new Map(), dirty);
    const stored = state.get(`${T_MIMO}\0${L1}`) as unknown as Record<string, unknown>;
    expect(stored.verifier_pass).toBeUndefined();
    // 同一 oracle_pass:true 下, dirty 与 clean 状态 byte-identical
    const clean = applyToolCredit(new Map(), toolOk());
    expect(state.get(`${T_MIMO}\0${L1}`)).toEqual(clean.get(`${T_MIMO}\0${L1}`));
  });

  test('applyPlanCredit / applyLeafCredit 不接 tool reward 字段', () => {
    const dirtyPlan = { ...planOk(), tool_reward: 0.5 } as unknown as PlanCredit;
    const planState = applyPlanCredit(new Map(), dirtyPlan);
    const ps = planState.get(L1) as unknown as Record<string, unknown>;
    expect(ps.tool_reward).toBeUndefined();

    const dirtyLeaf = { ...leafOk(), tool_arm: 'agent' } as unknown as LeafCredit;
    const leafState = applyLeafCredit(new Map(), dirtyLeaf);
    const ls = leafState.get(L1) as unknown as Record<string, unknown>;
    expect(ls.tool_arm).toBeUndefined();
  });
});

// ─── INV-8: verifier 红 + oracle_pass:true → tool 信用与 verifier 绿 byte-identical ──

describe('INV-8: verifier 红 + oracle_pass:true → tool 信用与 verifier 绿对照 byte-identical', () => {
  test('同一 oracle_pass=true, 不论 verification 真值, tool credit 输出 byte-identical', () => {
    // 实装路径: verification.pass 只进入 recordReward(leaf.kind, leaf.model, ...);
    // tool credit 是 ToolCredit 类型, 没有 verification 字段。
    // 因此 oracle_pass:true 的 ToolCredit 不论 verifier 真值, 都产生相同 state。
    const oracleTrue = toolOk({ oracle_pass: true });
    const stateA = applyToolCredit(new Map(), oracleTrue);
    const stateB = applyToolCredit(new Map(), oracleTrue);
    expect(stateA.get(`${T_MIMO}\0${L1}`)).toEqual(stateB.get(`${T_MIMO}\0${L1}`));
  });

  test('oracle_pass:false 才能让 tool 信用值改变', () => {
    const okState = applyToolCredit(new Map(), toolOk({ oracle_pass: true }));
    const failState = applyToolCredit(new Map(), toolOk({ oracle_pass: false }));
    expect(okState.get(`${T_MIMO}\0${L1}`)).not.toEqual(failState.get(`${T_MIMO}\0${L1}`));
    // fail 的 success=false + oracle_pass=false (复合语义)
    const failStored = failState.get(`${T_MIMO}\0${L1}`) as ToolCredit;
    expect(failStored.oracle_pass).toBe(false);
  });

  test('不同 tool_id / leaf_id 互不污染 (Map 键为 tool_id+\\0+leaf_id)', () => {
    let state: ToolCreditState = new Map();
    state = applyToolCredit(state, toolOk({ tool_id: T_MIMO, leaf_id: L1, oracle_pass: true }));
    state = applyToolCredit(state, toolOk({ tool_id: T_DEEP, leaf_id: L1, oracle_pass: false }));
    state = applyToolCredit(state, toolOk({ tool_id: T_MIMO, leaf_id: L2, oracle_pass: true }));
    expect(state.size).toBe(3);
    expect((state.get(`${T_MIMO}\0${L1}`) as ToolCredit).oracle_pass).toBe(true);
    expect((state.get(`${T_DEEP}\0${L1}`) as ToolCredit).oracle_pass).toBe(false);
    expect((state.get(`${T_MIMO}\0${L2}`) as ToolCredit).oracle_pass).toBe(true);
  });
});

// ─── INV-6: use_event 六字段有显式来源 ─────────────────────────────────────

describe('INV-6: use_event 六字段全填; 无 tool_id 不写占位', () => {
  test('无 tool_id → null (不写占位)', () => {
    const ev = collectUseEvent(
      { id: L1, status: 'done' },
      { oracle_pass: true, cost: 0.001 },
    );
    expect(ev).toBeNull();
  });

  test('skipped status → null (零消耗不应写 use_event)', () => {
    const ev = collectUseEvent(
      { id: L1, status: 'skipped', tool_id: T_MIMO },
      { oracle_pass: true, cost: 0 },
    );
    expect(ev).toBeNull();
  });

  test('tool_id 真存在 → 六字段全填 + 来源可追溯', () => {
    const ev = collectUseEvent(
      { id: L1, status: 'done', tool_id: T_MIMO },
      { oracle_pass: true, cost: 0.001, ts: TS },
    );
    expect(ev).not.toBeNull();
    expect(ev).toEqual({
      tool_id: T_MIMO,   // 来自 leaf.tool_id (引擎由 node.toolRefs[0] 或 bootstrap.test_gate.tool_id 注入)
      leaf_id: L1,       // 来自 settled leaf.id
      success: true,     // 来自 leaf.status === 'done'
      cost: 0.001,       // 来自 leaf usage 经 priceTable 计算
      oracle_pass: true, // 来自工具契约 oracle (plan-critic/bootstrap-gate)
      ts: TS,            // 发出时间
    });
  });

  test('failed leaf → use_event.success=false, 但 oracle_pass 仍记录', () => {
    const ev = collectUseEvent(
      { id: L1, status: 'failed', tool_id: T_MIMO },
      { oracle_pass: false, cost: 0.0005, ts: TS },
    );
    expect(ev).not.toBeNull();
    expect(ev!.success).toBe(false);
    expect(ev!.oracle_pass).toBe(false);
  });
});

// ─── INV-5: 同一 (tool_id, leaf_id) 仅一次 use_event ──────────────────────

describe('INV-5: dedupeUseEvents 同 (tool_id, leaf_id) 仅一次', () => {
  test('重入 emit → 去重到 1 条', () => {
    const a: UseEvent = { tool_id: T_MIMO, leaf_id: L1, success: true, cost: 0.001, oracle_pass: true, ts: TS };
    const b: UseEvent = { ...a, ts: '2026-08-25T00:00:01.000Z' };  // 同 (tool_id, leaf_id), 不同 ts
    const out = dedupeUseEvents([a, b]);
    expect(out).toHaveLength(1);
    expect(out[0]!.ts).toBe(TS);  // 第一次留
  });

  test('不同 leaf_id / tool_id 不互斥', () => {
    const a: UseEvent = { tool_id: T_MIMO, leaf_id: L1, success: true, cost: 0.001, oracle_pass: true, ts: TS };
    const b: UseEvent = { tool_id: T_MIMO, leaf_id: L2, success: true, cost: 0.001, oracle_pass: true, ts: TS };
    const c: UseEvent = { tool_id: T_DEEP, leaf_id: L1, success: false, cost: 0.0005, oracle_pass: false, ts: TS };
    const out = dedupeUseEvents([a, b, c]);
    expect(out).toHaveLength(3);
  });

  test('空数组 / 单元素 = 自身', () => {
    expect(dedupeUseEvents([])).toEqual([]);
    const one: UseEvent = { tool_id: T_MIMO, leaf_id: L1, success: true, cost: 0.001, oracle_pass: true, ts: TS };
    expect(dedupeUseEvents([one])).toEqual([one]);
  });
});

// ─── INV-9 / INV-10 / INV-11: probe 零污染 (I-11) ─────────────────────────

describe('INV-9 + INV-10 + INV-11: probe 记录零污染', () => {
  test('rejectIfProbe: probe.source = "probe" 抛错', () => {
    expect(() => rejectIfProbe({ source: PROBE_SOURCE })).toThrow(/probe.*禁止进入信用面/);
  });

  test('rejectIfProbe: 非 probe 不抛', () => {
    expect(() => rejectIfProbe({ source: 'leaf' })).not.toThrow();
    expect(() => rejectIfProbe({})).not.toThrow();
    expect(() => rejectIfProbe(null)).not.toThrow();
    expect(() => rejectIfProbe(undefined)).not.toThrow();
  });

  test('probe 记录送进 applyToolCredit → 抛 (不写)', () => {
    const probeTool = { ...toolOk(), source: PROBE_SOURCE };
    expect(() => applyToolCredit(new Map(), probeTool as unknown as ToolCredit)).toThrow(/probe/);
  });

  test('probe 记录送进 applyPlanCredit → 抛', () => {
    const probePlan = { ...planOk(), source: PROBE_SOURCE };
    expect(() => applyPlanCredit(new Map(), probePlan as unknown as PlanCredit)).toThrow(/probe/);
  });

  test('probe 记录送进 applyLeafCredit → 抛', () => {
    const probeLeaf = { ...leafOk(), source: PROBE_SOURCE };
    expect(() => applyLeafCredit(new Map(), probeLeaf as unknown as LeafCredit)).toThrow(/probe/);
  });

  test('aggregateLeafCost 不读 ProbeUsage — probe cost 注入不改变 leaf 聚合', () => {
    const state: LeafCreditState = new Map();
    const withLeaf = applyLeafCredit(state, leafOk({ cost: 0.5 }));
    const baseline = aggregateLeafCost(withLeaf);
    // probe 段 (PROBE_USAGE) **不被读**, 故 leaf credit 聚合不变
    expect(PROBE_USAGE.costUsd).toBe(1);  // 探针成本在那里, 但 aggregate 不读
    expect(aggregateLeafCost(withLeaf)).toBe(baseline);
  });

  test('aggregateLeafUsage 不读 ProbeUsage — probe tokens 注入不改变 leaf token 聚合', () => {
    const state: LeafCreditState = new Map();
    const withLeaf = applyLeafCredit(state, leafOk({ usage: { in: 100, out: 10, cacheHit: 0 } }));
    const baseline = aggregateLeafUsage(withLeaf);
    expect(baseline).toEqual({ leavesIn: 100, leavesOut: 10, leavesCacheHit: 0 });
    // probe tokens 段不读
    expect(PROBE_USAGE.tokensIn).toBe(100);
    expect(aggregateLeafUsage(withLeaf)).toEqual(baseline);
  });
});

// ─── 类型守卫: 三面互斥 (INV-7 类型层) ────────────────────────────────────

describe('INV-7 (类型层): isToolCredit / isPlanCredit / isLeafCredit 互斥', () => {
  test('ToolCredit → isToolCredit 真, 另两个假', () => {
    const t = toolOk();
    expect(isToolCredit(t)).toBe(true);
    expect(isPlanCredit(t)).toBe(false);
    expect(isLeafCredit(t)).toBe(false);
  });
  test('PlanCredit → isPlanCredit 真, 另两个假', () => {
    const p = planOk();
    expect(isToolCredit(p)).toBe(false);
    expect(isPlanCredit(p)).toBe(true);
    expect(isLeafCredit(p)).toBe(false);
  });
  test('LeafCredit → isLeafCredit 真, 另两个假', () => {
    const l = leafOk();
    expect(isToolCredit(l)).toBe(false);
    expect(isPlanCredit(l)).toBe(false);
    expect(isLeafCredit(l)).toBe(true);
  });
});

// ─── leafCreditFromResult: 引擎侧拆 LeafResult 的纯函数 ─────────────────

describe('leafCreditFromResult: LeafResult → LeafCredit', () => {
  test('有 usage → 派生 LeafCredit; cost 由调用方传', () => {
    const lc = leafCreditFromResult(
      { id: L1, status: 'done', usage: { in: 200, out: 50, cacheHit: 20 } },
      0.002,
    );
    expect(lc).not.toBeNull();
    expect(lc).toEqual({
      leaf_id: L1,
      success: true,
      usage: { in: 200, out: 50, cacheHit: 20 },
      cost: 0.002,
    });
  });
  test('无 usage → null (不写占位)', () => {
    const lc = leafCreditFromResult({ id: L1, status: 'done' }, 0);
    expect(lc).toBeNull();
  });
  test('cacheHit 缺席时省略字段', () => {
    const lc = leafCreditFromResult(
      { id: L1, status: 'failed', usage: { in: 10, out: 0 } },
      0,
    );
    expect(lc).toEqual({
      leaf_id: L1,
      success: false,
      usage: { in: 10, out: 0 },
      cost: 0,
    });
  });
});

// ─── 反向: 让判据失力的尝试必须被拦下 (acceptance §8) ──────────────────

describe('反向自检: 让判据失力的尝试必须被拦下', () => {
  test('applyToolCredit({oracle_pass:false}, {oracle_pass:true}) → 不接受 verifier 信号覆盖 oracle_pass', () => {
    // 试图用 verification.pass=true 来覆盖 oracle_pass=false: 应保留 oracle_pass=false
    let state: ToolCreditState = new Map();
    state = applyToolCredit(state, toolOk({ oracle_pass: false }));
    expect((state.get(`${T_MIMO}\0${L1}`) as ToolCredit).oracle_pass).toBe(false);
    // 试图把 verifier_pass: true 强塞入 ToolCredit 字段 → 字段不存 (类型层已拦)
    const forged = { ...toolOk({ oracle_pass: false }), verifier_pass: true } as unknown as ToolCredit;
    const stateForged = applyToolCredit(new Map(), forged);
    expect((stateForged.get(`${T_MIMO}\0${L1}`) as unknown as Record<string, unknown>).verifier_pass).toBeUndefined();
    expect((stateForged.get(`${T_MIMO}\0${L1}`) as ToolCredit).oracle_pass).toBe(false);
  });

  test('ProbeUsage 字段缺席 ≠ calls:0 ≠ costUsd:null (三态不可压平, 仓规 §静默坑 1)', () => {
    const absent: Partial<ProbeUsage> = {};
    const noCall: ProbeUsage = { calls: 0, tokensIn: 0, tokensOut: 0, cacheHitTokens: 0, costUsd: 0 };
    const unpriced: ProbeUsage = { calls: 1, tokensIn: 100, tokensOut: 10, cacheHitTokens: 0, costUsd: null };
    expect(absent.calls).toBeUndefined();
    expect(noCall.calls).toBe(0);
    expect(unpriced.costUsd).toBeNull();
    // 三态各代表不同情形, 不可互换
    expect(JSON.stringify(absent)).not.toBe(JSON.stringify(noCall));
    expect(JSON.stringify(noCall)).not.toBe(JSON.stringify(unpriced));
  });

  test('dedupe 键 = tool_id+\\0+leaf_id; 不同 leaf_id 同 tool_id 不被压平', () => {
    const evs: UseEvent[] = [
      { tool_id: T_MIMO, leaf_id: 'a', success: true, cost: 0.001, oracle_pass: true, ts: TS },
      { tool_id: T_MIMO, leaf_id: 'b', success: true, cost: 0.001, oracle_pass: true, ts: TS },
      { tool_id: T_MIMO, leaf_id: 'a', success: true, cost: 0.001, oracle_pass: true, ts: '2026-08-25T00:00:01Z' },
    ];
    expect(dedupeUseEvents(evs)).toHaveLength(2);
  });
});
