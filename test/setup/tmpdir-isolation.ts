/**
 * test/setup/tmpdir-isolation —— **整轮测试共用一个一次性 TMPDIR**(2026-08-15)。
 *
 * ## 它修的是什么
 *
 * 全仓测试到处 `mkdtempSync(join(tmpdir(), 'omd-xxx-'))`,而**绝大多数没有配套的 `rmSync`**。
 * 实测(单变量:跑一次全量,前后计数 `~/.cache/tmp` 条目):
 *
 *     跑前 510,149 → 跑后 510,916   **+767 / 每次全量**
 *
 * 累计现状:**510,149 个条目 · 11G**(`omd-*` 452,427 · `headless-cfg-*` 17,705),
 * 其中 166,675 个是空目录。按 767/跑 反推 ≈ 660 次全量套件的沉积。
 * 单个都不大(最大 20M)—— 是五十万乘以 22KB 堆出来的。
 *
 * ## 为什么不逐个测试文件补 `afterEach`
 *
 * 近 30 分钟新增的 769 个分散在**几十个不同前缀**(`omd-goal-` 76 · `omd-tui-embedded-` 31 ·
 * `omd-dream-gather-` 26 …)—— 不是某一个元凶,是几十个文件各漏几个。逐个补:diff 巨大,
 * 而且**防不住下一个新增的测试**。把 `TMPDIR` 换成一次性目录是**单点修复**,零测试文件改动。
 *
 * ## 前提(实测过,不是推的)
 *
 * Bun 的 `os.tmpdir()` **每次调用都读 env**,不缓存 —— 探针:改 `process.env.TMPDIR` 之后
 * `os.tmpdir()` 立刻变、`mkdtempSync` 落在新目录里。这条不成立整个方案就废,所以先量再写。
 *
 * ## ⚠ 一个已知不覆盖面(实测,不是推测)
 *
 * **子进程不继承本轮 TMPDIR。** `Bun.spawn` 的默认 env 是**进程启动时的快照**,不是运行时被改过的
 * `process.env` —— 探针实测:父进程改完 `process.env.TMPDIR` 之后,默认 spawn 出来的子进程
 * `os.tmpdir()` 仍是宿主共享 tmp;只有显式传 `env: {...process.env}` 才跟过去。
 * (`Bun.env` 也改不到那个快照,一并试过。)全仓 34 个 `Bun.spawn(` 调用点里只有 2 个显式传 env。
 *
 * **但实测这个缺口不要紧**:带本件跑一次全量,宿主 tmp 的增量从 **+767 降到 +1**。
 * 原因是那些夹具子进程的临时目录**是父进程建好再经 `--root` 传进去的**,子进程自己不建。
 * → 故**不为它加机制**(要加就得逐个改 32 个 spawn 点,为一个量到是 1 的问题)。
 * 若哪天残余涨起来,第一嫌疑就是这里,修法是给对应 spawn 点补 `env: {...process.env}`。
 *
 * ## 为什么还带一条启动清扫
 *
 * `afterAll` 覆盖正常跑完与用例失败,但 **SIGKILL / 中途 Ctrl-C 覆盖不到** —— 那时会留下
 * **一个**目录(相对原来的 767 已是两个数量级的改善)。而"跑被强杀"在本仓不是假想:
 * 我们刚刚才因为它清理过 7 个存活 15–17 小时的孤儿进程。所以补一条启动清扫,让机制**自愈**,
 * 而不是慢慢重新沉积。
 */
import { afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 本轮目录的前缀。**故意可被 grep 认出**,以便人工排查时一眼分清"本轮"与"历史沉积"。 */
const RUN_PREFIX = 'omd-testrun-';
/** 启动清扫的年龄阈值。比任何一次全量套件(实测 ~110s)长得多 → 不会误删正在跑的另一轮。 */
const STALE_MS = 6 * 60 * 60 * 1000;

/** 宿主真实 tmp(改 env 之前读一次;后面都要相对它算)。 */
const HOST_TMP = tmpdir();

/**
 * 清扫历史遗留的 `omd-testrun-*`(只清**足够老**的,不碰并行跑的另一轮)。
 * 整个过程 fail-open:清扫失败绝不该让测试跑不起来 —— 但**留证据**,不吞。
 */
function sweepStale(): void {
  let swept = 0;
  try {
    for (const name of readdirSync(HOST_TMP)) {
      if (!name.startsWith(RUN_PREFIX)) continue;
      const p = join(HOST_TMP, name);
      try {
        if (Date.now() - statSync(p).mtimeMs < STALE_MS) continue;
        rmSync(p, { recursive: true, force: true });
        swept++;
      } catch (e) {
        // 单个删不掉不影响其余(可能是别的用户/正在写)。
        console.error(`[tmpdir-isolation] 清扫 ${p} 失败: ${(e as Error).message}`);
      }
    }
  } catch (e) {
    console.error(`[tmpdir-isolation] 启动清扫整体失败 (不阻塞测试): ${(e as Error).message}`);
  }
  if (swept > 0) console.error(`[tmpdir-isolation] 清扫了 ${swept} 个过期的 ${RUN_PREFIX}* 目录`);
}

sweepStale();

/** 本轮专属目录。**导出**给闸用 —— 闸要能断言"我们确实换掉了 TMPDIR"。 */
export const TEST_RUN_TMPDIR = mkdtempSync(join(HOST_TMP, RUN_PREFIX));
mkdirSync(TEST_RUN_TMPDIR, { recursive: true });

// 从这一行起, 全仓测试里的 `tmpdir()` / `mkdtempSync` 都落进本轮目录。
process.env.TMPDIR = TEST_RUN_TMPDIR;

/**
 * 收尾删除。
 *
 * ⚠ **用 `afterAll` 而不是 `process.on('exit')`** —— 后者在 `bun test` 下**根本不触发**。
 * 这是实测出来的, 不是查文档:第一版就写的 `process.on('exit')`, 结果每跑一次必留一个目录
 * (+767 变成了 +1, 看起来"基本修好了", 差点被当成收尾)。探针 = preload 里同时挂两种钩子, 各写一个
 * 标记文件, 跑一次空用例看谁留下:`exit` ❌ / `afterAll` ✅。
 * **"从 767 降到 1"这种好看的数最容易掩盖"机制其实没生效"** —— 剩的那个 1 就是没删掉的本轮目录。
 *
 * force:true: 收尾删不掉不该把整轮测试的退出码变成失败(那会把"清理问题"伪装成"测试失败"),
 * 但**留证据**。
 */
afterAll(() => {
  try {
    rmSync(TEST_RUN_TMPDIR, { recursive: true, force: true });
  } catch (e) {
    console.error(`[tmpdir-isolation] 收尾删除 ${TEST_RUN_TMPDIR} 失败: ${(e as Error).message}`);
  }
});
