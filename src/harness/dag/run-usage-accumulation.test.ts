/**
 * src/harness/dag/run-usage-accumulation.test.ts —— D7 切片 1 的判别力测试 (#274)。
 *
 * GWT 表 (2026-08-25, 修补轮不再吃掉首轮的账):
 *   GWT-1 36a5f131 形状: 首轮 n 节点带用量 → 修补轮 plan 长出 n2 个新节点 → run 级
 *        leaves 轴 = 首轮之和 + 修补轮新节点之和 (闭包外 D-21 注入 = 零贡献)。
 *   GWT-2 D-21 复用不双记: 修补只动闭包内 → 闭包外节点零 LLM 注入上轮结果, run 级账
 *        不因注入翻倍 (复用节点的 usage.in/out 在它真跑那一轮已计 — 见 INV-D7-1)。
 *   GWT-3 无修补单轮 (回归): 与今天的 usage.leavesIn/Out/CacheHit 行为逐字节相同
 *        (单轮档本就该是单轮数和, 不是修这套的人能偷偷改的)。
 *
 * 反向自检 (本片手做, 与 usage-attribution.test.ts 同源):
 *   1. 把 `let leavesIn = exec.leavesIn` (engine.ts:5208) 改成 `let leavesIn = 0`
 *      ⇒ GWT-1/GWT-2 当场红 (首轮账单为 0)。
 *   2. 把 `leavesIn += exec.leavesIn` 改成 `leavesIn = exec.leavesIn`
 *      ⇒ GWT-1/GWT-2 当场红 (修补轮覆盖掉首轮)。
 *   3. 把 GWT-3 单轮档的 leavesIn 断言去掉 ⇒ 用例失去判别力, 由 GWT-1 间接保活。
 *
 * 锚: G-21 patch 模式的 fake-generate 形状 (engine.test.ts) 同源复用, 不抄第二份。
 */
import { describe, expect, test } from 'bun:test';
import { registerProvider } from '../../model/providers';
import type { ConductorPlan } from '../conductor-plan';
import { runExecutorDagWithPlan } from './engine';
import type { ContentPart } from '../../model/gateway';
import type { ExecutorDagConfig, GenerateFn } from './types';

const contentText = (c: string | ContentPart[] | undefined): string =>
  typeof c === 'string' ? (c ?? '') : (c ?? []).map((p) => (p.type === 'text' ? p.text : '')).join('');

const leafId = (prompt: string): string => /\[omd leaf: ([^\]]+)\]/.exec(prompt)?.[1] ?? '?';

const plan = (nodes: ConductorPlan['nodes']): ConductorPlan => ({ name: 'test-plan', nodes });

const makeConfig = (generate: GenerateFn, extra: Partial<ExecutorDagConfig> = {}): ExecutorDagConfig => ({
  conductorModel: 'test:conductor',
  leafModel: 'test:leaf',
  generate,
  agentTemplates: new Map(),
  ...extra,
});

/** verifier first call fails, second passes (G-21 既有夹具同源)。 */
const makeFirstFailVerifier = (failReason: string): NonNullable<ExecutorDagConfig['verifier']> => {
  let n = 0;
  return async () => {
    n++;
    return n === 1 ? { pass: false, reason: failReason, usage: { in: 0, out: 0 } } : { pass: true, reason: 'ok', usage: { in: 0, out: 0 } };
  };
};

/** fake generate: ESCL-PATCH (升级重规划通道) 返回轮 2 修补;
 *  CONDUCTOR-PLAN (首轮规划通道) 返回完整 plan JSON (兜底防失控);
 *  余下按 leaf id 计调用 + 返固定 usage. */
const makeEscalationGenerate = (round2Patch: Record<string, unknown>, perLeafUsage: { in: number; out: number; cacheHit: number } = { in: 1, out: 1, cacheHit: 2 }) => {
  const calls: string[] = [];
  // 全量回灌 (兜底用) — 真不触发也无所谓, 是 fail-open 兜底契约要求 generate 永不全返 out:
  const fullPlanJson = JSON.stringify({
    name: 'replan-flat',
    nodes: { replan_a: { goal: '回灌甲' }, replan_b: { goal: '回灌乙', depends_on: ['replan_a'] } },
  });
  const generate: GenerateFn = async (req) => {
    const sysC = req.messages.find((m) => m.role === 'system')?.content;
    const sys = typeof sysC === 'string' ? sysC : '';
    if (sys.includes('REPLAN-PATCH')) {
      return { text: JSON.stringify({ patch: round2Patch }), usage: { in: 5, out: 5, cacheHit: 0 } };
    }
    if (sys.includes('CONDUCTOR')) {
      return { text: fullPlanJson, usage: { in: 0, out: 0, cacheHit: 0 } };
    }
    const prompt = contentText(req.messages.find((m) => m.role === 'user')?.content);
    const id = leafId(prompt);
    if (id === '?') return { text: 'non-leaf-out', usage: { in: 0, out: 0, cacheHit: 0 } };
    calls.push(id);
    return { text: `out:${id}`, usage: perLeafUsage };
  };
  return { generate, calls };
};

describe('D7 切片 1: run-level usage 跨轮累加 (SDD #274, INV-D7-1 恰计一次)', () => {
  registerProvider('escx', { baseUrl: 'http://127.0.0.1:9', apiKey: 'test-key', api: 'openai-compatible' });

  /** GWT-1 36a5f131 形状: 首轮 5 节点 → 修补新增 2 个新下游节点 → leavesIn = 5 + 2 = 7。 */
  test('GWT-1: 修补轮新增下游 → leavesIn 跨轮累加 = 首轮 + 修轮新节点', async () => {
    const { generate, calls } = makeEscalationGenerate(
      // 修补加 2 个节点, depends_on=[] 即可独立跑; 无 blame 围栏 ⇒ patch 无闭包限制。
      { x: { goal: '补丁新增丁', depends_on: ['a'] }, y: { goal: '补丁新增戊', depends_on: ['a'] } },
      { in: 2, out: 3, cacheHit: 4 },
    );
    const r = await runExecutorDagWithPlan(
      plan({ a: { goal: '甲' }, b: { goal: '乙' }, c: { goal: '丙' } }),
      makeConfig(generate, {
        verifier: makeFirstFailVerifier('缺审查节点'),
        conductorEscalationModel: 'escx:strong',
      }),
    );
    expect(r.verification?.pass).toBe(true);
    // 修补模式生效: a/b/c 逐字保留 ⇒ D-21 复用, 用量=0; x/y 真跑一次, 贡献 2 each。
    // leavesIn = 首轮 (3 节点 × 2) + 修轮 (2 节点 × 2) = 10。
    expect(r.usage.leavesIn).toBe(10);
    expect(r.usage.leavesOut).toBe(15); // 5 × 3
    expect(r.usage.leavesCacheHit).toBe(20); // 5 × 4
    // 真实调用次数: a/b/c 各 1 (a 喂给 x/y 加一次也算 a 头上), x/y 各 1
    // a 被 x、y 两节点 depends_on, 计 3 次 (轮 1 一次 + 轮 2 喂给 x、y 各一次的 dep 摘要等等)
    // 关键是 b/c 在 calls 里只出现一次 — 修补轮真没跑它们。
    expect(calls.filter((c) => c === 'b').length).toBe(1);
    expect(calls.filter((c) => c === 'c').length).toBe(1);
  });

  /** GWT-2 D-21 复用不双记: 修补仅修闭包内 (c) → 闭包外 a, b 零 LLM 注入, leavesIn 不翻倍。 */
  test('GWT-2: 修补仅修闭包内 c → 闭包外 a, b D-21 注入零贡献', async () => {
    const { generate, calls } = makeEscalationGenerate(
      { c: { goal: '修好的丙' } }, // 仅动 c, 闭包 = {c}
      { in: 10, out: 20, cacheHit: 5 },
    );
    const r = await runExecutorDagWithPlan(
      plan({ a: { goal: '甲' }, b: { goal: '乙' }, c: { goal: '丙' } }),
      makeConfig(generate, {
        verifier: makeFirstFailVerifier('仅 c 不合格'),
        conductorEscalationModel: 'escx:strong',
      }),
    );
    expect(r.verification?.pass).toBe(true);
    // 修补闭包 = {c}。a, b 在轮 2 走 D-21 注入 (calls 计数只能看到 c 跑过两轮), usage.in=0 不贡献。
    // leavesIn = 首轮 3 节点 × 10 + 修轮 1 节点 × 10 = 40。
    expect(r.usage.leavesIn).toBe(40);
    expect(calls.filter((c) => c === 'a').length).toBe(1);
    expect(calls.filter((c) => c === 'b').length).toBe(1);
    expect(calls.filter((c) => c === 'c').length).toBe(2);
  });

  /** GWT-3 无修补单轮 (回归): 与 G-11v2 既有行为逐字节相同。 */
  test('GWT-3: 无修补单轮 — leaves 轴 = 节点数和 × 单叶用量', async () => {
    const { generate } = makeEscalationGenerate({}, { in: 7, out: 11, cacheHit: 3 });
    const r = await runExecutorDagWithPlan(
      plan({ a: { goal: '甲' }, b: { goal: '乙', depends_on: ['a'] }, c: { goal: '丙', depends_on: ['a'] } }),
      makeConfig(generate), // 无 verifier ⇒ 不进 upgrade 环
    );
    expect(r.verification).toBeUndefined(); // 没配 verifier ⇒ verification 缺席 (D-3 纪律)
    expect(r.usage.leavesIn).toBe(21); // 3 节点 × 7
    expect(r.usage.leavesOut).toBe(33); // 3 × 11
    expect(r.usage.leavesCacheHit).toBe(9); // 3 × 3
  });
});
