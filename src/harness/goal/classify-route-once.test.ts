/**
 * src/harness/goal/classify-route-once.test —— INV-12 (D-19, 2026-09-02)
 *
 * 默认路径动手前的 LLM 调用恰 1 次(classify 与 route 合成的那一次),
 * `chain-router.ts` 的 `routeChain` 在默认路径上零调用。
 *
 * 场景选 `chain: true` 才有判别力 —— chain 关着时 `routeChain` 今天也从不会被调 (chainOn
 * 默认 false), 那样测不出"合并"这件事真的发生了。开着 chain 走到那个分支, 才是唯一一处
 * 旧代码会真去调 `routeChain` 的地方 (run-goal.ts:1732 起的 `else if (chainOn && runnable)`)。
 *
 * 反向自检 (证伪方式): 把 run-goal.ts 该分支里的
 *   `const decision = classified.route ?? { kind: 'none' };`
 * 改回旧写法
 *   `const decision = await routeChain(goal, {...});`
 * → 本文件两条断言都当场红 (classifyCalls 仍是 1 没变, 但 routeChainSpy 从零调用变成一次调用;
 *   若同时把 classify 拆成两次调用, `classifyCalls` 也会变 2)。
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
import { pinLegacyExecutionPath } from './pin-legacy-path';

// P3 S6b (2026-09-02): 本文件钉 P3 之前的执行路径 (fake _runDag 产 `execute` 节点); 循环路径的判据见 orchestrating-loop.test.ts。
pinLegacyExecutionPath();

const executeDag = (): ExecutorDagResult =>
  ({
    plan: { name: 'goal-execute', nodes: {} },
    results: {
      // 判据轴用了 executable → execPlan 上多一个环外 `accept` 节点 (D-I), 假图得带它一起过,
      // 否则"没有 accept 结果"会被读成"没被证明过就不算成", 与本文件要测的东西无关地拉低 converged。
      accept: { id: 'accept', status: 'done', kind: 'command', output: '', deps: ['execute'], usage: { in: 0, out: 0 }, timedOut: false, signal: null },
      execute: { id: 'execute', status: 'done', kind: 'conductor', output: 'ok', deps: [], usage: { in: 1, out: 1 }, rounds: 1, converged: true },
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
      // chain 开 —— 旧代码在这条分支上会额外调一次 routeChain (今天 chainOn 默认关,
      // 所以必须显式开它, 不然这条测试测不出"合并"到底发生没发生, 见文件头注)。
      chain: true,
      _classify: async (): Promise<GoalClassification> => {
        classifyCalls++;
        return {
          tier: 'complex',
          acceptance: { kind: 'executable', command: 'bun test', expectExit: 0 },
          route: { kind: 'none' },
        };
      },
      _runDag: async (plan: ConductorPlan) => {
        expect(plan.name).toBe('goal-execute'); // 到这里之前不该有第二张图
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
      chain: true,
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
