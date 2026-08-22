/**
 * plan-patch 单元测试 (SDD v2 S3.6, G-21 强化)。
 * 覆盖: 浅 merge / 字段删除 / 节点删除 / 加节点 / 悬挂依赖闸 / 整图校验 / 模板闸 /
 * 未补丁节点字节不动 (D-21 复用按构造成立的前提)。
 */
import { describe, expect, test } from 'bun:test';
import type { ConductorPlan } from '../conductor-plan';
import { applyPlanPatch, buildPatchRequest, parsePlanPatch } from './plan-patch';

const prev = (): ConductorPlan =>
  ({
    name: 'p',
    nodes: {
      a: { goal: '研判', persona: '分析师', depends_on: [] },
      b: { goal: '实装', executor: 'agent', output_type: 'file', output_path: 'src/x.ts', depends_on: ['a'] },
      c: { goal: '审查', depends_on: ['b'] },
    },
    outputs: ['c'],
  }) as unknown as ConductorPlan;

describe('parsePlanPatch', () => {
  test('fence + 前后 prose 鲁棒提取', () => {
    const r = parsePlanPatch('思考...\n```json\n{"patch": {"b": {"goal": "修"}}}\n```\n完');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.patch.patch.b).toEqual({ goal: '修' });
  });

  test('非 JSON / 缺 patch 键 → error', () => {
    expect(parsePlanPatch('sorry no json').ok).toBe(false);
    expect(parsePlanPatch('{"nodes": {}}').ok).toBe(false);
  });

  test('空 patch {} 合法 (拓扑没问题只重跑失败节点)', () => {
    const r = parsePlanPatch('{"patch": {}}');
    expect(r.ok).toBe(true);
  });
});

describe('applyPlanPatch', () => {
  test('浅 merge: 只覆盖给的字段, 未补丁节点字节不动 (D-21 前提)', () => {
    const p = prev();
    const r = applyPlanPatch(p, { patch: { b: { goal: '修好的实装' } } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const b = r.applied.plan.nodes.b as Record<string, unknown>;
    expect(b.goal).toBe('修好的实装');
    expect(b.executor).toBe('agent'); // 未提字段保留
    expect(b.output_path).toBe('src/x.ts');
    // 未补丁节点与上轮 JSON 逐字节相等
    expect(JSON.stringify(r.applied.plan.nodes.a)).toBe(JSON.stringify(p.nodes.a));
    expect(JSON.stringify(r.applied.plan.nodes.c)).toBe(JSON.stringify(p.nodes.c));
    expect(r.applied.changed).toEqual(['b']);
  });

  test('字段值 null → 删该字段', () => {
    const r = applyPlanPatch(prev(), { patch: { a: { persona: null as unknown as string } } as never });
    expect(r.ok).toBe(true);
    if (r.ok) expect('persona' in (r.applied.plan.nodes.a as object)).toBe(false);
  });

  test('节点值 null → 删节点; 消费者 depends_on 同步补丁后通过', () => {
    const r = applyPlanPatch(prev(), { patch: { c: null, b: { depends_on: ['a'] } } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect('c' in r.applied.plan.nodes).toBe(false);
    expect(r.applied.removed).toEqual(['c']);
    expect(r.applied.plan.outputs).toBeUndefined(); // outputs 继承并剔除被删节点 → 空则不留
  });

  test('悬挂依赖闸: 删节点但消费者仍引用 → 拒收', () => {
    const r = applyPlanPatch(prev(), { patch: { b: null } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('依赖被删除的节点');
  });

  test('加节点 (新 id 全字段); 加坏节点 (schema 违规) → 拒收', () => {
    const ok = applyPlanPatch(prev(), { patch: { d: { goal: '补漏', depends_on: ['c'] } } });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.applied.added).toEqual(['d']);
    // executor:'map' 无 map spec → PlanSchema superRefine 拒
    const bad = applyPlanPatch(prev(), { patch: { d: { executor: 'map' } } });
    expect(bad.ok).toBe(false);
  });

  test('删除不存在的节点 → 拒收', () => {
    const r = applyPlanPatch(prev(), { patch: { ghost: null } });
    expect(r.ok).toBe(false);
  });

  test('outputs 补丁整体替换; 引用不存在的 id → 拒收 (PlanSchema superRefine)', () => {
    const ok = applyPlanPatch(prev(), { patch: {}, outputs: ['b'] });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.applied.plan.outputs).toEqual(['b']);
    const bad = applyPlanPatch(prev(), { patch: {}, outputs: ['ghost'] });
    expect(bad.ok).toBe(false);
  });

  test('模板闸: 补丁引入未知 template → 拒收 (TPL-2 平价)', () => {
    const r = applyPlanPatch(prev(), { patch: { b: { template: 'no-such-card' } } }, { knownTemplates: new Set(['reviewer']) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('unknown template');
  });

  test('D-2 越界机器闸: 补丁 touch 闭包外节点 → 拒且判词点名 id 与「闭包外」', () => {
    const r = applyPlanPatch(prev(), { patch: { c: { goal: '偷改' } } }, { allowedIds: new Set(['a', 'b']) });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('c');
      expect(r.error).toContain('闭包外');
    }
  });

  test('D-2 反向自检: 闭包内 touch 不受 allowedIds 影响 (证伪 — 摘掉判据这条测试也会绿, 需配上一条才成立闸)', () => {
    const r = applyPlanPatch(prev(), { patch: { a: { goal: '改研判' } } }, { allowedIds: new Set(['a']) });
    expect(r.ok).toBe(true);
  });
});

describe('buildPatchRequest (D-1 请求侧差量)', () => {
  test('闭包节点全文入请求, 闭包外只留 `id: goal首行` 单行清单', () => {
    const p = prev();
    const req = buildPatchRequest(p, new Set(['b']));
    expect(req).toContain('"b"');
    expect(req).toContain('实装'); // 闭包节点 goal 全文在
    expect(req).toContain('a: 研判'); // 闭包外单行清单
    expect(req).toContain('c: 审查');
    expect(req).not.toContain('"depends_on": ["b"]'); // c 的字段没有整节点入请求 (只单行)
  });

  test('G-1: 差量请求字节数严格小于整图 JSON (证伪 — 若把冻结节点发成全文, 此断言会红)', () => {
    const p = prev();
    const fullJson = JSON.stringify({ name: p.name, nodes: p.nodes, outputs: p.outputs }, null, 1);
    const req = buildPatchRequest(p, new Set(['b']));
    expect(req.length).toBeLessThan(fullJson.length);
  });

  test('闭包 = 全图时仍产出合法请求 (无冻结清单)', () => {
    const p = prev();
    const req = buildPatchRequest(p, new Set(['a', 'b', 'c']));
    expect(req).not.toContain('字节冻结');
  });
});