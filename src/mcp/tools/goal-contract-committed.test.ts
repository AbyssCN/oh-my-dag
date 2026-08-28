/**
 * src/mcp/tools/goal-contract-committed.test —— T-3 契约入库闸接线(owner 2026-08-28 裁)。
 *
 * ## 它锁的是什么
 *
 * O-6 的切片交付判定拿「契约入库之后本片写集被动过没有」当证据。契约还没提交时查不到
 * 入库点,原实装降级成「只看脏文件数」—— 而脏不脏答不了**是谁弄脏的**:同一棵树上
 * 另一个窗口的在途改动同样让它脏。`already-delivered` 是 O-6 里**唯一放行**的那一格,
 * 假阳性的后果是整片被跳过、契约修订一行代码都不进。
 *
 * 判定层那半在 `harness/goal/slice-delivery.ts`(查不到入库点即 `available:false`);
 * 这里锁的是**点火层**那半:契约没提交,`solve --sddPath` 在点火那一刻就同步拒。
 *
 * ## 四条出口,每条一个 test
 * · git 仓 + 契约未提交 → 拒(detached 侧零 spawn / 非 detached 侧 runGoal 不跑)
 * · git 仓 + 契约已提交 → 放行
 * · git 仓 + 契约未提交 + force → 越闸放行(owner 的合法人工路径,不许掐死)
 * · **非 git 仓 → 闸缺席**(fail-open)
 *
 * ⚠ 最后一条是这组里最要紧的:O-6 只在「切片 verify 已绿」时才问那一问,而 verify 全红的
 * 图完全健康。拿 git 取不到证据去挡它们是误伤一整类本来能跑的图。既有的
 * `goal-ignition-dryrun.test.ts` 12 条全跑在 `mkdtemp` 的非 git 仓里 —— 它们保持绿
 * 本身就是这条 fail-open 的第二份证据。
 *
 * ## 证伪(每条真跑过一次)
 * · 摘掉非 detached 接线点的 `contractCommittedGate` 调用 → 第 1 条红。
 * · 摘掉 detached 接线点的调用 → 第 2 条红(spawn 会真发生)。
 * · 把 `birth.exitCode !== 0` 的 fail-open 改成拒 → 第 5 条红(非 git 仓被误伤)。
 * · 把 force 分支短路 → 第 4 条红。
 * · 把「查得到入库点就放行」那句删掉 → 第 3 条红(提交过的契约也被拒,闸恒拒 = 不是闸)。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createGoalTool } from './goal';
import { RunRegistry } from '../run-registry';
import { CheckpointManager } from '../../harness/continuity/checkpoint-manager';
import type { RunGoalResult } from '../../harness/goal/run-goal';
import type { CommandLeafRunner } from '../../harness/leaf-runners';

/** 过得了 D3 空跑闸的最小合法契约 —— T-3 排在空跑闸之后, 前面拒了就轮不到它。 */
const SDD_OK = [
  '# t',
  '## 契约 (Contracts)',
  '- G-1',
  '## 分解 (Breakdown)',
  '',
  '| 切片 | 写集 | 依赖 | verify |',
  '|---|---|---|---|',
  '| 1 a | src/foo.ts + test | — | bun test src/foo.test.ts |',
  '| 2 b | src/bar.ts + test | 1 | bun test src/bar.test.ts |',
  '',
  '## 非目标 (Non-goals)',
  '- 无',
].join('\n');

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 非 git 仓(既有 dryrun 测试同款)—— 闸该缺席的那一格。 */
const plainRoot = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'omd-t3-plain-'));
  dirs.push(d);
  return d;
};

/**
 * 真 git 仓。`commit` 决定契约进不进 HEAD —— 这一个布尔就是本组测试的单一变量。
 * 用真 git 而不是替身:被测的正是「`git log --diff-filter=A` 在这棵真树上答什么」。
 */
const gitRoot = (opts: { commit: boolean }): { root: string; sddPath: string } => {
  const root = mkdtempSync(join(tmpdir(), 'omd-t3-git-'));
  dirs.push(root);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  git('config', 'commit.gpgsign', 'false');
  // 先造一个与契约无关的入库点 —— 空仓里 `git log` 退非零, 那会走 fail-open 而不是本组要测的格。
  writeFileSync(join(root, 'README.md'), '# t\n');
  git('add', 'README.md');
  git('commit', '-qm', 'seed');

  const sddPath = join(root, 'docs', 'plan', 'sdd.md');
  mkdirSync(dirname(sddPath), { recursive: true });
  writeFileSync(sddPath, SDD_OK);
  if (opts.commit) {
    git('add', 'docs/plan/sdd.md');
    git('commit', '-qm', 'contract');
  }
  return { root, sddPath };
};

const emptyResult = (goal: string): RunGoalResult => ({
  goal,
  tier: 'simple',
  acceptance: { kind: 'executable', command: 'bun test', expectExit: 0 },
  stages: [],
  sources: [],
  repoContext: '',
  converged: true,
  outcome: 'success' as const,
  rounds: 1,
  reusedNodes: [],
});

const call = (tool: ReturnType<typeof createGoalTool>, args: Record<string, unknown>) =>
  tool.handler(args as never, {} as never) as Promise<{ content: { text: string }[]; isError?: boolean }>;

/** exit 1 让下游 checkIgnitionCriteria 不拒 —— 与 goal-ignition-dryrun.test 同款用法。 */
const redRunner: CommandLeafRunner = async () => ({
  text: '',
  usage: { in: 0, out: 0 },
  timedOut: false,
  signal: null,
  exitCode: 1,
});

const REJECT_MARK = 'T-3 · 契约还没提交';

describe('T-3 契约入库闸 (点火层)', () => {
  test('★ git 仓 + 契约未提交 + 非 detached → 同步拒, runGoal 不跑, registry 无记录', async () => {
    const { root, sddPath } = gitRoot({ commit: false });
    const registry = new RunRegistry();
    let runGoalCalls = 0;
    const tool = createGoalTool({
      runGoal: async (goal) => {
        runGoalCalls++;
        return emptyResult(goal);
      },
      runRegistry: registry,
      cwd: root,
      buildConfig: () => ({ conductorModel: 'c:m', leafModel: 'l:m' }),
      continuity: { manager: new CheckpointManager(root), repoRoot: root },
      commandRunner: redRunner,
    });
    const out = await call(tool, { goal: 'g', sddPath });

    expect(out.isError).toBe(true);
    expect(out.content[0]!.text).toContain(REJECT_MARK);
    // 回执要说得出**该敲哪条命令** —— 拒了却不说怎么过, 等于把人卡在门口。
    expect(out.content[0]!.text).toContain('git add');
    expect(runGoalCalls).toBe(0);
    expect(registry.listRuns()).toHaveLength(0);
  });

  test('★ git 仓 + 契约未提交 + detached → 同步拒, 零 spawn', async () => {
    const { root, sddPath } = gitRoot({ commit: false });
    const seenSpawns: string[][] = [];
    const registry = new RunRegistry();
    const tool = createGoalTool({
      runGoal: async () => {
        throw new Error('detached 路径不该在母进程里跑 runGoal');
      },
      runRegistry: registry,
      cwd: root,
      buildConfig: () => ({ conductorModel: 'c:m', leafModel: 'l:m' }),
      continuity: { manager: new CheckpointManager(root), repoRoot: root },
      commandRunner: redRunner,
      spawnDetached: (cmd) => {
        seenSpawns.push(cmd);
        return 4242;
      },
    });
    const out = await call(tool, { goal: 'g', detached: true, sddPath });

    expect(out.isError).toBe(true);
    expect(out.content[0]!.text).toContain(REJECT_MARK);
    expect(seenSpawns).toHaveLength(0);
    expect(registry.listRuns()).toHaveLength(0);
  });

  test('★ git 仓 + 契约已提交 → 闸放行 (单一变量: 只有 commit 这一个布尔变了)', async () => {
    const { root, sddPath } = gitRoot({ commit: true });
    const tool = createGoalTool({
      runGoal: async (goal) => emptyResult(goal),
      runRegistry: new RunRegistry(),
      cwd: root,
      buildConfig: () => ({ conductorModel: 'c:m', leafModel: 'l:m' }),
      continuity: { manager: new CheckpointManager(root), repoRoot: root },
      commandRunner: redRunner,
    });
    const out = await call(tool, { goal: 'g', sddPath });

    expect(out.content[0]!.text).not.toContain(REJECT_MARK);
    expect(out.isError).toBeUndefined();
  });

  test('★ git 仓 + 契约未提交 + force=true → 越闸放行 (owner 的合法人工路径)', async () => {
    const { root, sddPath } = gitRoot({ commit: false });
    const tool = createGoalTool({
      runGoal: async (goal) => emptyResult(goal),
      runRegistry: new RunRegistry(),
      cwd: root,
      buildConfig: () => ({ conductorModel: 'c:m', leafModel: 'l:m' }),
      continuity: { manager: new CheckpointManager(root), repoRoot: root },
      commandRunner: redRunner,
    });
    const out = await call(tool, { goal: 'g', force: true, sddPath });

    expect(out.content[0]!.text).not.toContain(REJECT_MARK);
  });

  test('★ 非 git 仓 → 闸缺席 (fail-open: 别误伤 verify 全红的健康图)', async () => {
    // 这一条是本组的重点。O-6 只在「切片 verify 已绿」时才问交付那一问 —— verify 全红的图
    // 从来不经过它。拿「git 取不到证据」去挡点火, 挡掉的是一整类本来能跑的图。
    const root = plainRoot();
    const sddPath = join(root, 'docs', 'plan', 'sdd.md');
    mkdirSync(dirname(sddPath), { recursive: true });
    writeFileSync(sddPath, SDD_OK);
    const tool = createGoalTool({
      runGoal: async (goal) => emptyResult(goal),
      runRegistry: new RunRegistry(),
      cwd: root,
      buildConfig: () => ({ conductorModel: 'c:m', leafModel: 'l:m' }),
      continuity: { manager: new CheckpointManager(root), repoRoot: root },
      commandRunner: redRunner,
    });
    const out = await call(tool, { goal: 'g', sddPath });

    expect(out.content[0]!.text).not.toContain(REJECT_MARK);
    expect(out.isError).toBeUndefined();
  });
});
