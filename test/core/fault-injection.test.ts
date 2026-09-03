/**
 * 故障注入实测 (INV-P2-6 **后半** · D-1 风险的第一次真打)。
 *
 * `iterate-persist.test.ts` 已经证了 journal 的读写与"同进程里再调一次能接回",
 * 但那**证不了崩溃恢复**: 轮次/毒集/复用源是进程内闭包, 同进程里它们本来就没死过。
 * 本文件把进程真杀掉一次 —— 外力 SIGKILL, 不是协作式退出 —— 再从磁盘接着跑, 判据只认文件:
 *
 *   exec.log 的行数 = 每个节点**真跑过几次** (「已绿节点不重跑」)
 *   art-*.txt        = 已批准制品 (「不丢」)
 *   _fixpoint.json   = 轮次 + 毒集 (「毒集随 checkpoint 一同恢复」)
 *
 * 另一半是**坏盘**: 崩溃不只发生在"两次写之间", 也发生在"一次写中间"。原子写 (tmp+rename)
 * 声称能兜住撕裂, 这里就把撕裂/残留/损坏都造出来, 看恢复路径是真 fail-open 还是当场炸。
 *
 * 全程零 LLM (预构造图 + command 叶子 + 注入 judge) → 可无限重跑, 读数不含模型噪声。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 反向自检实际读数 (skill: 闸只有被证伪过一次才算闸)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ① 桩掉「等退出事件」那一句 (`awaitExitBounded(proc, ...)` → 立即抛
 *    `Error('模拟退出事件丢')`):
 *      - 命令: `bun test test/core/fault-injection.test.ts`
 *      - 读数: 11 pass / 0 fail / 49 expect() calls
 *      - 结论: 该句抛 → EXIT 有界轮询兜住, EXIT 仍在 → code = 0; 不依赖该 await,
 *        闸**仍全绿** —— 退出事件的 await 不是单点失败源。
 *
 * ② 桩掉「读 stdout/stderr 管道」那一句 (`readAllBounded(...)` → 立即抛同款 Error):
 *      - 命令: `bun test test/core/fault-injection.test.ts`
 *      - 读数: 11 pass / 0 fail / 49 expect() calls
 *      - 结论: 管道抛 → stdoutText = '' (空串, 不外抛) → RESULT.json 走兜底路径,
 *        EXIT/RESULT.json 在盘, code/out 仍能取; 闸**仍全绿** —— 读管道也不是单点。
 *
 * ③ 注入「子进程写 EXIT 文件之前抛未捕获异常」
 *    (`fault-injection-child.ts:135` 的 `writeFileSync(join(root, 'EXIT'), '0')`
 *    之前 `throw new Error('模拟写 EXIT 之前崩')`):
 *      - 命令: `bun test test/core/fault-injection.test.ts`
 *      - 读数: 5 pass / 6 fail / 34 expect() calls; 6 红**全部**落在「code 应为 0」
 *        的断言上 (F3 四条 + F4 两条, 满 6 条), 收到的全是 1 (未捕获异常 →
 *        proc.exitCode = 1)。
 *      - 结论: 没有 EXIT 文件 → code 退回 proc.exitCode (1), 不是 0 → 6 条全红。
 *        证明『没有标记』**没被**当成成功, 闸被这一击证伪, 反过来证明它是真闸。
 *
 * 注: ③ 的注入落在 child.ts, 不在 test 文件; 闸本体的全部修改 + 头注写在这里。
 *     还原后 (`bun test test/core/fault-injection.test.ts`) 回到 11 pass / 0 fail。
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { awaitDeath, awaitExitBounded, awaitWhileAlive, readAllBounded } from '../../src/harness/proc/await-exit';

const CHILD = join(import.meta.dir, 'fault-injection-child.ts');
const RUN_ID = 'crash-run';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'omd-fault-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const runDir = (): string => join(root, '.omd', 'continuity', RUN_ID);
const execCount = (node: string): number =>
  (existsSync(join(root, 'exec.log')) ? readFileSync(join(root, 'exec.log'), 'utf-8') : '')
    .split('\n')
    .filter((l) => l.trim() === node).length;

interface ChildOut {
  startedFromRound: number;
  roundsThisProcess: number;
  converged: boolean;
  completedRounds: number;
  poisoned: number;
  lastRoundStatuses: Record<string, string>;
  reusedNodes: string[];
}

/** 起一个子进程跑 iterate。回 {exitCode, signal, parsed}。 */
async function runChild(args: string[]): Promise<{ code: number | null; signal: string | null; out: ChildOut | null; stderr: string }> {
  // 子进程在 process.exit(0) 紧邻前同步写这两个文件 —— spawn 前清掉, 否则上一轮残留会污染本次读数
  // (同一个 <root> 在同一条用例内被复用, F1/F2 都是先 crashAt 再 runChild)。
  const exitPath = join(root, 'EXIT');
  const resultPath = join(root, 'RESULT.json');
  rmSync(exitPath, { force: true });
  rmSync(resultPath, { force: true });

  const proc = Bun.spawn(['bun', 'run', CHILD, '--root', root, '--run', RUN_ID, ...args], {
      // 子进程**不继承**父进程运行时改过的 env (Bun.spawn 的 env 是启动快照, 见
      // test/setup/tmpdir-isolation.ts 的已知边界)。不显式传, 夹具的 seat-usage / seat-health
      // 就会写进**生产** .omd/ —— 实测一次全量漏 66 条 `fixture:none` 进真账本。
      env: { ...process.env },
    cwd: join(import.meta.dir, '..', '..'),
    stdout: 'pipe',
    stderr: 'pipe',
  });

  // 读管道与等退出**各自单独** try/catch:一个抛不要连累另一个。
  // 错误只入局部变量不外抛 —— 子进程已把 EXIT/RESULT.json 写盘的话, 那些是更直接的读数 (P-2)。
  let readErr: unknown;
  let exitErr: unknown;
  let stdoutText = '';
  let stderrText = '';
  try {
    const [stdout, stderr] = await readAllBounded([proc.stdout, proc.stderr], 'runChild 读管道') as [string, string];
    stdoutText = stdout;
    stderrText = stderr;
  } catch (e) {
    readErr = e;
  }
  try {
    await awaitExitBounded(proc, 'runChild(resume 子进程)');
  } catch (e) {
    exitErr = e;
  }

  // 任一句抛过 → 对 EXIT 有界轮询 (5s/50ms, 远低于 60s 的 awaitExitBounded 内置界, 不再调它/不杀进程/
  // 不读 RESULT.json —— 把决策权留给子进程本身:它要写就会写, 超时即承认这次拿不到 EXIT 事实)。
  if (readErr !== undefined || exitErr !== undefined) {
    const CAP_MS = 5_000;
    const INTERVAL_MS = 50;
    const deadline = Date.now() + CAP_MS;
    while (!existsSync(exitPath) && Date.now() < deadline) {
      await Bun.sleep(INTERVAL_MS);
    }
  }

  // code 优先级:EXIT 解析出的整数 > proc.exitCode 真值。EXIT 不在场或解析失败才退回。
  // 不许写 ?? 常数兜底 (如 ?? 0 / ?? 1 / ?? 137) —— null 是 ChildOut.code 类型自洽的空态, 不是兜底。
  let code: number | null;
  if (existsSync(exitPath)) {
    const codeRaw = readFileSync(exitPath, 'utf-8').trim();
    const parsed = /^-?\d+$/.test(codeRaw) ? Number.parseInt(codeRaw, 10) : NaN;
    code = Number.isFinite(parsed) ? parsed : (proc.exitCode ?? null);
  } else {
    code = proc.exitCode ?? null;
  }

  // out 优先级:stdout 的 ##RESULT## 行 > <root>/RESULT.json。stdout 没找到或 parse 抛才读 RESULT.json;
  // 都不在 → out = null。
  let out: ChildOut | null = null;
  const resultLine = stdoutText.split('\n').find((l) => l.startsWith('##RESULT## '));
  if (resultLine) {
    try {
      out = JSON.parse(resultLine.slice('##RESULT## '.length)) as ChildOut;
    } catch {
      if (existsSync(resultPath)) {
        try {
          out = JSON.parse(readFileSync(resultPath, 'utf-8')) as ChildOut;
        } catch {
          out = null;
        }
      }
    }
  } else if (existsSync(resultPath)) {
    try {
      out = JSON.parse(readFileSync(resultPath, 'utf-8')) as ChildOut;
    } catch {
      out = null;
    }
  }

  // 两句都抛**且**两文件都不在场 → 读数真报废, 抛;否则照常返回 (不让本次读数报废)。
  if (readErr !== undefined && exitErr !== undefined && !existsSync(exitPath) && !existsSync(resultPath)) {
    throw readErr ?? exitErr;
  }

  return {
    code,
    signal: proc.signalCode,
    out,
    stderr: stderrText,
  };
}

/**
 * 起子进程 → 等它挂在 `--hang` 的那个节点上 (哨兵文件 READY-<node>) → **外力 SIGKILL**。
 * 等哨兵而不是等定时: 定时会在慢机器上杀早 (还没跑到就杀 = 测了个空), 哨兵是确定时点。
 */
async function crashAt(hangNode: string, args: string[]): Promise<void> {
  const proc = Bun.spawn(['bun', 'run', CHILD, '--root', root, '--run', RUN_ID, '--hang', hangNode, ...args], {
      // 子进程**不继承**父进程运行时改过的 env (Bun.spawn 的 env 是启动快照, 见
      // test/setup/tmpdir-isolation.ts 的已知边界)。不显式传, 夹具的 seat-usage / seat-health
      // 就会写进**生产** .omd/ —— 实测一次全量漏 66 条 `fixture:none` 进真账本。
      env: { ...process.env },
    cwd: join(import.meta.dir, '..', '..'),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  // ⚠ **管道必须有人读** (2026-08-23): 上面开了 `stdout/stderr: 'pipe'` 而这里从头到尾不读,
  //   子进程日志量一旦超过管道缓冲就**阻塞在写上**, 永远到不了哨兵 —— 那时 60s 超时是
  //   **结果不是原因**, 而判词却说「夹具没能进入崩溃点」, 把人带向错误方向。
  //   边读边丢, 只留尾巴作诊断。
  let sawBytes = 0;
  let tail = '';
  const drain = async (stream: ReadableStream<Uint8Array> | null): Promise<void> => {
    if (!stream) return;
    const dec = new TextDecoder();
    for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
      sawBytes += chunk.byteLength;
      tail = (tail + dec.decode(chunk, { stream: true })).slice(-600);
    }
  };
  const draining = Promise.all([drain(proc.stdout), drain(proc.stderr)]).catch(() => {});

  const sentinel = join(root, `READY-${hangNode}`);
  // ⚠ **按「有没有进展」判, 不按墙钟判**: 上面那条注释说得对 —— 定时会在慢机器上杀早。
  //   而原来的兜底仍是 60s 墙钟, 于是机器一忙就复现同一个病 (2026-08-23 实测: 今晚全量里
  //   这一族红过三次, 每次都恰好 60.2s, 单跑该文件 11 pass/0 fail)。
  //   改成: 只要子进程还在**产出字节**就不算卡住; 连续 NO_PROGRESS_MS 一个字节没有才判死。
  const NO_PROGRESS_MS = 30_000;
  // ⚠ **无进展判也必须有总上界** (2026-08-23 实测, 这一族 flaky 的第四种表现):
  //   只按「有没有进展」判, 子进程只要还在断续吐字节就**永远转下去** —— 那一趟撞的是
  //   bun 的 240s 单测上限, 于是上面这段精心写的可诊断判词一句都没打出来, 报告里只剩
  //   `this test timed out after 240000ms`。总上界不是为了掐性能 (正常 ~1s),
  //   是为了保证**判词由这里出, 不由 runner 出**: 留出余量给同一条用例的 resume 那一跳。
  //   ⚠ 它分不出「慢但本来能成」和「真挂了」—— 所以判词把用时和字节数都念出来, 让下一个
  //   读的人自己判, 别替他下结论。
  //   ⚠ 取值判据: 必须低于**本文件最小的那个**单测预算 (F1 是 180s, 其余 240s), 且要给
  //   同一条用例的 resume 那一跳留出余地 —— 卡在这里把 runner 的预算吃光, 判词照样出不来。
  const TOTAL_CAP_MS = 120_000;
  const startedAt = Date.now();
  let lastBytes = -1;
  let lastProgressAt = Date.now();
  while (!existsSync(sentinel)) {
    if (sawBytes !== lastBytes) {
      lastBytes = sawBytes;
      lastProgressAt = Date.now();
    }
    const idleMs = Date.now() - lastProgressAt;
    const totalMs = Date.now() - startedAt;
    if (idleMs > NO_PROGRESS_MS || totalMs > TOTAL_CAP_MS) {
      proc.kill('SIGKILL');
      await drained(proc, hangNode, draining);
      // ⚠ 判词要**可诊断**: 原来只说「没跑到, 本次读数无效」—— 那句话是诚实的, 但它把
      //   「机器慢」「子进程死了」「管道堵了」三件事压成一句, 查不动。
      //   两条兜底各自报出自己是哪一条: 卡死 (一个字节都没有) 与空转 (一直在吐但到不了)
      //   要查的是不同的东西, 压成一句就等于又回到「查不动」。
      const why =
        idleMs > NO_PROGRESS_MS
          ? `子进程 ${NO_PROGRESS_MS / 1000}s 内一个字节都没产出`
          : `子进程一直在产出字节, 但 ${TOTAL_CAP_MS / 1000}s 内到不了哨兵`;
      const files = existsSync(root) ? readdirSync(root).slice(0, 12).join(', ') : '(root 不在)';
      throw new Error(
        `${why}且没跑到 ${hangNode} —— 累计收到 ${sawBytes} 字节; 用时 ${Math.round(totalMs / 1000)}s; ` +
          `root 里有: ${files}; 输出尾: ${tail.slice(-300) || '(空)'}`,
      );
    }
    await Bun.sleep(50);
  }
  // ⚠ **不许在 kill 之前 await draining**: 子进程此刻正挂在崩溃点上, stdout 永远不关,
  //   drain 永远不 resolve ⇒ 整个用例死挂 (2026-08-23 我第一版就是这么写的, 跑一遍就照出来)。
  //   先杀, 流随之关闭, drain 自然收尾。
  proc.kill('SIGKILL');
  await awaitDeath(proc, `crashAt(${hangNode}) 的 SIGKILL 之后`);
  await drained(proc, hangNode, draining);
}

/**
 * 等 drain 收尾 —— **但这一等必须有界**(2026-08-23)。
 *
 * 「先杀, 流随之关闭, drain 自然收尾」是个**假设**, 而 bun 1.3.14 的子进程记账缺陷
 * 正好能证伪它(同一族的另一张脸就是管道到不了 EOF)。裸 `await draining` 不设界 ⇒
 * 流不关就挂到 runner 的单测上限, 报告里只剩 `this test timed out`, 一句判词都没有 ——
 * 与「哨兵循环没有总上界」是**同一个病的两处**, 上一片只治了其中一处。
 *
 * 界不用编数: `awaitWhileAlive` 的判据是 `processGone(pid)` 的直接观测 ——
 * 进程还在就一秒不催, 进程没了而 EOF 还不来才判「记账丢了」。
 */
const drained = (proc: { pid: number }, hangNode: string, draining: Promise<unknown>): Promise<unknown> =>
  awaitWhileAlive(draining, proc.pid, `crashAt(${hangNode}) 等 stdout/stderr 收尾`);

describe('F1 崩在一轮中途 —— 轮内已绿节点不重跑, 制品不丢', () => {
  test('a/b 已绿时杀进程 → resume 只补跑 c, a/b 各仍只执行过 1 次', async () => {
    await crashAt('c', ['--max-rounds', '1']);

    // 崩溃现场: a/b 各跑过一次且制品在盘上; c 没有痕迹 (半完成的节点不算绿)。
    expect(execCount('a')).toBe(1);
    expect(execCount('b')).toBe(1);
    expect(execCount('c')).toBe(0);
    expect(readFileSync(join(root, 'art-a.txt'), 'utf-8')).toContain('artifact of a');
    expect(existsSync(join(runDir(), 'a.json'))).toBe(true);
    expect(existsSync(join(runDir(), 'c.json'))).toBe(false);

    const r = await runChild(['--max-rounds', '1', '--resume']);
    expect(r.out).not.toBeNull();
    expect(r.out!.converged).toBe(true);
    // 判据: a/b 的执行次数**没有涨**, c 补跑了一次。
    expect(execCount('a')).toBe(1);
    expect(execCount('b')).toBe(1);
    expect(execCount('c')).toBe(1);
    // 已批准制品在恢复后仍是原样 (没被"重跑覆盖"掩盖成绿)。
    expect(readFileSync(join(root, 'art-a.txt'), 'utf-8')).toContain('artifact of a');
    expect(r.out!.lastRoundStatuses).toEqual({ a: 'done', b: 'done', c: 'done' });
  }, 180_000);

  test('不带 --resume → 同一个 runId 也整轮重跑 (恢复必须是显式的)', async () => {
    await crashAt('c', ['--max-rounds', '1']);
    expect(execCount('a')).toBe(1);

    await runChild(['--max-rounds', '1']);
    expect(execCount('a')).toBe(2); // 没要求恢复就不恢复 —— 这是设计, 不是缺陷
  }, 180_000);
});

describe('F2 崩在轮间 —— 外层轮次与毒集跨进程存活', () => {
  test('第 1 轮判未收敛并点名 b, 崩在第 2 轮 → resume 从第 2 轮起, 毒集还在', async () => {
    // 第 1 轮全绿 → judge 判 reject-b (毒集入一条) → 第 2 轮跑到 c 时被杀。
    await crashAt('c', ['--max-rounds', '3', '--hang-round', '2', '--verdicts', 'reject-b,converge']);

    const journal = JSON.parse(readFileSync(join(runDir(), '_fixpoint.json'), 'utf-8')) as {
      completedRounds: number;
      poisoned: string[];
      converged: boolean;
    };
    expect(journal.completedRounds).toBe(1);
    expect(journal.poisoned).toHaveLength(1); // D-4 铸票存盘了
    expect(journal.converged).toBe(false);

    const r = await runChild(['--max-rounds', '3', '--verdicts', 'converge', '--resume']);
    expect(r.out!.startedFromRound).toBe(2); // 不从第 1 轮重来
    expect(r.out!.roundsThisProcess).toBe(1); // 本进程只跑了第 2 轮
    expect(r.out!.converged).toBe(true);
    // **毒集没有清零** —— 清零 = 被拒产出复活, 比不复用更坏 (INV-P2-6 点名的那条)。
    expect(r.out!.poisoned).toBe(1);
  }, 240_000);

  /**
   * 两条持久化互相独立, 崩溃把它们的时序错开时会不会打架 —— 这是故障注入才问得出来的问题。
   *
   * 场景: 第 1 轮 b 被判拒 (毒集有它) → 第 2 轮**还没轮到 b 重跑就崩了** → 恢复。
   * 此刻磁盘上 b 的 per-node checkpoint 仍是**第 1 轮那份被拒的产出**, 而 resume 的
   * 已绿预载 (`loadAllGreen`) 不问毒集。若它把 b 当绿跳过, 被拒产出就借崩溃复活了 ——
   * 正是 INV-P2-6 里"毒集丢了比不复用更坏"的同一种坏, 只是走的是另一条通道。
   */
  test('毒集里的节点不得靠 per-node checkpoint 复活 (两条持久化通道的接缝)', async () => {
    await crashAt('b', ['--max-rounds', '3', '--hang-round', '2', '--verdicts', 'reject-b,converge']);
    expect(execCount('b')).toBe(1); // 第 2 轮崩在 b 之前 —— 盘上那份 b 就是被拒的第 1 轮产出

    const r = await runChild(['--max-rounds', '3', '--verdicts', 'converge', '--resume']);
    expect(r.out!.poisoned).toBe(1);
    expect(execCount('b')).toBe(2); // 被拒的那份不算数, b 必须真重跑
    expect(r.out!.reusedNodes).not.toContain('b');
  }, 240_000);

  test('maxRounds 是总上界: 崩一次不该换来额外轮数', async () => {
    await crashAt('c', ['--max-rounds', '2', '--hang-round', '2', '--verdicts', 'reject-b,blind']);
    const r = await runChild(['--max-rounds', '2', '--verdicts', 'blind', '--resume']);
    expect(r.out!.startedFromRound).toBe(2);
    expect(r.out!.roundsThisProcess).toBe(1); // 2 轮上界 - 已完成 1 轮 = 只剩 1 轮
  }, 240_000);
});

describe('F3 坏盘 —— 撕裂/残留/损坏不得把恢复路径炸掉', () => {
  test('_fixpoint.json 被截断 → 不炸, 退回第 1 轮 (fail-open), 但毒集确实丢了', async () => {
    await crashAt('c', ['--max-rounds', '3', '--hang-round', '2', '--verdicts', 'reject-b,converge']);
    const jpath = join(runDir(), '_fixpoint.json');
    writeFileSync(jpath, readFileSync(jpath, 'utf-8').slice(0, 40), 'utf-8'); // 半截 JSON = 写到一半掉电

    const r = await runChild(['--max-rounds', '3', '--verdicts', 'converge', '--resume']);
    expect(r.code).toBe(0); // 不炸
    expect(r.out!.startedFromRound).toBe(1); // 读不出 journal → 当没有外层历史
    // 诚实记账: 这条**不是**"恢复成功", 是降级。毒集归零, 上一轮被拒的产出重新有资格被复用。
    // 轮内 per-node checkpoint 仍然兜住了已绿节点 —— 两层持久化互相独立, 坏一层不连坐。
    expect(execCount('a')).toBe(1);
  }, 240_000);

  test('per-node checkpoint 损坏 → 该节点重跑, 其余仍跳过 (损坏不扩散)', async () => {
    await crashAt('c', ['--max-rounds', '1']);
    writeFileSync(join(runDir(), 'b.json'), '{"nodeId":"b","statu', 'utf-8');

    const r = await runChild(['--max-rounds', '1', '--resume']);
    expect(r.code).toBe(0);
    expect(execCount('a')).toBe(1); // 好的那个仍跳过
    expect(execCount('b')).toBe(2); // 坏的那个重跑
    expect(r.out!.lastRoundStatuses.b).toBe('done');
  }, 240_000);

  test('原子写的半成品 (.tmp 残留) 不被当成 checkpoint', async () => {
    await crashAt('c', ['--max-rounds', '1']);
    writeFileSync(join(runDir(), 'c.tmp'), '{"nodeId":"c","status":"done","schemaVersion":1}', 'utf-8');
    writeFileSync(join(runDir(), '_fixpoint.tmp'), '{"completedRounds":9}', 'utf-8');

    const r = await runChild(['--max-rounds', '1', '--resume']);
    expect(r.code).toBe(0);
    expect(execCount('c')).toBe(1); // .tmp 没被当成"c 已绿"
    expect(r.out!.startedFromRound).toBe(1); // _fixpoint.tmp 没被当成 journal
  }, 240_000);

  test('runDir 整个被删 → 从头跑, 不抛 (最坏情况仍可用)', async () => {
    await crashAt('c', ['--max-rounds', '1']);
    rmSync(runDir(), { recursive: true, force: true });

    const r = await runChild(['--max-rounds', '1', '--resume']);
    expect(r.code).toBe(0);
    expect(r.out!.converged).toBe(true);
    expect(execCount('a')).toBe(2); // 没 checkpoint 就老实重跑
  }, 240_000);
});

describe('F4 制品校验 —— "已批准"是拿产物证的, 不是拿 checkpoint 自述证的', () => {
  test('已绿节点的产物被删 → 不跳过, 重跑补回 (checkpoint 说绿不算数)', async () => {
    await crashAt('c', ['--max-rounds', '1']);
    rmSync(join(root, 'art-a.txt'), { force: true });

    const r = await runChild(['--max-rounds', '1', '--resume']);
    expect(r.code).toBe(0);
    expect(execCount('a')).toBe(2); // 产物没了 → 这个节点不算绿
    expect(execCount('b')).toBe(1); // 产物还在的那个照样跳过 (逐节点判, 不整轮连坐)
    expect(existsSync(join(root, 'art-a.txt'))).toBe(true); // 补回来了
  }, 240_000);

  test('已绿节点的产物被改 → hash 不匹配, 同样重跑', async () => {
    await crashAt('c', ['--max-rounds', '1']);
    writeFileSync(join(root, 'art-b.txt'), '被别人改过了\n', 'utf-8');

    const r = await runChild(['--max-rounds', '1', '--resume']);
    expect(r.code).toBe(0);
    expect(execCount('a')).toBe(1);
    expect(execCount('b')).toBe(2);
    expect(readFileSync(join(root, 'art-b.txt'), 'utf-8')).toContain('artifact of b'); // 覆盖回正确内容
  }, 240_000);
});
