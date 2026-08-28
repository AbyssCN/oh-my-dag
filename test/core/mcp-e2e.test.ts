/**
 * test/core/mcp-e2e.test.ts — InMemoryTransport 双端 e2e (SDD omd-mcp-server §测试接缝, D-3/D-11)。
 *
 * assembleOmdMcpTools 全工具面 (deps 全注入 fake/内存, 零网络零磁盘):
 *   tools/list: v1 七工具全在, 每个 description 非空且 ≤120 字符 (D-11 一行制);
 *   坏参: schema 拒收 (dag_run task 非 string) / parsePlan 拒非法 plan / 未知 runId → isError, server 不崩;
 *   dag_run_plan 三段式生命周期 (D-3): run → status running → (fake engine resolve) → done → result 取产物。
 */
import { describe, expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createOmdMcpServer } from '../../src/mcp/server';
import { assembleOmdMcpTools, type AssembleOmdMcpDeps } from '../../src/mcp/assemble';
import { RunRegistry } from '../../src/mcp/run-registry';
import { createOmdMemory } from '../../src/harness/memory';
import { UNIVERSAL_SAFEGUARD } from '../../src/memory/safeguards/namespaces';
import type { DagEngine } from '../../src/mcp/tools/dag-tools';
import type { ExecutorDagResult } from '../../src/harness/dag/types';
import type { ConductorPlan } from '../../src/harness/conductor-plan';
import type { AgentLeafRunner, CommandLeafRunner } from '../../src/harness/leaf-runners';
import { Database } from 'bun:sqlite';
import { createPlanLedger } from '../../src/harness/plan/plan-ledger';
import { TOOL_RENAMES } from '../../src/mcp/tool-renames';

/** v1 工具面全清单 (SDD §工具面 P1 期)。 */
const ALL_TOOLS = [
  'dag_run',
  'dag_run_plan',
  'dag_resume',
  // D-P 协作式取消 (2026-07-30): 叫停在飞 run, 不杀在飞节点, 停完可 dag_resume 续。
  'dag_cancel',
  'dag_status',
  'dag_result',
  // S3 owner 收件箱 (2026-07-31): 无人值守的产出必须有去处 —— dag_triage 看, dag_rule 裁。
  'dag_triage',
  'dag_rule',
  // #160 发射片 (2026-08-17): 人工介入记录面 —— intervened 上板, 读数板算可避免性率。
  'dag_intervene',
  'dag_node_output',
  'dag_research',
  'memory_recall',
  'memory_fact', // recall 截断后的 L2 出口 (2026-08-28)
  'memory_remember',
  // pathfinder 七件套 (TUI-less 决策地图; path_init = SDD 2026-07-22 gh 后端接入向导)
  'path_map',
  'path_add',
  'path_tickets',
  'path_rule',
  'path_deliver',
  'path_prefetch',
  'path_init',
  // S-1 片b (2026-08-04): t7 后出生的新工具, 直接新词表名, 无 alias。
  'map_confirm',
  // fleet 增量 (SDD 2026-07-20: 车队四工具 + run 发现)
  'dag_review',
  'dag_slim',
  'dag_deepen',
  'dag_goal',
  'dag_debug',
  'dag_runs',
  // config 工具族 (omd init 的 MCP 面)
  'omd_set_key',
  'omd_apply_preset',
  'omd_set_role',
  'omd_shapes',
  'omd_models_auto',
  'omd_register_provider',
  'omd_set_model',
  'omd_config_status',
  'omd_distill',
  'omd_toggle_hud',
  // plan-memory 账本 (Phase A 证据门仪表)
  'omd_plans',
  'omd_primitive',
  // S1 对话位入口 (SDD 2026-08-09 远程指挥接缝): t7 后出生, 直接新词表名, 无 alias。
  'conductor_chat',
].sort();

/**
 * 真实注册面 = ALL_TOOLS 经 TOOL_RENAMES 变换 (t7, 2026-08-04): 表内工具挂新名
 * map_* · solve · run, 旧名留 deprecated alias —— 与 assemble 出口同一张表同一变换,
 * 这里**不手抄新名清单** (手抄就是第二真源, 必漂)。
 */
const REGISTERED_TOOLS = [
  ...new Set(ALL_TOOLS.flatMap((n) => (TOOL_RENAMES[n] ? [TOOL_RENAMES[n]!, n] : [n]))),
].sort();

/** Minimal valid ConductorPlan (同 mcp-dag-tools.test.ts 形状)。 */
const VALID_PLAN_JSON = JSON.stringify({
  name: 'e2e-plan',
  description: 'e2e three-phase lifecycle',
  nodes: {
    root: { goal: 'produce an artifact', executor: 'leaf' },
  },
});

/** Stub ExecutorDagResult: root done + filesTouched 产物。 */
function stubResult(): ExecutorDagResult {
  return {
    plan: { name: 'e2e-plan', nodes: {} } as unknown as ConductorPlan,
    sessionId: 'e2e-session',
    levels: [['root']],
    results: {
      root: {
        id: 'root',
        status: 'done',
        kind: 'inproc',
        output: 'ok',
        deps: [],
        usage: { in: 10, out: 5 },
        filesTouched: ['src/artifact.ts'],
      },
    },
    usage: { conductor: { in: 0, out: 0 }, leavesIn: 10, leavesOut: 5, leavesCacheHit: 0 },
  };
}

/** Fake engine with a manual gate: caller resolves to complete the run. */
function gatedEngine() {
  let release!: (r: ExecutorDagResult) => void;
  const gate = new Promise<ExecutorDagResult>((res) => {
    release = res;
  });
  const engine: DagEngine = {
    runExecutorDag: async () => gate,
    runExecutorDagWithPlan: async () => gate,
  };
  return { engine, release };
}

/** 双端接线: assemble (deps 全覆盖) → server ⇄ InMemoryTransport ⇄ client。 */
async function wire(overrides: Partial<AssembleOmdMcpDeps> = {}) {
  const { engine, release } = gatedEngine();
  const memory = createOmdMemory({ path: ':memory:', safeguard: UNIVERSAL_SAFEGUARD });
  const fakeAgentRunner: AgentLeafRunner = async () => ({ text: 'noop', usage: { in: 0, out: 0 }, timedOut: false, signal: null });
  const fakeCommandRunner: CommandLeafRunner = async () => ({
    text: 'noop',
    usage: { in: 0, out: 0 }, timedOut: false, signal: null,
    exitCode: 0,
  });
  const deps: AssembleOmdMcpDeps = {
    env: {
      OMD_ITER_LEAF_MODEL: 'test:leaf',
      OMD_ITER_CONDUCTOR_MODEL: 'test:conductor',
      // ⚠ #263 根因 (2026-08-25 实测): 本文件用 `cwd: process.cwd()` 装配 —— 那是**真仓根**
      //   (它要的是"生产装配收到什么", 不是临时目录)。#253 之后写型 run 默认落隔离 worktree,
      //   于是每跑一次这个文件就在本仓真建 1 棵 `omd/run/*` worktree + 1 个分支, 而测试全绿 ——
      //   污染只在 `git worktree list` 里看得见, 且**打脸本文件头那句「零网络零磁盘」**。
      //   实测: 单跑一次 +1, 修后 +0。与 seat-wiring.test.ts 同一条修法同一个理由。
      //   ⚠ 别改成传 `branchStrategy: 'head'` —— 那会让这里测的不再是"缺省路径"。
      OMD_RUN_BRANCH_DEFAULT: '0',
    },
    cwd: process.cwd(),
    engine,
    runRegistry: new RunRegistry(),
    memory,
    researchFanout: async () => ({ runId: 'r-x', reportPath: '/tmp/x.md', summary: 's' }),
    agentRunner: fakeAgentRunner,
    commandRunner: fakeCommandRunner,
    // plan-ledger 注入 :memory: — e2e 的 'e2e lifecycle' 任务不许污染真实 .omd/plan-ledger.db (证据门数据)。
    ledger: createPlanLedger({ db: new Database(':memory:') }),
    ...overrides,
  };
  const server = createOmdMcpServer(assembleOmdMcpTools(deps), { name: 'omd', version: 'test' });
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(ct), client.connect(st)]);
  return { client, release, memory };
}

/** 取 callTool 结果的首段文本 (测试便利)。 */
function textOf(res: unknown): string {
  const content = (res as { content: { type: string; text: string }[] }).content;
  return content[0]!.text;
}

describe('omd MCP e2e (InMemoryTransport 双端)', () => {
  test('tools/list: v1 全工具在, 每个 description 非空且 ≤120 字符 (D-11)', async () => {
    const { client, memory } = await wire();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...REGISTERED_TOOLS].sort());
    for (const t of tools) {
      expect(typeof t.description).toBe('string');
      expect(t.description!.length).toBeGreaterThan(0);
      expect(t.description!.length).toBeLessThanOrEqual(120);
    }
    await client.close();
    memory.close();
  });

  test('坏参拒收: schema 拒 / parsePlan 拒 / 未知 runId → MCP error, server 不崩', async () => {
    const { client, memory } = await wire();

    // ① schema 层拒 (task 非 string)。
    let rejected = false;
    try {
      const r = await client.callTool({ name: 'dag_run', arguments: { task: 123 } });
      rejected = r.isError === true;
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);

    // ② parsePlan 层拒 (合法 JSON 但非 ConductorPlan)。
    let planRejected = false;
    try {
      const r = await client.callTool({ name: 'dag_run_plan', arguments: { plan: '{"foo":1}' } });
      planRejected = r.isError === true;
    } catch {
      planRejected = true;
    }
    expect(planRejected).toBe(true);

    // ③ 未知 runId → isError (非 crash)。
    const st = await client.callTool({ name: 'dag_status', arguments: { runId: 'no-such-run' } });
    expect(st.isError).toBe(true);
    expect(textOf(st)).toContain('unknown run');

    // server 未崩: 注册面仍可枚举。
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(REGISTERED_TOOLS.length);
    await client.close();
    memory.close();
  });

  test('dag_run_plan 三段式: run → status running → done → result 取产物 (D-3)', async () => {
    const { client, release, memory } = await wire();

    // ① run: 立即回 runId + running (fire-and-forget, 不等引擎)。
    const runRes = await client.callTool({
      name: 'dag_run_plan',
      arguments: { plan: VALID_PLAN_JSON, task: 'e2e lifecycle' },
    });
    expect(runRes.isError).toBeFalsy();
    const runText = textOf(runRes);
    const runId = /runId: (\S+)/.exec(runText)?.[1];
    expect(runId).toBeTruthy();
    expect(runText).toContain('status: running');

    // ② status: running (engine gate 未放); result: 非 done → isError。
    const st1 = await client.callTool({ name: 'dag_status', arguments: { runId: runId! } });
    expect(st1.isError).toBeFalsy();
    expect(textOf(st1)).toContain('status: running');
    const r0 = await client.callTool({ name: 'dag_result', arguments: { runId: runId! } });
    expect(r0.isError).toBe(true);

    // engine 完成 → 注册表转 done (fire-and-forget .then 落表, flush 微任务后可见)。
    release(stubResult());
    await new Promise((r) => setImmediate(r));

    // ③ status: done; result: 产物摘要 (artifactPaths 含 filesTouched)。
    const st2 = await client.callTool({ name: 'dag_status', arguments: { runId: runId! } });
    expect(textOf(st2)).toContain('status: done');
    const r1 = await client.callTool({ name: 'dag_result', arguments: { runId: runId! } });
    expect(r1.isError).toBeFalsy();
    const result = JSON.parse(textOf(r1)) as { sessionId: string; done: number; artifactPaths?: string[] };
    expect(result.sessionId).toBe('e2e-session');
    expect(result.done).toBe(1);
    expect(result.artifactPaths).toContain('src/artifact.ts');

    await client.close();
    memory.close();
  });
});
