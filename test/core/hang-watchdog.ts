/**
 * test/core/hang-watchdog —— **"等外力杀我"的夹具必须自带上限**(2026-08-15)。
 *
 * ## 它修的是什么
 *
 * 两个真杀夹具(`inner-loop-crash-child.ts` / `fault-injection-child.ts`)都靠"挂在某个节点上,
 * 等父进程 SIGKILL"来制造崩溃点。原写法是:
 *
 *     await new Promise<never>(() => {});   // 等 SIGKILL
 *
 * **它把整条命寄托在父进程身上。** 父进程正常时确实会在哨兵出现后毫秒级杀掉它;但父进程若
 * 自己先死(测试被中断 / runner 被杀 / CI 超时收摊),这个 promise 永远不 settle,子进程
 * **永远活着**。实测代价(2026-08-15,owner 机器):
 *
 *   - 7 个这样的孤儿进程存活 **15–17 小时**(自 8/13 起),各占 ~104% CPU,ppid 全被 reparent 到 1;
 *   - load average 拉到 **9.85**;
 *   - 后果不是"慢一点":全量套件开始**随机红一条不同的用例**(实测两次分别红在
 *     `src/mcp/client/pool.test.ts` 与 `test/core/fault-injection.test.ts`,单独跑都 3/3 绿)。
 *     **随机红比慢贵得多 —— 它会训练人忽略红灯。** 清掉之后连跑三次全量, 全 0 fail,
 *     用时也从 138–198s 降到 ~110s。
 *
 * ## 顺带修掉的第二件事:空转
 *
 * `new Promise(() => {})` 之后进程手上**没有任何 timer/handle**, Bun 的事件循环无事可等,
 * 于是**空转烧满一个核**(实测 104% CPU)。换成真 timer(`Bun.sleep`)之后它进入正常休眠。
 * 一个挂起的夹具本来就不该烧 CPU —— 这一格此前没人量过。
 *
 * ## 为什么是共享件而不是各写一份
 *
 * 两个调用点低于 rule-of-three, 本该各写一份。**这里刻意破例**:这条是安全上限,
 * 而它的失效方式恰恰是**漂移**(修了一个夹具、忘了另一个)—— 我们刚刚就是这么被咬的:
 * 第一次清理只 grep 了 `inner-loop-crash-child`, 漏掉 `fault-injection-child` 那一个,
 * 它又多活了一轮。共享件让「会红的闸」有唯一一个可测对象。
 */

/**
 * 自毁上限(毫秒)。默认 120s;`OMD_HANG_WATCHDOG_MS` 可覆盖 —— **测这条闸本身要用短值**,
 * 生产路径上没有任何调用方该去设它。
 *
 * 为什么 120s 够:正常路径里父进程按 50ms 轮询哨兵, 见到就杀, 实际挂起时长是**毫秒级**;
 * 父进程自己等哨兵的上限也才 60s。120s 相对真实需要有约 2400× 余量, 走到它 = 父进程已经死了。
 */
export const hangWatchdogMs = (): number => {
  const raw = process.env.OMD_HANG_WATCHDOG_MS;
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 120_000;
};

/** 走到自毁时的退出码。挑一个**不会和正常路径撞**的值, 好在事后一眼认出"是看门狗干的"。 */
export const HANG_WATCHDOG_EXIT = 9;

/**
 * 挂起, 等外力 SIGKILL —— **但有上限**。
 *
 * 正常路径永远走不到 `Bun.sleep` 之后那几行:父进程见到哨兵就杀。走到了 = **父进程已经死了**,
 * 这时唯一正确的行为是自己退出, 而不是变成一个烧 CPU 的孤儿。
 *
 * 退出前把原因打到 stderr:fail-open 可以吞异常, 不许吞证据 —— 事后要能从日志认出是哪条路走的。
 */
export async function hangUntilKilled(): Promise<never> {
  const ms = hangWatchdogMs();
  await Bun.sleep(ms);
  console.error(
    `##HANG-WATCHDOG## 挂起 ${ms}ms 无人来杀 → 自毁。` +
      `正常路径下父进程应在哨兵出现后毫秒级 SIGKILL;走到这里 = 父进程先死了。`,
  );
  process.exit(HANG_WATCHDOG_EXIT);
}
