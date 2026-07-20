/**
 * test/core/mcp-fleet-tools.test.ts — fleet + runs tools unit tests.
 *
 * Pure memory: fake spawn/fake dream/in-memory registry, zero real processes or network.
 * Covers: dag_review happy+fail, dream_consolidate stats, dag_runs merge,
 *         dag_run resume via reopenForResume (continuity.resume=true).
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RunRegistry } from '../../src/mcp/run-registry';
import { createFleetTools, type SpawnFn, type SpawnResult } from '../../src/mcp/tools/fleet';
import { createRunsTools } from '../../src/mcp/tools/runs';
import { createDagTools, type DagEngine } from '../../src/mcp/tools/dag-tools';
import type { ExecutorDagConfig, ExecutorDagResult } from '../../src/harness/executor-dag-types';
import type { ConductorPlan } from '../../src/harness/conductor-plan';
import type { DreamPump, PumpResult } from '../../src/harness/learning/types';
import { CheckpointManager } from '../../src/harness/continuity/checkpoint-manager';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Extract handler from tool list by name. */
function getTool<T extends { name: string; handler: Function }>(tools: T[], name: string) {
  const t = tools.find((t) => t.name === name);
  if (!t) throw new Error(`tool ${name} not found`);
  return (args: Record<string, unknown> = {}) =>
    (t.handler as (args: Record<string, unknown>, extra?: unknown) => unknown)(args, {});
}

/** Fake spawn that resolves with given result. */
function fakeSpawn(result: SpawnResult): SpawnFn {
  return async () => result;
}

/** Fake DreamPump returning fixed stats. */
function fakeDream(result: PumpResult): DreamPump {
  return { pump: async () => result };
}

/** Stub ExecutorDagResult for dag_run resume tests. */
function stubResult(): ExecutorDagResult {
  return {
    plan: { name: 'test', nodes: {} } as unknown as ConductorPlan,
    sessionId: 's',
    levels: [['root']],
    results: {
      root: {
        id: 'root',
        status: 'done',
        kind: 'inproc',
        output: 'ok',
        deps: [],
        usage: { in: 10, out: 5 },
        filesTouched: [],
      },
    },
    usage: { conductor: { in: 0, out: 0 }, leavesIn: 10, leavesOut: 5, leavesCacheHit: 0 },
  };
}

/** Capturing engine for continuity/resume tests. */
function capturingEngine(outcome: 'ok' | 'reject') {
  const captured: { config?: ExecutorDagConfig } = {};
  const engine: DagEngine = {
    runExecutorDag: async (_task: string, config: ExecutorDagConfig) => {
      captured.config = config;
      if (outcome === 'reject') throw new Error('boom 429');
      return stubResult();
    },
    runExecutorDagWithPlan: async (_plan, config) => {
      captured.config = config;
      if (outcome === 'reject') throw new Error('boom 429');
      return stubResult();
    },
  };
  return { engine, captured };
}

// ---------------------------------------------------------------------------
// ① dag_review happy path
// ---------------------------------------------------------------------------
describe('dag_review', () => {
  test('fake spawn exit 0 → runId 三段式到 done, 结果含 reportPath', async () => {
    const reg = new RunRegistry();
    const spawn = fakeSpawn({ exitCode: 0, stdout: 'all clear\n', stderr: '' });
    const tools = createFleetTools({ runRegistry: reg, cwd: '/tmp', spawn });
    const handler = getTool(tools, 'dag_review');
    const res = (await handler({ gate: 'G0' })) as { content: { text: string }[] };
    const text = res.content[0]!.text;
    expect(text).toContain('runId:');
    expect(text).toContain('running');

    // Extract runId. Fake spawn resolves immediately → already done after await.
    const runId = /runId: ([\w-]+)/.exec(text)![1]!;
    await new Promise((r) => setTimeout(r, 10));
    expect(reg.getStatus(runId)).toBe('done');
    const rec = reg.getRecord(runId)!;
    expect(rec.result).toBeTruthy();
    expect((rec.result as { reportPath: string }).reportPath).toContain('/tmp/omd-fleet-review-');
  });

  // ---------------------------------------------------------------------------
  // ② dag_review spawn exit 1 → failed, error 含 stderr 尾
  // ---------------------------------------------------------------------------
  test('fake spawn exit 1 → failed, error 含 stderr 尾', async () => {
    const reg = new RunRegistry();
    const spawn = fakeSpawn({ exitCode: 1, stdout: '', stderr: 'lint exploded on line 42\n' });
    const tools = createFleetTools({ runRegistry: reg, cwd: '/tmp', spawn });
    const handler = getTool(tools, 'dag_review');
    const res = (await handler()) as { content: { text: string }[] };
    const runId = /runId: ([\w-]+)/.exec(res.content[0]!.text)![1]!;
    await new Promise((r) => setTimeout(r, 10));
    expect(reg.getStatus(runId)).toBe('failed');
    expect(reg.getRecord(runId)!.error).toContain('lint exploded on line 42');
  });
});

// ---------------------------------------------------------------------------
// ③ dream_consolidate 返回统计
// ---------------------------------------------------------------------------
describe('dream_consolidate', () => {
  test('fake pump → returns events/facts stats JSON', async () => {
    const stats: PumpResult = { eventsConsumed: 5, factsWritten: 3, factsRejected: 1, newWatermark: 100 };
    const tools = createFleetTools({
      runRegistry: new RunRegistry(),
      cwd: '/tmp',
      dream: fakeDream(stats),
    });
    const handler = getTool(tools, 'dream_consolidate');
    const res = (await handler()) as { content: { text: string }[] };
    const parsed = JSON.parse(res.content[0]!.text) as PumpResult;
    expect(parsed.eventsConsumed).toBe(5);
    expect(parsed.factsWritten).toBe(3);
    expect(parsed.factsRejected).toBe(1);
    expect(parsed.newWatermark).toBe(100);
  });

  test('dream not wired → isError', async () => {
    const tools = createFleetTools({ runRegistry: new RunRegistry(), cwd: '/tmp' });
    const handler = getTool(tools, 'dream_consolidate');
    const res = (await handler()) as { isError?: boolean; content: { text: string }[] };
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('not wired');
  });
});

// ---------------------------------------------------------------------------
// ④ dag_runs: memory + disk 合并去重, disk-only 标 unknown(restart)
// ---------------------------------------------------------------------------
describe('dag_runs', () => {
  test('memory run + disk _dag.json 合并去重, disk-only 标 unknown(restart)', () => {
    // Create tmp dir with two continuity run dirs.
    const root = mkdtempSync(join(tmpdir(), 'omd-runs-'));
    const contBase = join(root, '.omd', 'continuity');

    // Disk run A — will also be in memory (duplicate, memory wins).
    const diskRunA = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    mkdirSync(join(contBase, diskRunA), { recursive: true });
    writeFileSync(join(contBase, diskRunA, '_dag.json'), JSON.stringify({
      runId: diskRunA, goal: 'disk-goal-a', createdAt: '2024-01-01T00:00:00Z',
    }));

    // Disk run B — memory has no record → unknown(restart).
    const diskRunB = '11111111-2222-3333-4444-555555555555';
    mkdirSync(join(contBase, diskRunB), { recursive: true });
    writeFileSync(join(contBase, diskRunB, '_dag.json'), JSON.stringify({
      runId: diskRunB, goal: 'disk-goal-b', createdAt: '2024-01-02T00:00:00Z',
    }));

    // Memory: diskRunA (done) + memOnly (running).
    const reg = new RunRegistry();
    reg.register(diskRunA, { goal: 'mem-goal-a' });
    reg.start(diskRunA);
    reg.succeed(diskRunA, {});

    const memOnly = 'mmmmmmmm-nnnn-oooo-pppp-qqqqqqqqqqqq';
    reg.register(memOnly, { goal: 'mem-only-goal' });
    reg.start(memOnly);

    const tools = createRunsTools({ runRegistry: reg, cwd: root });
    const handler = getTool(tools, 'dag_runs');
    const res = handler() as { content: { text: string }[] };
    const text = res.content[0]!.text;

    // Memory run A present (memory wins, not disk's goal).
    expect(text).toContain(diskRunA);
    expect(text).toContain('mem-goal-a');

    // Disk-only B marked unknown(restart).
    expect(text).toContain(diskRunB);
    expect(text).toContain('unknown(restart)');
    expect(text).toContain('disk-goal-b');

    // Memory-only present.
    expect(text).toContain(memOnly);
    expect(text).toContain('running');
  });

  test('status filter excludes disk-only unknown(restart)', () => {
    const root = mkdtempSync(join(tmpdir(), 'omd-runs-filter-'));
    const contBase = join(root, '.omd', 'continuity');
    const diskId = 'dddd-dddd-dddd-dddd-dddddddddddd';
    mkdirSync(join(contBase, diskId), { recursive: true });
    writeFileSync(join(contBase, diskId, '_dag.json'), JSON.stringify({
      runId: diskId, goal: 'gone', createdAt: '2024-01-01T00:00:00Z',
    }));

    const reg = new RunRegistry();
    const tools = createRunsTools({ runRegistry: reg, cwd: root });
    // status=done filter → disk-only excluded (no memory status).
    const res = getTool(tools, 'dag_runs')({ status: 'done' }) as { content: { text: string }[] };
    expect(res.content[0]!.text).not.toContain(diskId);
    expect(res.content[0]!.text).toContain('No runs found');
  });

  test('missing continuity dir → No runs found', () => {
    const tools = createRunsTools({ runRegistry: new RunRegistry(), cwd: '/tmp/empty-omd-xxxx' });
    const res = getTool(tools, 'dag_runs')() as { content: { text: string }[] };
    expect(res.content[0]!.text).toContain('No runs found');
  });
});

// ---------------------------------------------------------------------------
// ⑤ dag_run resume=旧 failed runId → reopenForResume 生效 (continuity.resume=true)
// ---------------------------------------------------------------------------
describe('dag_run resume', () => {
  const VALID_PLAN = JSON.stringify({
    name: 'resume-plan',
    nodes: { root: { goal: 'do', executor: 'leaf' } },
  });

  test('resume failed runId → reopenForResume + continuity.resume=true', async () => {
    function contDeps() {
      const root = mkdtempSync(join(tmpdir(), 'omd-fleet-resume-'));
      return { manager: new CheckpointManager(root), repoRoot: root };
    }
    const cont = contDeps();
    const reg = new RunRegistry();
    const { engine: failEngine } = capturingEngine('reject');
    const tools1 = createDagTools({
      engine: failEngine,
      runRegistry: reg,
      cwd: '/tmp',
      defaultConfig: { conductorModel: 'test:conductor', leafModel: 'fake:leaf' },
      continuity: cont,
    });
    const first = (await getTool(tools1, 'dag_run')({ task: 'initial' })) as { content: { text: string }[] };
    const runId = /runId: ([\w-]+)/.exec(first.content[0]!.text)![1]!;
    await new Promise((r) => setTimeout(r, 10));
    expect(reg.getStatus(runId)).toBe('failed');

    const { engine: okEngine, captured } = capturingEngine('ok');
    const tools2 = createDagTools({
      engine: okEngine,
      runRegistry: reg,
      cwd: '/tmp',
      defaultConfig: { conductorModel: 'test:conductor', leafModel: 'fake:leaf' },
      continuity: cont,
    });
    const second = (await getTool(tools2, 'dag_run')({ task: 'retry', resume: runId })) as { content: { text: string }[] };
    expect(second.content[0]!.text).toContain(`runId: ${runId}`);
    await new Promise((r) => setTimeout(r, 10));
    expect(captured.config!.continuity!.resume).toBe(true);
    expect(reg.getStatus(runId)).toBe('done');
  });

  test('resume running run → isError 拒绝', async () => {
    const reg = new RunRegistry();
    reg.register('inflight', { goal: 'g' });
    reg.start('inflight');
    const { engine } = capturingEngine('ok');
    const tools = createDagTools({
      engine,
      runRegistry: reg,
      cwd: '/tmp',
      defaultConfig: { leafModel: 'fake:leaf' },
    });
    const res = (await getTool(tools, 'dag_run')({ task: 'nope', resume: 'inflight' })) as {
      isError?: boolean;
      content: { text: string }[];
    };
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('running');
  });
});
