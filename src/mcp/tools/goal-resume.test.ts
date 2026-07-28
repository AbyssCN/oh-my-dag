/**
 * `dag_goal` 的 continuity 接线 (INV-P2-6) —— 外层 journal 得**够得着**才算落地。
 *
 * 这条测试存在的理由: 持久化机制写完时, goal 那条路根本没往 iterate 传 continuity,
 * 于是 `_fixpoint.json` 永远不会被写 —— 又一个"有实现、零调用方"的空旋钮
 * (正是 D-11 刚清掉的形态)。这里钉住接线本身。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGoalTool } from './goal';
import { RunRegistry } from '../run-registry';
import { CheckpointManager } from '../../harness/continuity/checkpoint-manager';
import type { ExecutorDagConfig } from '../../harness/executor-dag-types';
import type { RunGoalResult } from '../../harness/goal/run-goal';

const emptyResult = (goal: string): RunGoalResult => ({
  goal,
  tier: 'simple',
  stages: [],
  sources: [],
  repoContext: '',
  converged: true,
  rounds: 1,
  reusedNodes: [],
});

/** 造工具 + 回收 runGoal 实际拿到的 dag config。 */
const make = (withContinuity = true) => {
  const seen: { dag?: ExecutorDagConfig }[] = [];
  const root = mkdtempSync(join(tmpdir(), 'omd-goal-'));
  const tool = createGoalTool({
    runGoal: async (goal, cfg) => {
      seen.push({ dag: cfg.dag });
      return emptyResult(goal);
    },
    runRegistry: new RunRegistry(),
    cwd: root,
    buildConfig: () => ({ conductorModel: 'c:m', leafModel: 'l:m' }),
    ...(withContinuity ? { continuity: { manager: new CheckpointManager(root), repoRoot: root } } : {}),
  });
  return { tool, seen };
};

const call = (tool: ReturnType<typeof createGoalTool>, args: Record<string, unknown>) =>
  tool.handler(args as never, {} as never) as Promise<{ content: { text: string }[]; isError?: boolean }>;

const runIdOf = (text: string): string => /runId: (\S+)/.exec(text)?.[1] ?? '';

describe('dag_goal 外层 journal 接线', () => {
  test('常态: continuity 传进 dag config, runId 一致, 不开 resume', async () => {
    const { tool, seen } = make();
    const out = await call(tool, { goal: '干点活' });
    const text = out.content[0]!.text;
    await Bun.sleep(1); // fire-and-forget
    const c = seen[0]?.dag?.continuity;
    expect(c).toBeDefined();
    expect(c!.runId).toBe(runIdOf(text));
    expect(c!.resume).toBeUndefined(); // 新跑不读 journal
  });

  test('resume=<runId>: 复用同一个 runId 并开 resume (换 id 等于从零开始)', async () => {
    const { tool, seen } = make();
    const out = await call(tool, { goal: '接着干', resume: 'run-abc' });
    await Bun.sleep(1);
    expect(out.content[0]!.text).toContain('run-abc');
    expect(seen[0]?.dag?.continuity?.runId).toBe('run-abc');
    expect(seen[0]?.dag?.continuity?.resume).toBe(true);
  });

  test('没配 continuity 时 resume 响亮拒绝 (不静默当新跑)', async () => {
    const { tool, seen } = make(false);
    const out = await call(tool, { goal: 'x', resume: 'run-abc' });
    expect(out.isError).toBe(true);
    expect(out.content[0]!.text).toContain('resume 需要 continuity');
    expect(seen).toHaveLength(0); // 没偷偷起跑
  });

  test('没配 continuity 的常态跑仍能起 (零回归)', async () => {
    const { tool, seen } = make(false);
    await call(tool, { goal: 'x' });
    await Bun.sleep(1);
    expect(seen[0]?.dag?.continuity).toBeUndefined();
  });
});
