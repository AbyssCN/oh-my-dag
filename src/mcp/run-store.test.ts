/**
 * S2 registry 身份持久面 (2026-08-03)。
 *
 * 缺陷: `RunRegistry` 是这个 server 唯一那份"哪些 run 在飞"的真相, 而它纯内存 —— 而 MCP server
 * 是 stdio + **客户端消失即自杀**, 于是"重启"不是异常路径, 是每次 Claude 会话结束都会发生的事。
 * checkpoint 一直在盘上, 但**没人记得那个 runId 存在过**。
 *
 * 这一条钉的两件事, 第二件比第一件重要:
 *  ① 重启后 runId 还认得出来 (否则 resume 无从谈起);
 *  ② **不许把 `running` 原样恢复** —— 属主进程都没了还说"在跑", 比不持久化更坏:
 *     不持久化至少是"不知道", 这是"知道错的", 而且它会让人一直等一个永远不会有结果的 run。
 */
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { RunRegistry } from './run-registry';
import { createRunStore } from './run-store';

/** 共享一个 :memory: db 造"同一份磁盘, 两个进程" —— 第二个 registry 就是重启后的 server。 */
const shared = () => {
  const db = new Database(':memory:');
  return { store: () => createRunStore({ db }) };
};

describe('run 身份持久面', () => {
  test('重启后 runId 还在, 而且带着 goal 与状态', () => {
    const { store } = shared();
    const a = new RunRegistry(undefined, { store: store(), pid: 111, isAlive: () => true });
    a.register('r1', { goal: '干点活', meta: { tool: 'dag_goal' } });
    a.start('r1');
    a.succeed('r1', 'ok');

    const b = new RunRegistry(undefined, { store: store(), pid: 222, isAlive: () => true });
    expect(b.getStatus('r1')).toBe('done');
    expect(b.getRecord('r1')?.goal).toBe('干点活');
    expect(b.getRecord('r1')?.meta).toEqual({ tool: 'dag_goal' });
  });

  test('**属主进程没了的 running → 判成被打断, 不是"在跑"**', () => {
    const { store } = shared();
    const a = new RunRegistry(undefined, { store: store(), pid: 111, isAlive: () => true });
    a.register('r2', { goal: '长活的活' });
    a.start('r2'); // 盘上留下 running + pid 111

    // 重启: 111 已经不在了 (上一个 server 的进程)。
    const b = new RunRegistry(undefined, { store: store(), pid: 222, isAlive: (p) => p === 222 });
    expect(b.getStatus('r2')).toBe('failed');
    expect(b.getRecord('r2')?.error).toContain('属主进程已不在');
    // 下一步与 failed/cancelled 完全一样 —— 所以不造新词, 而 resume 直接接得上。
    expect(() => b.reopenForResume('r2', { goal: '长活的活' })).not.toThrow();
    expect(b.getStatus('r2')).toBe('running');
  });

  test('属主还活着的 running → 原样保留 (别把在飞的 run 判死)', () => {
    // 同一个 cwd 起两个 server 的情形: 另一个进程真的在跑它, 判死等于把别人的活报销了。
    const { store } = shared();
    const a = new RunRegistry(undefined, { store: store(), pid: 111, isAlive: () => true });
    a.register('r3', { goal: '别人在跑' });
    a.start('r3');

    const b = new RunRegistry(undefined, { store: store(), pid: 222, isAlive: () => true });
    expect(b.getStatus('r3')).toBe('running');
  });

  test('续跑把属主改成本进程 —— 否则下次 hydrate 会把在跑的判成被打断', () => {
    const { store } = shared();
    const a = new RunRegistry(undefined, { store: store(), pid: 111, isAlive: () => true });
    a.register('r4', { goal: 'g' });
    a.start('r4');
    a.fail('r4', '挂了');

    const b = new RunRegistry(undefined, { store: store(), pid: 222, isAlive: (p) => p === 222 });
    b.reopenForResume('r4', { goal: 'g' });

    // 第三次起来时 222 还活着 → 它该看到 running, 而不是"被打断"。
    const c = new RunRegistry(undefined, { store: store(), pid: 333, isAlive: (p) => p === 222 || p === 333 });
    expect(c.getStatus('r4')).toBe('running');
  });

  test('失败原因跨重启还在 (查为什么挂了是 failed 的全部意义)', () => {
    const { store } = shared();
    const a = new RunRegistry(undefined, { store: store(), pid: 111, isAlive: () => true });
    a.register('r5', { goal: 'g' });
    a.start('r5');
    a.fail('r5', 'conductor 出图失败: 座位没配');

    const b = new RunRegistry(undefined, { store: store(), pid: 222, isAlive: () => true });
    expect(b.getRecord('r5')?.error).toBe('conductor 出图失败: 座位没配');
  });

  test('不给 store → 老语义, 零磁盘 (单测与旧调用方一个字不用改)', () => {
    const r = new RunRegistry();
    r.register('x', { goal: 'g' });
    expect(r.getStatus('x')).toBe('pending');
  });

  test('**持久化挂了不把一次真跑带走** —— 不变量在边界上成立, 不靠 store 有礼貌', () => {
    const broken = {
      put: () => {
        throw new Error('磁盘满了');
      },
      all: () => [],
      close: () => {},
    };
    const r = new RunRegistry(undefined, { store: broken as never });
    expect(() => r.register('y', { goal: 'g' })).not.toThrow();
    expect(() => r.start('y')).not.toThrow();
    expect(r.getStatus('y')).toBe('running'); // 内存热路径照常工作
  });
});
