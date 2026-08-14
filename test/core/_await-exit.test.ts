/**
 * `awaitExitBounded` 的闸 —— 它存在的全部理由是**把两种"没等到"分开**,
 * 所以判据必须证明这两条分得开,而不只是"超时了会抛"。
 *
 * 反向自检(实跑,三刀):
 *   ① 把 `processGone` 恒返 `false` → 「事件丢了」那条变成「真挂死」判词 ⇒ 第 2 条红。
 *   ② 把 `processGone` 恒返 `true`  → 真挂死被当成运行时缺陷放过 ⇒ 第 3 条红(且 kill 不再被调)。
 *   ③ 把超时那条 race 去掉(直接 `await proc.exited`)⇒ 第 2/3 条**永远跑不完**,
 *      本文件自己撞上 bun:test 超时 —— 那正是这条闸要消灭的形状。
 */
import { describe, expect, test } from 'bun:test';
import { awaitDeath, awaitExitBounded, processGone, readAllBounded, spawnWithPipes } from './_await-exit';

/** 一个 `exited` 永不 resolve 的假子进程 —— 正是线上那个缺陷的形状。 */
const stuckProc = (pid: number, onKill?: () => void) => ({
  exited: new Promise<number>(() => {}),
  pid,
  kill: (() => onKill?.()) as Bun.Subprocess['kill'],
});

describe('processGone —— 活/死判据', () => {
  test('自己这个进程 → 还活着', () => {
    expect(processGone(process.pid)).toBe(false);
  });

  test('★ 已退出的真子进程 → 判已不在(不靠 sleep 猜, 等它真的 exited 之后再问)', async () => {
    const p = Bun.spawn(['true']);
    await p.exited;
    expect(processGone(p.pid)).toBe(true);
  });
});

describe('awaitExitBounded —— 正常路一个字不改', () => {
  test('子进程正常退出 → 原样返回退出码, 不抛', async () => {
    const p = Bun.spawn(['sh', '-c', 'exit 7']);
    expect(await awaitExitBounded(p, '正常路', 10_000)).toBe(7);
  });
});

describe('★ 两种「没等到」必须分开(抹成一个 timeout 会让真挂死混过去)', () => {
  test('★ 进程已不在 + 事件没来 → 判**运行时缺陷**, 判词点名本次读数无效', async () => {
    const p = Bun.spawn(['true']);
    await p.exited; // 它真的退了
    const err = await awaitExitBounded(stuckProc(p.pid), '假的 runChild', 50).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('已经不在');
    expect((err as Error).message).toContain('本次读数无效');
    expect((err as Error).message).not.toContain('真挂死');
  });

  test('★ 进程还活着 + 事件没来 → 判**真挂死**, 且真的 SIGKILL 了它', async () => {
    let killed = false;
    // 用自己的 pid 当"还活着"的样本 —— kill 是注入的假的, 不会真杀自己。
    const err = await awaitExitBounded(stuckProc(process.pid, () => (killed = true)), '假的 crashAt', 50).catch((e: Error) => e);
    expect((err as Error).message).toContain('真挂死');
    expect((err as Error).message).toContain('别把它当上面那条运行时缺陷放过');
    expect(killed).toBe(true); // 光抛不杀 = 留一个占着资源的挂死进程
  });

  /**
   * ★ **抛出来的那张脸也要被接住**(2026-08-14 实测缺口):`EBADF: epoll_ctl` 是从
   * `proc.exited` **抛**出来的,只 race 不 catch 时 `Promise.race` 直接把裸栈传出去,
   * 界形同虚设 —— 这条闸就是那次缺口的化石。
   * 反向自检:把 `awaitExitBounded` 里那个 `.catch` 去掉 → 本条当场红(抛的是 EBADF 不是判词)。
   */
  test('★ proc.exited **抛**(EBADF 那张脸)→ 仍按同一张表分类, 判词带上原始错', async () => {
    const p = Bun.spawn(['true']);
    await p.exited;
    const rejecting = { exited: Promise.reject(new Error('EBADF: bad file descriptor, epoll_ctl')), pid: p.pid, kill: (() => {}) as Bun.Subprocess['kill'] };
    const err = await awaitExitBounded(rejecting, '假的 runChild', 50).catch((e: Error) => e);
    expect((err as Error).message).toContain('proc.exited 抛了');
    expect((err as Error).message).toContain('EBADF');
    expect((err as Error).message).toContain('已经不在'); // 分类没因为"是抛的"而丢
  });

  test('★ 判词带 what 与 pid(光有超时读的人不知道是哪一步卡了)', async () => {
    const err = await awaitExitBounded(stuckProc(process.pid), 'crashAt(b) 的 SIGKILL 之后', 50).catch((e: Error) => e);
    expect((err as Error).message).toContain('crashAt(b) 的 SIGKILL 之后');
    expect((err as Error).message).toContain(String(process.pid));
  });
});

/**
 * `awaitDeath` 与上面那组的**分野是需求不同,不是宽严不同**:
 * `crashAt` 只要"进程没了", 而 `processGone(pid)` **直接观测**得到 ⇒ 事件丢了也能照常走;
 * `runChild` 要退出码, 事件丢了就真的拿不到 ⇒ 只能抛。
 *
 * 反向自检:把 `awaitDeath` 末尾的 `processGone` 判断改成无条件 return → 第 3 条当场红
 * (杀不掉的进程被放过 = 这个函数唯一该抓的东西漏了)。
 */
describe('awaitDeath —— 只要「它死了」, 事件丢了不算失败', () => {
  test('★ 事件永不来 + 进程已死 → 正常返回(不抛)', async () => {
    const p = Bun.spawn(['true']);
    await p.exited;
    await awaitDeath({ exited: new Promise<number>(() => {}), pid: p.pid }, '假的 crashAt', 50);
  });

  test('★ proc.exited 抛 EBADF + 进程已死 → 也正常返回(挂死那条界拦不住抛的这条)', async () => {
    const p = Bun.spawn(['true']);
    await p.exited;
    await awaitDeath({ exited: Promise.reject(new Error('EBADF: epoll_ctl')), pid: p.pid }, '假的 crashAt', 50);
  });

  test('★ 进程**还活着** → 必须抛(杀不掉是真问题, 不许被这条放宽顺手放过)', async () => {
    // ⚠ 必须注入假 killPid: 样本 pid 是本进程, 真补刀会把 runner 自己杀掉(踩过)。
    const err = await awaitDeath({ exited: new Promise<number>(() => {}), pid: 1 }, '假的 crashAt', 50, 20, () => {}).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('杀不掉'); // 钉稳定词, 不钉会随判词微调而漂的措辞
  });

  /**
   * ★ **判词不许报一段没发生过的等待**(2026-08-14 的真实事故化石)。
   * 上一版走"抛"那条路时, 判词照印 `SIGKILL 之后 60000ms`, 而那条测试总共只跑了 207ms ——
   * 读的人会以为真等过一分钟, 从而把「杀不掉」当成板上钉钉。
   * 反向自检:把判词里的 `${how}` 换回硬编码的 timeoutMs → 本条当场红。
   */
  test('★ 抛的那条路: 判词说的是**真发生的事**, 不印没等过的 timeoutMs', async () => {
    const err = await awaitDeath(
      { exited: Promise.reject(new Error('EBADF: epoll_ctl')), pid: 1 },
      '假的 crashAt', 60_000, 20, () => {},
    ).catch((e: Error) => e);
    const msg = (err as Error).message;
    expect(msg).toContain('proc.exited 抛了');
    expect(msg).toContain('EBADF');
    expect(msg).toContain('宽限 20ms');
    expect(msg).not.toContain('60000ms'); // ← 这就是上一版撒的那个谎
  });

  /**
   * ★ SIGKILL 是异步的 —— 抛的那条路会在毫秒级走到判死活那一步,
   * 没有宽限就必然把"正在消失"读成"杀不掉"(run4 那次假红的根因)。
   * 反向自检:把宽限轮询那两行删掉 → 本条大概率红(它靠宽限等进程真消失)。
   */
  test('★ 刚 SIGKILL 完就问 → 宽限期内它会消失, 不判杀不掉', async () => {
    const p = Bun.spawn(['sleep', '5']);
    p.kill('SIGKILL');
    await awaitDeath({ exited: Promise.reject(new Error('EBADF: epoll_ctl')), pid: p.pid }, '刚杀完', 60_000, 3_000);
  });

  /**
   * ★ **调用方那一刀没生效时, 按 pid 直接补一刀**(2026-08-14 实测: 两次全量各红一条,
   * 耗时都卡在 graceMs 上 —— 因为 `proc.kill()` 走的是同一个已经丢了退出事件的坏句柄)。
   *
   * 补刀实现注入, **不起真的长命进程** —— 我第一版就是拿 `sleep 30` 写的, 结果按 pid 杀
   * 绕开了 bun 的句柄, runner 自己退不出去, `bun test` 挂满 120s 被 kill。
   * 那正是本文件在修的同一族坑, 当场又踩一次。
   *
   * 反向自检:把实装里 `killPid(proc.pid)` 那段删掉 → 本条当场红(补刀没发生)。
   */
  test('★ 调用方的 kill 没生效 → 按 pid 补一刀(注入验证), 补完仍不死才判杀不掉', async () => {
    const killed: number[] = [];
    const err = await awaitDeath(
      { exited: Promise.reject(new Error('EBADF: epoll_ctl')), pid: 1 },
      '刀丢了', 60_000, 20, (pid) => void killed.push(pid),
    ).catch((e: Error) => e);
    expect(killed).toEqual([1]);           // 补刀真的发生了
    expect((err as Error).message).toContain('按 pid 直接再杀一次'); // 补完还不死才判死刑
  });

  /**
   * ★ **自保闸**:补刀无差别, 指向本进程就是自杀。
   * 反向自检:把实装里那句 `proc.pid === process.pid` 判断删掉 → 本条当场红
   * (而且在真跑时它会把 runner 杀掉 —— 我就是这么踩到的)。
   */
  test('★ 指向本进程 → 拒绝补刀并点名是调用错误(不许自杀)', async () => {
    let killed = 0;
    const err = await awaitDeath(
      { exited: Promise.reject(new Error('x')), pid: process.pid },
      '指错了', 60_000, 20, () => void killed++,
    ).catch((e: Error) => e);
    expect((err as Error).message).toContain('本进程');
    expect(killed).toBe(0); // 一刀都不许下
  });
});

/**
 * `spawnWithPipes` —— 同一子系统的第三张脸(管道压根没建起来)。
 *
 * 反向自检(**实跑读数,不是预期**):
 *   · 重试上界 2 → 1(一次没拿到就放弃)   → **2 条红**(第 1、3 条);
 *   · 删掉 `missing.length === 0` 判断    → **2 条红**(同样两条)。
 * ⚠ 初稿我各写的是"红 1 条", 实测都是 2 条 —— 第 2 个变异会把第一个 proc 直接交出去,
 *   于是 `id` 那条断言也跟着红。判据没问题, 是我的预测粗了。
 */
describe('spawnWithPipes —— 管道没建起来就重起一次', () => {
  test('★ 第 1 次没管道、第 2 次有 → 返回第 2 个(而不是把 undefined 交出去)', () => {
    let n = 0;
    const proc = spawnWithPipes(() => ({ id: ++n, stdout: n === 1 ? undefined : {}, kill() {} }), ['stdout'], 'x');
    expect(proc.id).toBe(2);
  });

  test('正常路: 第 1 次就有管道 → 只起一次', () => {
    let n = 0;
    const proc = spawnWithPipes(() => ({ id: ++n, stdout: {}, kill() {} }), ['stdout'], 'x');
    expect(proc.id).toBe(1);
    expect(n).toBe(1); // 没有多余的 spawn
  });

  test('★ 两次都没有 → 抛, 判词点名是 spawn 层不是被测对象, 且把死掉的那个杀掉', () => {
    let killed = 0;
    expect(() => spawnWithPipes(() => ({ stdout: undefined, kill: () => void killed++ }), ['stdout'], '起 X')).toThrow(/spawn 层没兑现契约/);
    expect(killed).toBe(2); // 两次都没白留
  });
});

/**
 * `readAllBounded` —— **一条链上只要还剩一个无界等待, 整条界就是虚的**。
 *
 * 2026-08-14 实测化石: 给 `proc.exited` 加完界之后仍然中了一次 240s 挂死(F4),
 * 因为把管道读干那一步还是无界的。
 * 反向自检: 把 race 换成直接 `await Promise.all(...)` → 第 2 条**永远跑不完**(本文件自己挂住)。
 */
describe('readAllBounded —— 管道读也要有界', () => {
  test('正常路: 读得到就原样返回', async () => {
    const p = Bun.spawn(['sh', '-c', 'echo hi; echo err >&2'], { stdout: 'pipe', stderr: 'pipe' });
    const [out, err] = await readAllBounded([p.stdout, p.stderr], 'x', 10_000);
    expect(out!.trim()).toBe('hi');
    expect(err!.trim()).toBe('err');
    await p.exited;
  });

  test('★ 永不到 EOF 的流 → 有界抛, 判词点名管道被丢了', async () => {
    const never = new ReadableStream<Uint8Array>({ start() { /* 永不 close */ } });
    const err = await readAllBounded([never], '假的读管道', 30).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('还没到 EOF');
    expect((err as Error).message).toContain('本次读数无效');
  });
});
