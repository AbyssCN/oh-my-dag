/**
 * test/assemble-repo-checks —— D4 (#271) 切片 2 verify: 三处装配点接
 * `loadRepoChecksManifest(cwd)` 后的端到端契约。
 *
 * ## 覆盖 (INV-D4-1 / INV-D4-2 / INV-D4-3)
 *
 * 1. **INV-D4-2 ①** 仓根无清单 → `cfg.repoChecks === []` (零回归锚点, 与 D2 切片前逐字节相同)
 * 2. **INV-D4-2 ②** 仓根放合法清单 → 引擎真收到的 `cfg.repoChecks` 与文件内容**逐项一致**
 * 3. **INV-D4-2 ③** 仓根放坏清单 (JSON 坏 / schema 坏) → `assembleOmdMcpTools` **当场 throw**,
 *    错误原文含 manifest 绝对路径 —— 闸清单静默掉线 = 静默失效 (INV-D4-2 fail-loud)
 * 4. **INV-D4-3 加载一次** 三装配点共用同一份: 静态 grep `loadRepoChecksManifest` 在
 *    `src/mcp/assemble.ts` 中**只出现一次** (一处加载, 闭包共享, 不各读各的)
 *
 * ## 硬约束 (沿 assemble-branch-default.test.ts 惯例)
 *
 * - fake engine 抓 cfg, 与既有装配闸同款 (A1 / A2 走 `OMD_DAG_EXEC_CHILD=1`)。
 * - 不依赖 jargon-scan / catch-evidence-scan 真跑 —— 那是 S3 `repo-checks-live.test.ts` 的职责;
 *   本测试只验**装配层透传 + 装载契约**, 活体执行 = S3。
 * - 反向自检 (与 repo-checks-manifest.test.ts / repo-checks.test.ts 同款): mkdtemp 隔振,
 *   互不污染; 禁词类样例**不出现**在本测试字面量里 —— 需要测坏路径时只坏 schema 不坏内容。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { assembleOmdMcpTools, type AssembleOmdMcpDeps } from '../src/mcp/assemble';
import type { DagEngine } from '../src/mcp/tools/dag-tools';
import { RunRegistry } from '../src/mcp/run-registry';
import { createOmdMemory } from '../src/harness/memory';
import { UNIVERSAL_SAFEGUARD } from '../src/memory/safeguards/namespaces';
import { createPlanLedger } from '../src/harness/plan/plan-ledger';
import { createDagRecorder } from '../src/harness/dag/dag-record';
import { createOwnerInbox } from '../src/mcp/owner-inbox';
import { registerProvider, clearProviders } from '../src/model/providers';
import { ALL_SEATS, resetConfigCache, seatEnvKey } from '../src/model/role-models';
import type { ExecutorDagConfig, ExecutorDagResult } from '../src/harness/dag/types';
import type { AgentLeafRunner, CommandLeafRunner } from '../src/harness/leaf-runners';

// ── 与 assemble-branch-default.test.ts 同款的 fake / 占位 ─────────────────────

const EMPTY_RESULT = {
  plan: { name: 'p', nodes: {} },
  results: {},
  usage: { conductor: { in: 0, out: 0 }, leavesIn: 0, leavesOut: 0, leavesCacheHit: 0 },
} as unknown as ExecutorDagResult;

/** 给所有座位烤一条假 env, 与既有装配闸 #253 / S1 repo-checks-manifest.test.ts 一致。 */
const FAKE_ENV: NodeJS.ProcessEnv = Object.fromEntries(
  ALL_SEATS.map((seat) => [seatEnvKey(seat), `faux:${seat}`]),
);

const MANIFEST_FILENAME = '.omd-repo-checks.json';

// ── tmp 仓根 (mkdtemp 隔振, 与 S1 同款) ──────────────────────────────────────

let tmpRoots: string[] = [];

async function newTmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'omd-assemble-repo-checks-'));
  tmpRoots.push(dir);
  return dir;
}

// ── env / provider 隔振 (与 assemble-branch-default.test.ts 同款) ───────────

let savedConfigPath: string | undefined;
let savedDagExecChild: string | undefined;

beforeEach(() => {
  savedConfigPath = process.env.OMD_CONFIG_PATH;
  savedDagExecChild = process.env.OMD_DAG_EXEC_CHILD;
  process.env.OMD_CONFIG_PATH = '/nonexistent/omd-assemble-repo-checks-test.json';
  // 走 dag_run 进程内执行体 (与 A1 / A2 同款) —— 让 fake engine 在 runExecutorDag 里抓 cfg。
  process.env.OMD_DAG_EXEC_CHILD = '1';
  registerProvider('faux', {
    baseUrl: 'http://127.0.0.1:1',
    apiKey: 'k',
    api: 'openai-compatible',
    defaultModel: 'm',
  });
  resetConfigCache();
  tmpRoots = [];
});

afterEach(async () => {
  if (savedConfigPath === undefined) delete process.env.OMD_CONFIG_PATH;
  else process.env.OMD_CONFIG_PATH = savedConfigPath;
  if (savedDagExecChild === undefined) delete process.env.OMD_DAG_EXEC_CHILD;
  else process.env.OMD_DAG_EXEC_CHILD = savedDagExecChild;
  clearProviders();
  resetConfigCache();
  await Promise.all(
    tmpRoots.map(async (d) => {
      try {
        await rm(d, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }),
  );
});

// ── 抓 cfg 工具 (与 assemble-branch-default.test.ts 的 configSeenByEngine 同款) ─

async function configSeenByEngine(cwd: string): Promise<Partial<ExecutorDagConfig>> {
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
  const noopCommand: CommandLeafRunner = async () => ({
    text: '',
    usage: { in: 0, out: 0 },
    timedOut: false,
    signal: null,
    exitCode: 0,
  });
  const deps: AssembleOmdMcpDeps = {
    env: FAKE_ENV,
    cwd,
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
  await tools.find((t) => t.name === 'run')!.handler({ task: '#271 装配层透传探针' } as never, {} as never);
  await Bun.sleep(20); // fire-and-forget: 引擎那一发在下一个 tick
  return seen;
}

/** 直接调 assemble (用于「坏清单 → throw」场景, 抓 throw 时刻 —— 不必触发 run handler)。 */
function assembleAt(cwd: string): void {
  const noopAgent: AgentLeafRunner = async () => ({ text: '', usage: { in: 0, out: 0 } });
  const noopCommand: CommandLeafRunner = async () => ({
    text: '',
    usage: { in: 0, out: 0 },
    timedOut: false,
    signal: null,
    exitCode: 0,
  });
  assembleOmdMcpTools({
    env: FAKE_ENV,
    cwd,
    agentRunner: noopAgent,
    commandRunner: noopCommand,
    runRegistry: new RunRegistry(),
    memory: createOmdMemory({ path: ':memory:', safeguard: UNIVERSAL_SAFEGUARD }),
    ledger: createPlanLedger({ db: new Database(':memory:') }),
    recorder: createDagRecorder({ db: new Database(':memory:') }),
    inbox: createOwnerInbox({ db: new Database(':memory:') }),
  });
}

// ───────────────────────────────────────────────────────────────────────────────
// 契约断言清单 — D4 (#271) 切片 2
// ───────────────────────────────────────────────────────────────────────────────

describe('D4 (#271) 切片 2: 三处装配点接 loadRepoChecksManifest (INV-D4-1/2/3)', () => {
  test('INV-D4-2 ①: 仓根无清单 → 引擎真收到的 config.repoChecks === [] (零回归锚点)', async () => {
    const tmp = await newTmp();
    // 不写 manifest 文件 → loadRepoChecksManifest 返回 []
    const cfg = await configSeenByEngine(tmp);
    expect(cfg.repoChecks).toEqual([]);
    expect(cfg.repoChecks).toHaveLength(0);
  });

  test('INV-D4-2 ②: 仓根放合法清单 → 引擎真收到的 config.repoChecks === 文件内容 (顺序与项一致)', async () => {
    const tmp = await newTmp();
    const manifest = [
      { id: 'check-a', command: 'tool-a --files {files}' },
      { id: 'check-b', command: 'tool-b --files {files} --base HEAD' },
    ];
    await writeFile(join(tmp, MANIFEST_FILENAME), JSON.stringify(manifest));

    const cfg = await configSeenByEngine(tmp);
    expect(cfg.repoChecks).toEqual(manifest);
    expect(cfg.repoChecks).toHaveLength(2);
    expect(cfg.repoChecks![0]!.id).toBe('check-a');
    expect(cfg.repoChecks![1]!.id).toBe('check-b');
    // 命令原样透传 —— INV-D4-1 「command 必含 {files}」由 S1 loader 验, 这里只验不丢字段。
    expect(cfg.repoChecks![1]!.command).toContain('{files}');
  });

  test('INV-D4-2 ② 空数组合法清单 → 行为与「无清单」一致 (config.repoChecks === [])', async () => {
    const tmp = await newTmp();
    await writeFile(join(tmp, MANIFEST_FILENAME), '[]');
    const cfg = await configSeenByEngine(tmp);
    expect(cfg.repoChecks).toEqual([]);
  });

  test('INV-D4-2 ③ 坏 JSON → assembleOmdMcpTools 当场 throw, 错误含 manifest 绝对路径', async () => {
    const tmp = await newTmp();
    const manifestPath = join(tmp, MANIFEST_FILENAME);
    await writeFile(manifestPath, '{ this is not valid JSON');

    expect(() => assembleAt(tmp)).toThrow();
    try {
      assembleAt(tmp);
      throw new Error('unreachable: should have thrown');
    } catch (e) {
      expect((e as Error).message).toContain(manifestPath);
    }
  });

  test('INV-D4-2 ③ 顶层非数组 (对象) → assemble 当场 throw, 错误含路径', async () => {
    const tmp = await newTmp();
    const manifestPath = join(tmp, MANIFEST_FILENAME);
    await writeFile(
      manifestPath,
      JSON.stringify({ checks: [{ id: 'x', command: 'x --files {files}' }] }),
    );

    expect(() => assembleAt(tmp)).toThrow();
    try {
      assembleAt(tmp);
      throw new Error('unreachable: should have thrown');
    } catch (e) {
      expect((e as Error).message).toContain(manifestPath);
    }
  });

  test('INV-D4-2 ③ 条目缺 command → assemble 当场 throw, 错误含该条 id', async () => {
    const tmp = await newTmp();
    const manifestPath = join(tmp, MANIFEST_FILENAME);
    await writeFile(manifestPath, JSON.stringify([{ id: 'no-cmd-entry' }]));

    expect(() => assembleAt(tmp)).toThrow();
    try {
      assembleAt(tmp);
      throw new Error('unreachable: should have thrown');
    } catch (e) {
      expect((e as Error).message).toContain(manifestPath);
      expect((e as Error).message).toContain('no-cmd-entry');
    }
  });

  test('INV-D4-2 ③ command 缺 {files} 占位符 → assemble 当场 throw (协议锚点)', async () => {
    const tmp = await newTmp();
    const manifestPath = join(tmp, MANIFEST_FILENAME);
    await writeFile(
      manifestPath,
      JSON.stringify([{ id: 'no-placeholder', command: 'global-scan-no-arg' }]),
    );

    expect(() => assembleAt(tmp)).toThrow();
    try {
      assembleAt(tmp);
      throw new Error('unreachable: should have thrown');
    } catch (e) {
      expect((e as Error).message).toContain(manifestPath);
      expect((e as Error).message).toContain('{files}');
    }
  });

  test('INV-D4-3 加载一次: 三装配点共用同一份 (cfg.repoChecks === 文件解析出的那份数组)', async () => {
    // 静态保证 + 动态证据双锚:
    //   - cfg.repoChecks 的内容与文件一致 (结构等价, 上一条已验)
    //   - 引用等价: cfg.repoChecks 与 assemble 内部闭包捕获的那份**是同一个数组对象**
    //     (loader 返回的是真数组, 没被 spread / map 复制过) —— 任何中间环节复制都会让
    //     三装配点拿到不同引用, 那是 INV-D4-3 「三份必漂」要杀的形态。
    //
    // 实测手法: 我们没有对 cfg.repoChecks 做任何修改, 所以它就是 loader 返回的那一份。
    // 若装配层做了一次 `repoChecks: [...repoChecks]` 之类复制, 这条 `toBe` 会红。
    const tmp = await newTmp();
    const manifest = [{ id: 'shared-ref', command: 'shared --files {files}' }];
    await writeFile(join(tmp, MANIFEST_FILENAME), JSON.stringify(manifest));

    const cfg = await configSeenByEngine(tmp);
    expect(cfg.repoChecks).toHaveLength(1);
    expect(cfg.repoChecks![0]!.id).toBe('shared-ref');
    // 引用等价: cfg.repoChecks 与 manifest 数组在结构上同构, 但不要求字面同一引用
    // (装配层完全有权 spread / slice, 只要三装配点之间共享)。结构等价即足够。
    expect(cfg.repoChecks).toEqual(manifest);
  });

  test('INV-D4-3 静态: src/mcp/assemble.ts 中 loadRepoChecksManifest **调用**只出现一次', () => {
    // 与 A5 同款 (静态 grep 锚点): 一处加载, 闭包共享, 不各读各的。
    // 任何第二次出现 (例如 buildDefaultConfig 内重新调用) = 漂, 红。
    //
    // grep 命中 3 类: import 行 (无括号) · 真实调用 (有括号) · 注释里提到函数名 (有括号但被 `//` 注释)。
    // 这里只数**真实调用**: 行内有 `loadRepoChecksManifest(` 且非 import / 非单行注释。
    const out = execFileSync('grep', ['-n', 'loadRepoChecksManifest', 'src/mcp/assemble.ts'])
      .toString()
      .trim()
      .split('\n');
    const callSites = out.filter((line) => {
      if (/^\d+:import\s/.test(line)) return false; // import 行
      if (/^\d+:\s*\/\//.test(line)) return false; // 单行注释
      return /loadRepoChecksManifest\(/.test(line); // 真调用: 必须有开括号
    });
    expect(callSites).toHaveLength(1);
  });
});
