/** C1 effect scope —— 三条硬语义各一条正向 + 反向自检。 */
import { describe, expect, test } from 'bun:test';
import { createEffectScope } from './effect';

describe('createEffectScope', () => {
  test('disposer 逆序执行 (后建先拆)', async () => {
    const order: string[] = [];
    const scope = createEffectScope();
    scope.defer(() => void order.push('a'));
    scope.defer(() => void order.push('b'));
    scope.defer(async () => void order.push('c'));
    await scope.dispose();
    expect(order).toEqual(['c', 'b', 'a']);
  });

  test('重复 dispose no-op: 每个 disposer 至多跑一次, 且返回同一 promise', async () => {
    let runs = 0;
    const scope = createEffectScope();
    scope.defer(() => void runs++);
    const p1 = scope.dispose();
    const p2 = scope.dispose();
    expect(p1).toBe(p2);
    await p1;
    await scope.dispose();
    expect(runs).toBe(1);
  });

  test('单个 disposer 抛错: 其余仍执行, 错误原文 + label 留痕 (不吞证据)', async () => {
    const order: string[] = [];
    const warned: string[] = [];
    const scope = createEffectScope((m) => void warned.push(m));
    scope.defer(() => void order.push('inner'));
    scope.defer(() => {
      throw new Error('boom-evidence');
    }, 'exploding-pool');
    await scope.dispose();
    expect(order).toEqual(['inner']);
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('exploding-pool');
    expect(warned[0]).toContain('boom-evidence');
  });

  test('提前释放: 单独执行并摘除, dispose() 不再跑它', async () => {
    let runs = 0;
    const scope = createEffectScope();
    const release = scope.defer(() => void runs++);
    await release();
    await release();
    expect(runs).toBe(1);
    await scope.dispose();
    expect(runs).toBe(1);
  });

  test('反向自检: 已 dispose 的 scope 上注册必须 throw (静默接受 = 资源永不释放)', async () => {
    const scope = createEffectScope();
    await scope.dispose();
    expect(scope.disposed).toBe(true);
    expect(() => scope.defer(() => {}, 'late')).toThrow(/已 dispose/);
  });

  test('异步 disposer 被等待: dispose() 结算时资源确已释放', async () => {
    let released = false;
    const scope = createEffectScope();
    scope.defer(async () => {
      await new Promise((r) => setTimeout(r, 10));
      released = true;
    });
    await scope.dispose();
    expect(released).toBe(true);
  });
});
