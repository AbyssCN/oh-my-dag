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
import { awaitExitBounded, processGone } from './_await-exit';

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

  test('★ 判词带 what 与 pid(光有超时读的人不知道是哪一步卡了)', async () => {
    const err = await awaitExitBounded(stuckProc(process.pid), 'crashAt(b) 的 SIGKILL 之后', 50).catch((e: Error) => e);
    expect((err as Error).message).toContain('crashAt(b) 的 SIGKILL 之后');
    expect((err as Error).message).toContain(String(process.pid));
  });
});
