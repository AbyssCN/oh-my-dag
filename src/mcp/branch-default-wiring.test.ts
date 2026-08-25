/**
 * **装配层真的把缺省翻过来了吗** (#253, 2026-08-25) —— 判据取**引擎真收到的 config**。
 *
 * 与 `tools/branch-default.test.ts` 分工: 那份钉工厂层 (注入了就用, 不注入零回归),
 * 这份钉**只有装配层才有的那一格** —— `assemble.ts` 到底注没注入。两层各测各的,
 * 因为这个形态的历史事故恰恰是「机制写好了但默认关着 / 只挂在一条路上」
 * (`rollback-anchor.ts` 头注量过一次: `git worktree list` 里一个 `omd/run/*` 都没有)。
 *
 * 判据不能是「装配层有没有那行代码」—— 那是 grep 不是闸。判据是引擎收到的 `continuity.repoRoot`:
 * 它指向隔离树, 才说明产物闸/写集/leaf runner 全部改锚到那棵树上了。
 *
 * 反向自检: 删掉 `assemble.ts` 里 `createDagTools({... defaultBranchStrategy })` 那一位 →
 * 第一条当场红 (repoRoot 落回主树)。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { assembleOmdMcpTools, type AssembleOmdMcpDeps } from './assemble';
import { RunRegistry } from './run-registry';
import { createOmdMemory } from '../harness/memory';
import { UNIVERSAL_SAFEGUARD } from '../memory/safeguards/namespaces';
import { createPlanLedger } from '../harness/plan/plan-ledger';
import { createDagRecorder } from '../harness/dag/dag-record';
import { createOwnerInbox } from './owner-inbox';
import { registerProvider, clearProviders } from '../model/providers';
import { ALL_SEATS, resetConfigCache, seatEnvKey } from '../model/role-models';
import type { DagEngine } from './tools/dag-tools';
import type { ExecutorDagConfig, ExecutorDagResult } from '../harness/dag/types';
import type { AgentLeafRunner, CommandLeafRunner } from '../harness/leaf-runners';

const EMPTY_RESULT = {
  plan: { name: 'p', nodes: {} },
  results: {},
  usage: { conductor: { in: 0, out: 0 }, leavesIn: 0, leavesOut: 0, leavesCacheHit: 0 },
} as unknown as ExecutorDagResult;

const FAKE_ENV: NodeJS.ProcessEnv = Object.fromEntries(ALL_SEATS.map((seat) => [seatEnvKey(seat), `faux:${seat}`]));

const git = (args: string[], cwd: string): void => {
  const r = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${new TextDecoder().decode(r.stderr)}`);
};

const tmpGitRepo = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'omd-bdw-'));
  git(['init', '-q'], root);
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-q', '-m', 'seed'], root);
  return root;
};

/** 装配一次并跑一发 dag_run (进程内执行体), 把引擎真收到的 config 抓出来。 */
async function configSeenByEngine(root: string, env: NodeJS.ProcessEnv): Promise<Partial<ExecutorDagConfig>> {
  let seen: Partial<ExecutorDagConfig> = {};
  const engine: DagEngine = {
    runExecutorDag: async (_task: string, cfg: Partial<ExecutorDagConfig>) => {
      seen = cfg;
      return EMPTY_RESULT;
    },
    runExecutorDagWithPlan: async (_plan: unknown, cfg: Partial<ExecutorDagConfig>) => {
      seen = cfg;
      return EMPTY_RESULT;
    },
  } as unknown as DagEngine;
  const noopAgent: AgentLeafRunner = async () => ({ text: '', usage: { in: 0, out: 0 } });
  const noopCommand: CommandLeafRunner = async () => ({ text: '', usage: { in: 0, out: 0 }, timedOut: false, signal: null, exitCode: 0 });
  const deps: AssembleOmdMcpDeps = {
    env,
    cwd: root,
    engine,
    runRegistry: new RunRegistry(),
    memory: createOmdMemory({ path: ':memory:', safeguard: UNIVERSAL_SAFEGUARD }),
    agentRunner: noopAgent,
    commandRunner: noopCommand,
    ledger: createPlanLedger({ db: new Database(':memory:') }),
    recorder: createDagRecorder({ db: new Database(':memory:') }),
    inbox: createOwnerInbox({ db: new Database(':memory:') }),
  };
  const tools = assembleOmdMcpTools(deps);
  await tools.find((t) => t.name === 'run')!.handler({ task: '#253 落点探针' } as never, {} as never);
  await Bun.sleep(20); // fire-and-forget: 引擎那一发在下一个 tick
  return seen;
}

let savedConfigPath: string | undefined;
beforeEach(() => {
  savedConfigPath = process.env.OMD_CONFIG_PATH;
  process.env.OMD_CONFIG_PATH = '/nonexistent/omd-branch-default-test.json';
  // 走 dag_run 的**进程内执行体** —— 母进程面 (spawn 转发) 由 tools/branch-default.test.ts 钉。
  process.env.OMD_DAG_EXEC_CHILD = '1';
  registerProvider('faux', { baseUrl: 'http://127.0.0.1:1', apiKey: 'k', api: 'openai-compatible', defaultModel: 'm' });
  resetConfigCache();
});
afterEach(() => {
  if (savedConfigPath === undefined) delete process.env.OMD_CONFIG_PATH;
  else process.env.OMD_CONFIG_PATH = savedConfigPath;
  delete process.env.OMD_DAG_EXEC_CHILD;
  clearProviders();
  resetConfigCache();
});

describe('#253 装配层缺省: 生产的 run 默认落隔离树', () => {
  test('★ 不传 branchStrategy → 产物根钉在 .omd/runs/<runId> (不是主工作树)', async () => {
    const root = tmpGitRepo();
    const cfg = await configSeenByEngine(root, { ...FAKE_ENV });
    expect(cfg.continuity!.repoRoot).toContain(join(root, '.omd', 'runs'));
    rmSync(root, { recursive: true, force: true });
  });

  test('OMD_RUN_BRANCH_DEFAULT=0 退回老默认 (head) —— 逃生阀是真的', async () => {
    const root = tmpGitRepo();
    const cfg = await configSeenByEngine(root, { ...FAKE_ENV, OMD_RUN_BRANCH_DEFAULT: '0' });
    expect(cfg.continuity!.repoRoot).toBe(root);
    rmSync(root, { recursive: true, force: true });
  });
});
