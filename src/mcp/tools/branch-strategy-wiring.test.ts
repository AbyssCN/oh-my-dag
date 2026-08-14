/**
 * dag_run/dag_run_plan 隔离档接线 (2026-08-14, owner 裁方案 A)。
 *
 * 背景: 2026-08-13 夜 plana 9 个 run 全在同一棵主树上并行 (dag_run 此前没有隔离参数),
 * 竞写零命中靠文件集恰好不相交。本闸把 dag_goal 已有的 branchStrategy 抬到 dag_run 面。
 *
 * 反向自检: 把 launchPlanRun 里 resolveRunWorktree/resolveDefaults(cwd) 那两行删掉 →
 * 第一条当场红 (thunk 收不到 worktree cwd = leaf runner 仍钉在主树, 隔离是假的 ——
 * goal.ts 2026-07-31 live 抓过同一形态)。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDagTools, type DagEngine } from './dag-tools';
import { RunRegistry } from '../run-registry';
import { CheckpointManager } from '../../harness/continuity/checkpoint-manager';
import type { ConductorPlan } from '../../harness/conductor-plan';
import type { ExecutorDagConfig, ExecutorDagResult } from '../../harness/dag/types';

const git = (args: string[], cwd: string): void => {
  const r = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${new TextDecoder().decode(r.stderr)}`);
};

/** 一个带一次 commit 的临时 git 仓 (worktree add 需要 HEAD)。 */
const tmpGitRepo = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'omd-bs-'));
  git(['init', '-q'], root);
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-q', '-m', 'seed'], root);
  return root;
};

const stubResult: ExecutorDagResult = {
  plan: { name: 'p', nodes: { root: { goal: 'g' } } } as unknown as ConductorPlan,
  sessionId: 's',
  levels: [['root']],
  results: { root: { id: 'root', status: 'done', kind: 'inproc', output: 'ok', deps: [], usage: { in: 1, out: 1 } } },
  reusedNodes: [],
  usage: { conductor: { in: 1, out: 1 }, leavesIn: 1, leavesOut: 1, leavesCacheHit: 0 },
} as unknown as ExecutorDagResult;

const PLAN = JSON.stringify({ name: 'p', nodes: { root: { goal: 'g', executor: 'leaf' } } });

function makeTools(root: string, seen: { cwds: (string | undefined)[]; configs: ExecutorDagConfig[] }) {
  const engine: DagEngine = {
    runExecutorDag: async (_t: string, config: ExecutorDagConfig) => {
      seen.configs.push(config);
      return stubResult;
    },
    runExecutorDagWithPlan: async (_p: ConductorPlan, config: ExecutorDagConfig) => {
      seen.configs.push(config);
      return stubResult;
    },
  };
  return createDagTools({
    engine,
    runRegistry: new RunRegistry(),
    defaultConfig: (cwd?: string) => {
      seen.cwds.push(cwd);
      return { conductorModel: 'c:m', leafModel: 'l:m' };
    },
    continuity: { manager: new CheckpointManager(root), repoRoot: root },
  });
}

describe('dag_run_plan branchStrategy (隔离档接线)', () => {
  test("★ 'branch' → thunk 收到 worktree cwd, continuity 钉到隔离树, 回执念出目录与分支", async () => {
    const root = tmpGitRepo();
    const seen = { cwds: [] as (string | undefined)[], configs: [] as ExecutorDagConfig[] };
    const tool = makeTools(root, seen).find((t) => t.name === 'dag_run_plan')!;
    const out = (await tool.handler({ plan: PLAN, branchStrategy: 'branch' } as never, {} as never)) as {
      content: { text: string }[];
    };
    await Bun.sleep(10);
    const text = out.content[0]!.text;
    expect(text).toContain('omd/run/'); // 分支名进回执 (拿不到把手 = 东西不见了)
    const wtDir = join(root, '.omd', 'runs');
    expect(seen.cwds[0]).toContain(wtDir); // leaf runner 重建在隔离树 (不是主树!)
    expect(seen.configs[0]!.continuity!.repoRoot).toContain(wtDir); // 产物根同树
    rmSync(root, { recursive: true, force: true });
  });

  test('缺省 (head) → thunk 收 undefined, 回执无 worktree 段, 零回归', async () => {
    const root = tmpGitRepo();
    const seen = { cwds: [] as (string | undefined)[], configs: [] as ExecutorDagConfig[] };
    const tool = makeTools(root, seen).find((t) => t.name === 'dag_run_plan')!;
    const out = (await tool.handler({ plan: PLAN } as never, {} as never)) as { content: { text: string }[] };
    await Bun.sleep(10);
    expect(seen.cwds[0]).toBeUndefined();
    expect(seen.configs[0]!.continuity!.repoRoot).toBe(root);
    expect(out.content[0]!.text).not.toContain('omd/run/');
    rmSync(root, { recursive: true, force: true });
  });

  test("非 git 目录 + 'branch' → 退回 head 且回执响亮说明 (静默退回 = 以为隔离了其实在写主树)", async () => {
    const root = mkdtempSync(join(tmpdir(), 'omd-bs-nogit-'));
    const seen = { cwds: [] as (string | undefined)[], configs: [] as ExecutorDagConfig[] };
    const tool = makeTools(root, seen).find((t) => t.name === 'dag_run_plan')!;
    const out = (await tool.handler({ plan: PLAN, branchStrategy: 'branch' } as never, {} as never)) as {
      content: { text: string }[];
    };
    await Bun.sleep(10);
    expect(seen.cwds[0]).toBeUndefined(); // 退回 head → 不用 worktree cwd
    expect(out.content[0]!.text).toContain('退回 head');
    rmSync(root, { recursive: true, force: true });
  });
});
