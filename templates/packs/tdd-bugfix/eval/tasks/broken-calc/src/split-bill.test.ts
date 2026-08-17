// 既有测试 (刻意没盖住 bug): 只测整除路径 —— eval 世界的起点是"全绿但有 bug"。
import { test, expect } from 'bun:test';
import { splitBill } from './split-bill';

test('整除: 4 人分 100 分', () => {
  expect(splitBill(100, 4)).toEqual([25, 25, 25, 25]);
});

test('单人拿全额', () => {
  expect(splitBill(37, 1)).toEqual([37]);
});
