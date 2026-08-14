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

/**
 * 一个**用完就能撤掉**的超时闸门。
 *
 * ⚠ 别用 `Bun.sleep(ms)` 直接进 `Promise.race`:race 提前结束时那个 sleep **还挂着**,
 * 它把事件循环钉住,`bun test` 跑完也退不出去。2026-08-14 实测:本文件三处传了 60_000,
 * 于是 runner 挂满 200s 被 kill —— **一个防挂死的工具自己造了一次挂死**。
 * `unref()` 让它不再算作"还有活要干", `cancel()` 供正常路径立刻撤掉。
 */
function timeoutGate<T>(ms: number, value: T): { promise: Promise<T>; cancel: () => void } {
  let id: ReturnType<typeof setTimeout>;
  const promise = new Promise<T>((resolve) => {
    id = setTimeout(() => resolve(value), ms);
    (id as unknown as { unref?: () => void }).unref?.();
  });
  return { promise, cancel: () => clearTimeout(id) };
}

/**
 * 起子进程,**并确认要到的管道真的在**;没在就重起一次。
 *
 * 同一个子系统的第三张脸(2026-08-14 实测,8 次全量中 2 次):明明传了 `stdout: 'pipe'`,
 * 拿回来的 `proc.stdout` 是 `undefined` —— 于是 `stdout.getReader()` 当场
 * `TypeError`,而判词长得像被测对象 boot 失败(实际是 spawn 没兑现契约)。
 *
 * **重试是正当的,不是掩盖**:此刻子进程还什么都没做,而"要的管道不在"是**直接观测**到的
 * 契约违约,不是从别的现象推断出来的(对比:退出码丢了只能抛,因为那是推断,见 `awaitExitBounded`)。
 * 两次都拿不到 ⇒ 抛,判词点名是 spawn 层不是被测对象。
 */
export function spawnWithPipes<T extends { kill(): void }>(
  /** 真正的 `Bun.spawn(...)` 调用 —— 收 thunk 而不是收参数, 这样调用点的字面量 opts 推出来的类型原样保留。 */
  spawn: () => T,
  needs: readonly ('stdin' | 'stdout' | 'stderr')[],
  what: string,
): T {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const proc = spawn();
    const missing = needs.filter((k) => (proc as unknown as Record<string, unknown>)[k] === undefined);
    if (missing.length === 0) return proc;
    proc.kill();
    if (attempt === 2) {
      throw new Error(
        `${what}: 连起两次子进程, 要的管道 [${missing.join(', ')}] 都没建起来 (传了 'pipe' 却拿到 undefined)。` +
          ` 这是 spawn 层没兑现契约 (bun ${Bun.version}), 不是被测对象的问题。`,
      );
    }
  }
  throw new Error('unreachable');
}

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
 * 有界地把管道读干。
 *
 * ⚠ 2026-08-14 实测:光给 `proc.exited` 加界**不够** —— `new Response(proc.stdout).text()`
 * 读到 EOF 同样是**无界**的,子进程/管道一旦被运行时丢掉,这一步就永远等下去,
 * 于是仍然撞满测试自己的 240s 超时(F4 那次)。**一条链上只要还剩一个无界等待,整条界就是虚的。**
 */
export async function readAllBounded(streams: ReadableStream<Uint8Array>[], what: string, timeoutMs = 60_000): Promise<string[]> {
  const timedOut = Symbol('timeout');
  const gate = timeoutGate(timeoutMs, timedOut);
  try {
    const r = await Promise.race([Promise.all(streams.map((s) => new Response(s).text())), gate.promise]);
    if (r === timedOut) {
      throw new Error(`${what}: 读子进程管道超过 ${timeoutMs}ms 还没到 EOF ⇒ 管道被运行时丢了 (bun ${Bun.version}), 本次读数无效, 重跑。`);
    }
    return r as string[];
  } finally {
    gate.cancel();
  }
}

/**
 * **只要"它死了",不要退出码** —— SIGKILL 之后的等待专用(`crashAt`)。
 *
 * 与 `awaitExitBounded` 的分野是**需求不同,不是宽严不同**:
 *   - `runChild` 要退出码 ⇒ 事件丢了就拿不到,只能抛(伪造 exit 0 是推断不是观测,P-2);
 *   - `crashAt` 只要"进程没了" ⇒ `processGone(pid)` **直接观测**得到这件事,
 *     所以运行时把退出事件弄丢(挂死 or 抛 EBADF)时,这里**可以并且应该**照常往下走。
 *
 * 2026-08-14 实测:`EBADF: epoll_ctl` 从 `proc.exited` **抛**出来时,
 * `Promise.race` 会直接把 rejection 传出去 —— 挂死那条界拦不住抛的这条。
 */
export async function awaitDeath(
  proc: Pick<Bun.Subprocess, 'exited' | 'pid'>,
  what: string,
  timeoutMs = 60_000,
  /** SIGKILL 之后允许进程消失的宽限。见下方 ⚠。 */
  graceMs = 3_000,
  /** 补刀实现(注入面)。默认走内核;测试注入假的, 免得为验证这条去起一个长命真进程。 */
  killPid: (pid: number) => void = (pid) => process.kill(pid, 'SIGKILL'),
): Promise<void> {
  const timedOut = Symbol('timeout');
  let how = `等 proc.exited 超过 ${timeoutMs}ms`;
  const gate = timeoutGate(timeoutMs, timedOut);
  try {
    const r = await Promise.race([proc.exited, gate.promise]);
    if (r !== timedOut) return;
  } catch (e) {
    // 运行时把退出事件的记账弄丢了(EBADF/epoll_ctl 那一面)。下面按 pid 实测判死活。
    how = `proc.exited 抛了 (${String(e).slice(0, 80)})`;
  } finally {
    gate.cancel();
  }
  // ⚠ **SIGKILL 是异步的**:进程要一小会儿才真的从 /proc 上消失。抛的那条路会在**毫秒级**
  //   就走到这里, 立刻问"死了没"必然误判成"杀不掉"。
  //   2026-08-14 实测(本函数上一版的真实事故):判词报「SIGKILL 之后 60000ms 仍然活着」,
  //   而那条测试**总共只跑了 207ms** —— 判词自己就在撒谎。所以既要宽限, 也要把
  //   「实际发生了什么」如实写进判词, 不许把没等过的 timeoutMs 印出去。
  const wait = async (ms: number): Promise<boolean> => {
    const until = Date.now() + ms;
    while (!processGone(proc.pid) && Date.now() < until) await Bun.sleep(20);
    return processGone(proc.pid);
  };
  if (await wait(graceMs)) return; // 它真的没了 —— 这正是本函数唯一要的事实

  // ⚠ 走到这里说明宽限期内它没消失。**别急着判"杀不掉"** —— 调用方那一刀是
  //   `proc.kill()`,走的正是**同一个已经不可信的 bun 子进程句柄**(它连退出事件都丢了)。
  //   2026-08-14 实测:上一版在这里直接抛, 两次全量各红一条, 耗时都卡在 graceMs 上。
  //   既然记账层不可信, 就绕开它按 pid 直接下系统调用 —— 内核那一刀是权威的。
  // ⚠ 自保闸:补刀是**无差别**的,给错 pid 就杀错人。绝不允许指向本进程 ——
  //   2026-08-14 写这条测试时当场踩到:样本用 `process.pid` 当"还活着"的进程而忘了注入假
  //   killPid, 默认实现于是 `process.kill(自己, SIGKILL)`, **把 bun test runner 自己杀了**
  //   (表现为整个文件"挂住"然后 Killed, 查了三轮才看出是自杀不是挂死)。
  if (proc.pid === process.pid) throw new Error(`${what}: awaitDeath 被指向**本进程** (pid ${proc.pid}) —— 这是调用错误, 拒绝补刀。`);
  try {
    killPid(proc.pid);
  } catch {
    // ESRCH = 它其实已经没了(刚好在这一瞬消失); 下面再问一次即可。
  }
  if (await wait(graceMs)) return;
  throw new Error(
    `${what}: ${how}; SIGKILL 后宽限 ${graceMs}ms 仍在, **按 pid 直接再杀一次**又等 ${graceMs}ms,` +
      ` 进程 (pid ${proc.pid}) 依然活着 ⇒ 这是真杀不掉 (D 态/内核卡住), 不是记账问题。`,
  );
}

/**
 * 等 `proc.exited` 拿**退出码**,最多 `timeoutMs`。拿不到即抛,判词按上表分类。
 *
 * 要退出码的调用点用这个(`runChild`);只要"它死了"的用 `awaitDeath`。
 *
 * @param what 这一步在做什么(进判词 —— 光有 pid, 读的人不知道是哪一步卡了)。
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
  const gate = timeoutGate(timeoutMs, timedOut);
  // ⚠ 同一个缺陷有**两张脸**, 两张都要接:挂死(事件永不来)与**抛**(EBADF/epoll_ctl)。
  //   2026-08-14 实测:只 race 不 catch 时, 抛的那张脸会把裸栈直接传出去, 界形同虚设。
  let thrown: unknown;
  const r = await Promise.race([proc.exited, gate.promise]).catch((e: unknown) => {
    thrown = e;
    return timedOut;
  });
  gate.cancel();
  if (r !== timedOut) return r as number;
  const face = thrown === undefined ? `等 proc.exited 超过 ${timeoutMs}ms` : `proc.exited 抛了 (${String(thrown).slice(0, 120)})`;

  const gone = processGone(proc.pid);
  if (gone) {
    throw new Error(
      `${what}: ${face}, 而子进程 (pid ${proc.pid}) **已经不在**。` +
        ` 这是运行时的子进程回收缺陷 (bun ${Bun.version}: 退出事件丢了), 不是被测对象的问题 —— 本次读数无效, 重跑。` +
        ` 同源的另一面是 EBADF/epoll_ctl。详见 test/core/_await-exit.ts 的模块注。`,
    );
  }
  proc.kill('SIGKILL');
  throw new Error(
    `${what}: ${face}, 且子进程 (pid ${proc.pid}) **还活着** ⇒ 这是真挂死,` +
      ` 是被测对象卡住了 (已 SIGKILL)。别把它当上面那条运行时缺陷放过。`,
  );
}
