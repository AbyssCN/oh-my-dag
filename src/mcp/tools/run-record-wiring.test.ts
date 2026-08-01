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
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGoalTool } from './goal';
import { createDagTools, type DagEngine } from './dag-tools';
import { RunRegistry } from '../run-registry';
import { createDagRecorder } from '../../harness/dag-record';
import type { ExecutorDagConfig, ExecutorDagResult } from '../../harness/executor-dag-types';
import type { RunGoalResult } from '../../harness/goal/run-goal';
import type { ConductorPlan } from '../../harness/conductor-plan';

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
      // 真 runGoal 会跑两张图 (契约段 + 执行段), 引擎在每张跑完时各调一次 onComplete。
      // 这里照那个形状驱动: 接线对了, 两条记录就带着同一个 runId 落进库。
      runGoal: async (goal, cfg) => {
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

    expect(recorder.listByRun(runIdOf(out.content[0]!.text))).toHaveLength(1);
    recorder.close();
  });
});
