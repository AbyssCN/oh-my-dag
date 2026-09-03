/**
 * P3 S2 —— `LeafResult.acceptance` 的引擎侧三态落账 (镜像 engine-self-check-wiring.test.ts 的 G-2 段)。
 *
 *   · 没派判据 → 键缺席;
 *   · 派了、leaf 没报 → 键缺席 (+ 一行 WARN), **不编 null**;
 *   · 派了、leaf 报了 → 对象深等。
 *
 * 证伪方式: 把 engine.ts 里 `if (r.acceptance !== undefined) acceptance = r.acceptance;` 改成
 * `acceptance = r.acceptance ?? null` → 第二格当场红 (缺席被顶成 null, 正是仓规 §静默坑 1 的形状)。
 */
import { describe, expect, test } from 'bun:test';
import { runExecutorDagWithPlan } from './engine';
import type { ConductorPlan } from '../conductor-plan';
import type { ExecutorDagConfig, GenerateFn } from './types';
import type { AgentLeafInput, AgentLeafResult } from '../leaf-runners';

const SPEC = { command: 'exit 3', expect_exit: 0 } as const;
const generate: GenerateFn = async () => ({ text: 'unused', usage: { in: 0, out: 0 } });

const mkCfg = (runner: (input: AgentLeafInput) => Promise<AgentLeafResult>): ExecutorDagConfig => ({
  conductorModel: 't:cond',
  leafModel: 't:leaf',
  agentLeafModel: 't:leaf',
  generate,
  agentRunner: runner,
});

const planMixed = (): ConductorPlan => ({
  name: 'acc-wiring',
  nodes: {
    a: { executor: 'agent', goal: '带判据', self_check: { ...SPEC } },
    b: { executor: 'agent', goal: '不带判据' },
  },
});

const runner = (result: (input: AgentLeafInput) => Partial<AgentLeafResult>) =>
  async (input: AgentLeafInput): Promise<AgentLeafResult> => {
    const id = /\[omd leaf: ([^\]]+)\]/.exec(input.prompt)?.[1] ?? '?';
    return { text: `out:${id}`, usage: { in: 1, out: 1 }, filesTouched: [], ...result(input) };
  };

describe('P3 S2 · LeafResult.acceptance 三态落账', () => {
  test('★ 没派判据的节点 → 键缺席', async () => {
    const r = await runExecutorDagWithPlan(planMixed(), mkCfg(runner(() => ({}))));
    expect('acceptance' in r.results.b!).toBe(false);
  });

  test('★ 派了判据但 leaf 没报 → 键缺席, 不编 null', async () => {
    const r = await runExecutorDagWithPlan(planMixed(), mkCfg(runner(() => ({}))));
    expect('acceptance' in r.results.a!).toBe(false);
  });

  test('★ 派了判据且 leaf 报了 → 对象深等 (ran/rounds/last 原样透传)', async () => {
    const ledger = { ran: true, rounds: 2, last: { kind: 'exited' as const, verdict: 'green' as const, command: 'exit 3', ran: 'exit 3', exitCode: 0, expectExit: 0, tail: '', failSet: [] } };
    const r = await runExecutorDagWithPlan(planMixed(), mkCfg(runner((input) => (input.self_check ? { acceptance: ledger } : {}))));
    expect(r.results.a!.acceptance).toEqual(ledger);
    expect('acceptance' in r.results.b!).toBe(false);
  });

  test('派了判据, leaf 报 null (作用域缺席) → 原样落 null, 与缺席分得开', async () => {
    const r = await runExecutorDagWithPlan(planMixed(), mkCfg(runner((input) => (input.self_check ? { acceptance: null } : {}))));
    expect(r.results.a!.acceptance).toBeNull();
    expect('acceptance' in r.results.a!).toBe(true);
  });
});
