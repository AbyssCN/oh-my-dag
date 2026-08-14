/**
 * **G2 硬闸的最后一格:内环上真杀一次进程**(S6 / F1-真杀,2026-07-31)。
 *
 * ## 这份补的是哪半格
 *
 * 内环故障注入(`src/harness/plan/inner-loop-fault.test.ts`)18 条全绿,但它自己在文件头写着:
 * 那是**崩溃的进程内等价物**,对 F2/F3/F4 忠实,对 F1 只是近似。而 G2 是硬闸,它问的是
 * 「崩溃不丢已批准制品」—— 在那份近似里,**崩溃从没真发生过**:轮次/毒集/复用源是进程内闭包,
 * 同进程里它们没死过一次。旧那套真杀夹具打的是**外层 fixpoint**,而环 D-F 之后搬进了
 * conductor 节点。本文件把「等哨兵 → 外力 SIGKILL → 带 resume 重起」移植到内环。
 *
 * 判据只认**盘上的文件**,不认进程回传的话:
 *   `exec.log` 行数 = 每个子节点真跑过几次(「已绿不重跑」的唯一硬判据)
 *   `art-<id>.txt` = 已批准制品(「不丢」)
 *   `_loop-P.json` = 内环轮次 + 毒集(「环状态跨进程存活」)
 *
 * ## ★ 一条这次才量到的结论(写在最前面,免得被读成"没测出东西")
 *
 * 交接文让这份夹具去「造出**写了一半的 checkpoint**」。**SIGKILL 造不出来,而且是构造上造不出来** ——
 * `CheckpointManager` 全部落盘走 tmp + `renameSync`,rename 在 POSIX 上是原子的:进程被杀时
 * 盘上要么是旧那份完整文件,要么是新那份完整文件,**没有第三种**。写到一半的只可能是那个
 * 从不被读的 `.tmp`。
 *
 * 所以撕裂属于**另一类故障**:掉电 / 内核崩溃(页缓存都没落到盘),而那一类 SIGKILL 模拟不了,
 * 也不是本仓测得了的。`inner-loop-fault.test.ts` 里那条**合成**撕裂用例正是为它准备的 ——
 * 两者不是重复,是分工:合成那条问「读到撕裂的怎么办」,本文件问「真被杀会不会撕裂」。
 * 答案是不会,而这个"不会"此前是**声称**(注释里写着"原子写避免损坏"),现在是**读数**。
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { awaitDeath, readAllBounded } from './_await-exit';

const CHILD = join(import.meta.dir, 'inner-loop-crash-child.ts');
const REPO = join(import.meta.dir, '..', '..');
const RUN_ID = 'inner-crash-run';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'omd-inner-crash-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const runDir = (): string => join(root, '.omd', 'continuity', RUN_ID);
const loopFile = (): string => join(runDir(), '_loop-P.json');
const execCount = (node: string): number =>
  (existsSync(join(root, 'exec.log')) ? readFileSync(join(root, 'exec.log'), 'utf-8') : '')
    .split('\n')
    .filter((l) => l.trim() === node).length;

interface ChildOut {
  startedFromRound: number;
  converged: boolean;
  status: string;
  rounds: number;
  completedRounds: number;
  poisoned: number;
  reusedNodes: string[];
}

async function runChild(args: string[]): Promise<ChildOut | null> {
  const proc = Bun.spawn(['bun', 'run', CHILD, '--root', root, '--run', RUN_ID, ...args], { cwd: REPO, stdout: 'pipe', stderr: 'pipe' });
  // 本文件的 runChild **不看退出码**(返回值里没有它, 判据全在 `##RESULT##` 那行),
  // 所以退出事件丢了不该让整条用例红 —— 用 awaitDeath 而不是 awaitExitBounded。
  const [stdout, stderr] = await readAllBounded([proc.stdout, proc.stderr], 'runChild(resume 子进程) 读管道') as [string, string];
  await awaitDeath(proc, 'runChild(resume 子进程)');
  const line = stdout.split('\n').find((l) => l.startsWith('##RESULT## '));
  if (!line) throw new Error(`子进程没给出读数 —— stderr:\n${stderr.slice(-2000)}`);
  return JSON.parse(line.slice('##RESULT## '.length)) as ChildOut;
}

/**
 * 起子进程 → 等它挂在 `--hang` 的那个子节点上(哨兵文件 `READY-<id>`)→ **外力 SIGKILL**。
 * 等哨兵而不是等定时:定时会在慢机器上杀早(还没跑到就杀 = 测了个空),哨兵是确定时点。
 */
async function crashAt(hangNode: string, args: string[]): Promise<void> {
  const proc = Bun.spawn(['bun', 'run', CHILD, '--root', root, '--run', RUN_ID, '--hang', hangNode, ...args], {
    cwd: REPO,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const sentinel = join(root, `READY-${hangNode}`);
  const deadline = Date.now() + 60_000;
  while (!existsSync(sentinel)) {
    if (Date.now() > deadline) {
      proc.kill('SIGKILL');
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`子进程 60s 内没跑到 ${hangNode} —— 夹具没进崩溃点, 本次读数无效。stderr:\n${stderr.slice(-2000)}`);
    }
    await Bun.sleep(50);
  }
  proc.kill('SIGKILL');
  await awaitDeath(proc, `crashAt(${hangNode}) 的 SIGKILL 之后`);
}

describe('G2/F1 真杀 —— 内环崩在轮中, 已批准制品不丢、已绿子节点不重跑', () => {
  test('第 1 轮跑完(判未收敛并点名 b), 崩在第 2 轮的 b 上 → resume 只补跑 b', async () => {
    // 第 1 轮: a、b 各跑一次 → judge 判未收敛并点名 b (毒集入一条) → 第 2 轮重展开,
    // a 命中 checkpoint 复用, b 被毒集强制重跑 —— 就在这时被杀。
    await crashAt('b', ['--max-rounds', '2', '--hang-round', '2', '--verdicts', 'reject-b,converge']);

    // ── 崩溃现场 ──────────────────────────────────────────────────────────────
    expect(execCount('a')).toBe(1); // 第 2 轮它是复用的, 没有第二次执行
    expect(execCount('b')).toBe(1); // 第 2 轮的 b 挂在执行前, 不留痕
    expect(readFileSync(join(root, 'art-a.txt'), 'utf-8')).toContain('artifact of a');
    const j = JSON.parse(readFileSync(loopFile(), 'utf-8')) as { completedRounds: number; poisoned: string[]; nodeId: string };
    expect(j.nodeId).toBe('P');
    expect(j.completedRounds).toBe(1); // 第 1 轮判完了; 第 2 轮没判完 → 不算数
    expect(j.poisoned).toHaveLength(1); // 毒集跨进程活了下来

    // ── 带 resume 重起 ────────────────────────────────────────────────────────
    const out = await runChild(['--max-rounds', '2', '--resume', '--verdicts', 'converge']);
    expect(out!.startedFromRound).toBe(2); // 从第 2 轮起, 不是从头
    expect(out!.converged).toBe(true);
    // ★ G2 的那句话: 已批准制品不丢, 且没被"重跑覆盖"掩盖成绿
    expect(readFileSync(join(root, 'art-a.txt'), 'utf-8')).toContain('artifact of a');
    expect(execCount('a')).toBe(1); // ← 判据: 它的执行次数**没有涨**
    expect(execCount('b')).toBe(2); // 被点名的那个补跑了一次
  }, 180_000);

  test('不带 resume → 同一个 runId 也整轮重跑(恢复必须是显式的, 这是设计)', async () => {
    await crashAt('b', ['--max-rounds', '2', '--hang-round', '2', '--verdicts', 'reject-b,converge']);
    expect(execCount('a')).toBe(1);

    await runChild(['--max-rounds', '1', '--verdicts', 'converge']);
    expect(execCount('a')).toBe(2); // 没要求恢复就不恢复
  }, 180_000);
});

describe('G2/F1 真杀 —— 外力杀死留下的盘面本身是不是可读的', () => {
  /**
   * ★ 这一条是本文件的**主要读数**,而不是附带检查。
   *
   * 它把「原子写(tmp+rename)避免损坏」这句注释里的**声称**,换成一次真 SIGKILL 之后的
   * **实测**:runDir 下每一个 `.json` 都完整可解析。撕裂只可能出现在从不被读的 `.tmp` 上。
   */
  test('SIGKILL 之后 runDir 里每一个 .json 都完整可解析 —— 撕裂在这类故障下构造上不可能', async () => {
    await crashAt('b', ['--max-rounds', '2', '--hang-round', '2', '--verdicts', 'reject-b,converge']);
    const files = readdirSync(runDir()).filter((f) => f.endsWith('.json'));
    expect(files.length).toBeGreaterThan(0); // 没文件就是在测空气
    for (const f of files) {
      const raw = readFileSync(join(runDir(), f), 'utf-8');
      // 不用 toThrow 包一层: 失败时要看见是**哪个文件**的**什么内容** —— 撕裂读数的全部价值在这。
      expect(() => JSON.parse(raw) as unknown).not.toThrow();
      expect(raw.length).toBeGreaterThan(0);
    }
  }, 180_000);

  test('残留的 `.tmp` (若有) 不会被当成状态读回来 —— resume 照常从第 2 轮起', async () => {
    // `.tmp` 出不出现取决于杀的时点, 因此**不断言它存在**(那样会造出一条随机绿/随机红的用例);
    // 断言的是它在与不在都不改变恢复结果 —— 那才是我们真正依赖的性质。
    await crashAt('b', ['--max-rounds', '2', '--hang-round', '2', '--verdicts', 'reject-b,converge']);
    const out = await runChild(['--max-rounds', '2', '--resume', '--verdicts', 'converge']);
    expect(out!.startedFromRound).toBe(2);
    expect(out!.completedRounds).toBe(2);
  }, 180_000);
});
