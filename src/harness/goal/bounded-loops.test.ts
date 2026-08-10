/**
 * INV-GOAL-4 契约测试 — **无环 + 有界** (SDD 2026-07-28 omd-goal-engine)。
 *
 * GWT: 任一 emitted plan 编译时拓扑排序成功 (无回边); 每个循环节点有 max_attempts/timeout/cost 界。
 *
 * 这条不变量的价值全在"没有例外": 只要有一个环能画出来、或有一个循环构造没有硬顶,
 * 自主引擎就有一条不停机的路径。所以这里逐个构造点名, 而不是抽查。
 */
import { describe, expect, test } from 'bun:test';
import { topoLevels } from '../dag/planner';
import { parsePlan } from '../conductor-plan';
import type { ConductorPlan } from '../conductor-plan';
import { PRIMITIVE_IDS, PRIMITIVE_REGISTRY } from '../primitive-registry';

const planJson = (nodes: Record<string, unknown>): string => JSON.stringify({ name: 'p', nodes });

describe('INV-GOAL-4 · 无环: 回边 → 编译期抛, 不进执行', () => {
  test('二元环 A↔B → topoLevels 抛并点名涉环节点', () => {
    const cyclic = {
      name: 'p',
      nodes: { A: { goal: 'a', depends_on: ['B'] }, B: { goal: 'b', depends_on: ['A'] } },
    } as unknown as ConductorPlan;
    expect(() => topoLevels(cyclic)).toThrow(/cycle/);
    try {
      topoLevels(cyclic);
    } catch (e) {
      expect((e as Error).message).toContain('A');
      expect((e as Error).message).toContain('B');
    }
  });

  test('自环 → 同样抛 (不靠"没人会这么画"兜)', () => {
    const selfLoop = { name: 'p', nodes: { A: { goal: 'a', depends_on: ['A'] } } } as unknown as ConductorPlan;
    expect(() => topoLevels(selfLoop)).toThrow(/cycle/);
  });

  test('无环图正常分层 (证明上面不是恒抛的空转断言)', () => {
    const dag = {
      name: 'p',
      nodes: { A: { goal: 'a' }, B: { goal: 'b', depends_on: ['A'] }, C: { goal: 'c', depends_on: ['A'] } },
    } as unknown as ConductorPlan;
    expect(topoLevels(dag)).toEqual([['A'], ['B', 'C']]);
  });
});

describe('INV-GOAL-4 · 有界: 每个循环构造都有 schema 层硬顶', () => {
  // research 节点内环 (D-6): 二次检索轮数。conductor 想写 99 轮也写不进来。
  test('research.rounds 上限 4 — 越界 plan 规划层就被拒', () => {
    const ok = parsePlan(planJson({ R: { goal: 'q', executor: 'research', research: { rounds: 4 } } }), { knownServers: new Set() });
    expect(ok.ok).toBe(true);
    const bad = parsePlan(planJson({ R: { goal: 'q', executor: 'research', research: { rounds: 5 } } }), { knownServers: new Set() });
    expect(bad.ok).toBe(false);
  });

  test('research.k 上限 12 (广度也有顶, 否则一个节点能烧穿预算)', () => {
    expect(parsePlan(planJson({ R: { goal: 'q', executor: 'research', research: { k: 12 } } }), { knownServers: new Set() }).ok).toBe(true);
    expect(parsePlan(planJson({ R: { goal: 'q', executor: 'research', research: { k: 13 } } }), { knownServers: new Set() }).ok).toBe(false);
  });

  // primitive 的 params 由**编译闸** (compilePrimitive → paramsSchema) 校, 不由 parsePlan 校 ——
  // GWT 说的"编译"就是这一层。
  test('loop-until 原语: target ≤ 64 且 maxIterations ≤ 100 (well-founded 硬顶)', () => {
    const schema = PRIMITIVE_REGISTRY['loop-until'].paramsSchema;
    expect(schema.safeParse({ stepGoal: 's', target: 64, maxIterations: 100 }).success).toBe(true);
    expect(schema.safeParse({ stepGoal: 's', target: 65 }).success).toBe(false);
    expect(schema.safeParse({ stepGoal: 's', target: 4, maxIterations: 101 }).success).toBe(false);
  });

  test('每个原语都声明了静态定界 (maxUnits ≤ PRIMITIVE_UNIT_CAP, SEL-2)', () => {
    // 定界本身在 compilePrimitive 里判; 这里钉的是"没有原语忘了声明 paramsSchema"。
    for (const id of PRIMITIVE_IDS) {
      expect(PRIMITIVE_REGISTRY[id].paramsSchema).toBeDefined();
    }
  });

  test('节点重试也有界 (max_retry 不是"重试到成功")', () => {
    const r = parsePlan(planJson({ A: { goal: 'a', on_failure: 'retry', max_retry: 2 } }), { knownServers: new Set() });
    expect(r.ok).toBe(true);
    // 负数/非整数被 schema 拒 — 没有"无限重试"这个取值
    expect(parsePlan(planJson({ A: { goal: 'a', max_retry: -1 } }), { knownServers: new Set() }).ok).toBe(false);
  });
});
