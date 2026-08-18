/**
 * 生产路径的**运行留痕接线** (2026-08-02)。
 *
 * 缺陷本身: `createDagRecorder` 从很早就写好了, 但只挂在 TUI 侧的 `/cg` `/audit` `/iterate` 上 ——
 * MCP 这条 (`dag_run` / `dag_run_plan` / `dag_goal`) 一次都没接过。症状是**沉默**的: 库文件在,
 * 表在, 查出来恒零行, 读上去和"这个仓不记运行"没有区别。代价是两个问题没有数据源:
 * 「一次 goal 花了多少」(上线闸 G3) 与「兄弟节点吃到多少前缀缓存」。
 *
 * 这一条钉的就是接线本身 —— 与 `goal-resume.test.ts` 钉 continuity 接线同一个理由:
 * **有实现、零调用方**是这个仓反复撞见的形态, 只能靠"从工具面打进去"的测试拦住。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGoalTool } from './goal';
import { createPathfinderTools, type PathfinderToolDeps } from './pathfinder';
import { createDagTools, type DagEngine } from './dag-tools';
import { createComposeTools } from './compose';
import { RunRegistry } from '../run-registry';
import { createDagRecorder } from '../../harness/dag-record';
import type { ExecutorDagConfig, ExecutorDagResult } from '../../harness/dag/types';
import type { RunGoalResult } from '../../harness/goal/run-goal';
import type { ConductorPlan } from '../../harness/conductor-plan';

// S2 进程化 (SDD 2026-08-10): dag_run 用例走**进程内执行体** (生产里只在 dag-exec 子进程跑)。
beforeEach(() => { process.env.OMD_DAG_EXEC_CHILD = '1'; });
afterEach(() => { delete process.env.OMD_DAG_EXEC_CHILD; });

const stubResult = (planName: string, leavesIn: number, cacheHit: number): ExecutorDagResult =>
  ({
    plan: { name: planName, nodes: { root: { goal: 'x' } } } as unknown as ConductorPlan,
    sessionId: 's',
    levels: [['root']],
    results: { root: { id: 'root', status: 'done', kind: 'inproc', output: 'ok', deps: [], usage: { in: leavesIn, out: 1 } } },
    reusedNodes: [],
    usage: { conductor: { in: 5, out: 5 }, leavesIn, leavesOut: 1, leavesCacheHit: cacheHit },
  }) as unknown as ExecutorDagResult;

const runIdOf = (text: string): string => /runId: (\S+)/.exec(text)?.[1] ?? '';

describe('dag_goal 的运行留痕接线', () => {
  test('两段图各落一条, 同 runId 归组 —— 一次 goal 的账才算得出来', async () => {
    const recorder = createDagRecorder({ path: ':memory:' });
    const root = mkdtempSync(join(tmpdir(), 'omd-rec-'));
    const tool = createGoalTool({
      // 真 runGoal 先回传定稿分类, 再跑两张图 (契约段 + 执行段), 引擎各调一次 onComplete。
      // 这里照生产顺序驱动: 接线对了, 两条记录就带着同一个 runId 与探针结局落进库。
      runGoal: async (goal, cfg) => {
        cfg.onClassified?.({
          tier: 'simple',
          acceptance: { kind: 'executable', command: 'bun test', expectExit: 0 },
          acceptanceProbe: { kind: 'passed-both' },
        });
        await cfg.dag.onComplete?.(stubResult('goal-contract', 300, 120));
        await cfg.dag.onComplete?.(stubResult('goal-execute', 700, 400));
        return {
          goal,
          tier: 'simple',
          acceptance: { kind: 'executable', command: 'bun test', expectExit: 0 },
          stages: [],
          sources: [],
          repoContext: '',
          converged: true,
          outcome: 'success' as const,
          rounds: 1,
          reusedNodes: [],
        } satisfies RunGoalResult;
      },
      runRegistry: new RunRegistry(),
      cwd: root,
      buildConfig: () => ({ conductorModel: 'c:m', leafModel: 'l:m' }),
      recorder,
    });

    const out = (await tool.handler({ goal: '干点活' } as never, {} as never)) as { content: { text: string }[] };
    const runId = runIdOf(out.content[0]!.text);
    await Bun.sleep(5); // fire-and-forget

    const group = recorder.listByRun(runId);
    expect(group.map((r) => r.planName)).toEqual(['goal-contract', 'goal-execute']);
    expect(group.every((r) => r.question === '干点活')).toBe(true);
    // 入口是**一次调用**不是一张图: 两段都记 dag_goal, 读数板按 runId 去重才不会数成两次。
    expect(group.map((r) => r.entry)).toEqual(['solve', 'solve']); // entry 新词表 (t7)
    expect(group.map((r) => r.acceptanceProbe)).toEqual([{ kind: 'passed-both' }, { kind: 'passed-both' }]);
    // 这两个和数就是 G3 (这次多少钱) 与前缀缓存 (兄弟间命中多少) 的读数来源。
    expect(group.reduce((s, r) => s + r.usage.leavesIn, 0)).toBe(1000);
    expect(group.reduce((s, r) => s + r.usage.leavesCacheHit, 0)).toBe(520);
    recorder.close();
  });

  test('没给 recorder → 不记, 也不炸 (留痕是可选项, 不是执行前提)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omd-rec-'));
    let seen: ExecutorDagConfig | undefined;
    const tool = createGoalTool({
      runGoal: async (goal, cfg) => {
        seen = cfg.dag;
        return {
          goal, tier: 'simple', acceptance: { kind: 'executable', command: 'x', expectExit: 0 },
          stages: [], sources: [], repoContext: '', converged: true, rounds: 1, reusedNodes: [], outcome: 'success' as const,
        } satisfies RunGoalResult;
      },
      runRegistry: new RunRegistry(),
      cwd: root,
      buildConfig: () => ({ conductorModel: 'c:m', leafModel: 'l:m' }),
    });
    await tool.handler({ goal: 'x' } as never, {} as never);
    await Bun.sleep(5);
    expect(seen?.onComplete).toBeUndefined();
  });
});

describe('dag_run 的运行留痕接线', () => {
  const engineThatCompletes = (result: ExecutorDagResult): DagEngine => ({
    // 真引擎在返回前调 onComplete (executor-dag 末尾, 已 try/catch)。夹具照做。
    runExecutorDag: async (_task: string, config: ExecutorDagConfig) => {
      await config.onComplete?.(result);
      return result;
    },
    runExecutorDagWithPlan: async (_plan: ConductorPlan, config: ExecutorDagConfig) => {
      await config.onComplete?.(result);
      return result;
    },
  });

  test('跑完落一条, 带 runId 与任务文本', async () => {
    const recorder = createDagRecorder({ path: ':memory:' });
    const tools = createDagTools({
      engine: engineThatCompletes(stubResult('dag_run 的图', 42, 7)),
      runRegistry: new RunRegistry(),
      defaultConfig: { conductorModel: 'c:m', leafModel: 'l:m' },
      recorder,
    });
    const dagRun = tools.find((t) => t.name === 'dag_run')!;
    const out = (await dagRun.handler({ task: '把活干了' } as never, {} as never)) as { content: { text: string }[] };
    await Bun.sleep(5);

    const rows = recorder.listByRun(runIdOf(out.content[0]!.text));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.question).toBe('把活干了');
    expect(rows[0]!.usage.leavesCacheHit).toBe(7);
    expect(rows[0]!.entry).toBe('run'); // entry 新词表 (t7)
    recorder.close();
  });

  test('dag_run_plan 同样落 —— 两个入口各自组 config, 接线要接两处', async () => {
    // 第一版就漏了这一处的镜像: `dag_run` (conductor 路径) 与 `dag_run_plan` (预构造 plan 路径)
    // 是**两个各自组 config 的函数**, 只接一处的症状与完全没接一模一样 —— 换个工具就没记录。
    const recorder = createDagRecorder({ path: ':memory:' });
    const tools = createDagTools({
      engine: engineThatCompletes(stubResult('预构造图', 9, 3)),
      runRegistry: new RunRegistry(),
      defaultConfig: { conductorModel: 'c:m', leafModel: 'l:m' },
      recorder,
    });
    const dagRunPlan = tools.find((t) => t.name === 'dag_run_plan')!;
    const plan = JSON.stringify({ name: 'p', description: 'd', nodes: { root: { goal: 'g', executor: 'leaf' } } });
    const out = (await dagRunPlan.handler({ plan } as never, {} as never)) as { content: { text: string }[] };
    await Bun.sleep(5);

    const rows = recorder.listByRun(runIdOf(out.content[0]!.text));
    expect(rows).toHaveLength(1);
    // entry 复用 launchPlanRun 已有的 toolName —— 不是另造的一套分类法。
    expect(rows[0]!.entry).toBe('dag_run_plan');
    recorder.close();
  });
});

/**
 * `path_deliver` 的留痕接线 (2026-08-02 新接)。
 *
 * 它是四个**会真跑图**的入口里最后一个不进账本的。这一格空着的后果不是"少一列":
 * 「各入口占比」会**系统性看不见慢回路那一块**,而"缺一个入口"与"没人用这个入口"
 * 在读数上长得一模一样 —— 正是本文件头注说的那种沉默。
 *
 * ⚠ **这条网的边界**: 它钉的是 `path_deliver → executeSlice` 那一跳传对了 recorder/entry/runId。
 * `executeSlice` 内部把 `opts.entry` 转进 `record()` meta 的那几行**没有网**
 * (它要真跑 `iterateExecutorDag`,建夹具不成比例)。所以别把这条的绿读成"端到端记上了"。
 */
describe('path_deliver 的运行留痕接线', () => {
  test('把 recorder / entry / runId 传进 executeSlice —— 慢回路这条此前完全不进账本', async () => {
    const recorder = createDagRecorder({ path: ':memory:' });
    const dir = mkdtempSync(join(tmpdir(), 'omd-pf-rec-'));
    let seen: Record<string, unknown> | undefined;

    const deps: PathfinderToolDeps = {
      cwd: dir,
      env: {},
      models: { conductorModel: '', leafModel: 'fake:leaf' },
      agentRunner: (async () => ({ text: '', usage: { in: 0, out: 0 } })) as PathfinderToolDeps['agentRunner'],
      commandRunner: (async () => ({
        text: '', usage: { in: 0, out: 0 }, timedOut: false, signal: null, exitCode: 0,
      })) as PathfinderToolDeps['commandRunner'],
      dispatchFrontier: (() => ({ dispatched: [], reported: [] })) as unknown as PathfinderToolDeps['dispatchFrontier'],
      executeSlice: (async (plan: { nodes: Record<string, unknown> }, opts: Record<string, unknown>) => {
        seen = opts;
        return { results: Object.fromEntries(Object.keys(plan.nodes).map((id) => [id, { status: 'done' }])) };
      }) as unknown as PathfinderToolDeps['executeSlice'],
      recorder,
    };
    const byName = new Map(createPathfinderTools(deps).map((t) => [t.name, t]));
    const call = async (n: string, a: Record<string, unknown> = {}) =>
      (await byName.get(n)!.handler(a as never, {} as never)) as { content: { text: string }[]; isError?: boolean };

    await call('path_map', { destination: 'Ship X' });
    // #197: executorKind 显式给 ('inproc' 取代旧静默回落, 不撞 spec gate)
    await call('path_add', { title: 'build the thing', type: 'task', executorKind: 'inproc' });
    await call('path_rule', { ticketId: 't1', ruling: 'do it with bun' });
    const deliver = await call('path_deliver');

    expect(deliver.isError).not.toBe(true);
    expect(seen?.recorder).toBe(recorder);
    expect(seen?.entry).toBe('map_deliver'); // entry 新词表 (t7)
    // runId 现造: executeSlice 可能落多条 (iterate 每轮一张图), 没有共同 runId 就归不成"这一次交付"。
    expect(typeof seen?.runId).toBe('string');
    recorder.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('没给 recorder → 不传 recorder/entry, 也不炸 (留痕是可选项)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omd-pf-rec-'));
    let seen: Record<string, unknown> | undefined;
    const deps: PathfinderToolDeps = {
      cwd: dir,
      env: {},
      models: { conductorModel: '', leafModel: 'fake:leaf' },
      agentRunner: (async () => ({ text: '', usage: { in: 0, out: 0 } })) as PathfinderToolDeps['agentRunner'],
      commandRunner: (async () => ({
        text: '', usage: { in: 0, out: 0 }, timedOut: false, signal: null, exitCode: 0,
      })) as PathfinderToolDeps['commandRunner'],
      dispatchFrontier: (() => ({ dispatched: [], reported: [] })) as unknown as PathfinderToolDeps['dispatchFrontier'],
      executeSlice: (async (plan: { nodes: Record<string, unknown> }, opts: Record<string, unknown>) => {
        seen = opts;
        return { results: Object.fromEntries(Object.keys(plan.nodes).map((id) => [id, { status: 'done' }])) };
      }) as unknown as PathfinderToolDeps['executeSlice'],
    };
    const byName = new Map(createPathfinderTools(deps).map((t) => [t.name, t]));
    const call = async (n: string, a: Record<string, unknown> = {}) =>
      (await byName.get(n)!.handler(a as never, {} as never)) as { content: { text: string }[]; isError?: boolean };

    await call('path_map', { destination: 'Ship Y' });
    // #197: executorKind 显式给 ('inproc' 取代旧静默回落, 不撞 spec gate)
    await call('path_add', { title: 'x', type: 'task', executorKind: 'inproc' });
    await call('path_rule', { ticketId: 't1', ruling: 'go' });
    await call('path_deliver');

    // **不许编一个 entry** —— 没 recorder 时这两位一律缺席 (同 DagRunRecord.entry 的纪律)。
    expect(seen?.recorder).toBeUndefined();
    expect(seen?.entry).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('entry 缺席 ≠ 编造', () => {
  test('没传 entry 的记录读出来是 undefined, 不是 "unknown" —— 老行同理', () => {
    // 「这条链没接」与「跑了但认不出入口」结论相反: 前者是缺陷要去补接线, 后者是事实。
    // 编一个 'unknown' 会把前者伪装成后者, 读数板就再也报不出"还有入口没接"。
    const rec = createDagRecorder({ path: ':memory:' });
    const id = rec.record(stubResult('无入口的图', 1, 0), { runId: 'r-noentry' });
    expect(rec.get(id)!.entry).toBeUndefined();
    expect('entry' in rec.get(id)!).toBe(false);
    rec.close();
  });
});

/**
 * `omd_primitive` 的运行留痕接线 (T6, 2026-08-03) —— **第五个入口**, S0 当时刻意留的那格。
 *
 * S0 的理由是「它没有 runId, 记进去是无主的账」。今天不成立了: `dag_run` 早就是自己 `randomUUID`
 * 的成例, 而账本要回答的是"**哪个入口跑了一次**", 不是"调用方能不能拿这个 id 回来查"。
 * 一个从不落账的入口, 在 entry 分布里与"没人用这个入口"**长得一模一样**(D-AM 立 entry 必填时
 * 点名的就是这个形态)。
 *
 * ⚠ 边界同上: 这条钉的是 `omd_primitive → runPlan` 那一跳把 onComplete 挂上了、entry 是
 * `'omd_primitive'`、且**没有吃掉**调用方自己的 onComplete。引擎内部真调用 onComplete 那一段
 * 由 dag-record 自己的测试守。
 */
describe('omd_primitive 的运行留痕接线', () => {
  test('挂上 onComplete, entry=omd_primitive, 且不吃掉调用方自己的钩子', async () => {
    const recorder = createDagRecorder({ path: ':memory:' });
    let seenConfig: Record<string, unknown> | undefined;
    let prevCalled = false;
    const prev = (): void => void (prevCalled = true);

    const tools = createComposeTools({
      runPlan: (async (_plan: unknown, config: Record<string, unknown>) => {
        seenConfig = config;
        return { results: { p: { status: 'done', output: 'ok' } }, usage: {} };
      }) as never,
      baseConfig: () => ({ onComplete: prev }) as Record<string, unknown>,
      recorder,
    });
    const primitive = tools.find((t) => t.name === 'omd_primitive')!;
    const res = (await primitive.handler({ primitive: 'verify', params: { claim: 'x' } } as never, {} as never)) as {
      isError?: boolean;
    };
    expect(res.isError).not.toBe(true);

    // 留痕挂上了, 且**不是**调用方原来那个 (它被链在里面, 不是被替掉)。
    expect(typeof seenConfig?.onComplete).toBe('function');
    expect(seenConfig?.onComplete).not.toBe(prev);

    // 真跑一次 onComplete: 调用方的钩子仍被叫到, 账本落一条且 entry 对。
    await (seenConfig!.onComplete as (r: unknown) => Promise<void>)({
      plan: { name: 'primitive:verify', nodes: { p: { goal: 'x' } } },
      levels: [['p']],
      results: { p: { id: 'p', kind: 'inproc', status: 'done', deps: [], output: '', usage: { in: 0, out: 0 } } },
      usage: { conductor: { in: 0, out: 0 }, leavesIn: 0, leavesOut: 0, leavesCacheHit: 0 },
    });
    expect(prevCalled).toBe(true);
    const rows = recorder.list();
    expect(rows.length).toBe(1);
    expect(rows[0]!.entry).toBe('omd_primitive');
    recorder.close();
  });

  test('没给 recorder → 不挂 onComplete 留痕, 调用方的钩子原样在 (留痕是可选项)', async () => {
    let seenConfig: Record<string, unknown> | undefined;
    const prev = (): void => {};
    const tools = createComposeTools({
      runPlan: (async (_plan: unknown, config: Record<string, unknown>) => {
        seenConfig = config;
        return { results: { p: { status: 'done', output: 'ok' } }, usage: {} };
      }) as never,
      baseConfig: () => ({ onComplete: prev }) as Record<string, unknown>,
    });
    const primitive = tools.find((t) => t.name === 'omd_primitive')!;
    await primitive.handler({ primitive: 'verify', params: { claim: 'x' } } as never, {} as never);
    expect(seenConfig?.onComplete).toBe(prev); // 一个字都没动
  });
});
