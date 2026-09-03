import { describe, expect, test } from 'bun:test';
import { GRAPH_SHAPES, renderShapesForPrompt, shapeById } from './index';

// shape = 图式的单一真源 (2026-07-26)。这些闸守的是"它别退化回散文"。

// SHAPE_EXAMPLES (2026-08-31): 4 张卡有真实绿跑来源, 蒸馏进 prompt 渲染。
// 逐字来自收割附录 (runId + goalHint + graph) —— D-1 不许编。无源卡 example 字段缺席 (D-2)。
// SDD GWT-1 用本常量 grep (锚串 SHAPE_EXAMPLES 逐字在测试文件内)。
const SHAPE_EXAMPLES = ['one-decision-then-fanout', 'runtime-work-list', 'runtime-decomposition', 'research-lens'] as const;
const SHAPE_EXAMPLE_RUNIDS = ['49e1bfcf', '0f53b6fe', '5d0853b6', '56fd4aa3'] as const;
const NO_EXAMPLE_SHAPES = ['ui-evidence', 'ui-best-of-n', 'full-stack', 'research-second-pass'] as const;

describe('GRAPH_SHAPES 数据完整性', () => {
  test('每个 shape 都有触发条件与**反例** —— 反例是数据化强制多出来的那一栏', () => {
    for (const s of GRAPH_SHAPES) {
      expect(s.when.length).toBeGreaterThan(8);
      expect(s.whenNot.length).toBeGreaterThan(8); // 散文版从来没有这一栏
      expect(s.steps.length).toBeGreaterThan(0);
      expect(s.why.length).toBeGreaterThan(10);
    }
  });

  test('id 唯一且可按 id 取', () => {
    const ids = GRAPH_SHAPES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(shapeById('ui-evidence')?.enforced).toContain('evidence pass');
  });

  test('被引擎硬闸强制的 shape 必须写明 enforced (否则读者分不清"建议"与"闸")', () => {
    expect(shapeById('ui-evidence')!.enforced).toBeTruthy();
    // 其余是建议, 不该冒充硬闸
    expect(shapeById('full-stack')!.enforced).toBeUndefined();
  });
});

describe('两个消费面共用同一份数据 (不许抄第二份)', () => {
  test('lean 档省掉 WHY 但保留 WHEN/NOT when (强模型自己推得出理由, 推不出触发条件)', () => {
    const full = renderShapesForPrompt('full').join('\n');
    const lean = renderShapesForPrompt('lean').join('\n');
    expect(full).toContain('WHY:');
    expect(lean).not.toContain('WHY:');
    for (const p of [full, lean]) {
      expect(p).toContain('NOT when:');
      expect(p).toContain('one-decision-then-fanout');
    }
  });

});

// 2026-08-31 few-shot 落地 (SHAPE_EXAMPLES 锚串, SDD INV-1/INV-2)。
// GWT-1/2 的判定全在这一段; GWT-3/4 靠 snapshot + 全量测试 (不在本文件内钉)。
describe('few-shot 样例 (SHAPE_EXAMPLES) 真源与渲染', () => {
  // GWT-1 (INV-1): 恰 4 张卡带 example, source 含附录 8 位 runId; 其余 4 张严格 undefined。
  test('带 example 的卡恰为 4 张 (one-decision-then-fanout / runtime-work-list / runtime-decomposition / research-lens), source 含附录 runId', () => {
    const withExample = GRAPH_SHAPES.filter((s) => s.example !== undefined);
    expect(withExample.map((s) => s.id).sort()).toEqual([...SHAPE_EXAMPLES].sort());
    for (let i = 0; i < SHAPE_EXAMPLES.length; i++) {
      const id = SHAPE_EXAMPLES[i]!;
      const runId = SHAPE_EXAMPLE_RUNIDS[i]!;
      const s = shapeById(id)!;
      expect(s.example).toBeDefined();
      const ex = s.example!;
      expect(ex.source).toContain(runId);
      expect(ex.graph.length).toBeGreaterThan(0);
    }
  });

  test('无源卡 (ui-evidence / ui-best-of-n / full-stack / research-second-pass) 的 example 严格 undefined —— 缺席 ≠ 0', () => {
    for (const id of NO_EXAMPLE_SHAPES) {
      expect(shapeById(id)!.example).toBeUndefined();
    }
  });

  // GWT-2 (INV-2): 两档各恰 4 处 EXAMPLE 标记行, 且 A1 的 probe_landmarks 出现。
  test('full 档: 恰 4 处 EXAMPLE 标记行, 节点 id (probe_landmarks) 入 prompt', () => {
    const lines = renderShapesForPrompt('full');
    const exampleLines = lines.filter((l) => l.trimStart().startsWith('EXAMPLE (real green run'));
    expect(exampleLines.length).toBe(SHAPE_EXAMPLES.length);
    expect(lines.join('\n')).toContain('probe_landmarks');
  });

  test('lean 档: 恰 4 处 EXAMPLE 标记行 —— 样例是证据不是理由, 两档同渲染 (与 lean「省 WHY」判据正交)', () => {
    const lines = renderShapesForPrompt('lean');
    const exampleLines = lines.filter((l) => l.trimStart().startsWith('EXAMPLE (real green run'));
    expect(exampleLines.length).toBe(SHAPE_EXAMPLES.length);
    // lean 档仍然省 WHY (与既有判据不冲突)。
    expect(lines.join('\n')).not.toContain('WHY:');
    expect(lines.join('\n')).toContain('probe_landmarks');
  });

  // INV-4 字段/闸零改动: GraphShape 既有字段都还在; shapeById / isKnownShapeId 调用形态不变。
  test('既有字段 (when/whenNot/steps/why/enforced) 形态零改 —— example 是新增可选', () => {
    for (const s of GRAPH_SHAPES) {
      // 既有字段齐在, 与片 1 入仓前的形一致。
      expect(typeof s.id).toBe('string');
      expect(typeof s.what).toBe('string');
      expect(typeof s.when).toBe('string');
      expect(typeof s.whenNot).toBe('string');
      expect(Array.isArray(s.steps)).toBe(true);
      expect(typeof s.why).toBe('string');
    }
    // ui-evidence 仍是被强制闸 (INV-4: 既有闸零改)。
    expect(shapeById('ui-evidence')!.enforced).toBeTruthy();
  });
});
