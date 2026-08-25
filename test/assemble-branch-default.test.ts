/**
 * **#253-CRYSTAL v1 契约断言清单** (2026-08-25) —— owner 冻结文本 5 条, 本文件一条不少。
 *
 * 逐条对应 (disc R6, 写前已核验):
 *   A1 (映 O-2 「assemble.ts MCP 真实入口对有写意图的 run 默认 branch」):
 *       装配层不读 OMD_RUN_BRANCH_DEFAULT → run 工具 handler 把 cfg 推进引擎 →
 *       引擎真收到的 continuity.repoRoot 指向 <root>/.omd/runs (隔离 worktree)。
 *   A2 (映 O-3 「OMD_RUN_BRANCH_DEFAULT=0 翻回 head 逃生阀」):
 *       同 A1 但 env.OMD_RUN_BRANCH_DEFAULT='0' → continuity.repoRoot === root (主工作树)。
 *   A3 (映 O-3 「显式 head opt-in 被尊重」):
 *       工厂层 createDagTools(..., defaultBranchStrategy='branch') + 调用方传 branchStrategy:'head'
 *       → 引擎真收到的 spec.args.branchStrategy === 'head' (显式压过入口默认)。
 *   A4 (映 O-1 「引擎层 branchStrategy 缺省不动 (零回归)」):
 *       工厂层 createDagTools(deps) 完全省略 defaultBranchStrategy → spec.args.branchStrategy
 *       缺席 (=== undefined) → 透到 run-worktree.ts:289 引擎层缺省 'head', O-1 锚点零字符改动。
 *   A5 (映 O-2 「写意图工具 = createDagTools + createGoalTool (其余无)」):
 *       静态: src/mcp/assemble.ts 中 defaultBranchStrategy 的注入点恰好 2 处 (变量定义在 :735,
 *       注入位 :741 createDagTools · :768 createGoalTool), 无第三处。无新写意图工具被发现。
 *
 * ## 硬约束 (契约 §6 · 本节点只读不写)
 *
 * - 只调契约 §6 列出的真实导出: assembleOmdMcpTools · AssembleOmdMcpDeps ·
 *   createDagTools · DagToolDeps · BranchStrategy (from run-worktree.ts) · DagEngine 等。
 * - 断言对象 = 引擎真收到的 cfg / spec.args / repoRoot 等落地副作用; 禁止 mock 掉被测规则、
 *   禁止把规则抄一遍再和自己比较 (恒真式)。A1/A2 用 fake engine 抓 cfg (与既有装配闸同款);
 *   A3/A4 用 fake spawnDagExec 抓 spec.args (与既有工厂闸同款); A5 直接读源文件静态数。
 * - 不动 src/ 下任何文件; 不修改既有测试 (branch-default-wiring / branch-default 等逐字不变)。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Database } from 'bun:sqlite';
import { assembleOmdMcpTools, type AssembleOmdMcpDeps } from '../src/mcp/assemble';
import { createDagTools, type DagEngine, type DagToolDeps, type SpawnDagExecFn } from '../src/mcp/tools/dag-tools';
import { RunRegistry } from '../src/mcp/run-registry';
import { createOmdMemory } from '../src/harness/memory';
import { UNIVERSAL_SAFEGUARD } from '../src/memory/safeguards/namespaces';
import { createPlanLedger } from '../src/harness/plan/plan-ledger';
import { createDagRecorder } from '../src/harness/dag/dag-record';
import { createOwnerInbox } from '../src/mcp/owner-inbox';
import { registerProvider, clearProviders } from '../src/model/providers';
import { ALL_SEATS, resetConfigCache, seatEnvKey } from '../src/model/role-models';
import { CheckpointManager } from '../src/harness/continuity/checkpoint-manager';
import type { ExecutorDagConfig, ExecutorDagResult } from '../src/harness/dag/types';
import type { AgentLeafRunner, CommandLeafRunner } from '../src/harness/leaf-runners';

// ── 与既有 branch-default-wiring.test.ts 同款的 fake / 占位 ─────────────────────

const EMPTY_RESULT = {
  plan: { name: 'p', nodes: {} },
  results: {},
  usage: { conductor: { in: 0, out: 0 }, leavesIn: 0, leavesOut: 0, leavesCacheHit: 0 },
} as unknown as ExecutorDagResult;

/** 给所有座位烤一条假 env, 与既有装配闸 #253 一致 —— 避免角色矩阵解析空 env 抛错。 */
const FAKE_ENV: NodeJS.ProcessEnv = Object.fromEntries(ALL_SEATS.map((seat) => [seatEnvKey(seat), `faux:${seat}`]));

const git = (args: string[], cwd: string): void => {
  const r = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${new TextDecoder().decode(r.stderr)}`);
};

/** `worktree add` 要有 HEAD —— 一枚 empty commit 当种子。 */
const tmpGitRepo = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'omd-crystal-'));
  git(['init', '-q'], root);
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-q', '-m', 'seed'], root);
  return root;
};

/** 装配一次 + 触发 run 工具 handler (进程内执行体) + 抓引擎真收到的 cfg (与既有装配闸同款)。 */
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
  // 三层改名后: dag_run 挂新名 'run', 旧名作为 deprecated alias 同 handler。
  await tools.find((t) => t.name === 'run')!.handler({ task: '#253 契约落点探针' } as never, {} as never);
  await Bun.sleep(20); // fire-and-forget: 引擎那一发在下一个 tick
  return seen;
}

/** 工厂层 fake —— 用 spawnDagExec 抓 spec.args (与既有工厂闸同款)。 */
function dagToolsWithSpy(root: string, overrides: Partial<DagToolDeps> = {}) {
  const specs: Record<string, unknown>[] = [];
  const engine: DagEngine = {
    runExecutorDag: async () => EMPTY_RESULT,
    runExecutorDagWithPlan: async () => EMPTY_RESULT,
  };
  const baseDeps: DagToolDeps = {
    engine,
    runRegistry: new RunRegistry(),
    defaultConfig: () => ({ conductorModel: 'c:m', leafModel: 'l:m' }),
    continuity: { manager: new CheckpointManager(root), repoRoot: root },
    spawnDagExec: ((spec) => {
      specs.push(spec.args as Record<string, unknown>);
      return { ok: true, pid: 4242, logPath: join(root, 'x.log') };
    }) as SpawnDagExecFn,
  };
  // 关键: 故意用对象 spread + 条件键 —— 「完全省略 defaultBranchStrategy」 vs 「注入 branch」
  // 必须分得开, 否则 A3 / A4 的语义被自己稀释掉。
  const finalDeps: DagToolDeps = { ...baseDeps, ...overrides };
  const tools = createDagTools(finalDeps);
  return { tools, specs };
}

const call = (tool: { handler: (a: never, b: never) => unknown }, args: Record<string, unknown>) =>
  tool.handler(args as never, {} as never) as Promise<{ content: { text: string }[]; isError?: boolean }>;

// ── before/after: 与既有装配闸 / 工厂闸同款的 env / provider 隔振 ────────────────

// A1/A2 走 dag_run **进程内执行体** (env: OMD_DAG_EXEC_CHILD=1), 与既有装配闸同款 ——
// 引擎替身在 runExecutorDag 里抓 cfg。A3/A4 反过来: 不能开这旗标, 否则母进程 spawn 那一侧
// 被子进程拦下, spawnDagExec 替身接不到, spec.args 抓空。两种路径靠 env 旗标分叉, 不互斥。
let savedConfigPath: string | undefined;
let savedDagExecChild: string | undefined;
beforeEach(() => {
  savedConfigPath = process.env.OMD_CONFIG_PATH;
  savedDagExecChild = process.env.OMD_DAG_EXEC_CHILD;
  process.env.OMD_CONFIG_PATH = '/nonexistent/omd-crystal-test.json';
  process.env.OMD_DAG_EXEC_CHILD = '1';
  registerProvider('faux', { baseUrl: 'http://127.0.0.1:1', apiKey: 'k', api: 'openai-compatible', defaultModel: 'm' });
  resetConfigCache();
});
afterEach(() => {
  if (savedConfigPath === undefined) delete process.env.OMD_CONFIG_PATH;
  else process.env.OMD_CONFIG_PATH = savedConfigPath;
  if (savedDagExecChild === undefined) delete process.env.OMD_DAG_EXEC_CHILD;
  else process.env.OMD_DAG_EXEC_CHILD = savedDagExecChild;
  clearProviders();
  resetConfigCache();
});

/** A3/A4 用 —— 关 OMD_DAG_EXEC_CHILD, 让母进程真的去 spawn, spawnDagExec 替身才接得到。 */
async function callFactory(root: string, overrides: Partial<DagToolDeps>, args: Record<string, unknown>) {
  const saved = process.env.OMD_DAG_EXEC_CHILD;
  delete process.env.OMD_DAG_EXEC_CHILD;
  try {
    const { tools, specs } = dagToolsWithSpy(root, overrides);
    await call(tools.find((t) => t.name === 'dag_run')!, args);
    return specs;
  } finally {
    if (saved !== undefined) process.env.OMD_DAG_EXEC_CHILD = saved;
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// 契约断言清单 A1..A5
// ───────────────────────────────────────────────────────────────────────────────

describe('#253-CRYSTAL v1: 装配层 branchStrategy 缺省契约 (A1..A5)', () => {
  test('A1 — 入口默认 = branch (写意图) → 引擎真收到的 continuity.repoRoot 指向 .omd/runs', async () => {
    const root = tmpGitRepo();
    // 不传 OMD_RUN_BRANCH_DEFAULT, 也不传 branchStrategy —— 入口层缺省应顶到最远端。
    const cfg = await configSeenByEngine(root, { ...FAKE_ENV });
    expect(cfg.continuity!.repoRoot).toContain(join(root, '.omd', 'runs'));
    // 同时钉死: 没显式 = 透到入口层 (即落入 prepareRunWorktree 时 strategy='branch')。
    expect(cfg.continuity!.repoRoot).not.toBe(root);
    rmSync(root, { recursive: true, force: true });
  });

  test('A2 — OMD_RUN_BRANCH_DEFAULT=0 → 翻回 head, 引擎真收到的 continuity.repoRoot === 主工作树', async () => {
    const root = tmpGitRepo();
    const cfg = await configSeenByEngine(root, { ...FAKE_ENV, OMD_RUN_BRANCH_DEFAULT: '0' });
    expect(cfg.continuity!.repoRoot).toBe(root);
    rmSync(root, { recursive: true, force: true });
  });

  test("A3 — 显式 'head' 压得过入口层注入的 'branch' (opt-in 那一侧真的还在)", async () => {
    const root = tmpGitRepo();
    // 入口层注入 'branch' —— 这是契约说「写型 run 默认 branch」的那条路 (装配层真源)。
    // 调用方传 'head' → 必须压过入口默认, 这是逃生阀的对偶形态。
    const specs = await callFactory(root, { defaultBranchStrategy: 'branch' }, { task: 't', branchStrategy: 'head' });
    expect(specs[0]!.branchStrategy).toBe('head');
    rmSync(root, { recursive: true, force: true });
  });

  test('A4 — 工厂层不注入 defaultBranchStrategy → spec.args.branchStrategy 缺席 (= 引擎层 head 缺省, O-1 零回归)', async () => {
    const root = tmpGitRepo();
    // 故意不带 defaultBranchStrategy 这个键 —— 「完全省略」而非「显式 undefined」。
    const specs = await callFactory(root, {}, { task: 't' });
    // 关键断言: branchStrategy 字段缺席 = 透到 run-worktree.ts:289 的 'head' 缺省。
    // 这是 O-1 「引擎层缺省不动」**正面的**观察: 工厂层不注入时, 引擎拿不到这个字段,
    // 因此走自己的 'head' 缺省, run-worktree.ts:289 零字符改动仍生效。
    expect(specs[0]!.branchStrategy).toBeUndefined();
    expect('branchStrategy' in specs[0]!).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  test('A5 — 写意图工具恰为 createDagTools + createGoalTool 两个, 无第三处注入 defaultBranchStrategy', () => {
    // 静态读源: src/mcp/assemble.ts 中 defaultBranchStrategy 变量定义 + 注入位分布。
    // 行 735 = `const defaultBranchStrategy: BranchStrategy = ...` (变量定义/赋值);
    // 行 741 = createDagTools({ ..., defaultBranchStrategy }) (注入位 #1);
    // 行 768 = createGoalTool({ ..., defaultBranchStrategy }) (注入位 #2)。(D2 #266 assemble +10 行后重钉)
    // 契约锚点: O-2 说「写意图工具 = createDagTools + createGoalTool」—— 任何第三处注入都是契约漂移。
    const out = execFileSync('grep', ['-n', 'defaultBranchStrategy', 'src/mcp/assemble.ts']).toString().trim().split('\n');
    expect(out.length).toBe(3); // 定义 + 注入×2, 与事实表 (d) 一致
    // 抽出注入位 (非变量定义的那行), 必须恰好是 :741 (createDagTools) 与 :768 (createGoalTool)。
    const injectionSites = out.filter((line) => !/^735:.*const defaultBranchStrategy:/.test(line));
    expect(injectionSites.length).toBe(2);
    expect(injectionSites.some((line) => line.startsWith('741:'))).toBe(true);
    expect(injectionSites.some((line) => line.startsWith('768:'))).toBe(true);
    // 反向 (negative): 研究 / 记忆 / pathfinder / fleet 这一组非写意图工具**未**被注入。
    // 装配层相关函数声明扫描: 它们都不该出现 defaultBranchStrategy。
    const allTools = execFileSync('grep', ['-n', 'createDagResearchTool\\|createMemoryTools\\|createPathfinderTools\\|createFleetTools\\|createTriageTools\\|createInterveneTools\\|createConfigTools\\|createDistillTools', 'src/mcp/assemble.ts'])
      .toString()
      .trim()
      .split('\n');
    for (const line of allTools) {
      expect(line).not.toContain('defaultBranchStrategy');
    }
  });
});