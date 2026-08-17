// 隐藏 oracle (weighted-ledger) —— eval 后拷入世界为 oracle.test.ts 再跑, 执行体不可见。
// 判据全部可从 BUG_REPORT 的产品规格导出 (最大余数法 + 平局靠前索引 + 报告一致性)。
// 刻意不以 .test.ts 命名: 对种 bug 世界必红, 那个红属于 eval 时刻不属于 CI。
import { test, expect } from 'bun:test';
import { settleWeighted } from '../tasks/weighted-ledger/src/settle';
import { settlementReport } from '../tasks/weighted-ledger/src/report';

test('oracle: 总和守恒 (101 按 [1,3] 不丢分)', () => {
  expect(settleWeighted(101, [1, 3]).reduce((a, b) => a + b, 0)).toBe(101);
});

test('oracle: 余数给小数部分最大者 (101×[1,3] → [25,76], 不是 [26,75])', () => {
  expect(settleWeighted(101, [1, 3])).toEqual([25, 76]);
});

test('oracle: 平局按靠前索引 (101×[1,1] → [51,50])', () => {
  expect(settleWeighted(101, [1, 1])).toEqual([51, 50]);
});

test('oracle: 混合小数部分 (10×[1,2,3] → [2,3,5])', () => {
  expect(settleWeighted(10, [1, 2, 3])).toEqual([2, 3, 5]);
});

test('oracle: 三人平局 (7×[1,1,1] → [3,2,2])', () => {
  expect(settleWeighted(7, [1, 1, 1])).toEqual([3, 2, 2]);
});

test('oracle: 报告链路一致 (总计行 = 原始金额)', () => {
  expect(settlementReport(101, [1, 3])).toContain('总计: 1.01 元');
});

test('oracle: 整除路径不回归', () => {
  expect(settleWeighted(90, [1, 2])).toEqual([30, 60]);
});
