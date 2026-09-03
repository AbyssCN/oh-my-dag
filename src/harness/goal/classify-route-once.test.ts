/**
 * src/harness/goal/classify-route-once.test —— INV-12 (D-19, 2026-09-02)
 *
 * 默认路径动手前的 LLM 调用恰 1 次(classify 与 route 合成的那一次),
 * `chain-router.ts` 的 `routeChain` 在默认路径上零调用。
 *
 * 2026-09-03 v1 / chain 梯子退役后 run-goal 已没有任何调 `routeChain` 的分支 (`solve` 入参 `chain` 一并删),
 * 所以第二条断言今天由构造成立; 留着它是绊线 —— 谁把 routeChain 接回 run-goal, 这里当场红。
 * 第一条 (classifyCalls 恰 1) 仍有判别力: 把 classify 拆成两次调用即红。
 */
import { describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGoal } from './run-goal';
import type { GoalClassification } from './classify-acceptance';
import * as chainRouter from './chain-router';
import type { ConductorPlan } from '../conductor-plan';
import type { ExecutorDagConfig, ExecutorDagResult } from '../dag/types';

const executeDag = (): ExecutorDagResult =>
  ({
    plan: { name: 'goal-orchestrating-loop', nodes: {} },
    results: {
      // 判据轴用了 executable → execPlan 上多一个环外 `accept` 节点 (D-I), 假图得带它一起过,
      // 否则"没有 accept 结果"会被读成"没被证明过就不算成", 与本文件要测的东西无关地拉低 converged。
      accept: { id: 'accept', status: 'done', kind: 'command', output: '', deps: ['conductor'], usage: { in: 0, out: 0 }, timedOut: false, signal: null },
      conductor: { id: 'conductor', status: 'done', kind: 'agent', output: 'ok', deps: [], usage: { in: 1, out: 1 }, },
    },
    reusedNodes: [],
  }) as unknown as ExecutorDagResult;

describe('INV-12 —— classify 与 route 合成一次调用, routeChain 默认路径零调用', () => {
  test('★ deps.call (classify) 计数恰 1 次; chain 分支不再独立调 routeChain', async () => {
    const routeChainSpy = spyOn(chainRouter, 'routeChain');
    let classifyCalls = 0;
    const cwd = mkdtempSync(join(tmpdir(), 'omd-route-once-'));

    const r = await runGoal('给 omd 加个 D4 路由测试', {
      cwd,
      dag: { conductorModel: 'c:m', leafModel: 'l:m' } as ExecutorDagConfig,
      _classify: async (): Promise<GoalClassification> => {
        classifyCalls++;
        return {
          tier: 'complex',
          acceptance: { kind: 'executable', command: 'bun test', expectExit: 0 },
          route: { kind: 'none' },
        };
      },
      _runDag: async (plan: ConductorPlan) => {
        expect(plan.name).toBe('goal-orchestrating-loop'); // 到这里之前不该有第二张图
        return executeDag();
      },
    });

    expect(classifyCalls).toBe(1); // 动手前 LLM 调用恰 1 次 (INV-12)
    expect(routeChainSpy).not.toHaveBeenCalled(); // routeChain 在默认路径上零调用
    expect(r.converged).toBe(true);

    routeChainSpy.mockRestore();
  });

  test('对照: classified.route 缺席 (老续跑状态没有这一格) → 兜底 none, 仍不调 routeChain', async () => {
    const routeChainSpy = spyOn(chainRouter, 'routeChain');
    const cwd = mkdtempSync(join(tmpdir(), 'omd-route-once-legacy-'));

    const r = await runGoal('目标丙', {
      cwd,
      dag: { conductorModel: 'c:m', leafModel: 'l:m' } as ExecutorDagConfig,
      // 老续跑状态没有 route 这一格 (加这个字段之前写的 GoalClassification) ——
      // `route` 干脆不传, 消费侧必须 `?? {kind:'none'}` 兜底, 不能因此去调 routeChain 补一次。
      _classify: async (): Promise<GoalClassification> => ({
        tier: 'complex',
        acceptance: { kind: 'executable', command: 'bun test', expectExit: 0 },
      }),
      _runDag: async () => executeDag(),
    });

    expect(routeChainSpy).not.toHaveBeenCalled();
    expect(r.converged).toBe(true);

    routeChainSpy.mockRestore();
  });
});
