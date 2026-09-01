/**
 * `src/eval/replay/fitness.ts` 契约 C-3 真值链断言。
 *
 * 真值链逐跳写在每条 fixture 注释里 (plan-fake-serial.json / plan-clean.json 的
 * `_fixtureTruthChain` 段)。反向自检 (锁死判据力):
 *  - FAKE_SERIAL_TRUTH: 把 `expect(fakeFitness.fakeSerialPairs).toBeGreaterThan(0)` 改成
 *    `toBe(0)` ⇒ 红 (假串行判定真接住 fixture, 不是注释旁路);
 *  - 把 cleanFitness 期望 `toBe(0)` 改成 `toBeGreaterThan(0)` ⇒ 红 (有可观察输出的边
 *    不会被错判为假串行);
 *  - 把 parsePlan 喂 brokenText (形如 `'not json at all'`) 后 planValidity 期望 true
 *    改成 false ⇒ 红 (parsePlan 走 zod 真在拒);
 *  - 在 aggregateFitness 里塞一个 `shapeDeclared:true` 但期望 shapeDeclarationRate=0
 *    ⇒ 红 (聚合真在数, 不是写死的常数)。
 *
 * 桩规划 (stub): 不写第二个「plan 是否有效」判定 —— 严格走 src/harness/conductor-plan
 * 的 parsePlan (INV-4 复盘: 仓内不出现第二个 plan validity 判定)。
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  aggregateFitness,
  computeFitness,
  estimateTokens,
  fakeSerialPairsOf,
  speedupTheoreticalOf,
  type PlanFitness,
} from './fitness';
import type { ConductorPlan } from '../../harness/conductor-plan';
import { parsePlan } from '../../harness/conductor-plan';

const FIXTURE_DIR = join(import.meta.dir, 'fixtures');

function loadFixture(name: string): { plan: ConductorPlan; rawText: string } {
  const rawText = readFileSync(join(FIXTURE_DIR, name), 'utf8');
  // 解析时一并剥掉 `_fixtureIntent` / `_fixtureTruthChain` 注释字段 (passthrough 但不进判据)
  const parsed = JSON.parse(rawText) as Record<string, unknown>;
  delete parsed['_fixtureIntent'];
  delete parsed['_fixtureTruthChain'];
  const cleanText = JSON.stringify(parsed);
  const res = parsePlan(cleanText, { knownTemplates: new Set(), knownServers: new Set() });
  if (!res.ok) throw new Error(`fixture ${name} 自身坏: ${res.error}`);
  return { plan: res.plan, rawText: cleanText };
}

// =====================================================================
// FAKE_SERIAL_TRUTH — C-3 真值链 (fixture 真值, 改 fixture / 改判定 ⇒ 红)
// =====================================================================
describe('FAKE_SERIAL_TRUTH — C-3 假串行对真值', () => {
  test('fake-serial fixture → fakeSerialPairs > 0 (5 条假串行边)', () => {
    // 真值链 (写在 fixture 文件的 _fixtureTruthChain 段):
    //   · lint / typecheck / format / final 四节点
    //   · format depends_on [lint, typecheck] — 两端都无 output_path, format goal/args 都空
    //   · final depends_on [format, lint, typecheck] — 同理, final.goal='summarize results' 不含 id
    //   · 5 条 depends_on 边全部满足 (无可观察输出 ∧ 文本不含依赖 id)
    const { plan, rawText } = loadFixture('plan-fake-serial.json');
    const fit = computeFitness({ plan, rawText });
    expect(fit.fakeSerialPairs).toBeGreaterThan(0);
    // 锁死具体数 (fixture 设计: 5 条);改 fixture 或改 fakeSerialPairsOf 都会立刻红。
    expect(fit.fakeSerialPairs).toBe(5);
  });

  test('clean fixture → fakeSerialPairs === 0 (3 条 depends_on 边全部因 output_path 放行)', () => {
    // 真值链:
    //   · compile.output_path='dist/index.js', test.output_path='test-results.json'
    //   · test depends_on compile (compile 有 output_path → 放行)
    //   · package depends_on test (test 有 output_path → 放行)
    //   · 3 条边全部因 hasObservableOutput 提前 continue → count = 0
    const { plan, rawText } = loadFixture('plan-clean.json');
    const fit = computeFitness({ plan, rawText });
    expect(fit.fakeSerialPairs).toBe(0);
  });

  test('fakeSerialPairsOf 对纯串行 fixture 仍按判定规则走 (有 output_path 即放行)', () => {
    // 直调 fakeSerialPairsOf, 验证 clean fixture 拆出来的 plan 走判定分支;
    //   反向: 改成把 output_path 删掉的同 plan → fakeSerialPairs 应跳到 >0 (此处不写,
    //   留作未来调试断言; 当前的断言已锁 0)。
    const { plan } = loadFixture('plan-clean.json');
    expect(fakeSerialPairsOf(plan)).toBe(0);
  });
});

// =====================================================================
// planValidity 维 — parsePlan 同尺复用 (不写第二个判定)
// =====================================================================
describe('planValidity 维 — parsePlan 同尺', () => {
  test('合法 fixture → planValidity=true', () => {
    const { plan, rawText } = loadFixture('plan-clean.json');
    expect(computeFitness({ plan, rawText }).planValidity).toBe(true);
  });

  test('坏 JSON → planValidity=false (parsePlan 真拒, 不是写死 true)', () => {
    // 真值链: parsePlan 喂 non-JSON → 走 extractPlanJson → 全锚点候选不可解析 → 抛
    //   `not JSON: ...` → res.ok=false。
    const { plan } = loadFixture('plan-clean.json');
    const brokenText = 'this is definitely not a plan — no JSON here';
    expect(computeFitness({ plan, rawText: brokenText }).planValidity).toBe(false);
  });

  test('缺 nodes 字段 → planValidity=false (PlanSchema refine 拒空 nodes)', () => {
    const { plan } = loadFixture('plan-clean.json');
    const noNodesText = JSON.stringify({ name: 'no-nodes', schema_version: '1.0' });
    expect(computeFitness({ plan, rawText: noNodesText }).planValidity).toBe(false);
  });
});

// =====================================================================
// shapeDeclared 维 — 顶层 plan.shape 是否声明
// =====================================================================
describe('shapeDeclared 维 — 顶层 shape 字段', () => {
  test('clean fixture 无 shape 字段 → shapeDeclared=false', () => {
    const { plan, rawText } = loadFixture('plan-clean.json');
    expect(computeFitness({ plan, rawText }).shapeDeclared).toBe(false);
  });

  test('fake-serial fixture 含 shape 字段 → shapeDeclared=true', () => {
    // 临时注入 shape 字段 (不动 fixture);通过 rawText 改写后 parsePlan 重得 plan。
    const rawText = readFileSync(join(FIXTURE_DIR, 'plan-fake-serial.json'), 'utf8');
    const obj = JSON.parse(rawText) as Record<string, unknown>;
    delete obj['_fixtureIntent'];
    delete obj['_fixtureTruthChain'];
    (obj as { shape?: string }).shape = 'test-shape';
    const mutated = JSON.stringify(obj);
    const res = parsePlan(mutated, { knownTemplates: new Set(), knownServers: new Set() });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(computeFitness({ plan: res.plan, rawText: mutated }).shapeDeclared).toBe(true);
  });

  test('shape 空串在 PlanSchema 层就被拒 (zod min(1), 不会到 fitness)', () => {
    // 真值链: PlanSchema.shape = z.string().min(1).optional() → 空串拒绝;这一闸把
    //   "空串 ≠ 声明"这条退化掉了 —— fitness 收到的 shape 永远非空或缺席。
    const rawText = readFileSync(join(FIXTURE_DIR, 'plan-clean.json'), 'utf8');
    const obj = JSON.parse(rawText) as Record<string, unknown>;
    delete obj['_fixtureIntent'];
    delete obj['_fixtureTruthChain'];
    (obj as { shape?: string }).shape = '';
    const mutated = JSON.stringify(obj);
    const res = parsePlan(mutated, { knownTemplates: new Set(), knownServers: new Set() });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.error).toMatch(/shape/);
  });
});

// =====================================================================
// planningTokens 维 — char/4 启发式
// =====================================================================
describe('planningTokens 维 — char/4 启发式', () => {
  test('clean fixture → planningTokens = ceil(chars/4)', () => {
    const { plan, rawText } = loadFixture('plan-clean.json');
    const expected = Math.ceil(rawText.length / 4);
    expect(computeFitness({ plan, rawText }).planningTokens).toBe(expected);
  });

  test('estimateTokens 空串 → 0', () => {
    expect(estimateTokens('')).toBe(0);
  });

  test('estimateTokens 4 字符 → 1 (ceil 行为)', () => {
    expect(estimateTokens('abcd')).toBe(1);
  });

  test('estimateTokens 5 字符 → 2 (1.25 ceil)', () => {
    expect(estimateTokens('abcde')).toBe(2);
  });
});

// =====================================================================
// speedupTheoretical 维 — plan 口径 Σcost / critical
// =====================================================================
describe('speedupTheoretical 维 — plan 口径', () => {
  test('clean fixture (纯串行) → speedup = 1 (三节点 cost=1+1+1, critical=3)', () => {
    const { plan, rawText } = loadFixture('plan-clean.json');
    const expected = 3 / 3;
    expect(computeFitness({ plan, rawText }).speedupTheoretical).toBe(expected);
  });

  test('fake-serial fixture (4 节点 diamond-ish) → speedup = 4/3 (总 4, 关键链 3)', () => {
    // 真值链: lint(1) + typecheck(1) + format(1) + final(1) = 4;
    //   final → format → lint/typecheck = 1+1+1 = 3;
    //   4 / 3 ≈ 1.333。
    const { plan, rawText } = loadFixture('plan-fake-serial.json');
    expect(computeFitness({ plan, rawText }).speedupTheoretical).toBeCloseTo(4 / 3, 6);
  });

  test('全无 budgetBasis → null (尺未修, NULL ≠ 0)', () => {
    // 真值链: costOf 全返 0 → total=0 → 提前返 null。
    const rawText = readFileSync(join(FIXTURE_DIR, 'plan-clean.json'), 'utf8');
    const obj = JSON.parse(rawText) as Record<string, unknown>;
    delete obj['_fixtureIntent'];
    delete obj['_fixtureTruthChain'];
    for (const n of Object.values(obj['nodes'] as Record<string, unknown>)) {
      delete (n as { budgetBasis?: unknown })['budgetBasis'];
    }
    const mutated = JSON.stringify(obj);
    const res = parsePlan(mutated, { knownTemplates: new Set(), knownServers: new Set() });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(computeFitness({ plan: res.plan, rawText: mutated }).speedupTheoretical).toBeNull();
    // 直调也返 null
    expect(speedupTheoreticalOf(res.plan)).toBeNull();
  });

  test('空 plan → null (无节点)', () => {
    const empty: ConductorPlan = { name: 'empty', nodes: {} };
    expect(speedupTheoreticalOf(empty)).toBeNull();
  });
});

// =====================================================================
// aggregateFitness — 多 plan 聚合
// =====================================================================
describe('aggregateFitness — 多 plan 聚合', () => {
  test('clean + fake-serial → 聚合 rate/total 走真', () => {
    // 真值链: n=2, 两张都 parsePlan ok → planValidityRate=1;
    //   fakeSerialPairsTotal=0+5=5;
    //   speedupTheoreticalMedian=median([1, 4/3])=7/6;
    //   shapeDeclarationRate=0/2=0 (两张 fixture 都没声明 shape);
    //   planningTokensTotal=两 rawText 之和 ceil 之和。
    const c = loadFixture('plan-clean.json');
    const f = loadFixture('plan-fake-serial.json');
    const cf = computeFitness(c);
    const ff = computeFitness(f);
    const agg = aggregateFitness([cf, ff]);
    expect(agg.n).toBe(2);
    expect(agg.planValidityRate).toBe(1);
    expect(agg.fakeSerialPairsTotal).toBe(5);
    expect(agg.shapeDeclarationRate).toBe(0);
    expect(agg.planningTokensTotal).toBe(cf.planningTokens + ff.planningTokens);
    expect(agg.speedupTheoreticalMedian).toBeCloseTo(7 / 6, 6);
  });

  test('n=0 → 全部 0 / null 兜底', () => {
    const agg = aggregateFitness([]);
    expect(agg.n).toBe(0);
    expect(agg.planValidityRate).toBe(0);
    expect(agg.fakeSerialPairsTotal).toBe(0);
    expect(agg.shapeDeclarationRate).toBe(0);
    expect(agg.planningTokensTotal).toBe(0);
    expect(agg.speedupTheoreticalMedian).toBeNull();
  });

  test('全 speedupTheoretical=null → 中位 null (空数组)', () => {
    const results: PlanFitness[] = [
      {
        planValidity: true,
        fakeSerialPairs: 0,
        speedupTheoretical: null,
        shapeDeclared: false,
        planningTokens: 100,
      },
      {
        planValidity: true,
        fakeSerialPairs: 1,
        speedupTheoretical: null,
        shapeDeclared: false,
        planningTokens: 200,
      },
    ];
    expect(aggregateFitness(results).speedupTheoreticalMedian).toBeNull();
  });

  test('混合 shapeDeclared:1/0 → shapeDeclarationRate=0.5', () => {
    const results: PlanFitness[] = [
      {
        planValidity: true,
        fakeSerialPairs: 0,
        speedupTheoretical: 2,
        shapeDeclared: true,
        planningTokens: 100,
      },
      {
        planValidity: true,
        fakeSerialPairs: 0,
        speedupTheoretical: 1.5,
        shapeDeclared: false,
        planningTokens: 100,
      },
    ];
    const agg = aggregateFitness(results);
    expect(agg.shapeDeclarationRate).toBe(0.5);
    expect(agg.planValidityRate).toBe(1);
    expect(agg.fakeSerialPairsTotal).toBe(0);
  });
});