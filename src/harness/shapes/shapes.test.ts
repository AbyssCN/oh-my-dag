import { describe, expect, test } from 'bun:test';
import { conductorSystemPrompt } from '../conductor-plan';
import { GRAPH_SHAPES, renderShapesForPrompt, shapeById } from './index';

// shape = 图式的单一真源 (2026-07-26)。这些闸守的是"它别退化回散文"。

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

  test('conductor prompt 里的 shape 段来自这份数据 (改数据 prompt 自动跟着变)', () => {
    const prompt = conductorSystemPrompt({ profile: 'full' });
    for (const s of GRAPH_SHAPES) expect(prompt).toContain(s.id);
    expect(prompt).toContain('NOT when:');
  });
});
