/**
 * 真杀夹具的**自毁上限**闸(2026-08-15)。
 *
 * ## 它守的那一条
 *
 * `inner-loop-crash-child.ts` / `fault-injection-child.ts` 都要"挂起等父进程 SIGKILL"。
 * 本闸问的是**父进程不来杀的那一支**:它必须自己退出,而不是变成永久孤儿。
 *
 * 这条闸是拿代价换来的,不是设想出来的 —— 2026-08-15 owner 机器上 7 个这样的孤儿存活
 * 15–17 小时、各烧 ~104% CPU、把 load 拉到 9.85,导致全量套件**随机红一条不同的用例**
 * (两次分别红在 `src/mcp/client/pool.test.ts` 与 `test/core/fault-injection.test.ts`,
 * 单独跑都 3/3 绿)。清掉后连跑三次全量 0 fail。详见 `hang-watchdog.ts` 头注。
 *
 * ## ★ 证伪方法(改这个闸必做一次,做不到 = 闸已哑,不许合入)
 *
 * 把 `hang-watchdog.ts` 的 `hangUntilKilled` 改回 `await new Promise<never>(() => {})`
 * → ★① ★② **必须红**(超时,因为子进程永不退出),且红在"没等到退出"上。改回来 → 回绿。
 * ⚠ 跑证伪时记得 `pkill -f <fixture>`:那次故意制造的正是本闸要防的孤儿。
 *
 * ## 为什么用短 watchdog 而不是等 120s
 *
 * `OMD_HANG_WATCHDOG_MS` 就是为这条闸留的口子。**它只被测试设**;生产路径没有调用方该碰它。
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HANG_WATCHDOG_EXIT } from './hang-watchdog';
import { awaitExitBounded } from '../../src/harness/proc/await-exit';

const REPO = join(import.meta.dir, '..', '..');
const WATCHDOG_MS = 1_500;
/** 给足够余量: 子进程要先把 DAG 跑到挂起节点, 再等 WATCHDOG_MS。 */
const GIVE_UP_MS = 90_000;

/**
 * 起一个会挂起的夹具, **故意不杀它**, 等它自毁。
 * @returns 退出码 + 是否真的等到了哨兵(没等到 = 夹具没进挂起点, 这条读数无效)
 */
async function runUnkilled(
  child: string,
  args: string[],
): Promise<{ exitCode: number; sawSentinel: boolean; stderr: string }> {
  const root = mkdtempSync(join(tmpdir(), 'omd-hang-wd-'));
  try {
    const proc = Bun.spawn(['bun', 'run', join(import.meta.dir, child), '--root', root, '--run', 'wd-run', '--hang', 'b', ...args], {
      cwd: REPO,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, OMD_HANG_WATCHDOG_MS: String(WATCHDOG_MS) },
    });

    // 等哨兵 —— 确认它**真的进了挂起点**, 否则"进程退出了"可能只是因为它压根没跑到那儿。
    const sentinel = join(root, 'READY-b');
    const deadline = Date.now() + GIVE_UP_MS;
    let sawSentinel = false;
    while (Date.now() < deadline) {
      if (existsSync(sentinel)) {
        sawSentinel = true;
        break;
      }
      if (proc.exitCode !== null) break; // 提前死了 → 下面断言会说清是哪种
      await Bun.sleep(25);
    }

    // ★ 关键: 这里**没有** proc.kill()。活下来的唯一途径就是看门狗。
    //
    // ⚠ 用 `awaitExitBounded` 而不是裸 `Promise.race([proc.exited, sleep])`:后者只挡住"不 resolve"
    // 那一张脸, 挡不住 `proc.exited` **抛** EBADF 那一张(bun 1.3.14 同族, 见 `await-exit.ts` 头注)——
    // 抛出来会变成一条与本闸无关的错误消息, 把"看门狗没生效"和"运行时抽风"混成一个红。
    // 本闸要的正是退出码, 所以只能用会抛的那一档(伪造 exit 0 是推断不是观测)。
    let exitCode: number;
    try {
      exitCode = await awaitExitBounded(proc, `hang-watchdog 等 ${child} 自毁`, GIVE_UP_MS);
    } catch {
      proc.kill('SIGKILL'); // 闸红了也不能把孤儿留给下一条用例 —— 本文件治的就是这个病
      exitCode = -1;
    }
    const stderr = await new Response(proc.stderr).text();
    return { exitCode, sawSentinel, stderr };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('真杀夹具的自毁上限 —— 没人来杀时不许变成孤儿', () => {
  test(
    '★① inner-loop-crash-child: 无人 SIGKILL → 自己按 watchdog 退出',
    async () => {
      const r = await runUnkilled('inner-loop-crash-child.ts', [
        '--max-rounds', '2', '--hang-round', '2', '--verdicts', 'reject-b,converge',
      ]);
      expect(r.sawSentinel, '没等到哨兵 = 夹具没进挂起点, 本条读数无效(不是闸的结论)').toBe(true);
      // -1 = 我们自己兜底杀的 → 说明它没自毁, 正是本闸要抓的那件事。
      expect(r.exitCode, `子进程没有自毁 (stderr 尾部: ${r.stderr.slice(-500)})`).toBe(HANG_WATCHDOG_EXIT);
      expect(r.stderr).toContain('##HANG-WATCHDOG##'); // 吞异常可以, 吞证据不行
    },
    GIVE_UP_MS + 30_000,
  );

  test(
    '★② fault-injection-child: 同上 (两个夹具共用同一条上限, 不许只修一个)',
    async () => {
      const r = await runUnkilled('fault-injection-child.ts', [
        '--max-rounds', '3', '--hang-round', '2', '--verdicts', 'reject-b,converge',
      ]);
      expect(r.sawSentinel, '没等到哨兵 = 夹具没进挂起点, 本条读数无效(不是闸的结论)').toBe(true);
      expect(r.exitCode, `子进程没有自毁 (stderr 尾部: ${r.stderr.slice(-500)})`).toBe(HANG_WATCHDOG_EXIT);
      expect(r.stderr).toContain('##HANG-WATCHDOG##');
    },
    GIVE_UP_MS + 30_000,
  );

  test('★③ 没有第三个夹具在用裸的 never-settle promise (防漂移 —— 第一次清理就是漏扫咬的)', () => {
    const out = Bun.spawnSync([
      'ugrep', '-rn', '-F', 'new Promise<never>(() => {})', '--include=*.ts', 'test/', 'src/', 'scripts/',
    ], { cwd: REPO });
    const hits = new TextDecoder()
      .decode(out.stdout)
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      // **不自咬**(同 seat-coordinate-gate 的做法): 本模块与本文件里那几处是**散文与 grep 模式本身** ——
      // 头注要讲清坏写法长什么样, 讲清就必然写出它。真出现回潮时 ★①★② 会红, 它们测的是行为不是文本。
      .filter((l) => !l.startsWith('test/core/hang-watchdog.ts:') && !l.startsWith('test/core/hang-watchdog.test.ts:'));
    // 空 = 全部改走 hangUntilKilled。新增夹具想挂起, 请用它, 别再手写裸 promise。
    expect(hits).toEqual([]);
  });
});
