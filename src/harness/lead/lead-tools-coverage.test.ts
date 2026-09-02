/**
 * lead-tools-coverage.test —— INV-18:原语覆盖三分法(D-23),无开放式排除逃逸。
 *
 * 怎么让它红:实装前 `coverage.ts` 不存在,module-not-found。之后:
 * 往 `PRIMITIVE_EXCLUDED` 加一项(哪怕是够不着的原语)会让并集与 `PRIMITIVE_IDS` 不再逐元素
 * 相等 → 红;`PRIMITIVE_EXCLUDED` 与契约 D-23 字面量不逐元素相等 → 红;
 * 三张表出现重叠 → 红;8 张图式漏一张没被任何卡引用 → 红。
 */
import { describe, expect, test } from 'bun:test';
import { PRIMITIVE_IDS } from '../primitive-registry';
import { GRAPH_SHAPES } from '../shapes';
import { CARD_COVERED, COMPILER_COVERED, PRIMITIVE_EXCLUDED } from './coverage';
import { ALL_SHAPE_IDS, MANUAL_SOURCES } from './render-manual';

// D-23 决策正文的字面量(逐元素相等,不许在这个文件里就地加宽 —— 改这个常量本身就是「回流改契约」的动作)。
const CONTRACT_PRIMITIVE_EXCLUDED = ['pipeline', 'iterate', 'router', 'race', 'saga', 'escape-hatch'];

describe('lead-tools-coverage (INV-18 三分法)', () => {
  test('三张表两两不相交', () => {
    const cardKeys = new Set(Object.keys(CARD_COVERED));
    const compiler = new Set(COMPILER_COVERED);
    const excluded = new Set(PRIMITIVE_EXCLUDED);
    for (const k of cardKeys) expect(compiler.has(k)).toBe(false);
    for (const k of cardKeys) expect(excluded.has(k)).toBe(false);
    for (const k of compiler) expect(excluded.has(k)).toBe(false);
  });

  test('三张表并集 === PRIMITIVE_IDS(13),逐元素相等(不是「减去排除表」的开放式恒真式)', () => {
    const union = new Set<string>([...Object.keys(CARD_COVERED), ...COMPILER_COVERED, ...PRIMITIVE_EXCLUDED]);
    expect(PRIMITIVE_IDS.length).toBe(13);
    expect(union.size).toBe(PRIMITIVE_IDS.length);
    expect([...union].sort()).toEqual([...PRIMITIVE_IDS].sort());
  });

  test('PRIMITIVE_EXCLUDED 逐元素等于契约 D-23 的六项字面量', () => {
    expect([...PRIMITIVE_EXCLUDED].sort()).toEqual([...CONTRACT_PRIMITIVE_EXCLUDED].sort());
    expect(PRIMITIVE_EXCLUDED.length).toBe(6);
  });

  test('CARD_COVERED 恰 5 项且值域 ⊆ 七张卡名', () => {
    expect(Object.keys(CARD_COVERED).length).toBe(5);
    const knownToolNames = new Set(['work', 'spawn', 'map', 'explore', 'best_of', 'research', 'decompose']);
    for (const tool of Object.values(CARD_COVERED)) expect(knownToolNames.has(tool)).toBe(true);
  });

  test('COMPILER_COVERED 恰 2 项(循环本体 + 收尾节点)', () => {
    expect([...COMPILER_COVERED].sort()).toEqual(['loop-until', 'verify']);
  });

  test('8 张 GRAPH_SHAPES 全部被卡覆盖(render-manual.ts 的 MANUAL_SOURCES),无排除项', () => {
    expect(GRAPH_SHAPES.length).toBe(8);
    const covered = new Set(Object.values(MANUAL_SOURCES).flatMap((src) => src.shapes));
    expect([...covered].sort()).toEqual([...ALL_SHAPE_IDS].sort());
    expect(covered.size).toBe(8);
  });

  test('反向自检:排除表不是无界的 —— 往里塞一个不存在的原语会破坏并集等式', () => {
    const polluted = new Set<string>([...Object.keys(CARD_COVERED), ...COMPILER_COVERED, ...PRIMITIVE_EXCLUDED, 'not-a-real-primitive']);
    expect([...polluted].sort()).not.toEqual([...PRIMITIVE_IDS].sort());
  });
});
