/**
 * src/harness/goal/chain-first-wiring.test —— P3 S7: D4 路由默认开 + route 槽合进 classify 那一发 (契约 D-17 / D-19 / INV-12)。
 *
 * 反向自检:
 *  · `chainEnabled` 缺省改回 opt-in → 「缺省开」那条红;
 *  · run-goal 把 chain 档挪回 flat-first 之后 → 「chain > flat-first」那条红 (flatFirst 开时 chain 命中仍该赢);
 *  · normalizeClassification 不套 parseRouteRaw → 越界 route 不再钳成 none, 那条红;
 *  · classifyPrompt 删掉判断三 → prompt 断言红。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConductorPlan } from '../conductor-plan';
import type { ExecutorDagConfig, ExecutorDagResult } from '../dag/types';
import { classifyGoal, classifyPrompt, normalizeClassification, type GoalClassification } from './classify-acceptance';
import { chainEnabled, runGoal, type RunGoalConfig } from './run-goal';
import type { StageChain } from './stage-chain';

const CHAIN: StageChain = {
  stages: [
    { id: 'impl', word: 'agent', goal: 'implement add() in src/a.ts' },
    { id: 'check', word: 'command', command: 'bun test src/a.test.ts' },
  ],
};

const EXEC_ACCEPT: GoalClassification['acceptance'] = { kind: 'executable', command: 'bun test src/a.test.ts', expectExit: 0 };

/** 假引擎: 记 plan; 所有节点 done (accept 也绿)。 */
const fakeEngine = (seen: ConductorPlan[]): NonNullable<RunGoalConfig['_runDag']> => async (plan) => {
  seen.push(plan);
  const results: ExecutorDagResult['results'] = {};
  for (const id of Object.keys(plan.nodes)) {
    const n = plan.nodes[id]!;
    results[id] = {
      id, status: 'done', kind: n.executor === 'command' ? 'command' : n.executor === 'conductor' ? 'conductor' : 'agent',
      output: 'ok', deps: n.depends_on ?? [], usage: { in: 1, out: 1 }, ...(n.executor === 'conductor' ? { rounds: 1, converged: true } : {}), ...(n.executor === 'command' ? { exitCode: 0 } : {}),
    } as never;
  }
  return { plan, sessionId: 's', levels: [], results, usage: { conductor: { in: 0, out: 0 }, leavesIn: 1, leavesOut: 1, leavesCacheHit: 0 }, reusedNodes: [], observations: [] } as unknown as ExecutorDagResult;
};

const cfg = (cwd: string, route: GoalClassification['route'], extra: Partial<RunGoalConfig>, seen: ConductorPlan[]): RunGoalConfig =>
  ({
    cwd,
    dag: { conductorModel: 'c:m', leafModel: 'l:m' } as ExecutorDagConfig,
    orchestratingLoop: false,
    _classify: async (): Promise<GoalClassification> => ({ tier: 'complex', acceptance: EXEC_ACCEPT, route }),
    _runDag: fakeEngine(seen),
    ...extra,
  }) as RunGoalConfig;

describe('chainEnabled — 缺省开 (D-17), env 0/false/off 关, config 布尔压过 env', () => {
  test('矩阵', () => {
    expect(chainEnabled({}, {})).toBe(true);
    expect(chainEnabled({}, { OMD_CHAIN: '1' })).toBe(true);
    expect(chainEnabled({}, { OMD_CHAIN: '0' })).toBe(false);
    expect(chainEnabled({}, { OMD_CHAIN: 'false' })).toBe(false);
    expect(chainEnabled({}, { OMD_CHAIN: 'off' })).toBe(false);
    expect(chainEnabled({ chain: false }, { OMD_CHAIN: '1' })).toBe(false);
    expect(chainEnabled({ chain: true }, { OMD_CHAIN: '0' })).toBe(true);
  });
});

describe('runGoal — loop 关 + chain 缺省开: route 命中 chain ⇒ compileChain 产物进 execPlan (D-17 第三档)', () => {
  test('★ 命中: plan 名 = stage-chain:…, path=chain, 无 generate 调用 (拓扑来自编译器)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-chain-hit-'));
    const seen: ConductorPlan[] = [];
    let gen = 0;
    const r = await runGoal('先实现再验证', cfg(cwd, { kind: 'chain', chain: CHAIN }, { dag: { conductorModel: 'c:m', leafModel: 'l:m', generate: (async () => { gen++; return { text: '', usage: { in: 0, out: 0 } }; }) as never } as ExecutorDagConfig }, seen));
    expect(seen).toHaveLength(1);
    expect(seen[0]!.name.startsWith('stage-chain:')).toBe(true);
    expect(r.path).toBe('chain');
    expect(gen).toBe(0);
  });

  test('未命中 (route none) ⇒ 落 v1 conductor (goal-execute), path=v1', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-chain-none-'));
    const seen: ConductorPlan[] = [];
    const r = await runGoal('修 add()', cfg(cwd, { kind: 'none' }, {}, seen));
    expect(seen[0]!.name).toBe('goal-execute');
    expect(r.path).toBe('v1');
  });

  test('chain:false 显式关 ⇒ 命中也不路由 (走 v1)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-chain-off-'));
    const seen: ConductorPlan[] = [];
    const r = await runGoal('先实现再验证', cfg(cwd, { kind: 'chain', chain: CHAIN }, { chain: false }, seen));
    expect(seen[0]!.name).toBe('goal-execute');
    expect(r.path).toBe('v1');
  });

  test('chain > flat-first: flatFirst 开且 route 命中 ⇒ 仍走 chain, 轻规划 generate 零调用', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-chain-vs-flat-'));
    const seen: ConductorPlan[] = [];
    let gen = 0;
    const r = await runGoal('先实现再验证', cfg(cwd, { kind: 'chain', chain: CHAIN }, { flatFirst: true, dag: { conductorModel: 'c:m', leafModel: 'l:m', generate: (async () => { gen++; return { text: '', usage: { in: 0, out: 0 } }; }) as never } as ExecutorDagConfig }, seen));
    expect(seen[0]!.name.startsWith('stage-chain:')).toBe(true);
    expect(r.path).toBe('chain');
    expect(gen).toBe(0);
  });

  test('loop 开 ⇒ chain 恒截胡 (循环是默认档, chain 只在对照臂上量)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-chain-loop-'));
    const seen: ConductorPlan[] = [];
    const r = await runGoal('先实现再验证', cfg(cwd, { kind: 'chain', chain: CHAIN }, { orchestratingLoop: true }, seen));
    expect(seen[0]!.name).toBe('goal-orchestrating-loop');
    expect(r.path).toBe('orchestrating-loop');
  });
});

describe('classify route 槽 — 同一发结构化调用带出, parseRouteRaw 钳 (D-19 / INV-6)', () => {
  test('prompt 有判断三 + 形状里有 route', () => {
    const p = classifyPrompt('修 add()');
    expect(p).toContain('判断三 `route`');
    expect(p).toContain('"route"?:');
  });

  test('normalize: 缺席 → none; 合法 chain → 原样; 越界 kind / 空 stages → none', () => {
    const base = { tier: 'complex', acceptance_kind: 'exploratory', learning_goal: 'x', affordable_loss: 'y' };
    expect(normalizeClassification(base).route).toEqual({ kind: 'none' });
    expect(normalizeClassification({ ...base, route: { kind: 'chain', chain: CHAIN } }).route).toEqual({ kind: 'chain', chain: CHAIN });
    // 证伪: 去掉 parseRouteRaw → 下面两条原样透传, 红。
    expect(normalizeClassification({ ...base, route: { kind: 'bogus' } }).route).toEqual({ kind: 'none' });
    expect(normalizeClassification({ ...base, route: { kind: 'chain', chain: { stages: [] } } }).route).toEqual({ kind: 'none' });
  });
});

describe('R-1: classifyGoal 记动手前 LLM 调用数', () => {
  test('一发即成 ⇒ llmCalls 1; 缺 generate ⇒ null', async () => {
    let n = 0;
    const generate = (async () => { n++; return { text: '{"tier":"simple","acceptance_kind":"exploratory","learning_goal":"x","affordable_loss":"y"}', usage: { in: 0, out: 0 } }; }) as never;
    const c = await classifyGoal('研究一下', { generate, model: 'c:m' });
    expect(c.llmCalls).toBe(1);
    expect(n).toBe(1);
    const none = await classifyGoal('研究一下', {});
    expect(none.llmCalls).toBeNull();
  });
});
