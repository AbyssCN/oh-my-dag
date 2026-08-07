/**
 * test/core/mcp-dag-tools.test.ts — dag tool handlers unit tests (SDD task-tools-dag).
 *
 * Pure memory, injectable engine/registry/clock. Covers:
 *   dag_run:      missing task → MCP error; happy path → runId + registry update
 *   dag_run_plan: missing plan → MCP error; invalid plan → parsePlan reject; happy path
 *   dag_status:   unknown runId → isError; known → summary
 *   dag_result:   unknown → isError; non-done → isError; done → result
 */
import { describe, expect, test } from 'bun:test';
import { RunRegistry } from '../../src/mcp/run-registry';
import { createDagTools, type DagEngine } from '../../src/mcp/tools/dag-tools';
import type { ExecutorDagConfig, ExecutorDagResult } from '../../src/harness/dag/types';
import type { ConductorPlan } from '../../src/harness/conductor-plan';

/** Minimal valid ConductorPlan for dag_run_plan tests. */
const VALID_PLAN_JSON = JSON.stringify({
  name: 'test-plan',
  description: 'test plan for unit tests',
  nodes: {
    root: {
      goal: 'do something',
      executor: 'leaf',
    },
  },
});

/** Stub ExecutorDagResult for fake engine. */
function stubResult(sessionId = 'test-session'): ExecutorDagResult {
  return {
    plan: { name: 'test', nodes: {} } as unknown as ConductorPlan,
    sessionId,
    levels: [['root']],
    results: {
      root: {
        id: 'root',
        status: 'done',
        kind: 'inproc',
        output: 'ok',
        deps: [],
        usage: { in: 10, out: 5 },
        filesTouched: ['src/foo.ts'],
      },
    },
    usage: { conductor: { in: 0, out: 0 }, leavesIn: 10, leavesOut: 5, leavesCacheHit: 0 },
  };
}

/** Fake engine that returns a pre-built result. */
function fakeEngine(result: ExecutorDagResult): DagEngine {
  return {
    runExecutorDag: async () => result,
    runExecutorDagWithPlan: async () => result,
  };
}

/** Fake engine that rejects. */
function rejectingEngine(err: Error): DagEngine {
  return {
    runExecutorDag: async () => {
      throw err;
    },
    runExecutorDagWithPlan: async () => {
      throw err;
    },
  };
}

/** Extract handler from tool list by name, wrapping to accept single arg (ignores MCP extra). */
function getTool(tools: ReturnType<typeof createDagTools>, name: string) {
  const t = tools.find((t) => t.name === name);
  if (!t) throw new Error(`tool ${name} not found`);
  return (args: Record<string, unknown>) => (t.handler as (args: Record<string, unknown>, extra?: unknown) => unknown)(args, {});
}

/** Default config for tests. */
const DEFAULT_CONFIG = { conductorModel: 'test:conductor', leafModel: 'test:leaf' };

// ---------------------------------------------------------------------------
// dag_run
// ---------------------------------------------------------------------------
describe('dag_run', () => {
  test('missing task → McpError InvalidParams', async () => {
    const tools = createDagTools({
      engine: fakeEngine(stubResult()),
      runRegistry: new RunRegistry(),
    });
    const handler = getTool(tools, 'dag_run');
    await expect(handler({})).rejects.toThrow('dag_run');
    await expect(handler({})).rejects.toThrow('task');
  });

  test('missing conductorModel (no default) → isError', async () => {
    const reg = new RunRegistry();
    const tools = createDagTools({
      engine: fakeEngine(stubResult()),
      runRegistry: reg,
    });
    const handler = getTool(tools, 'dag_run');
    const result = await handler({ task: 'do stuff' }) as { isError?: boolean; content: { type: string; text: string }[] };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('conductorModel');
  });

  test('happy path → runId + registry running', async () => {
    const reg = new RunRegistry();
    const tools = createDagTools({
      engine: fakeEngine(stubResult()),
      runRegistry: reg,
      defaultConfig: DEFAULT_CONFIG,
    });
    const handler = getTool(tools, 'dag_run');
    const result = await handler({ task: 'build the thing' }) as { content: { type: string; text: string }[] };
    expect(result.content[0]!.text).toContain('runId:');
    expect(result.content[0]!.text).toContain('running');

    // Extract runId from response.
    const match = result.content[0]!.text.match(/runId: ([\w-]+)/);
    expect(match).toBeTruthy();
    const runId = match![1]!;

    // Fake engine resolves immediately (microtask), so registry transitions to done by assertion time.
    expect(reg.getStatus(runId)).toBe('done');
  });

  test('engine rejects → registry transitions to failed', async () => {
    const reg = new RunRegistry();
    const tools = createDagTools({
      engine: rejectingEngine(new Error('boom')),
      runRegistry: reg,
      defaultConfig: DEFAULT_CONFIG,
    });
    const handler = getTool(tools, 'dag_run');
    const result = await handler({ task: 'fail task' }) as { content: { type: string; text: string }[] };
    const match = result.content[0]!.text.match(/runId: ([\w-]+)/);
    const runId = match![1]!;

    // Wait a tick for the async rejection to propagate.
    await new Promise((r) => setTimeout(r, 10));
    expect(reg.getStatus(runId)).toBe('failed');
    const rec = reg.getRecord(runId);
    expect(rec!.error).toContain('boom');
  });
});

// ---------------------------------------------------------------------------
// dag_run_plan
// ---------------------------------------------------------------------------
describe('dag_run_plan', () => {
  test('missing plan → McpError InvalidParams', async () => {
    const tools = createDagTools({
      engine: fakeEngine(stubResult()),
      runRegistry: new RunRegistry(),
    });
    const handler = getTool(tools, 'dag_run_plan');
    await expect(handler({})).rejects.toThrow('plan');
  });

  test('invalid plan (not JSON) → McpError InvalidParams from parsePlan', async () => {
    const tools = createDagTools({
      engine: fakeEngine(stubResult()),
      runRegistry: new RunRegistry(),
    });
    const handler = getTool(tools, 'dag_run_plan');
    await expect(handler({ plan: 'not json at all' })).rejects.toThrow('invalid plan');
  });

  test('invalid plan (bad schema) → McpError', async () => {
    const tools = createDagTools({
      engine: fakeEngine(stubResult()),
      runRegistry: new RunRegistry(),
    });
    const handler = getTool(tools, 'dag_run_plan');
    // Missing required fields.
    await expect(handler({ plan: JSON.stringify({ name: 'x' }) })).rejects.toThrow('invalid plan');
  });

  test('happy path → runId + registry running', async () => {
    const reg = new RunRegistry();
    const tools = createDagTools({
      engine: fakeEngine(stubResult()),
      runRegistry: reg,
      defaultConfig: DEFAULT_CONFIG,
    });
    const handler = getTool(tools, 'dag_run_plan');
    const result = await handler({ plan: VALID_PLAN_JSON }) as { content: { type: string; text: string }[] };
    expect(result.content[0]!.text).toContain('runId:');
    expect(result.content[0]!.text).toContain('running');

    const match = result.content[0]!.text.match(/runId: ([\w-]+)/);
    const runId = match![1]!;
    expect(reg.getStatus(runId)).toBe('done');
  });

  test('engine rejects → registry failed', async () => {
    const reg = new RunRegistry();
    const tools = createDagTools({
      engine: rejectingEngine(new Error('plan exec boom')),
      runRegistry: reg,
      defaultConfig: DEFAULT_CONFIG,
    });
    const handler = getTool(tools, 'dag_run_plan');
    const result = await handler({ plan: VALID_PLAN_JSON }) as { content: { type: string; text: string }[] };
    const match = result.content[0]!.text.match(/runId: ([\w-]+)/);
    const runId = match![1]!;

    await new Promise((r) => setTimeout(r, 10));
    expect(reg.getStatus(runId)).toBe('failed');
  });
});

// ---------------------------------------------------------------------------
// dag_status
// ---------------------------------------------------------------------------
describe('dag_status', () => {
  test('missing runId → McpError', async () => {
    const tools = createDagTools({
      engine: fakeEngine(stubResult()),
      runRegistry: new RunRegistry(),
    });
    const handler = getTool(tools, 'dag_status');
    await expect(handler({})).rejects.toThrow('runId');
  });

  test('unknown runId → isError', async () => {
    const tools = createDagTools({
      engine: fakeEngine(stubResult()),
      runRegistry: new RunRegistry(),
    });
    const handler = getTool(tools, 'dag_status');
    const result = await handler({ runId: 'nope' }) as { isError?: boolean; content: { type: string; text: string }[] };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('nope');
  });

  test('known runId → summary (not isError)', async () => {
    const reg = new RunRegistry();
    reg.register('r1', { goal: 'test' });
    reg.start('r1');
    const tools = createDagTools({
      engine: fakeEngine(stubResult()),
      runRegistry: reg,
    });
    const handler = getTool(tools, 'dag_status');
    const result = await handler({ runId: 'r1' }) as { isError?: boolean; content: { type: string; text: string }[] };
    expect(result.isError).toBeFalsy();
    expect(result.content[0]!.text).toContain('running');
  });
});

// ---------------------------------------------------------------------------
// dag_result
// ---------------------------------------------------------------------------
describe('dag_result', () => {
  test('missing runId → McpError', async () => {
    const tools = createDagTools({
      engine: fakeEngine(stubResult()),
      runRegistry: new RunRegistry(),
    });
    const handler = getTool(tools, 'dag_result');
    await expect(handler({})).rejects.toThrow('runId');
  });

  test('unknown runId → isError', async () => {
    const tools = createDagTools({
      engine: fakeEngine(stubResult()),
      runRegistry: new RunRegistry(),
    });
    const handler = getTool(tools, 'dag_result');
    const result = await handler({ runId: 'ghost' }) as { isError?: boolean; content: { type: string; text: string }[] };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('ghost');
  });

  test('pending runId → isError (not done)', async () => {
    const reg = new RunRegistry();
    reg.register('p1', { goal: 'waiting' });
    const tools = createDagTools({
      engine: fakeEngine(stubResult()),
      runRegistry: reg,
    });
    const handler = getTool(tools, 'dag_result');
    const result = await handler({ runId: 'p1' }) as { isError?: boolean; content: { type: string; text: string }[] };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('pending');
  });

  test('done runId → result JSON', async () => {
    const reg = new RunRegistry();
    reg.register('d1', { goal: 'finished' });
    reg.start('d1');
    const fakeResult = { sessionId: 's1', nodeCount: 2, done: 2, failed: 0 };
    reg.succeed('d1', fakeResult);
    const tools = createDagTools({
      engine: fakeEngine(stubResult()),
      runRegistry: reg,
    });
    const handler = getTool(tools, 'dag_result');
    const result = await handler({ runId: 'd1' }) as { isError?: boolean; content: { type: string; text: string }[] };
    expect(result.isError).toBeFalsy();
    expect(result.content[0]!.text).toContain('sessionId');
    expect(result.content[0]!.text).toContain('s1');
  });

  test('failed runId → isError (not done)', async () => {
    const reg = new RunRegistry();
    reg.register('f1', { goal: 'broken' });
    reg.start('f1');
    reg.fail('f1', 'crash');
    const tools = createDagTools({
      engine: fakeEngine(stubResult()),
      runRegistry: reg,
    });
    const handler = getTool(tools, 'dag_result');
    const result = await handler({ runId: 'f1' }) as { isError?: boolean; content: { type: string; text: string }[] };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('failed');
  });
});

// ── round4: 派发简报 + 活体进度 (briefing + onNodeEvent 接线) ─────────────────────

import type { DagNodeEvent } from '../../src/harness/dag/types';

describe('派发简报 + 活体进度', () => {
  const THREE_NODE_PLAN = JSON.stringify({
    name: 'briefing-plan',
    nodes: {
      a: { goal: 'research', executor: 'leaf' },
      b: { goal: 'implement', executor: 'agent', depends_on: ['a'] },
      gate: { executor: 'command', command: 'bun test', depends_on: ['b'] },
    },
  });

  test('dag_run_plan 返回派发简报: 节点计数/分类/层数/模型', async () => {
    const tools = createDagTools({
      engine: fakeEngine(stubResult()),
      runRegistry: new RunRegistry(),
      defaultConfig: { leafModel: 'fake:leaf', agentLeafModel: 'fake:agent' },
    });
    const res = (await getTool(tools, 'dag_run_plan')({ plan: THREE_NODE_PLAN })) as {
      content: { text: string }[];
    };
    const text = res.content[0]!.text;
    expect(text).toContain('--- dispatch ---');
    expect(text).toContain('nodes: 3 (leaf:1 agent:1 command:1)');
    expect(text).toContain('levels: 3 (widest 1)');
    expect(text).toContain('leaf=fake:leaf');
    expect(text).toContain('agent=fake:agent');
  });

  test('onNodeEvent 流进 registry: running 期 dag_status 活体进度, 完结回 done 语义', async () => {
    const reg = new RunRegistry();
    let emit!: (e: DagNodeEvent) => void;
    let finish!: () => void;
    const gatePromise = new Promise<void>((r) => {
      finish = r;
    });
    const engine: DagEngine = {
      runExecutorDag: async () => {
        throw new Error('unused');
      },
      runExecutorDagWithPlan: async (_plan, config) => {
        emit = config.onNodeEvent!;
        await gatePromise;
        return stubResult();
      },
    };
    const tools = createDagTools({ engine, runRegistry: reg, defaultConfig: { leafModel: 'fake:leaf' } });
    const runRes = (await getTool(tools, 'dag_run_plan')({ plan: THREE_NODE_PLAN })) as {
      content: { text: string }[];
    };
    const runId = /runId: (\S+)/.exec(runRes.content[0]!.text)![1]!;

    emit({ type: 'planned', nodes: [{ id: 'a', kind: 'inproc' }, { id: 'b', kind: 'agent' }, { id: 'gate', kind: 'command' }] });
    emit({ type: 'start', id: 'a', kind: 'inproc' });
    let status = (await getTool(tools, 'dag_status')({ runId })) as { content: { text: string }[] };
    expect(status.content[0]!.text).toContain('progress: 0/3 done, 2 pending');
    expect(status.content[0]!.text).toContain('running: a(inproc, 0s)');

    emit({ type: 'settle', id: 'a', status: 'done', kind: 'inproc' });
    emit({ type: 'start', id: 'b', kind: 'agent' });
    status = (await getTool(tools, 'dag_status')({ runId })) as { content: { text: string }[] };
    expect(status.content[0]!.text).toContain('progress: 1/3 done, 1 pending');
    expect(status.content[0]!.text).toContain('running: b(agent, 0s)');

    finish();
    await new Promise((r) => setTimeout(r, 10));
    status = (await getTool(tools, 'dag_status')({ runId })) as { content: { text: string }[] };
    expect(status.content[0]!.text).toContain('status: done');
    expect(status.content[0]!.text).not.toContain('running:');
  });
});

// ── continuity 断点续跑 (D-3): checkpoint 恒落 + resume 语义 ─────────────────────

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CheckpointManager } from '../../src/harness/continuity/checkpoint-manager';

describe('continuity 接线 + resume', () => {
  function continuityDeps() {
    const root = mkdtempSync(join(tmpdir(), 'omd-mcp-cont-'));
    return { manager: new CheckpointManager(root), repoRoot: root };
  }
  /** 捕获 config 的 fake engine (可指定结局)。 */
  function capturingEngine(outcome: 'ok' | 'reject') {
    const captured: { config?: ExecutorDagConfig } = {};
    const engine: DagEngine = {
      runExecutorDag: async () => {
        throw new Error('unused');
      },
      runExecutorDagWithPlan: async (_plan, config) => {
        captured.config = config;
        if (outcome === 'reject') throw new Error('boom 429');
        return stubResult();
      },
    };
    return { engine, captured };
  }

  test('新 run: continuity 恒落盘 (runId 一致, resume=false)', async () => {
    const { engine, captured } = capturingEngine('ok');
    const tools = createDagTools({
      engine,
      runRegistry: new RunRegistry(),
      defaultConfig: { leafModel: 'fake:leaf' },
      continuity: continuityDeps(),
    });
    const res = (await getTool(tools, 'dag_run_plan')({ plan: VALID_PLAN_JSON })) as { content: { text: string }[] };
    const runId = /runId: (\S+)/.exec(res.content[0]!.text)![1]!;
    await new Promise((r) => setTimeout(r, 10));
    expect(captured.config!.continuity!.runId).toBe(runId);
    expect(captured.config!.continuity!.resume).toBe(false);
  });

  test('resume failed run: 同 runId 重开, continuity.resume=true, 状态回 running→done', async () => {
    const reg = new RunRegistry();
    const cont = continuityDeps();
    const { engine: failEngine } = capturingEngine('reject');
    const tools1 = createDagTools({ engine: failEngine, runRegistry: reg, defaultConfig: { leafModel: 'fake:leaf' }, continuity: cont });
    const first = (await getTool(tools1, 'dag_run_plan')({ plan: VALID_PLAN_JSON })) as { content: { text: string }[] };
    const runId = /runId: (\S+)/.exec(first.content[0]!.text)![1]!;
    await new Promise((r) => setTimeout(r, 10));
    expect(reg.getRecord(runId)!.status).toBe('failed');

    const { engine: okEngine, captured } = capturingEngine('ok');
    const tools2 = createDagTools({ engine: okEngine, runRegistry: reg, defaultConfig: { leafModel: 'fake:leaf' }, continuity: cont });
    const second = (await getTool(tools2, 'dag_run_plan')({ plan: VALID_PLAN_JSON, resume: runId })) as { content: { text: string }[] };
    expect(/runId: (\S+)/.exec(second.content[0]!.text)![1]).toBe(runId);
    await new Promise((r) => setTimeout(r, 10));
    expect(captured.config!.continuity!.resume).toBe(true);
    expect(reg.getRecord(runId)!.status).toBe('done');
  });

  test('resume 未知 runId (server 重启): 重登记照跑', async () => {
    const { engine, captured } = capturingEngine('ok');
    const reg = new RunRegistry();
    const tools = createDagTools({ engine, runRegistry: reg, defaultConfig: { leafModel: 'fake:leaf' }, continuity: continuityDeps() });
    const res = (await getTool(tools, 'dag_run_plan')({ plan: VALID_PLAN_JSON, resume: 'lost-after-restart' })) as { content: { text: string }[] };
    expect(res.content[0]!.text).toContain('runId: lost-after-restart');
    await new Promise((r) => setTimeout(r, 10));
    expect(captured.config!.continuity!.runId).toBe('lost-after-restart');
    expect(captured.config!.continuity!.resume).toBe(true);
    expect(reg.getRecord('lost-after-restart')!.status).toBe('done');
  });

  test('resume 在飞 run → isError 拒绝 (不重复执行)', async () => {
    const reg = new RunRegistry();
    reg.register('inflight', { goal: 'g' });
    reg.start('inflight');
    const { engine } = capturingEngine('ok');
    const tools = createDagTools({ engine, runRegistry: reg, defaultConfig: { leafModel: 'fake:leaf' }, continuity: continuityDeps() });
    const res = (await getTool(tools, 'dag_run_plan')({ plan: VALID_PLAN_JSON, resume: 'inflight' })) as { isError?: boolean; content: { text: string }[] };
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('running');
  });
});

// ── maxFanout 手闸 (参数 > defaultConfig > 全宽) + briefing workers 行 ─────────────

describe('maxFanout 手闸', () => {
  function engineCapture() {
    const captured: { config?: ExecutorDagConfig } = {};
    const engine: DagEngine = {
      runExecutorDag: async () => { throw new Error('unused'); },
      runExecutorDagWithPlan: async (_p, config) => { captured.config = config; return stubResult(); },
    };
    return { engine, captured };
  }

  test('参数透传引擎 config 且覆盖 defaultConfig; briefing 出 workers 行', async () => {
    const { engine, captured } = engineCapture();
    const tools = createDagTools({ engine, runRegistry: new RunRegistry(),
      defaultConfig: { leafModel: 'fake:leaf', maxFanout: 3 } });
    const res = (await getTool(tools, 'dag_run_plan')({ plan: VALID_PLAN_JSON, maxFanout: 1 })) as { content: { text: string }[] };
    await new Promise((r) => setTimeout(r, 10));
    expect(captured.config!.maxFanout).toBe(1); // 参数 > defaultConfig(3)
    expect(res.content[0]!.text).toContain('workers: up to 1 (cap 1)');
  });

  test('无参数 → defaultConfig (装配层 provider 池) 生效', async () => {
    const { engine, captured } = engineCapture();
    const tools = createDagTools({ engine, runRegistry: new RunRegistry(),
      defaultConfig: { leafModel: 'fake:leaf', maxFanout: 3 } });
    (await getTool(tools, 'dag_run_plan')({ plan: VALID_PLAN_JSON })) as unknown;
    await new Promise((r) => setTimeout(r, 10));
    expect(captured.config!.maxFanout).toBe(3);
  });
});

// ── usage 可见性 (TUI /cost parity) ──────────────────────────────────────────────

describe('dag_result usage 回传', () => {
  test('result 含 conductor/leaves token 计数', async () => {
    const reg = new RunRegistry();
    const tools = createDagTools({ engine: fakeEngine(stubResult()), runRegistry: reg, defaultConfig: { leafModel: 'fake:leaf' } });
    const run = (await getTool(tools, 'dag_run_plan')({ plan: VALID_PLAN_JSON })) as { content: { text: string }[] };
    const runId = /runId: (\S+)/.exec(run.content[0]!.text)![1]!;
    await new Promise((r) => setTimeout(r, 10));
    const res = (await getTool(tools, 'dag_result')({ runId })) as { content: { text: string }[] };
    const text = res.content[0]!.text;
    expect(text).toContain('"leavesIn": 10');
    expect(text).toContain('"leavesOut": 5');
    expect(text).toContain('"conductor"');
  });
});

// ── INV-MODEL-3 (P0): 无 boot 冻结 ─────────────────────────────────────
// MCP server 长驻: 装配期把座位算死 → omd_set_role 改完配置仍跑旧模型, 得杀进程重连。
// defaultConfig 给 thunk 时必须**每个 run 重算**。
describe('defaultConfig thunk — INV-MODEL-3 无 boot 冻结', () => {
  test('每次 dag_run / dag_run_plan 重新求值 (改配置下一跑即生效)', async () => {
    const seen: string[] = [];
    let conductor = 'v1:model';
    const engine: DagEngine = {
      runExecutorDag: async (_task, cfg) => {
        seen.push((cfg as ExecutorDagConfig).conductorModel ?? '');
        return stubResult();
      },
      runExecutorDagWithPlan: async (_plan, cfg) => {
        seen.push((cfg as ExecutorDagConfig).conductorModel ?? '');
        return stubResult();
      },
    };
    const tools = createDagTools({
      engine,
      runRegistry: new RunRegistry(),
      defaultConfig: () => ({ conductorModel: conductor, leafModel: 'l:m' }),
    });
    const run = getTool(tools, 'dag_run');
    await run({ task: 'first' });
    conductor = 'v2:model'; // ← 模拟 omd_set_role 改 config
    await run({ task: 'second' });
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toEqual(['v1:model', 'v2:model']);
  });

  test('给值 (非 thunk) = 老语义, 不回归', async () => {
    const seen: string[] = [];
    const engine: DagEngine = {
      runExecutorDag: async (_t, cfg) => {
        seen.push((cfg as ExecutorDagConfig).conductorModel ?? '');
        return stubResult();
      },
      runExecutorDagWithPlan: async () => stubResult(),
    };
    const tools = createDagTools({
      engine,
      runRegistry: new RunRegistry(),
      defaultConfig: { conductorModel: 'fixed:m', leafModel: 'l:m' },
    });
    await getTool(tools, 'dag_run')({ task: 'x' });
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toEqual(['fixed:m']);
  });
});

// ── INV-MODEL-5 (P0): 起跑自检失败 → MCP error, 不崩 server ─────────────
describe('defaultConfig thunk 抛错 — INV-MODEL-5 响亮但不崩', () => {
  const throwing = () => {
    throw new Error('[omd/model] 起跑自检失败 —— 1 个座位不可用: conductor=<未配>');
  };

  test('dag_run: 回 isError 并带出座位名, run 标 failed', async () => {
    const reg = new RunRegistry();
    const tools = createDagTools({
      engine: fakeEngine(stubResult()),
      runRegistry: reg,
      defaultConfig: throwing,
    });
    const r = await getTool(tools, 'dag_run')({ task: 'x' }) as { content: { text: string }[]; isError?: boolean };
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain('conductor=<未配>');
    const runId = r.content[0]!.text.match(/runId: ([\w-]+)/)![1]!;
    expect(reg.getRecord(runId)!.status).toBe('failed');
  });

  test('dag_run_plan: 回 isError, 不注册在飞 run', async () => {
    const tools = createDagTools({
      engine: fakeEngine(stubResult()),
      runRegistry: new RunRegistry(),
      defaultConfig: throwing,
    });
    const r = await getTool(tools, 'dag_run_plan')({ plan: VALID_PLAN_JSON }) as { content: { text: string }[]; isError?: boolean };
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain('起跑自检失败');
  });
});

// ---------------------------------------------------------------------------
// dag_cancel (D-P 协作式取消, 2026-07-30)
// ---------------------------------------------------------------------------
describe('dag_cancel — 协作式取消的 MCP 面', () => {
  /** 引擎: 等取消信号被拉起来再返回一个"被叫停"的结果 (真引擎就是这么收尾的)。 */
  const cancellableEngine = (seen: { signal?: AbortSignal }): DagEngine => {
    const run = async (_a: unknown, config: ExecutorDagConfig): Promise<ExecutorDagResult> => {
      seen.signal = config.cancelSignal;
      await new Promise<void>((r) => {
        if (config.cancelSignal?.aborted) return r();
        config.cancelSignal?.addEventListener('abort', () => r(), { once: true });
      });
      return {
        ...stubResult(),
        cancelled: { reason: String(config.cancelSignal?.reason ?? '?'), at: '2026-07-30T00:00:00Z', notRun: ['later'] },
      };
    };
    return {
      runExecutorDag: (t, c) => run(t, c),
      runExecutorDagWithPlan: (p, c) => run(p, c),
    };
  };

  test('叫停在飞 run → 引擎收到 signal, run 终态 cancelled 而**不是 failed/done**', async () => {
    const reg = new RunRegistry();
    const seen: { signal?: AbortSignal } = {};
    const tools = createDagTools({ engine: cancellableEngine(seen), runRegistry: reg, defaultConfig: DEFAULT_CONFIG });
    const started = await getTool(tools, 'dag_run')({ task: 'long thing' }) as { content: { text: string }[] };
    const runId = started.content[0]!.text.match(/runId: ([\w-]+)/)![1]!;
    expect(reg.getRecord(runId)!.status).toBe('running');

    const r = await getTool(tools, 'dag_cancel')({ runId, reason: '不想跑了' }) as { content: { text: string }[]; isError?: boolean };
    expect(r.isError).toBeUndefined();
    // 回的是"已请求"而不是"已停止" —— 协作式取消这一刻活还没停。
    expect(r.content[0]!.text).toContain('已请求取消');
    expect(seen.signal?.aborted).toBe(true);

    await Bun.sleep(5); // 让 fire-and-forget 的收尾跑完
    const rec = reg.getRecord(runId)!;
    expect(rec.status).toBe('cancelled');
    expect(rec.error).toContain('不想跑了');
    expect(rec.result).toBeDefined(); // 手上的结果照给 (已跑完的节点值钱)
  });

  test('cancelled 的 run 可以直接 resume (D-P 的"已跑完的全保留"兑现在这一步)', async () => {
    const reg = new RunRegistry();
    reg.register('r1', { goal: 'g' });
    reg.start('r1');
    reg.cancel('r1', '叫停', '上一次的摘要');
    expect(() => reg.reopenForResume('r1', { goal: 'g' })).not.toThrow();
    expect(reg.getStatus('r1')).toBe('running');
    // 重开 = 新一次尝试: 上一次的结论**一样不留** (2026-07-30 取消冒烟撞出来的 —— 只清 error
    // 不清 result, 续跑之后 dag_result 还端着上一次那份摘要, 读的人分不清是这次还是上次)。
    expect(reg.getRecord('r1')!.result).toBeUndefined();
    expect(reg.getRecord('r1')!.error).toBeUndefined();
  });

  test('未知 / 不在飞的 run → isError, 不假装停到了', async () => {
    const reg = new RunRegistry();
    const tools = createDagTools({ engine: fakeEngine(stubResult()), runRegistry: reg, defaultConfig: DEFAULT_CONFIG });
    const unknown = await getTool(tools, 'dag_cancel')({ runId: 'nope' }) as { content: { text: string }[]; isError?: boolean };
    expect(unknown.isError).toBe(true);
    reg.register('r2', { goal: 'g' });
    reg.start('r2');
    reg.succeed('r2', 'ok');
    const doneRun = await getTool(tools, 'dag_cancel')({ runId: 'r2' }) as { content: { text: string }[]; isError?: boolean };
    expect(doneRun.isError).toBe(true);
    expect(doneRun.content[0]!.text).toContain('不在飞');
  });

  test('把手不在 (server 重启后内存态丢) → **如实说没停到**, 不回一句"已取消"', () => {
    const reg = new RunRegistry();
    reg.register('r3', { goal: 'g' });
    reg.start('r3'); // 没 attachCancel → 没有把手
    expect(reg.requestCancel('r3', 'x')).toBe(false);
  });
});
