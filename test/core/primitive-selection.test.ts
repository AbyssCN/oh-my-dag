/**
 * SDD 0013 S1 约束选择层 GWT(§6.2 Oracle + §6.3 反 happy-path)。
 * 纯逻辑 + 注入 fake generate,零真模型零 DB。
 */
import { test, expect } from 'bun:test';
import {
  PRIMITIVE_REGISTRY,
  PRIMITIVE_IDS,
  PRIMITIVE_UNIT_CAP,
  compilePrimitive,
  type PrimitiveCtx,
  type TaskSignals,
} from '../../src/harness/primitive-registry';
import { routePrimitive } from '../../src/harness/primitive-router';
import { parsePlan } from '../../src/harness/conductor-plan';
import { runExecutorDag } from '../../src/harness/executor-dag';
import type { GenerateFn } from '../../src/harness/executor-dag-types';

// ── fake ctx:leaf 按 goal 内容返不同桩,usage 每发 +1 ──────────────────────
function fakeCtx(leafImpl: (goal: string) => string): PrimitiveCtx {
  let usage = { in: 0, out: 0 };
  return {
    maxFanout: 4,
    usage: () => usage,
    leaf: async ({ goal }) => {
      usage = { in: usage.in + 1, out: usage.out + 1 };
      return leafImpl(goal);
    },
  };
}

// ══ 1. Router:signals → primitive(确定性 + 优先级 + 无匹配 null)══════════════

test('router R1..R5:每原语的 when 命中各自信号', () => {
  expect(routePrimitive({ parallelizableInvestigations: true }).primitive).toBe('parallel');
  expect(routePrimitive({ uniformMultiStepItems: true }).primitive).toBe('pipeline');
  expect(routePrimitive({ accumulateToTarget: true }).primitive).toBe('loop-until');
  expect(routePrimitive({ claimToRefute: true }).primitive).toBe('verify');
  expect(routePrimitive({ wideSolutionSpace: true }).primitive).toBe('judge');
});

test('router 复用 complexity 信号:independentDomains≥2 → parallel', () => {
  expect(routePrimitive({ independentDomains: 3 }).primitive).toBe('parallel');
});

test('router 优先级 = registry 顺序(多信号取首命中 parallel)', () => {
  const s: TaskSignals = { parallelizableInvestigations: true, wideSolutionSpace: true };
  expect(routePrimitive(s).primitive).toBe('parallel');
});

test('router 无匹配 → null(SEL-5 降级信号,绝不 crash)', () => {
  expect(routePrimitive({}).primitive).toBeNull();
  expect(routePrimitive({ fileCount: 4, crossLayer: true }).primitive).toBeNull();
});

// ══ 2. compile:SEL-1 fail-closed + SEL-2 静态定界 ═══════════════════════════

test('SEL-1 未知原语 → fail-closed', () => {
  const r = compilePrimitive('bogus', {}, fakeCtx(() => ''));
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toContain('未知原语');
});

test('SEL-1 坏 params(缺字段)→ fail-closed', () => {
  const r = compilePrimitive('parallel', { goals: ['只有一个'] }, fakeCtx(() => '')); // min 2
  expect(r.ok).toBe(false);
});

test('反幻觉:params 塞 model 字段 → strict 拒(模型路由归 config)', () => {
  const r = compilePrimitive('parallel', { goals: ['a', 'b'], model: 'deepseek:x' }, fakeCtx(() => ''));
  expect(r.ok).toBe(false);
});

test('SEL-2 静态定界:各原语 maxUnits 编译期可算', () => {
  const ctx = fakeCtx(() => '{}');
  const p = compilePrimitive('parallel', { goals: ['a', 'b', 'c'] }, ctx);
  expect(p.ok && p.invocation.maxUnits).toBe(3);
  const pl = compilePrimitive('pipeline', { items: ['i', 'j'], stages: [{ goal: 'x' }, { goal: 'y' }] }, ctx);
  expect(pl.ok && pl.invocation.maxUnits).toBe(4); // 2 items × 2 stages
  const lu = compilePrimitive('loop-until', { stepGoal: 'g', target: 3 }, ctx);
  expect(lu.ok && lu.invocation.maxUnits).toBe(3);
  const v = compilePrimitive('verify', { claim: 'c', n: 5 }, ctx);
  expect(v.ok && v.invocation.maxUnits).toBe(5);
  const j = compilePrimitive('judge', { attempts: 3, attemptGoal: 'g', scoreCriterion: 'best' }, ctx);
  expect(j.ok && j.invocation.maxUnits).toBe(6); // attempts × 2
});

test('SEL-2 硬顶:全部原语的 schema 上限 × 编译 ≤ PRIMITIVE_UNIT_CAP', () => {
  const ctx = fakeCtx(() => '{}');
  const big = compilePrimitive('pipeline', { items: Array(32).fill('i'), stages: Array(8).fill({ goal: 'g' }) }, ctx);
  expect(big.ok && big.invocation.maxUnits).toBe(256);
  expect(big.ok && big.invocation.maxUnits).toBeLessThanOrEqual(PRIMITIVE_UNIT_CAP);
});

// ══ 3. compile + run:原语真被调,控制流封装生效 ══════════════════════════════

test('parallel:N 目标各跑一 leaf,聚合 N 输出', async () => {
  const ctx = fakeCtx((g) => `OUT:${g}`);
  const r = compilePrimitive('parallel', { goals: ['a', 'b', 'c'] }, ctx);
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  const { output, usage } = await r.invocation.run();
  const rows = JSON.parse(output) as { goal: string; output: string }[];
  expect(rows.map((x) => x.output)).toEqual(['OUT:a', 'OUT:b', 'OUT:c']);
  expect(usage.out).toBe(3); // 3 leaf 发
});

test('verify:多数不反驳 → survived true;多数反驳 → false', async () => {
  const surv = compilePrimitive('verify', { claim: 'X 成立', n: 3 }, fakeCtx(() => '{"refuted": false}'));
  expect(surv.ok).toBe(true);
  if (surv.ok) expect(JSON.parse((await surv.invocation.run()).output).survived).toBe(true);

  const dead = compilePrimitive('verify', { claim: 'X 成立', n: 3 }, fakeCtx(() => '{"refuted": true}'));
  if (dead.ok) expect(JSON.parse((await dead.invocation.run()).output).survived).toBe(false);
});

test('verify:verdict 解析失败 → 保守 refuted(crashed skeptic 不放行)', async () => {
  const r = compilePrimitive('verify', { claim: 'X', n: 1 }, fakeCtx(() => '不是 JSON'));
  if (r.ok) expect(JSON.parse((await r.invocation.run()).output).survived).toBe(false);
});

test('judge:N 候选按分择优,取最高分', async () => {
  // attempt goal → 候选文本(长度不同);score goal → 按候选长度打分。
  const ctx = fakeCtx((g) => {
    if (g.includes('打分')) {
      const m = g.match(/<candidate>(.*?)<\/candidate>/s);
      return `{"score": ${m ? m[1]!.length : 0}}`;
    }
    return g.includes('第 3 稿') ? 'LONGEST-CANDIDATE' : 'short';
  });
  const r = compilePrimitive('judge', { attempts: 3, attemptGoal: '写一稿', scoreCriterion: '越长越好' }, ctx);
  expect(r.ok).toBe(true);
  if (r.ok) expect(JSON.parse((await r.invocation.run()).output).best).toBe('LONGEST-CANDIDATE');
});

test('loop-until:累积到 target 停', async () => {
  const r = compilePrimitive('loop-until', { stepGoal: '产一项', target: 4 }, fakeCtx(() => 'item'));
  if (r.ok) {
    const items = JSON.parse((await r.invocation.run()).output) as string[];
    expect(items.length).toBe(4);
  }
});

test('pipeline:每条目过全部阶段', async () => {
  const ctx = fakeCtx((g) => `stage-out(${g.includes('S2') ? '2' : '1'})`);
  const r = compilePrimitive('pipeline', { items: ['a', 'b'], stages: [{ goal: 'S1' }, { goal: 'S2' }] }, ctx);
  if (r.ok) {
    const rows = JSON.parse((await r.invocation.run()).output) as { item: string; output: string }[];
    expect(rows.length).toBe(2);
    expect(rows.every((x) => x.output.includes('stage-out(2)'))).toBe(true); // 末阶段是 S2
  }
});

// ══ 4. PlanSchema:primitive 节点解析 + SEL-1 结构闸 + BC ════════════════════

test('PlanSchema:合法 primitive 节点解析通过', () => {
  const plan = JSON.stringify({
    name: 't',
    nodes: { p: { kind: 'primitive', primitive: 'parallel', params: { goals: ['a', 'b'] } } },
  });
  const r = parsePlan(plan);
  expect(r.ok).toBe(true);
});

test('PlanSchema SEL-1:kind:primitive 缺 primitive/params → 拒', () => {
  expect(parsePlan(JSON.stringify({ name: 't', nodes: { p: { kind: 'primitive' } } })).ok).toBe(false);
});

test('PlanSchema:primitive 字段无 kind → 拒', () => {
  expect(
    parsePlan(JSON.stringify({ name: 't', nodes: { p: { primitive: 'parallel', params: {} } } })).ok,
  ).toBe(false);
});

test('PlanSchema BC:纯自由 node-graph 仍解析通过(不回归)', () => {
  const free = JSON.stringify({
    name: 't',
    nodes: { a: { goal: 'do a', executor: 'leaf' }, b: { goal: 'do b', depends_on: ['a'] } },
  });
  expect(parsePlan(free).ok).toBe(true);
});

// ══ 5. 端到端 runExecutorDag:primitive 节点跑通 + BC + 混合图 ════════════════

/** conductor 调用返回预置 plan JSON;leaf 调用返回桩。 */
function fakeGenerate(planJson: string): GenerateFn {
  return async ({ messages }) => {
    const sys = messages.find((m) => m.role === 'system')?.content ?? '';
    const usage = { in: 1, out: 1 };
    if (sys.includes('CONDUCTOR')) return { text: planJson, usage };
    return { text: 'leaf-stub', usage }; // 所有 leaf
  };
}

const baseConfig = (planJson: string) => ({
  conductorModel: 'fake:conductor',
  leafModel: 'fake:leaf',
  generate: fakeGenerate(planJson),
  warmThenFanout: false,
});

test('E2E:含 primitive(parallel)节点的 plan 跑通,kind=primitive done', async () => {
  const plan = JSON.stringify({
    name: 'e2e',
    nodes: { p: { kind: 'primitive', primitive: 'parallel', params: { goals: ['x', 'y'] } } },
  });
  const res = await runExecutorDag('任务', baseConfig(plan));
  expect(res.results.p!.status).toBe('done');
  expect(res.results.p!.kind).toBe('primitive');
  const rows = JSON.parse(res.results.p!.output) as { output: string }[];
  expect(rows.length).toBe(2);
});

test('E2E BC:纯自由图 plan 仍真绿(SEL-5 不回归)', async () => {
  const plan = JSON.stringify({
    name: 'bc',
    nodes: { a: { goal: 'do a', executor: 'leaf' }, b: { goal: 'do b', executor: 'leaf', depends_on: ['a'] } },
  });
  const res = await runExecutorDag('任务', baseConfig(plan));
  expect(res.results.a!.status).toBe('done');
  expect(res.results.b!.status).toBe('done');
  expect(res.results.a!.kind).toBe('inproc');
});

test('E2E 混合:自由 node + primitive node 同图并存跑通', async () => {
  const plan = JSON.stringify({
    name: 'mixed',
    nodes: {
      free: { goal: 'gather', executor: 'leaf' },
      prim: { kind: 'primitive', primitive: 'verify', params: { claim: '结论成立', n: 3 }, depends_on: ['free'] },
    },
  });
  const res = await runExecutorDag('任务', baseConfig(plan));
  expect(res.results.free!.status).toBe('done');
  expect(res.results.prim!.status).toBe('done');
  expect(res.results.prim!.kind).toBe('primitive');
});

test('E2E fail-closed:坏 params 的 primitive 节点 → failed 有明确错,不静默降范围', async () => {
  const plan = JSON.stringify({
    name: 'bad',
    nodes: { p: { kind: 'primitive', primitive: 'parallel', params: { goals: ['只一个'] } } },
  });
  const res = await runExecutorDag('任务', baseConfig(plan));
  expect(res.results.p!.status).toBe('failed');
  expect(res.results.p!.output).toContain('编译失败');
});

// ══ 6. registry 自洽 ════════════════════════════════════════════════════════

test('registry:13 原语 id 齐(S1 5 + S2 2 + S4 4 + S5 1 + S6 1)+ when 是纯谓词', () => {
  expect([...PRIMITIVE_IDS].sort()).toEqual([
    'discovery', 'escalation', 'escape-hatch', 'iterate', 'judge', 'loop-until', 'parallel', 'pipeline', 'race', 'router', 'saga', 'tournament', 'verify',
  ]);
  for (const id of PRIMITIVE_IDS) expect(typeof PRIMITIVE_REGISTRY[id].when).toBe('function');
});

// ══ S5:Saga / Compensation(通用补偿回滚;维二会计绑定 DEFER)══════════════════

test('S5 router:needsCompensatingRollback → saga', () => {
  expect(routePrimitive({ needsCompensatingRollback: true }).primitive).toBe('saga');
});

test('S5 saga:全步成功 → 无回滚', async () => {
  const ctx = fakeCtx(() => '{"ok": true, "output": "done"}');
  const r = compilePrimitive('saga', { steps: [{ goal: 'a', compensateGoal: 'undo-a' }, { goal: 'b', compensateGoal: 'undo-b' }] }, ctx);
  expect(r.ok && r.invocation.maxUnits).toBe(4); // 2 步 × 2
  if (r.ok) {
    const out = JSON.parse((await r.invocation.run()).output);
    expect(out.rolledBack).toBe(false);
    expect(out.compensated).toEqual([]);
  }
});

test('S5 saga:第 3 步失败 → 前 2 步反向补偿(顺序 2,1)', async () => {
  // 步 1/2 ok,步 3 !ok → 补偿 step2 再 step1。
  const compensateOrder: string[] = [];
  const ctx = fakeCtx((g) => {
    if (g.startsWith('undo-')) {
      compensateOrder.push(g);
      return 'compensated';
    }
    if (g.startsWith('s3')) return '{"ok": false, "output": "boom"}';
    return '{"ok": true, "output": "ok"}';
  });
  const r = compilePrimitive(
    'saga',
    { steps: [{ goal: 's1', compensateGoal: 'undo-1' }, { goal: 's2', compensateGoal: 'undo-2' }, { goal: 's3', compensateGoal: 'undo-3' }] },
    ctx,
  );
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  const out = JSON.parse((await r.invocation.run()).output);
  expect(out.rolledBack).toBe(true);
  expect(out.failedAt).toBe(3);
  // 反向补偿:先 undo-2 后 undo-1(step3 未完成不补偿)。
  expect(compensateOrder).toEqual(['undo-2', 'undo-1']);
  expect(out.compensated.map((c: { step: number }) => c.step)).toEqual([2, 1]);
});

test('S5 saga:单步 → schema 拒(无需补偿)+ 反幻觉 strict', () => {
  expect(compilePrimitive('saga', { steps: [{ goal: 'a', compensateGoal: 'x' }] }, fakeCtx(() => '')).ok).toBe(false);
  expect(compilePrimitive('saga', { steps: [{ goal: 'a', compensateGoal: 'x', model: 'm' }, { goal: 'b', compensateGoal: 'y' }] }, fakeCtx(() => '')).ok).toBe(false);
});

// ══ S6:capped 逃生舱(gated 默认关)══════════════════════════════════════════

test('S6 逃生舱:Router 永不自动选(when 恒 false)', () => {
  // 任何信号组合都不路由到 escape-hatch。
  expect(routePrimitive({ parallelizableInvestigations: true, wideSolutionSpace: true }).primitive).not.toBe('escape-hatch');
  expect(PRIMITIVE_REGISTRY['escape-hatch'].when({})).toBe(false);
});

test('S6 逃生舱:env 默认关 → compile fail-closed', () => {
  delete process.env.OMD_ESCAPE_HATCH;
  const r = compilePrimitive('escape-hatch', { steps: [{ goal: 'a' }], reason: '结构原语不够' }, fakeCtx(() => ''));
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toContain('闸拒');
});

test('S6 逃生舱:env 开 → 有界命令式步序跑通', async () => {
  process.env.OMD_ESCAPE_HATCH = '1';
  try {
    const r = compilePrimitive('escape-hatch', { steps: [{ goal: 's1' }, { goal: 's2' }], reason: '特例' }, fakeCtx((g) => `out(${g.slice(0, 2)})`));
    expect(r.ok && r.invocation.maxUnits).toBe(2);
    if (r.ok) {
      const out = JSON.parse((await r.invocation.run()).output);
      expect(out.steps.length).toBe(2);
      expect(out.reason).toBe('特例');
    }
  } finally {
    delete process.env.OMD_ESCAPE_HATCH;
  }
});

test('S6 逃生舱:steps 超 cap(>12)→ schema 拒', () => {
  process.env.OMD_ESCAPE_HATCH = '1';
  try {
    const r = compilePrimitive('escape-hatch', { steps: Array(13).fill({ goal: 'x' }), reason: 'r' }, fakeCtx(() => ''));
    expect(r.ok).toBe(false);
  } finally {
    delete process.env.OMD_ESCAPE_HATCH;
  }
});

// ══ S4:tournament / router / race / escalation ══════════════════════════════

test('S4 router 路由:各新信号选对原语', () => {
  expect(routePrimitive({ largeCandidatePool: true }).primitive).toBe('tournament');
  expect(routePrimitive({ needsClassificationRouting: true }).primitive).toBe('router');
  expect(routePrimitive({ needsFastestOfAlternatives: true }).primitive).toBe('race');
  expect(routePrimitive({ needsConditionalFallback: true }).primitive).toBe('escalation');
});

test('S4 tournament:分组淘汰出唯一冠军', async () => {
  // 候选文本 = 第 i 稿;打分 = 候选里的数字。第 7 稿分最高。
  const ctx = fakeCtx((g) => {
    if (g.includes('打分')) {
      const m = g.match(/<candidate>第 (\d+) 稿<\/candidate>/);
      return `{"score": ${m ? m[1] : 0}}`;
    }
    const n = g.match(/第 (\d+) 稿/);
    return `第 ${n ? n[1] : '?'} 稿`;
  });
  const r = compilePrimitive('tournament', { attempts: 7, attemptGoal: '写', scoreCriterion: '数字大' }, ctx);
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  const out = JSON.parse((await r.invocation.run()).output);
  expect(out.champion).toBe('第 7 稿'); // 全场最高分胜出
});

test('S4 router:分类命中 → 只跑该分支', async () => {
  const ctx = fakeCtx((g) => (g.includes('别的不要') ? 'billing' : `RAN:${g.slice(0, 12)}`));
  const r = compilePrimitive(
    'router',
    { classifyGoal: '这是啥问题', branches: [{ label: 'billing', goal: '处理账单' }, { label: 'tech', goal: '处理技术' }] },
    ctx,
  );
  if (r.ok) {
    const out = JSON.parse((await r.invocation.run()).output);
    expect(out.branch).toBe('billing');
    expect(out.output).toContain('处理账单');
  }
});

test('S4 router:分类落空 → fail-closed(不静默乱选)', async () => {
  const ctx = fakeCtx(() => 'zzznomatch');
  const r = compilePrimitive('router', { classifyGoal: 'x', branches: [{ label: 'billing', goal: 'gbill' }, { label: 'tech', goal: 'gtech' }] }, ctx);
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.invocation.run()).rejects.toThrow(/未匹配/);
});

test('S4 race:取首个成功者(全失败则抛)', async () => {
  const ok = compilePrimitive('race', { goals: ['a', 'b', 'c'] }, fakeCtx((g) => `done:${g}`));
  if (ok.ok) expect(JSON.parse((await ok.invocation.run()).output).winner).toContain('done:');
});

test('S4 escalation:某级验收通过即停;全不过 accepted:false', async () => {
  // 第 1 级不过,第 2 级过。
  let acc = 0;
  const passCtx = fakeCtx((g) => (g.includes('验收通过') ? (acc++ === 0 ? '{"accepted": false}' : '{"accepted": true}') : 'lvl-out'));
  const r = compilePrimitive('escalation', { levels: [{ goal: '廉价' }, { goal: '强' }], acceptCriterion: 'ok' }, passCtx);
  if (r.ok) {
    const out = JSON.parse((await r.invocation.run()).output);
    expect(out.accepted).toBe(true);
    expect(out.level).toBe(2);
  }
  const failCtx = fakeCtx((g) => (g.includes('验收通过') ? '{"accepted": false}' : 'lvl-out'));
  const r2 = compilePrimitive('escalation', { levels: [{ goal: 'a' }, { goal: 'b' }], acceptCriterion: 'ok' }, failCtx);
  if (r2.ok) expect(JSON.parse((await r2.invocation.run()).output).accepted).toBe(false);
});

test('S4 静态定界:各新原语 maxUnits 可算且 ≤ CAP', () => {
  const ctx = fakeCtx(() => '{}');
  const t = compilePrimitive('tournament', { attempts: 9, attemptGoal: 'g', scoreCriterion: 'c' }, ctx);
  expect(t.ok && t.invocation.maxUnits).toBeLessThanOrEqual(PRIMITIVE_UNIT_CAP);
  const ro = compilePrimitive('router', { classifyGoal: 'g', branches: [{ label: 'a', goal: 'x' }, { label: 'b', goal: 'y' }] }, ctx);
  expect(ro.ok && ro.invocation.maxUnits).toBe(2);
  const ra = compilePrimitive('race', { goals: ['a', 'b', 'c'] }, ctx);
  expect(ra.ok && ra.invocation.maxUnits).toBe(3);
  const e = compilePrimitive('escalation', { levels: [{ goal: 'a' }, { goal: 'b' }, { goal: 'c' }], acceptCriterion: 'ok' }, ctx);
  expect(e.ok && e.invocation.maxUnits).toBe(6);
});

test('S4 反幻觉:escalation levels 塞 model → strict 拒', () => {
  const r = compilePrimitive('escalation', { levels: [{ goal: 'a', model: 'x' }, { goal: 'b' }], acceptCriterion: 'ok' }, fakeCtx(() => ''));
  expect(r.ok).toBe(false);
});

// ══ S3:verify/judge 深化(显式 lenses + 多准则去偏)══════════════════════════

test('S3 verify:显式 lenses → n 缺省 = lenses 数,各镜头一发', async () => {
  const seen: string[] = [];
  const ctx = fakeCtx((g) => {
    const m = g.match(/以「(.+?)」视角/);
    if (m) seen.push(m[1]!);
    return '{"refuted": false}';
  });
  const r = compilePrimitive('verify', { claim: 'C', lenses: ['会计不变量', 'RLS 越权', '并发'] }, ctx);
  expect(r.ok && r.invocation.maxUnits).toBe(3); // n = lenses.length
  if (r.ok) {
    await r.invocation.run();
    expect(seen.sort()).toEqual(['RLS 越权', '会计不变量', '并发']); // 用了显式镜头,非默认
  }
});

test('S3 judge:多准则求均择优(降单 judge 偏见)', async () => {
  // 候选 = 第 i 稿;准则 A 给分 = i,准则 B 给分 = 10-i → 均值 = 5 恒定,除第 i=... 用不同:
  // 简化:准则各返固定,验证 criteria 回显 + 跑通。
  const ctx = fakeCtx((g) => {
    if (g.includes('打分')) return '{"score": 50}';
    return g.match(/第 (\d+) 稿/)?.[0] ?? 'c';
  });
  const r = compilePrimitive('judge', { attempts: 3, attemptGoal: '写', criteria: ['正确性', '简洁性'] }, ctx);
  expect(r.ok && r.invocation.maxUnits).toBe(3 + 3 * 2); // attempts + attempts×criteria
  if (r.ok) {
    const out = JSON.parse((await r.invocation.run()).output);
    expect(out.criteria).toEqual(['正确性', '简洁性']);
  }
});

test('S3 judge:scoreCriterion 与 criteria 全缺 → schema 拒', () => {
  const r = compilePrimitive('judge', { attempts: 2, attemptGoal: '写' }, fakeCtx(() => '{}'));
  expect(r.ok).toBe(false);
});

// ══ S2:discovery + iterate ══════════════════════════════════════════════════

test('S2 router:unknownScaleRecall → discovery;refineUntilConverged → iterate', () => {
  expect(routePrimitive({ unknownScaleRecall: true }).primitive).toBe('discovery');
  expect(routePrimitive({ refineUntilConverged: true }).primitive).toBe('iterate');
});

test('S2 静态定界:discovery=maxRounds · iterate=maxRounds×2', () => {
  const ctx = fakeCtx(() => '[]');
  const d = compilePrimitive('discovery', { roundGoal: '找 bug', maxRounds: 5 }, ctx);
  expect(d.ok && d.invocation.maxUnits).toBe(5);
  const it = compilePrimitive('iterate', { stepGoal: '写', convergeCriterion: '够好', maxRounds: 4 }, ctx);
  expect(it.ok && it.invocation.maxUnits).toBe(8);
});

test('S2 discovery:连续 dry 轮收敛,去重累积', async () => {
  // 轮 1 出 a,b;轮 2 出 b(旧)→ dry1;轮 3 出空 → dry2 → 收敛(dryThreshold 2)。
  const rounds = [['a', 'b'], ['b'], []];
  let i = 0;
  const ctx = fakeCtx(() => JSON.stringify(rounds[Math.min(i++, rounds.length - 1)]));
  const r = compilePrimitive('discovery', { roundGoal: '找', maxRounds: 6, dryThreshold: 2 }, ctx);
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  const out = JSON.parse((await r.invocation.run()).output);
  expect(out.items.sort()).toEqual(['a', 'b']);
  expect(out.converged).toBe(true);
  expect(out.status).toBe('dry');
});

test('S2 iterate:judge 判收敛即停', async () => {
  // step leaf 返 "draft";judge leaf 首轮不收敛、次轮收敛。
  let judged = 0;
  const ctx = fakeCtx((g) => {
    if (g.includes('是否已达标')) return judged++ === 0 ? '{"converged": false, "failureReason": "缺细节"}' : '{"converged": true}';
    return 'draft-output';
  });
  const r = compilePrimitive('iterate', { stepGoal: '写稿', convergeCriterion: '完整', maxRounds: 5 }, ctx);
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  const out = JSON.parse((await r.invocation.run()).output);
  expect(out.converged).toBe(true);
  expect(out.rounds).toBe(2); // 第 2 轮 judge 收敛
});

test('S2 iterate:不收敛触 maxRounds → exhausted(非假收敛)', async () => {
  const ctx = fakeCtx((g) => (g.includes('是否已达标') ? '{"converged": false, "failureReason": "还差"}' : 'draft'));
  const r = compilePrimitive('iterate', { stepGoal: '写', convergeCriterion: 'x', maxRounds: 3 }, ctx);
  if (r.ok) {
    const out = JSON.parse((await r.invocation.run()).output);
    expect(out.converged).toBe(false);
    expect(out.status).toBe('exhausted');
  }
});

test('S2 E2E:discovery primitive 节点跑通', async () => {
  const plan = JSON.stringify({
    name: 's2',
    nodes: { d: { kind: 'primitive', primitive: 'discovery', params: { roundGoal: '找', maxRounds: 2 } } },
  });
  // fakeGenerate 的 leaf 桩返 'leaf-stub' → extractArray 无数组 → [] → 立即 dry 收敛。
  const res = await runExecutorDag('任务', baseConfig(plan));
  expect(res.results.d!.status).toBe('done');
  expect(res.results.d!.kind).toBe('primitive');
});
