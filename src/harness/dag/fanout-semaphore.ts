/**
 * src/harness/dag/fanout-semaphore —— **进程级** leaf 在飞上限 (P3 契约 S8 / D-25 / INV-14, 2026-09-02)。
 *
 * 并发三层: ① 题内 `maxFanout` (一张图同时派几个, 由 ready-set pump 管) ② **本文件**: 一个进程里
 * 同时在飞的模型型 leaf (agent + inproc) 总数 ③ 题间 8 路 (bench 宿主侧, 不在引擎)。
 *
 * ② 为什么必须独立于 ①: S6b 之后 conductor 的每次派发是一次**嵌套 run**, 各自带一份 `maxFanout`;
 * 两个 conductor 同时派 map(N) 就是 2N 个 leaf 同时打同一个 provider —— batch 7 minimax 侧 31 次
 * 502/超时正是这形态。① 只看得见自己那张图, 挡不住跨 run 的叠加; 只有进程级的一把闸看得见总数。
 *
 * 形状: 契约冻结 `acquireLeafSlot(): Promise<() => void>` (release 走 finally)。cap 由装配层经
 * `ExecutorDagConfig.maxInflightLeaves` 给, 引擎在 run 起跑时 `configureLeafSlots(cap)` 一次;
 * 缺席 = 不限 (零回归: `acquireLeafSlot` 立即返回一个 no-op release)。
 *
 * 不重复解析 `OMD_MAX_FANOUT` (D-25): 题内 cap 的真源链是 fleet.ts → assemble.ts `effectiveFanout`,
 * 这里只吃装配层算好的数。
 *
 * 证伪方式 (fanout-semaphore.test.ts): cap=2 下第 3 个 acquire 必须挂起到有人 release; 把 `waiters`
 * 队列去掉 → 那条红。cap 缺席 → 100 个 acquire 零等待, 把 no-op 分支去掉 → 那条红。
 */

interface Waiter {
  resolve: (release: () => void) => void;
}

let cap: number | undefined;
let inflight = 0;
const waiters: Waiter[] = [];

/** 装配 / 引擎起跑时调一次。`undefined` 或 ≤0 = 不限。改小 cap 不杀在飞的, 只让后来者等。 */
export function configureLeafSlots(next: number | undefined): void {
  cap = next !== undefined && Number.isFinite(next) && next > 0 ? Math.floor(next) : undefined;
  drain();
}

/** 当前配置 (读数面; `undefined` = 不限)。 */
export function leafSlotCap(): number | undefined {
  return cap;
}

/** 当前在飞数 + 排队数 (读数面, R-1 「并行宽度分布」的进程级那一列)。 */
export function leafSlotStats(): { cap: number | undefined; inflight: number; waiting: number } {
  return { cap, inflight, waiting: waiters.length };
}

function makeRelease(): () => void {
  let released = false;
  return () => {
    if (released) return; // 幂等: finally 里双 release 不许把计数打负
    released = true;
    inflight = Math.max(0, inflight - 1);
    drain();
  };
}

function drain(): void {
  while (waiters.length > 0 && (cap === undefined || inflight < cap)) {
    const w = waiters.shift()!;
    inflight++;
    w.resolve(makeRelease());
  }
}

/**
 * 拿一个在飞槽。cap 缺席 → 立即返回 (计数照记, 不等)。有 cap 且满 → 排队 (FIFO), 直到有人 release。
 * 调用方必须 `try { … } finally { release() }`。
 */
export function acquireLeafSlot(): Promise<() => void> {
  if (cap === undefined || inflight < cap) {
    inflight++;
    return Promise.resolve(makeRelease());
  }
  return new Promise<() => void>((resolve) => {
    waiters.push({ resolve });
  });
}

/** 测试用: 清空 cap / 计数 / 队列 (排队中的 waiter 被放行, 免得测试挂死)。 */
export function _resetLeafSlotsForTest(): void {
  cap = undefined;
  inflight = 0;
  while (waiters.length > 0) {
    const w = waiters.shift()!;
    inflight++;
    w.resolve(makeRelease());
  }
  inflight = 0;
}
