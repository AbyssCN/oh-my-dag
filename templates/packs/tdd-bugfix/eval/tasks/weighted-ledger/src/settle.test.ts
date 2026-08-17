// 既有测试。整除路径全绿; ⚠ 最后一条钉住余数分配的**规格语义** —— 它现在也绿
// (整除无余数), 但「把余数全塞给第一个人」式的朴素修法会把它踩红 (陷阱是规格不是刁难)。
import { test, expect } from 'bun:test';
import { settleWeighted } from './settle';
import { settlementReport } from './report';

test('整除: 100 分按 [1,1,1,1]', () => {
  expect(settleWeighted(100, [1, 1, 1, 1])).toEqual([25, 25, 25, 25]);
});

test('整除: 90 分按 [1,2]', () => {
  expect(settleWeighted(90, [1, 2])).toEqual([30, 60]);
});

test('报告含每人一行与总计行', () => {
  const r = settlementReport(90, [1, 2]);
  expect(r).toContain('参与者1');
  expect(r).toContain('总计: 0.90 元');
});

test('规格钉: 权重大者不吃亏 —— 份额次序与权重次序一致', () => {
  const s = settleWeighted(90, [1, 2, 3]);
  expect(s[0]! <= s[1]! && s[1]! <= s[2]!).toBe(true);
});
