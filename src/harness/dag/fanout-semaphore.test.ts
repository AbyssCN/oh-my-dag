/**
 * src/harness/dag/fanout-semaphore.test —— P3 S8 进程级 leaf 在飞上限 (D-25 / INV-14)。
 * 反向自检写在各 test 注释里。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { _resetLeafSlotsForTest, acquireLeafSlot, configureLeafSlots, leafSlotStats } from './fanout-semaphore';

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

afterEach(() => _resetLeafSlotsForTest());

describe('acquireLeafSlot — cap 缺席 = 不限 (零回归)', () => {
  test('100 次 acquire 零等待, 计数照记, release 后归零', async () => {
    configureLeafSlots(undefined);
    const releases: (() => void)[] = [];
    for (let i = 0; i < 100; i++) releases.push(await acquireLeafSlot());
    expect(leafSlotStats()).toEqual({ cap: undefined, inflight: 100, waiting: 0 });
    for (const r of releases) r();
    expect(leafSlotStats().inflight).toBe(0);
  });
});

describe('acquireLeafSlot — cap=2', () => {
  test('★ 第 3 个 acquire 挂起, 直到有人 release; FIFO 放行', async () => {
    configureLeafSlots(2);
    const r1 = await acquireLeafSlot();
    const r2 = await acquireLeafSlot();
    let third: (() => void) | null = null;
    let fourth: (() => void) | null = null;
    const p3 = acquireLeafSlot().then((r) => { third = r; });
    const p4 = acquireLeafSlot().then((r) => { fourth = r; });
    await tick();
    // 证伪: 把 waiters 队列去掉 (acquire 直接 inflight++) → third 立刻非 null, 这条红。
    expect(third).toBeNull();
    expect(leafSlotStats()).toEqual({ cap: 2, inflight: 2, waiting: 2 });
    r1();
    await p3;
    expect(third).not.toBeNull();
    expect(fourth).toBeNull(); // FIFO: 只放了一个
    r2();
    await p4;
    expect(fourth).not.toBeNull();
    expect(leafSlotStats()).toEqual({ cap: 2, inflight: 2, waiting: 0 });
    third!();
    fourth!();
    expect(leafSlotStats().inflight).toBe(0);
  });

  test('release 幂等: 同一把 release 调两次不把计数打负', async () => {
    configureLeafSlots(1);
    const r = await acquireLeafSlot();
    r();
    r();
    expect(leafSlotStats().inflight).toBe(0);
  });

  test('cap 改大后排队者被放行; cap ≤0 视为不限', async () => {
    configureLeafSlots(1);
    const r1 = await acquireLeafSlot();
    let got = false;
    const p = acquireLeafSlot().then(() => { got = true; });
    await tick();
    expect(got).toBe(false);
    configureLeafSlots(3);
    await p;
    expect(got).toBe(true);
    r1();
    configureLeafSlots(0);
    expect(leafSlotStats().cap).toBeUndefined();
  });
});
