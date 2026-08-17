// 隐藏 oracle —— **eval 结束后**才拷进任务世界 (拷成 oracle.test.ts) 再跑, 执行体全程看不见它
// (防照抄答案当测试)。刻意**不**以 .test.ts 命名: 否则仓库全量 bun test 会自动发现它,
// 而它对种了 bug 的 fixture 必然红 —— oracle 的红属于 eval 时刻, 不属于 CI。
// 判据: 修复后总和守恒, 且既有行为不回归。
import { test, expect } from 'bun:test';
import { splitBill } from '../tasks/broken-calc/src/split-bill';

test('oracle: 总和守恒 (3 人分 100 分不许丢 1 分)', () => {
  expect(splitBill(100, 3).reduce((a, b) => a + b, 0)).toBe(100);
});

test('oracle: 余数摊派后每人差距 ≤ 1 分', () => {
  const shares = splitBill(101, 3);
  expect(Math.max(...shares) - Math.min(...shares)).toBeLessThanOrEqual(1);
});

test('oracle: 整除路径不回归', () => {
  expect(splitBill(100, 4)).toEqual([25, 25, 25, 25]);
});
