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
import type { ExecutorDagResult } from '../../src/harness/executor-dag-types';
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
      cwd: '/tmp',
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
      cwd: '/tmp',
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
      cwd: '/tmp',
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
      cwd: '/tmp',
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
      cwd: '/tmp',
    });
    const handler = getTool(tools, 'dag_run_plan');
    await expect(handler({})).rejects.toThrow('plan');
  });

  test('invalid plan (not JSON) → McpError InvalidParams from parsePlan', async () => {
    const tools = createDagTools({
      engine: fakeEngine(stubResult()),
      runRegistry: new RunRegistry(),
      cwd: '/tmp',
    });
    const handler = getTool(tools, 'dag_run_plan');
    await expect(handler({ plan: 'not json at all' })).rejects.toThrow('invalid plan');
  });

  test('invalid plan (bad schema) → McpError', async () => {
    const tools = createDagTools({
      engine: fakeEngine(stubResult()),
      runRegistry: new RunRegistry(),
      cwd: '/tmp',
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
      cwd: '/tmp',
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
      cwd: '/tmp',
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
      cwd: '/tmp',
    });
    const handler = getTool(tools, 'dag_status');
    await expect(handler({})).rejects.toThrow('runId');
  });

  test('unknown runId → isError', async () => {
    const tools = createDagTools({
      engine: fakeEngine(stubResult()),
      runRegistry: new RunRegistry(),
      cwd: '/tmp',
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
      cwd: '/tmp',
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
      cwd: '/tmp',
    });
    const handler = getTool(tools, 'dag_result');
    await expect(handler({})).rejects.toThrow('runId');
  });

  test('unknown runId → isError', async () => {
    const tools = createDagTools({
      engine: fakeEngine(stubResult()),
      runRegistry: new RunRegistry(),
      cwd: '/tmp',
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
      cwd: '/tmp',
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
      cwd: '/tmp',
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
      cwd: '/tmp',
    });
    const handler = getTool(tools, 'dag_result');
    const result = await handler({ runId: 'f1' }) as { isError?: boolean; content: { type: string; text: string }[] };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('failed');
  });
});
