/**
 * lead-tools-manual.test —— D-3:manual 从真源渲染,不是第二份手抄。
 *
 * 怎么让它红:实装前 `renderManual` 不存在,module-not-found。之后:改
 * `GRAPH_SHAPES` 里任一条 `when`(或本测试临时改写的那条),`renderManual` 的输出必须跟着变 ——
 * 若某天有人把 manual 改回手写死字符串,这条测试会因为「改了真源、输出没变」而红。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { PRIMITIVE_REGISTRY } from '../primitive-registry';
import { GRAPH_SHAPES } from '../shapes';
import { ALL_SHAPE_IDS, MANUAL_SOURCES, renderManual } from './render-manual';
import { LEAD_TOOL_NAMES } from './tools/index';

describe('lead-tools-manual (D-3 从真源渲染)', () => {
  test('七张卡 manual 非空,且各自的 headline 不同', () => {
    const manuals = LEAD_TOOL_NAMES.map((name) => renderManual(name));
    for (const m of manuals) expect(m.length).toBeGreaterThan(0);
    expect(new Set(manuals.map((m) => m.split('\n')[0])).size).toBe(LEAD_TOOL_NAMES.length);
  });

  test('renderManual 逐字引用 PRIMITIVE_REGISTRY 的参数名(不是手抄的第二份)', () => {
    const src = MANUAL_SOURCES.spawn;
    expect(src.primitives).toContain('parallel');
    const parallelSchema = PRIMITIVE_REGISTRY.parallel.paramsSchema as unknown as { shape: Record<string, unknown> };
    for (const key of Object.keys(parallelSchema.shape)) {
      expect(renderManual('spawn')).toContain(key);
    }
  });

  describe('renderManual 跟随 GRAPH_SHAPES 实时变化(证伪「manual 是第二份手抄」)', () => {
    const shape = GRAPH_SHAPES.find((s) => s.id === 'runtime-work-list')!;
    const originalWhen = shape.when;

    afterEach(() => {
      shape.when = originalWhen;
    });

    test('map 的 manual 含 runtime-work-list.when 的真实文本', () => {
      expect(renderManual('map')).toContain(originalWhen);
    });

    test('改 GRAPH_SHAPES 的 when 文本 → renderManual 的输出立刻变(不是缓存的第二份)', () => {
      const before = renderManual('map');
      shape.when = `${originalWhen} [S1-TEST-MUTATION]`;
      const after = renderManual('map');
      expect(after).not.toBe(before);
      expect(after).toContain('[S1-TEST-MUTATION]');
    });
  });

  test('8 张 GRAPH_SHAPES 全部至少被一张卡的 MANUAL_SOURCES 引用(INV-18 的图式那半)', () => {
    const covered = new Set(Object.values(MANUAL_SOURCES).flatMap((src) => src.shapes));
    expect([...covered].sort()).toEqual([...ALL_SHAPE_IDS].sort());
  });
});
