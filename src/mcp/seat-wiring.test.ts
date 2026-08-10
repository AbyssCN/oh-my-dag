/**
 * **座位真的接到引擎上了吗** —— 判据取引擎**真收到的 config** (2026-08-01)。
 *
 * ## 为什么要专门为这件事立一条闸
 *
 * 一个座位可以同时是"解析得出来的"和"没接上的", 而现有的闸全都只管前一半:
 *   · 座位自检 16/16 ✓ —— 它问的是"座位解析得出来吗"。verifier 座位确实被解析了 (被借去组
 *     `stampPools.strong` 那个池)。**坐标被人用 ≠ 它代表的机制在跑。**
 *   · `empty-knobs` 的「座位即承诺」 —— 同上, 只要求座位被解析过。
 *   · tsc —— 这些都是**可选**字段, 不给就是不给。
 *
 * 这个形态本轮抓到两例, 都在 MCP 这条路上、都活了很久:
 *   ① **verifier**: `executor-dag` 那段跨模型校验 + conductor 静默升级写着「config.verifier
 *      给则启用」, 而装配层从来没给过 —— 它只挂在 `tui.ts`。证据不用推理:
 *      `tools/dag-tools.ts` 里「MCP 路径无 verifier」那行注释, 就是当年照着这个事实
 *      改下游 ok 判据时留下的。
 *   ② **judge**: 引擎落回 `config.judgeModel ?? config.conductorModel`, 而两条路都不给
 *      judgeModel —— 于是「判这一轮收敛没有」的那一发一直骑在 **conductor 座位**上,
 *      改 judge 座位不生效, 而配置面明明写着有这个座位。
 *
 * 两例的共同点: **没有任何红灯**, 而且症状会伪装成别的东西 (①"任务好像没人管"
 * ②"改了配置没反应")。所以判据必须是"引擎收到了什么", 不能是"装配层有没有那行代码"。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { assembleOmdMcpTools, type AssembleOmdMcpDeps } from './assemble';
import { RunRegistry } from './run-registry';
import { createOmdMemory } from '../harness/memory';
import { UNIVERSAL_SAFEGUARD } from '../memory/safeguards/namespaces';
import { createPlanLedger } from '../harness/plan-ledger';
import { createDagRecorder } from '../harness/dag-record';
import { createOwnerInbox } from './owner-inbox';
import { registerProvider, clearProviders } from '../model/providers';
import { ALL_SEATS, resetConfigCache, seatEnvKey } from '../model/role-models';
import type { DagEngine } from './tools/dag-tools';
import type { ExecutorDagConfig } from '../harness/dag/types';
import type { ExecutorDagResult } from '../harness/dag/types';
import type { AgentLeafRunner, CommandLeafRunner } from '../harness/leaf-runners';
import { Database } from 'bun:sqlite';

const EMPTY_RESULT: ExecutorDagResult = {
  plan: { name: 'p', nodes: {} },
  results: {},
  usage: { conductor: { in: 0, out: 0 }, leavesIn: 0, leavesOut: 0, leavesCacheHit: 0 },
} as ExecutorDagResult;

/** 装配一次, 把引擎真收到的 config 抓出来。 */
async function configSeenByEngine(env: NodeJS.ProcessEnv): Promise<Partial<ExecutorDagConfig>> {
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
  const noopCommand: CommandLeafRunner = async () => ({ text: '', usage: { in: 0, out: 0 }, exitCode: 0 });
  const deps: AssembleOmdMcpDeps = {
    env,
    cwd: process.cwd(),
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
  const dagRun = tools.find((t) => t.name === 'dag_run')!;
  await dagRun.handler({ task: 'verify-wiring probe' } as never, {} as never);
  return seen;
}

/**
 * **全部 16 座**都钉到一个本地注册的假 provider 上 —— 不碰这台机器的 `.omd/config.json`, 不打网络。
 *
 * 为什么必须给全: 装配期会解析所有座位去组 stamp 池 (strong/mid/cheap), 少一个就在那里响亮失败
 * (`座位 'judge' 未配模型`) —— 而那时引擎根本没被调用, 于是断言收到的是一片 undefined,
 * 看起来像"verifier 没接上", 实际是压根没跑到。第一版就踩了这个, 记在这里。
 * 用 `seatEnvKey(座位)` 生成而不是手抄一张表: 加座位时这里自动跟上。
 */
const FAKE_ENV: NodeJS.ProcessEnv = Object.fromEntries(
  ALL_SEATS.map((seat) => [seatEnvKey(seat), `faux:${seat}`]),
);

function withFakeProvider(): void {
  registerProvider('faux', { baseUrl: 'http://127.0.0.1:1', apiKey: 'k', api: 'openai-compatible', defaultModel: 'm' });
  resetConfigCache();
}

/**
 * ⚠ 文件层的隔离必须动**进程级** env: `configPath()` 读的是 `process.env.OMD_CONFIG_PATH`,
 * 不是注入进 assemble 的那份 env。第一版只设了注入的那份, 于是测试读到了**这台机器真实的**
 * `.omd/config.json` —— 断言"escalation = faux:escalation"收到的是 `openai-codex:gpt-5.6-sol`。
 * 那种测试在别人机器上会以另一种方式绿或红, 等于没测。
 */
let savedConfigPath: string | undefined;
beforeEach(() => {
  savedConfigPath = process.env.OMD_CONFIG_PATH;
  process.env.OMD_CONFIG_PATH = '/nonexistent/omd-verifier-wired-test.json';
  // S2 进程化 (SDD 2026-08-10): configSeenByEngine 走 dag_run 的**进程内执行体** (子进程路径见 dag-exec.ts)。
  process.env.OMD_DAG_EXEC_CHILD = '1';
  resetConfigCache();
});
afterEach(() => {
  if (savedConfigPath === undefined) delete process.env.OMD_CONFIG_PATH;
  else process.env.OMD_CONFIG_PATH = savedConfigPath;
  delete process.env.OMD_DAG_EXEC_CHILD;
  clearProviders();
  resetConfigCache();
});

describe('verify 闸挂在 MCP 装配上', () => {
  test('★ dag_run 的 config 带 verifier —— 引擎那段「config.verifier 给则启用」不再永远走不到', async () => {
    withFakeProvider();
    const cfg = await configSeenByEngine({ ...FAKE_ENV });
    expect(typeof cfg.verifier).toBe('function');
  });

  test('★ escalation 座位跟着一起上场 (verifier 判不过才有得升级)', async () => {
    withFakeProvider();
    const cfg = await configSeenByEngine({ ...FAKE_ENV });
    expect(cfg.conductorEscalationModel).toBe('faux:escalation');
  });

  test('OMD_VERIFY=0 关得掉 (与 TUI 同一个旋钮, 不新造一个)', async () => {
    withFakeProvider();
    const cfg = await configSeenByEngine({ ...FAKE_ENV, OMD_VERIFY: '0' });
    expect(cfg.verifier).toBeUndefined();
  });

  test('调用方显式传的 verifier 压得过装配默认 (测试注入假 verifier 靠这条)', async () => {
    withFakeProvider();
    let seen: Partial<ExecutorDagConfig> = {};
    const engine = {
      runExecutorDag: async (_t: string, cfg: Partial<ExecutorDagConfig>) => { seen = cfg; return EMPTY_RESULT; },
      runExecutorDagWithPlan: async (_p: unknown, cfg: Partial<ExecutorDagConfig>) => { seen = cfg; return EMPTY_RESULT; },
    } as unknown as DagEngine;
    const mine = async (): Promise<{ pass: boolean; reason: string; usage: { in: number; out: number } }> => ({
      pass: true, reason: 'mine', usage: { in: 0, out: 0 },
    });
    const tools = assembleOmdMcpTools({
      env: { ...FAKE_ENV },
      cwd: process.cwd(),
      engine,
      runRegistry: new RunRegistry(),
      memory: createOmdMemory({ path: ':memory:', safeguard: UNIVERSAL_SAFEGUARD }),
      agentRunner: async () => ({ text: '', usage: { in: 0, out: 0 } }),
      commandRunner: async () => ({ text: '', usage: { in: 0, out: 0 }, exitCode: 0 }),
      ledger: createPlanLedger({ db: new Database(':memory:') }),
      recorder: createDagRecorder({ db: new Database(':memory:') }),
      inbox: createOwnerInbox({ db: new Database(':memory:') }),
      configOverrides: { verifier: mine as never },
    });
    await tools.find((t) => t.name === 'dag_run')!.handler({ task: 'override probe' } as never, {} as never);
    expect(seen.verifier).toBe(mine as never);
  });
});

describe('内环收敛闸的座位', () => {
  test('★ dag_run 的 config 带 judgeModel = **gate** 座 (不是 judge 座, 更不是默默骑 conductor)', async () => {
    withFakeProvider();
    const cfg = await configSeenByEngine({ ...FAKE_ENV });
    expect(cfg.judgeModel).toBe('faux:gate');
    // 三个座位在同一次装配里必须真的分得开 —— 否则"恰好同模型"时这条断言会假绿。
    // 这三者是三个不同角色: 分解 / 择优 / 闸 (见 model/seats.ts)。
    expect(cfg.conductorModel).toBe('faux:conductor');
    expect(cfg.judgeModel).not.toBe('faux:judge');
  });
});
