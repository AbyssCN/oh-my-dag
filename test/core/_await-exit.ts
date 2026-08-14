/**
 * test/core/_await-exit —— **有界地**等子进程退出,并把两种"没等到"分开。
 *
 * ## 为什么需要它(2026-08-14 实测,不是预防性优化)
 *
 * `await proc.exited` 在 bun 1.3.14 上**偶尔永不 resolve**:子进程早已不在(卡住那一刻
 * 全进程列表里查无此子进程),而 `bun test` 主进程仍停在 `do_epoll_wait` 等一个不会来的
 * 退出事件。唯一兜底是测试自己的 `timeout` 参数,于是**一次挂死 = 180–240 秒墙钟**。
 *
 * 今天 9 次全量里中了 5 次(`fault-injection` 240s ×4 · `inner-loop-crash` 180s ×1);
 * 中一次,全量从 98s 变 284–342s。
 *
 * 同一个子系统的另一面是 `EBADF: bad file descriptor, epoll_ctl`(`node-failure-kind`
 * 中过 2 次)—— 对失效 fd 记账时**把错抛出来**的那一面。抛出来的至少留了痕迹,
 * 静默丢的这一面连痕迹都没有,只剩一个光秃秃的超时。
 *
 * ## 判据:两种"没等到"必须分开(本仓坑①:`NULL` ≠ 0 ≠ 不适用)
 *
 * | 情况 | 判据 | 处置 |
 * |---|---|---|
 * | 进程**已经不在**(或僵尸) | `/proc/<pid>` 消失或 `State: Z` | 它真的退了、只是事件丢了 → 抛,判词点名是**运行时缺陷**,本次读数无效 |
 * | 进程**还活着** | `/proc/<pid>` 在且非 Z | 这是**真挂死**,是被测对象的问题 → SIGKILL 后抛,判词点名被测对象 |
 *
 * 抹成一个 "timeout" 会让真挂死借这条 workaround 混过去 —— 那比慢更坏。
 *
 * ## 为什么不"自动恢复成 exit 0"
 *
 * 事件丢了的时候 `proc.exitCode` 是 `null`,**退出码是拿不到的**。从"`##RESULT##` 打出来了"
 * 推断"它 exit 0",是推断不是观测(P-2)。所以本模块只把 3–4 分钟的静默停摆换成十几秒的
 * 具名失败,不伪造读数。要不要更进一步(丢事件时重跑一次子进程)等有了发生率读数再说。
 */
import { existsSync, readFileSync } from 'node:fs';

/** 进程还在不在。`/proc` 读不到时回落 `kill(pid, 0)`(非 Linux)。僵尸(`Z`)算**已退出**。 */
export function processGone(pid: number): boolean {
  const stat = `/proc/${pid}/stat`;
  if (existsSync('/proc')) {
    if (!existsSync(stat)) return true;
    try {
      // stat 格式: `pid (comm) STATE ...` —— comm 可能含空格/括号, 取最后一个 ')' 之后。
      const s = readFileSync(stat, 'utf8');
      return s.slice(s.lastIndexOf(')') + 1).trim().startsWith('Z');
    } catch {
      return true; // 读的过程中消失了
    }
  }
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

/**
 * 等 `proc.exited`,最多 `timeoutMs`。超时即抛,判词按上表分类。
 *
 * @param what 这一步在做什么(进判词 —— 光有 pid 读的人不知道是哪一步卡了)。
 */
export async function awaitExitBounded(
  proc: Pick<Bun.Subprocess, 'exited' | 'pid' | 'kill'>,
  what: string,
  // 60s = 与同文件 `crashAt` 已有的哨兵 deadline 同一个数(内部一致)。
  // 合法耗时实测 ~1s/次(两个文件 15 条共 6.8s), 60s 远在它之上;而挂死是无限,
  // 所以这个数只要"远高于合法、远低于 180–240s 的测试超时"即可, 不需要调准。
  timeoutMs = 60_000,
): Promise<number> {
  const timedOut = Symbol('timeout');
  const r = await Promise.race([proc.exited, Bun.sleep(timeoutMs).then(() => timedOut)]);
  if (r !== timedOut) return r as number;

  const gone = processGone(proc.pid);
  if (gone) {
    throw new Error(
      `${what}: 等 proc.exited 超过 ${timeoutMs}ms, 而子进程 (pid ${proc.pid}) **已经不在**。` +
        ` 这是运行时的子进程回收缺陷 (bun ${Bun.version}: 退出事件丢了), 不是被测对象的问题 —— 本次读数无效, 重跑。` +
        ` 同源的另一面是 EBADF/epoll_ctl。详见 test/core/_await-exit.ts 的模块注。`,
    );
  }
  proc.kill('SIGKILL');
  throw new Error(
    `${what}: 等 proc.exited 超过 ${timeoutMs}ms, 且子进程 (pid ${proc.pid}) **还活着** ⇒ 这是真挂死,` +
      ` 是被测对象卡住了 (已 SIGKILL)。别把它当上面那条运行时缺陷放过。`,
  );
}
