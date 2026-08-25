/**
 * **写型 run 默认落隔离树** (#253, 2026-08-25) —— 缺省翻面的接线闸。
 *
 * ## 它钉的是什么
 *
 * 缺省档位分三层, 三层各有各的值, 混一层就出静默事故:
 *   · 纯函数层 `prepareRunWorktree` —— 缺省仍 `head` (直调它的测试/外部调用零回归);
 *   · 工厂层 `createDagTools` / `createGoalTool` —— **不注入就不翻**, 老测试逐字节照旧;
 *   · 装配层 `assemble.ts` —— 注入 `'branch'`, 那才是 owner 真正点火的那条路。
 * 分层照 plan-critic 静态闸的先例 (assemble.ts 的 `OMD_PLAN_CRITIC_GATE`)。
 *
 * ## 反向自检 (一条永远绿的闸不是闸)
 *
 * · 把 `dag-tools.ts` 的 `requested ?? (resume ? undefined : deps.defaultBranchStrategy)` 改回
 *   `requested` → 「缺省 → branch」两条当场红。
 * · 把那个 `resume ? undefined :` 拿掉 → 「续跑不套缺省」当场红。**这一条是重点**: 首跑落 head
 *   的半成品在主工作树里未提交, 续跑若按新缺省建隔离树, 那棵树是 HEAD 的干净 checkout, 看不见
 *   它们 —— 既有的反向保护 (盘上有隔离树 → 强制 branch) 挡不住这个方向。
 * · 把 `assemble.ts` 那两处 `defaultBranchStrategy` 删掉 → 装配闸 (branch-default-wiring.test.ts) 红,
 *   本文件全绿 —— 两个文件分别钉不同的一层, 缺哪个都会漏掉一整层。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDagTools, type DagEngine } from './dag-tools';
import { createGoalTool } from './goal';
import { RunRegistry } from '../run-registry';
import { CheckpointManager } from '../../harness/continuity/checkpoint-manager';
import type { ConductorPlan } from '../../harness/conductor-plan';
import type { ExecutorDagConfig, ExecutorDagResult } from '../../harness/dag/types';
import type { RunGoalResult } from '../../harness/goal/run-goal';

const git = (args: string[], cwd: string): void => {
  const r = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${new TextDecoder().decode(r.stderr)}`);
};

/** 带一次 commit 的临时 git 仓 (`worktree add` 要有 HEAD)。 */
const tmpGitRepo = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'omd-bd-'));
  git(['init', '-q'], root);
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-q', '-m', 'seed'], root);
  return root;
};

const stubResult = {
  plan: { name: 'p', nodes: { root: { goal: 'g' } } } as unknown as ConductorPlan,
  sessionId: 's',
  levels: [['root']],
  results: { root: { id: 'root', status: 'done', kind: 'inproc', output: 'ok', deps: [], usage: { in: 1, out: 1 } } },
  reusedNodes: [],
  usage: { conductor: { in: 1, out: 1 }, leavesIn: 1, leavesOut: 1, leavesCacheHit: 0 },
} as unknown as ExecutorDagResult;

const PLAN = JSON.stringify({ name: 'p', nodes: { root: { goal: 'g', executor: 'leaf' } } });

/** dag_run 的**母进程**面: spawn 被替身接住, spec 里的 branchStrategy 就是判据。 */
function dagTools(root: string, opts: { defaultBranchStrategy?: 'head' | 'branch' } = {}) {
  const specs: Record<string, unknown>[] = [];
  const seenCwds: (string | undefined)[] = [];
  const engine: DagEngine = {
    runExecutorDag: async () => stubResult,
    runExecutorDagWithPlan: async () => stubResult,
  };
  const tools = createDagTools({
    engine,
    runRegistry: new RunRegistry(),
    defaultConfig: (cwd?: string) => {
      seenCwds.push(cwd);
      return { conductorModel: 'c:m', leafModel: 'l:m' };
    },
    continuity: { manager: new CheckpointManager(root), repoRoot: root },
    spawnDagExec: (spec) => {
      specs.push(spec.args as Record<string, unknown>);
      return { ok: true, pid: 4242, logPath: join(root, 'x.log') };
    },
    ...(opts.defaultBranchStrategy ? { defaultBranchStrategy: opts.defaultBranchStrategy } : {}),
  });
  return { tools, specs, seenCwds };
}

const call = (tool: { handler: (a: never, b: never) => unknown }, args: Record<string, unknown>) =>
  tool.handler(args as never, {} as never) as Promise<{ content: { text: string }[]; isError?: boolean }>;

describe('#253 run: 写型缺省落隔离树', () => {
  test('★ 缺省 (装配层注入 branch) → 不传 branchStrategy 的 dag_run 把 branch 写进 spec', async () => {
    const root = tmpGitRepo();
    const { tools, specs } = dagTools(root, { defaultBranchStrategy: 'branch' });
    const out = await call(tools.find((t) => t.name === 'dag_run')!, { task: '写点东西' });
    expect(specs[0]!.branchStrategy).toBe('branch');
    // 落点必须念在派工的人正在读的字里 —— 以为写主树而实际写隔离树同样坏。
    expect(out.content[0]!.text).toContain('写入落点');
    expect(out.content[0]!.text).toContain('隔离 worktree');
    rmSync(root, { recursive: true, force: true });
  });

  test("显式 'head' 压得过缺省 (opt-in 那一侧真的还在)", async () => {
    const root = tmpGitRepo();
    const { tools, specs } = dagTools(root, { defaultBranchStrategy: 'branch' });
    const out = await call(tools.find((t) => t.name === 'dag_run')!, { task: 't', branchStrategy: 'head' });
    expect(specs[0]!.branchStrategy).toBe('head');
    expect(out.content[0]!.text).toContain('当前工作树');
    rmSync(root, { recursive: true, force: true });
  });

  test('★ 续跑**不套缺省** —— 首跑 head 的半成品在主树里未提交, 建隔离树等于让它从零重做', async () => {
    const root = tmpGitRepo();
    const { tools, specs } = dagTools(root, { defaultBranchStrategy: 'branch' });
    const runId = '11111111-2222-3333-4444-555555555555';
    // 未知 runId 的 resume 不被 registry 拒 (register/reopen 语义), 走到 spawn。
    await call(tools.find((t) => t.name === 'dag_run')!, { task: 't', resume: runId });
    expect(specs[0]!.branchStrategy).toBeUndefined();
    rmSync(root, { recursive: true, force: true });
  });

  test('工厂层不注入 → 逐字节照旧 (spec 无 branchStrategy, 回执无落点行)', async () => {
    const root = tmpGitRepo();
    const { tools, specs } = dagTools(root);
    const out = await call(tools.find((t) => t.name === 'dag_run')!, { task: 't' });
    expect(specs[0]!.branchStrategy).toBeUndefined();
    expect(out.content[0]!.text).not.toContain('写入落点');
    rmSync(root, { recursive: true, force: true });
  });

  test('dag_run_plan 同一条缺省 (它不经 spawn, 直接建树) → leaf runner 重建在隔离树', async () => {
    const root = tmpGitRepo();
    const { tools, seenCwds } = dagTools(root, { defaultBranchStrategy: 'branch' });
    const out = await call(tools.find((t) => t.name === 'dag_run_plan')!, { plan: PLAN });
    await Bun.sleep(10);
    expect(out.content[0]!.text).toContain('omd/run/');
    expect(seenCwds[0]).toContain(join(root, '.omd', 'runs'));
    rmSync(root, { recursive: true, force: true });
  });
});

// ── solve 面 (同一条缺省, 另一个入口) ────────────────────────────────────────────

const neverRuns = async (): Promise<RunGoalResult> => {
  throw new Error('detached 路径不该在母进程里跑 runGoal');
};

function goalTool(root: string, opts: { defaultBranchStrategy?: 'head' | 'branch' } = {}) {
  const cmds: string[][] = [];
  const tool = createGoalTool({
    runGoal: neverRuns,
    runRegistry: new RunRegistry(),
    cwd: root,
    buildConfig: () => ({ conductorModel: 'c:m', leafModel: 'l:m' }) as Partial<ExecutorDagConfig>,
    continuity: { manager: new CheckpointManager(root), repoRoot: root },
    spawnDetached: (cmd) => {
      cmds.push(cmd);
      return 4242;
    },
    ...(opts.defaultBranchStrategy ? { defaultBranchStrategy: opts.defaultBranchStrategy } : {}),
  });
  return { tool, cmds };
}

describe('#253 solve: 同一条缺省, 不许两个入口各有各的默认', () => {
  test('★ 缺省 → detached worker 收到显式 `--branch-strategy branch` (母进程定死, worker 不再自己解析)', async () => {
    const root = tmpGitRepo();
    const { tool, cmds } = goalTool(root, { defaultBranchStrategy: 'branch' });
    const out = await call(tool, { goal: '夜批的活', detached: true });
    const cmd = cmds[0]!;
    expect(cmd[cmd.indexOf('--branch-strategy') + 1]).toBe('branch');
    expect(out.content[0]!.text).toContain('branchStrategy: branch (缺省)');
    rmSync(root, { recursive: true, force: true });
  });

  test("显式 'head' 压得过缺省, 且回执说清写落在主树", async () => {
    const root = tmpGitRepo();
    const { tool, cmds } = goalTool(root, { defaultBranchStrategy: 'branch' });
    const out = await call(tool, { goal: 'g', detached: true, branchStrategy: 'head' });
    const cmd = cmds[0]!;
    expect(cmd[cmd.indexOf('--branch-strategy') + 1]).toBe('head');
    expect(out.content[0]!.text).toContain('branchStrategy: head (显式)');
    rmSync(root, { recursive: true, force: true });
  });

  test('★ 续跑不套缺省 → 不转发 (worker 侧交回 prepareRunWorktree 按盘上有没有那棵树判)', async () => {
    const root = tmpGitRepo();
    const { tool, cmds } = goalTool(root, { defaultBranchStrategy: 'branch' });
    await call(tool, { goal: 'g', detached: true, resume: '99999999-2222-3333-4444-555555555555' });
    expect(cmds[0]!).not.toContain('--branch-strategy');
    rmSync(root, { recursive: true, force: true });
  });

  test('工厂层不注入 → 逐字节照旧 (无 --branch-strategy)', async () => {
    const root = tmpGitRepo();
    const { tool, cmds } = goalTool(root);
    await call(tool, { goal: 'g', detached: true });
    expect(cmds[0]!).not.toContain('--branch-strategy');
    rmSync(root, { recursive: true, force: true });
  });
});
