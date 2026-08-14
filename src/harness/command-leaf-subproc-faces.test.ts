/**
 * **生产码上的那四张脸**(2026-08-14 晚)—— `command-leaf.ts` 的 `defaultSpawn` 逐字是
 * `test/core/_await-exit.ts` 当天为测试补界的那个模式,而它当天一个字没改。
 *
 * ## 为什么这条测试值得存在
 *
 * 真实读数(`~/omd-readings/2026-08-14-subproc-flake-logs/`,26 次全量):`v4-5` 那一次,
 * G4 判别力探针走生产路(`acceptance-gate.ts` → `createCommandLeafRunner` → `defaultSpawn`)
 * 时 spawn 抛了,被 `acceptance-gate.ts:241` 的 catch 变成 `fail_open` ——
 * **闸静默失效,而调用方看到的和"判据合格"一模一样**。
 *
 * 满负载下 1/26 的东西不能靠跑全量来验。这里把四张脸**注入**成确定性的,
 * 于是"补没补界"这件事有了一条会红的闸。
 *
 * ## 反向自检(怎么证伪它)
 *
 * 把 `defaultSpawn` 里的三处换回裸写法,对应的条当场红:
 *   · `spawnWithPipes(...)` → `Bun.spawn(...)`      ⇒ 「管道给 undefined」那条红(TypeError,判词指向被测对象)
 *   · `readAllBounded(...)` → `new Response(s).text()` ⇒ 「管道读不到 EOF」那条红(挂满测试超时)
 *   · `awaitExitBounded(...)` → `proc.exited`        ⇒ 「退出事件丢了」两条红(一条挂死、一条抛 EBADF)
 *
 * 最后一条尤其要留意:退回裸写法时**它不是抛,而是被外层 `Promise.race` 的超时哨
 * 兑成 `exitCode 124`** —— 一次记账缺陷伪装成"命令超时"。而在 G4 探针那条路上
 * `124 !== expectExit` 会被读成 **`status:'ok'` = 判据有判别力**,是**假绿**,比 fail-open 更坏。
 */
import { describe, expect, test } from 'bun:test';
import { createCommandLeafRunner } from './command-leaf';

const ALLOW = ['echo'];

/** 一个假 `Bun.Subprocess`:四张脸各自可注入,pid 指向一个**必定不存在**的进程(免得误伤真进程)。 */
const DEAD_PID = 0x7fff_fffe;

describe('生产 defaultSpawn · 子进程记账失效的四张脸都得是具名失败', () => {
  test('★ 传了 pipe 拿到 undefined → 重起一次; 两次都没有 ⇒ 判词点名 spawn 层, 不是被测对象', async () => {
    let attempts = 0;
    const run = createCommandLeafRunner({
      allowlist: ALLOW,
      spawnRaw: () => {
        attempts++;
        return { stdout: undefined, stderr: undefined, exited: Promise.resolve(0), pid: DEAD_PID, kill: () => {} };
      },
    });
    await expect(run({ command: 'echo hi' })).rejects.toThrow(/管道.*没建起来|没兑现契约/);
    expect(attempts).toBe(2); // 一次调用里重起了一次, 不是一次就放弃、也不是无限重试
  });

  test('★ 第一次没建起管道、第二次建起来了 → 正常返回 (重试是正当的)', async () => {
    let attempts = 0;
    const run = createCommandLeafRunner({
      allowlist: ALLOW,
      spawnRaw: () => {
        attempts++;
        const ok = attempts > 1;
        return {
          stdout: ok ? streamOf('hi\n') : undefined,
          stderr: ok ? streamOf('') : undefined,
          exited: Promise.resolve(0),
          pid: DEAD_PID,
          kill: () => {},
        };
      },
    });
    const r = await run({ command: 'echo hi' });
    expect(r.exitCode).toBe(0);
    expect(r.text).toBe('hi');
  });

  test('★ 退出事件永不来 → 具名失败, **不得**兑成 exitCode 124 (那是把记账缺陷伪装成命令超时)', async () => {
    const run = createCommandLeafRunner({
      allowlist: ALLOW,
      timeoutMs: 300,
      spawnRaw: () => ({
        stdout: streamOf('hi\n'),
        stderr: streamOf(''),
        exited: new Promise<number>(() => {}), // 永不 resolve
        pid: DEAD_PID,
        kill: () => {},
      }),
    });
    // 判据的核心在这里: 是**抛**, 不是 `{exitCode:124}`。
    await expect(run({ command: 'echo hi' })).rejects.toThrow(/退出事件丢了|真挂死/);
  });

  test('★ proc.exited 抛 EBADF → 同样具名失败 (界只 race 不 catch 时, 抛的这张脸会穿过去)', async () => {
    const run = createCommandLeafRunner({
      allowlist: ALLOW,
      timeoutMs: 300,
      spawnRaw: () => ({
        stdout: streamOf('hi\n'),
        stderr: streamOf(''),
        exited: Promise.reject(new Error('EBADF: bad file descriptor, epoll_ctl')),
        pid: DEAD_PID,
        kill: () => {},
      }),
    });
    // ⚠ 判据**不能**只写 `/EBADF/` —— 裸写法下 `Promise.all` 也会把这个 rejection 原样传出去,
    //   于是那条断言两侧都绿, 是一条永远不红的闸(本仓 §「反向自检」)。第一版就是这么写的,
    //   证伪时当场露馅。有分辨力的是**判词把它归给谁**: 裸写法给出的是一条光秃秃的 EBADF 栈,
    //   读的人会以为是被测命令的问题; 有界之后它点名"运行时的子进程回收缺陷 + 本次读数无效"。
    await expect(run({ command: 'echo hi' })).rejects.toThrow(/EBADF/);
    await expect(run({ command: 'echo hi' })).rejects.toThrow(/子进程回收缺陷|真挂死/);
  });

  test('★ 管道到不了 EOF → 具名失败 (光给 proc.exited 加界不够: 一条链上剩一个无界等待, 整条界就是虚的)', async () => {
    const run = createCommandLeafRunner({
      allowlist: ALLOW,
      timeoutMs: 300,
      spawnRaw: () => ({
        stdout: new ReadableStream<Uint8Array>({ start() {} }), // 永不 close
        stderr: streamOf(''),
        exited: Promise.resolve(0),
        pid: DEAD_PID,
        kill: () => {},
      }),
    });
    await expect(run({ command: 'echo hi' })).rejects.toThrow(/还没到 EOF|管道被运行时丢了/);
  });

  test('一切正常时逐字不变 —— 上面四条界都不许改动正常路径的返回', async () => {
    const run = createCommandLeafRunner({
      allowlist: ALLOW,
      spawnRaw: () => ({
        stdout: streamOf('out\n'),
        stderr: streamOf('err\n'),
        exited: Promise.resolve(3),
        pid: DEAD_PID,
        kill: () => {},
      }),
    });
    const r = await run({ command: 'echo hi' });
    expect(r.exitCode).toBe(3);
    expect(r.text).toBe('out\nerr'); // 两条流都在 (2026-08-01 那条闸)
  });
});

function streamOf(s: string): ReadableStream<Uint8Array> {
  return new Response(s).body!;
}
