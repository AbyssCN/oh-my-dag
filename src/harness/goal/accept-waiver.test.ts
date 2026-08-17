/**
 * S-37 下沉 run-goal 半: `makeBaselineWaiver` 闭包 (D-3, goal 层) 的三格 GWT-7。
 *
 * 闭包由 `runGoal` 在 `baselineSide` 算好后挂进 `freezeCriterion.waiveRed`,
 * 引擎在判红点 (D-K 节点命令 / 环内冻结判据) 调用。
 * 引擎侧 (D-K / 环内) 的 GWT 1-6 见 `dag/engine-accept-waiver.test.ts`。
 *
 * 三格:
 *   - 基线 {A,B}, after {A} → 返赦免注记 (含 A)
 *   - 基线 {A},   after {A,C} → null (C 是新失败)
 *   - 基线 {A,B}, after 空集 → null (INV-2: 解析不出测试名 = 编译错/跑不起来/超时)
 *
 * 反向自检 (SDD 切片 2): 把闭包里 `if (!baselineSet.has(n)) return null` 改成返注记 →
 *   第二格 (新失败 C) 错误地通过 → GWT-7 第 2 格红。
 */
import { describe, expect, test } from 'bun:test';
import { makeBaselineWaiver } from './run-goal';

/** `bun test` 输出里 `(fail) <name>` 的标准格式 —— 与 `accept-delta.ts:47` 同源正则口径。 */
const failOutput = (names: string[]): string => names.map((n) => `(fail) ${n}`).join('\n');

describe('S-37 下沉: makeBaselineWaiver (goal 层闭包, D-3)', () => {
  test('★ GWT-7.a: 基线 {A,B}, after {A} ⊆ 基线 → 返赦免注记 (含 A)', () => {
    const waive = makeBaselineWaiver(['A', 'B']);
    const note = waive(failOutput(['A']));
    expect(note).not.toBeNull();
    expect(note).toContain('存量红赦免');
    expect(note).toContain('A');
    expect(note).toContain('1'); // N = 1
    // 名单必须按 (fail) 解析口径出 (与 D-3 注记一致)
    expect(note!).toMatch(/全在基线\s*—\s*A\s*$/);
  });

  test('★ GWT-7.b: 基线 {A}, after {A,C} (C 不在基线) → null (新失败不赦免)', () => {
    const waive = makeBaselineWaiver(['A']);
    const note = waive(failOutput(['A', 'C']));
    expect(note).toBeNull();
  });

  test('★ GWT-7.c: 基线 {A,B}, after 空集 (解析不出失败名) → null (INV-2)', () => {
    const waive = makeBaselineWaiver(['A', 'B']);
    // 编译错 / 跑不起来 / 超时 —— 无 (fail) 行, 解析不出失败名
    const note = waive('error TS2322: 类型不匹配 (无测试名)');
    expect(note).toBeNull();
  });

  test('★ 边界: 基线空集 → 任意非空 after 都含新失败 → null', () => {
    // 空基线意味着没有任何老失败可赦免; after 非空 = 100% 新失败 (D-3 fail-closed)。
    const waive = makeBaselineWaiver([]);
    expect(waive(failOutput(['A']))).toBeNull();
    // after 也空 → 仍 null (INV-2 同款)
    expect(waive('')).toBeNull();
  });

  test('★ 边界: after 多于基线但全 ⊆ → 仍赦免 (注记含全部名字)', () => {
    const waive = makeBaselineWaiver(['A', 'B', 'C']);
    const note = waive(failOutput(['A', 'B']));
    expect(note).not.toBeNull();
    expect(note).toContain('A');
    expect(note).toContain('B');
    expect(note).toContain('2'); // N = 2
  });
});