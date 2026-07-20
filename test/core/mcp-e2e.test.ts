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
import type { ExecutorDagResult } from '../../src/harness/executor-dag-types';
import type { ConductorPlan } from '../../src/harness/conductor-plan';
import type { AgentLeafRunner, CommandLeafRunner } from '../../src/harness/leaf-runners';

/** v1 工具面全清单 (SDD §工具面 P1 期)。 */
const ALL_TOOLS = [
  'dag_run',
  'dag_run_plan',
  'dag_status',
  'dag_result',
  'dag_node_output',
  'dag_research',
  'memory_recall',
  'memory_remember',
  // pathfinder 六件套 (TUI-less 决策地图)
  'path_map',
  'path_add',
  'path_tickets',
  'path_rule',
  'path_deliver',
  'path_prefetch',
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
  const fakeAgentRunner: AgentLeafRunner = async () => ({ text: 'noop', usage: { in: 0, out: 0 } });
  const fakeCommandRunner: CommandLeafRunner = async () => ({
    text: 'noop',
    usage: { in: 0, out: 0 },
    exitCode: 0,
  });
  const deps: AssembleOmdMcpDeps = {
    env: { OMD_ITER_LEAF_MODEL: 'test:leaf', OMD_ITER_CONDUCTOR_MODEL: 'test:conductor' },
    cwd: process.cwd(),
    engine,
    runRegistry: new RunRegistry(),
    memory,
    researchFanout: async () => ({ runId: 'r-x', reportPath: '/tmp/x.md', summary: 's' }),
    agentRunner: fakeAgentRunner,
    commandRunner: fakeCommandRunner,
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
  test('tools/list: v1 七工具全在, 每个 description 非空且 ≤120 字符 (D-11)', async () => {
    const { client, memory } = await wire();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...ALL_TOOLS].sort());
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
    expect(tools).toHaveLength(ALL_TOOLS.length);
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
