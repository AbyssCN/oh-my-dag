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
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { awaitDeath, awaitExitBounded, readAllBounded } from './_await-exit';

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
  const proc = Bun.spawn(['bun', 'run', CHILD, '--root', root, '--run', RUN_ID, ...args], {
    cwd: join(import.meta.dir, '..', '..'),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr] = await readAllBounded([proc.stdout, proc.stderr], 'runChild 读管道') as [string, string];
  await awaitExitBounded(proc, 'runChild(resume 子进程)');
  const line = stdout.split('\n').find((l) => l.startsWith('##RESULT## '));
  return {
    code: proc.exitCode,
    signal: proc.signalCode,
    out: line ? (JSON.parse(line.slice('##RESULT## '.length)) as ChildOut) : null,
    stderr,
  };
}

/**
 * 起子进程 → 等它挂在 `--hang` 的那个节点上 (哨兵文件 READY-<node>) → **外力 SIGKILL**。
 * 等哨兵而不是等定时: 定时会在慢机器上杀早 (还没跑到就杀 = 测了个空), 哨兵是确定时点。
 */
async function crashAt(hangNode: string, args: string[]): Promise<void> {
  const proc = Bun.spawn(['bun', 'run', CHILD, '--root', root, '--run', RUN_ID, '--hang', hangNode, ...args], {
    cwd: join(import.meta.dir, '..', '..'),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const sentinel = join(root, `READY-${hangNode}`);
  const deadline = Date.now() + 60_000;
  while (!existsSync(sentinel)) {
    if (Date.now() > deadline) {
      proc.kill('SIGKILL');
      throw new Error(`子进程 60s 内没跑到 ${hangNode} —— 夹具没能进入崩溃点, 本次读数无效`);
    }
    await Bun.sleep(50);
  }
  proc.kill('SIGKILL');
  await awaitDeath(proc, `crashAt(${hangNode}) 的 SIGKILL 之后`);
}

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
    expect(journal.poisoned).toHaveLength(1); // D-4 铸票落盘了
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
