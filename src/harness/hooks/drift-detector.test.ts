/**
 * drift-detector 的**空转累计**契约 (2026-08-03, G5)。
 *
 * 本文件只盯 `summary()` 那一格 —— 检出逻辑 (环/阈值/注入/恢复) 的行为不在这里断言。
 *
 * ## 为什么需要它
 *
 * 检测器一直在工作 (单次 live 命中 16 个回合、最高同签名重复 39 次), 但它的出口是
 * `onSpinning`/`onRecovered` 两个**函数回调**, 而隔离档的 leaf 跑在 bwrap 子进程里,
 * 只有 JSON 安全的东西过得了那道边界 —— 回调在那条路上**结构性接不了**。
 * 于是这个信号至今零消费者: **不是忘了接, 是接不了**。`summary()` 把它变成数据,
 * 随 leaf 结果过河, 在 executor-dag 转成 `leaf-spin` 观察进留痕库。
 *
 * ## 判据的诚实边界
 *
 * 这里量的是**频率读数**, 不带任何停机语义。要不要把它升成 BLOCKED、K 取几,
 * 得先有"真跑上多久命中一次"的数 —— 先有读数再谈判据, 别反过来 (同 observations 的注)。
 */
import { describe, expect, test } from 'bun:test';
import { createDriftTracker } from './drift-detector';

describe('空转累计 (G5 频率读数, 2026-08-03)', () => {
  const spin = (t: ReturnType<typeof createDriftTracker>, sig: string, n: number): void => {
    for (let i = 0; i < n; i++) t.note('bash', { command: sig });
  };

  test('没卡过 → 全 0 (缺席 ≠ 0 的口径靠调用方: agent-leaf 只在 >0 时带出去)', () => {
    const t = createDriftTracker();
    t.note('bash', { command: 'a' });
    t.note('bash', { command: 'b' });
    expect(t.summary()).toEqual({ spinEvents: 0, maxSameCount: 0, stuckSigs: [] });
  });

  test('卡一次 → 回合数 1, 记下卡在什么上, maxSameCount ≥ 阈值', () => {
    const t = createDriftTracker({ threshold: 4 });
    spin(t, 'same', 4);
    const s = t.summary();
    expect(s.spinEvents).toBe(1);
    expect(s.maxSameCount).toBeGreaterThanOrEqual(4);
    expect(s.stuckSigs.length).toBe(1);
  });

  /**
   * **这条是本组的要害。** `reset()` 是每轮 agent 开始时清环用的, 而累计量的是
   * "这个 leaf **整场**卡了多少" —— 跟着 reset 清就只剩最后一轮, 那不是要问的问题,
   * 而且症状是沉默的 (数字看着正常, 只是小了)。
   * 后人很容易"顺手"把它加进 reset 里当漏清的 bug 修掉, 这条闸就是拦那一手。
   */
  test('reset 不清累计 —— 它量的是整场, 不是最后一轮', () => {
    const t = createDriftTracker({ threshold: 4 });
    spin(t, 'x', 4);
    expect(t.summary().spinEvents).toBe(1);
    t.reset();
    spin(t, 'y', 4);
    expect(t.summary().spinEvents).toBe(2); // 跨轮累加, 不是 1
    expect(t.summary().stuckSigs.length).toBe(2);
  });

  test('反向自检: reset 确实清了环 (否则上一条是恒真式)', () => {
    const t = createDriftTracker({ threshold: 4 });
    spin(t, 'z', 3); // 差一次就到阈值
    t.reset();
    t.note('bash', { command: 'z' }); // 环清了 → 这一次不该凑成 4
    expect(t.summary().spinEvents).toBe(0);
  });

  test('stuckSigs 去重且有上界 (排障用, 不许把一整场的签名灌进留痕库)', () => {
    const t = createDriftTracker({ threshold: 4 });
    for (let i = 0; i < 30; i++) {
      spin(t, `sig-${i}`, 4);
      t.reset();
    }
    expect(t.summary().spinEvents).toBe(30);
    expect(t.summary().stuckSigs.length).toBeLessThanOrEqual(12);
  });
});
