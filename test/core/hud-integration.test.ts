/**
 * test/core/hud-integration.test.ts — omd-hud 写链路端到端 (真工具工厂 + 真 HudMirror + 假引擎)。
 *
 * 证: createDagTools 的 onNodeEvent 接缝 → hudMirror.write → 磁盘 dag.json, 且 levels 由 topoLevels 出。
 * 假引擎同步发 planned/start/settle 事件 (模拟真引擎), 无需 model/网络 → 确定性 dogfood。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunRegistry } from '../../src/mcp/run-registry';
import { createDagTools, type DagEngine } from '../../src/mcp/tools/dag-tools';
import { HudMirror } from '../../src/hud/mirror';
import type { ExecutorDagConfig, ExecutorDagResult } from '../../src/harness/executor-dag-types';
import type { ConductorPlan } from '../../src/harness/conductor-plan';
import { readDagView } from '../../src/hud/load';
import type { HudDagSnapshot } from '../../src/hud/types';
import type { OmdMcpTool } from '../../src/mcp/server';

/** 调工具 handler (MCP ToolCallback 需 extra 第二参; 测试传 {})。 */
const call = (t: OmdMcpTool, args: Record<string, unknown>) =>
  (t.handler as (a: Record<string, unknown>, extra?: unknown) => Promise<unknown>)(args, {});

const PLAN_JSON = JSON.stringify({
  name: 'hud-e2e',
  description: 'two-node plan',
  nodes: {
    root: { goal: 'first', executor: 'leaf' },
    leaf2: { goal: 'second', executor: 'agent', depends_on: ['root'] },
  },
});

function stubResult(): ExecutorDagResult {
  return {
    plan: { name: 'hud-e2e', nodes: {} } as unknown as ConductorPlan,
    sessionId: 's1',
    levels: [['root'], ['leaf2']],
    results: {
      root: { id: 'root', status: 'done', kind: 'inproc', output: 'ok', deps: [], usage: { in: 1, out: 1 } },
      leaf2: { id: 'leaf2', status: 'done', kind: 'agent', output: 'ok', deps: ['root'], usage: { in: 1, out: 1 } },
    },
    usage: { conductor: { in: 0, out: 0 }, leavesIn: 2, leavesOut: 2, leavesCacheHit: 0 },
  };
}

/** 假引擎: 同步发引擎三事件 (planned → start/settle root → start/settle leaf2) 再 resolve。 */
function emittingEngine(): DagEngine {
  const emit = (config: ExecutorDagConfig) => {
    config.onNodeEvent?.({ type: 'planned', nodes: [{ id: 'root', kind: 'leaf' }, { id: 'leaf2', kind: 'agent' }] });
    config.onNodeEvent?.({ type: 'start', id: 'root', kind: 'leaf' });
    config.onNodeEvent?.({ type: 'settle', id: 'root', status: 'done', kind: 'leaf', model: 'k3' });
    config.onNodeEvent?.({ type: 'start', id: 'leaf2', kind: 'agent' });
    config.onNodeEvent?.({ type: 'settle', id: 'leaf2', status: 'done', kind: 'agent', model: 'k3' });
  };
  return {
    runExecutorDag: async (_task, config) => { emit(config); return stubResult(); },
    runExecutorDagWithPlan: async (_plan, config) => { emit(config); return stubResult(); },
  };
}

describe('omd-hud 写链路 E2E', () => {
  let cwd: string;
  let savedHome: string | undefined;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'hud-e2e-'));
    savedHome = process.env.OMD_DATA_HOME;
    delete process.env.OMD_DATA_HOME;
  });
  afterEach(() => {
    if (savedHome === undefined) delete process.env.OMD_DATA_HOME;
    else process.env.OMD_DATA_HOME = savedHome;
    rmSync(cwd, { recursive: true, force: true });
  });

  test('dag_run_plan → dag.json 落盘 (终态 done, 2 节点 settled, levels 由 topo 出)', async () => {
    const reg = new RunRegistry();
    const tools = createDagTools({
      engine: emittingEngine(),
      runRegistry: reg,
      cwd,
      defaultConfig: { leafModel: 'kimi:k3' },
      hudMirror: new HudMirror(cwd),
    });
    const runPlan = tools.find((t) => t.name === 'dag_run_plan')!;
    await call(runPlan, { plan: PLAN_JSON });
    await Promise.resolve(); // 放行 fire-and-forget 的 .then (succeed → 终态写)

    const dagPath = join(cwd, '.omd', 'hud', 'dag.json');
    expect(existsSync(dagPath)).toBe(true);
    const snap = JSON.parse(readFileSync(dagPath, 'utf-8')) as HudDagSnapshot;
    expect(snap.status).toBe('done');
    expect(snap.settled).toHaveLength(2);
    expect(snap.settled.map((s) => s.id).sort()).toEqual(['leaf2', 'root']);
    // levels 来自 topoLevels(plan): root 无依赖 L1, leaf2 依赖 root L2。
    expect(snap.levels).toEqual([['root'], ['leaf2']]);

    // 读侧: 刚写完 (grace 内) → finished 视图可渲染。
    const view = readDagView(cwd, Date.parse(snap.updatedAt) + 1000);
    expect(view?.phase).toBe('finished');
  });

  test('无 hudMirror 注入 → 不写 dag.json (HUD 空闲, 零副作用)', async () => {
    const reg = new RunRegistry();
    const tools = createDagTools({ engine: emittingEngine(), runRegistry: reg, cwd, defaultConfig: { leafModel: 'kimi:k3' } });
    await call(tools.find((t) => t.name === 'dag_run_plan')!, { plan: PLAN_JSON });
    await Promise.resolve();
    expect(existsSync(join(cwd, '.omd', 'hud', 'dag.json'))).toBe(false);
  });
});
