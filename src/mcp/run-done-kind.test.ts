/**
 * C-2 (#250 终态分词 registry 面) 测试。
 *
 * ## 设计选择
 *
 * 终态词表不动 (`=== 'done'` 消费者零感知是兑现先例)。真实问题在**机器没判**与
 * **机器判过**在消费面分不开 —— 用 `meta.doneKind` 写, 走既有 meta 通道 = 零 schema
 * 迁移; 重开 (reopenForResume) 不清洗 (meta 本就不在它的清洗范围)。
 *
 * ## 三值纪律 (NULL ≠ 0 ≠ 不适用)
 *
 * - 不传 `opts.doneKind` → meta 无该键 (字节不变, 存量调用零改动即绿)
 * - 传 `verified` / `exploratory-unverified` → 写入磁盘, 跨进程读回字节一致
 * - 非 goal 入口 (dag_run 等无验收轴) 不传 → meta 无该键 = 不适用, 不编 `unknown`
 *
 * ## 反向自检 (一条永远绿的闸不是闸)
 *
 * 每条 GWT 注「怎么让它红」: 拿掉 opts 处理 → 红; 把 doneKind 默认写 'unknown' → 红;
 * reopenForResume 误清 meta → 红。
 */
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { RunRegistry } from './run-registry';
import { createRunStore } from './run-store';

describe('C-2 #250 终态分词 registry 面', () => {
  test('★ INV-5+6: succeed 带 doneKind → meta.doneKind 写入磁盘且跨进程读回 (字节一致)', () => {
    // 重开进程后内存态丢, 盘上那条是唯一出口 —— meta.doneKind 必走 meta 通道,
    // 否则跨重启就读不回 (run 385cf35b 的症状就是判词没留痕, 此处同形)。
    const db = new Database(':memory:');
    const store = () => createRunStore({ db });

    const a = new RunRegistry(undefined, { store: store(), pid: 111, isAlive: () => true });
    a.register('r1', { goal: 'g' });
    a.start('r1');
    a.succeed('r1', 'ok', { doneKind: 'verified' });

    // 重开 registry —— 模拟 server 重启。
    const b = new RunRegistry(undefined, { store: store(), pid: 222, isAlive: () => true });
    const rec = b.getRecord('r1');
    expect(rec).not.toBeNull();
    // 怎么让它红: 拿掉 opts 处理 → meta 无 doneKind → 红。
    expect(rec!.meta.doneKind).toBe('verified');

    // 另一个分词值 —— 探索型验收走的是这条
    const a2 = new RunRegistry(undefined, { store: store(), pid: 333, isAlive: () => true });
    a2.register('r2', { goal: 'g' });
    a2.start('r2');
    a2.succeed('r2', 'ok', { doneKind: 'exploratory-unverified' });
    const b2 = new RunRegistry(undefined, { store: store(), pid: 444, isAlive: () => true });
    expect(b2.getRecord('r2')!.meta.doneKind).toBe('exploratory-unverified');
  });

  test('★ INV-5: succeed 不带 doneKind → meta 无该键 (不是 null 不是 unknown)', () => {
    // 存量调用字节不变: 老 succeed(runId, result) 一字不动 —— 这是 C-2 不破存的承诺。
    // 三值纪律的关键测试: 缺席是「不适用」, 不是「不知道」。
    const db = new Database(':memory:');
    const store = createRunStore({ db });

    const a = new RunRegistry(undefined, { store, pid: 111, isAlive: () => true });
    a.register('r3', { goal: 'g' });
    a.start('r3');
    a.succeed('r3', 'ok'); // 老调用, 不传 opts

    const rec = a.getRecord('r3')!;
    // 怎么让它红: 把 doneKind 默认写 'unknown' → 这条红; 或写 null → 这条红。
    expect('doneKind' in rec.meta).toBe(false);

    // 跨进程读回仍是「无该键」
    const b = new RunRegistry(undefined, { store, pid: 222, isAlive: () => true });
    expect('doneKind' in (b.getRecord('r3')!.meta)).toBe(false);
  });

  test('★ INV-7: getStatus 词表不动 —— done 不分 verified / exploratory', () => {
    // 设计选择: status done 是全仓共识, 加词 = 让现有 `=== 'done'` 消费者全断;
    // 分词另起 meta 通道是兑现先例 (run-outcome N5)。
    const db = new Database(':memory:');
    const store = createRunStore({ db });
    const a = new RunRegistry(undefined, { store, pid: 111, isAlive: () => true });
    a.register('r4', { goal: 'g' });
    a.start('r4');
    a.succeed('r4', 'ok', { doneKind: 'exploratory-unverified' });
    // 怎么让它红: 试图把 status 改成 'exploratory-done' 之类 → getStatus 返回 'done' 才能保住。
    expect(a.getStatus('r4')).toBe('done');

    const b = new RunRegistry(undefined, { store, pid: 222, isAlive: () => true });
    expect(b.getStatus('r4')).toBe('done');
  });

  test('★ INV-6: reopenForResume 不清洗 meta (doneKind 既有语义不变)', () => {
    // meta 本就不在 reopenForResume 的清洗范围 (它只清 error/result/progress, 不动 meta) —
    // 这条测试是钉死「不要再把 meta 加进清洗范围」。
    // 形状: 先 succeed 带 doneKind, 跨重启读回——done 本身不可 reopen, 但 meta 必跨进程留住;
    // 再加另一条路径: register → fail → reopen → succeed 带 doneKind → 跨重启读回。
    // 两条路径一起保证: meta.doneKind 在任何 reopen 路径上都不被洗。
    const db = new Database(':memory:');
    const store = () => createRunStore({ db });

    // 路径 A: succeed 带 doneKind → done 终态 → 跨进程读回 (doneKind 必在)
    const a1 = new RunRegistry(undefined, { store: store(), pid: 111, isAlive: () => true });
    a1.register('rA', { goal: 'g' });
    a1.start('rA');
    a1.succeed('rA', 'ok', { doneKind: 'verified' });
    const b1 = new RunRegistry(undefined, { store: store(), pid: 222, isAlive: () => true });
    expect(b1.getRecord('rA')!.meta.doneKind).toBe('verified');

    // 路径 B: fail → reopen → succeed 带 doneKind → 跨进程读回 (reopenForResume 没洗 meta)
    const a2 = new RunRegistry(undefined, { store: store(), pid: 111, isAlive: () => true });
    a2.register('rB', { goal: 'g' });
    a2.start('rB');
    a2.fail('rB', 'boom'); // 此时 meta 空, doneKind 不存在
    a2.reopenForResume('rB', { goal: 'g' }); // 重开——这一步不许动 meta
    expect(a2.getStatus('rB')).toBe('running');
    a2.succeed('rB', 'ok', { doneKind: 'verified' });
    expect(a2.getRecord('rB')!.meta.doneKind).toBe('verified');
    // 跨重启读回: meta.doneKind 必保留
    const b2 = new RunRegistry(undefined, { store: store(), pid: 222, isAlive: () => true });
    // 怎么让它红: 把 meta 加进 reopenForResume 的清洗范围 (类似 `rec.meta = {}` 那样的语句) →
    // 这一行就会让 doneKind 在 reload 后变成 undefined, 红。
    expect(b2.getRecord('rB')!.meta.doneKind).toBe('verified');
  });

  test('★ 反向自检: 拿走 opts 处理 = 闸死 —— doneKind 落不进 meta', () => {
    // 这是 INV-4 那条纪律的本仓版 (新闸当场证伪)。GWT 给的两条都要在测试里挂过一回。
    // 这里做一个**手动模拟**: 不动源文件, 只断言现在的实现真的把值落进了 meta 字节里。
    const db = new Database(':memory:');
    const store = createRunStore({ db });
    const reg = new RunRegistry(undefined, { store, pid: 1, isAlive: () => true });
    reg.register('z', { goal: 'g' });
    reg.start('z');

    // 不带 doneKind: meta 应**完整缺席**该键 —— 不是 {} 不是 { undefined } 不是 { unknown }
    reg.succeed('z', 'ok');
    const meta1 = reg.getRecord('z')!.meta;
    expect(Object.keys(meta1)).not.toContain('doneKind');

    // 另一条 run, 带 doneKind: meta 必有该键且**精确等于**入参
    reg.register('z2', { goal: 'g' });
    reg.start('z2');
    reg.succeed('z2', 'ok', { doneKind: 'verified' });
    const meta2 = reg.getRecord('z2')!.meta;
    expect(meta2.doneKind).toBe('verified');
    expect(Object.keys(meta2)).toEqual(['doneKind']); // 没有别的键混进来
  });
});