/**
 * debug/run-debug 测试 —— 三振纪律 + judge 收敛早停 + priorRefuted 反馈进下轮 plan
 * + codegraph 探测/复现注入。全注入(_runDag/_probeCodegraph/_runRepro)→ 不碰 live 模型 / 真 shell。
 */
import { describe, expect, test } from 'bun:test';
import { runDebug } from './run-debug';
import { JUDGE_NODE_ID, HYPOTHESES_NODE_ID } from './debug-plan';
import type { ExecutorDagResult } from '../executor-dag-types';

/** 造一个 fake DAG 结果: 给 judge 输出 + 若干假设子节点裁决。 */
function fakeResult(judgeOutput: string, verdicts: Record<string, string> = {}): ExecutorDagResult {
  const results: Record<string, unknown> = {
    [JUDGE_NODE_ID]: { id: JUDGE_NODE_ID, status: 'done', kind: 'inproc', output: judgeOutput, deps: [HYPOTHESES_NODE_ID], usage: {} },
  };
  for (const [key, verdict] of Object.entries(verdicts)) {
    const id = `${HYPOTHESES_NODE_ID}::${key}`;
    results[id] = { id, status: 'done', kind: 'agent', output: `VERDICT: ${verdict}\n...`, deps: [], usage: {} };
  }
  return { results, plan: { name: 'dag-debug', nodes: {} }, sessionId: 's', levels: [], usage: {} } as unknown as ExecutorDagResult;
}

const NOOP_PROBE = () => true;
const BASE = { failure: '订单越权读取', cwd: '/repo', dagConfig: {} as never, _probeCodegraph: NOOP_PROBE } as const;

describe('runDebug', () => {
  test('judge CONFIRMED 第一轮 → root-cause 早停', async () => {
    const r = await runDebug({
      ...BASE,
      _runDag: async () => fakeResult('ROOT_CAUSE: CONFIRMED missing-scope-filter\n根因: ...', { 'missing-scope-filter': 'CONFIRMED' }),
    });
    expect(r.status).toBe('root-cause');
    expect(r.rounds).toBe(1);
    expect(r.rootCause).toContain('CONFIRMED missing-scope-filter');
    expect(r.ruledOut).toEqual([]); // 首轮即中, 无排除累积
  });

  test('三振全 NONE → exhausted, 升 owner', async () => {
    let calls = 0;
    const r = await runDebug({
      ...BASE,
      _runDag: async () => { calls++; return fakeResult(`ROOT_CAUSE: NONE\n已排除第${calls}轮`, { h1: 'REJECTED' }); },
    });
    expect(r.status).toBe('exhausted');
    expect(r.rounds).toBe(3);
    expect(calls).toBe(3); // 跑满三振
    expect(r.ruledOut.length).toBe(3);
    expect(r.reportMarkdown).toContain('升 owner');
    expect(r.reportMarkdown).toContain('无根因不修');
  });

  test('NONE 后 CONFIRMED → 第二轮早停, 携第一轮排除', async () => {
    let calls = 0;
    const r = await runDebug({
      ...BASE,
      _runDag: async () => {
        calls++;
        return calls === 1
          ? fakeResult('ROOT_CAUSE: NONE\n索引假设排除')
          : fakeResult('ROOT_CAUSE: CONFIRMED race-cond\n根因: 竞态');
      },
    });
    expect(r.status).toBe('root-cause');
    expect(r.rounds).toBe(2);
    expect(r.ruledOut.length).toBe(1); // 第一轮 NONE 进排除
    expect(r.ruledOut[0]).toContain('索引假设排除');
  });

  test('priorRefuted 反馈: 第二轮 plan 的 lister goal 含第一轮排除清单', async () => {
    const listerGoals: string[] = [];
    let calls = 0;
    await runDebug({
      ...BASE,
      _runDag: async (plan) => {
        calls++;
        const map = (plan.nodes[HYPOTHESES_NODE_ID] as unknown as { map: { lister: { goal: string } } }).map;
        listerGoals.push(map.lister.goal);
        return fakeResult('ROOT_CAUSE: NONE\n第一轮独有标记XYZ');
      },
    });
    expect(calls).toBe(3);
    expect(listerGoals[0]).not.toContain('第一轮独有标记XYZ'); // 首轮无反馈
    expect(listerGoals[1]).toContain('第一轮独有标记XYZ'); // 第二轮带上一轮排除
  });

  test('codegraph 探测 false → 报告标降级', async () => {
    const r = await runDebug({
      ...BASE,
      _probeCodegraph: () => false,
      _runDag: async () => fakeResult('ROOT_CAUSE: CONFIRMED x'),
    });
    expect(r.cgAvailable).toBe(false);
    expect(r.reportMarkdown).toContain('降级');
  });

  test('--repro 给 → 跑复现, red 进报告; 不给 → 不跑', async () => {
    let reproCalls = 0;
    const withRepro = await runDebug({
      ...BASE,
      reproCmd: 'bun test x',
      _runRepro: async (cmd) => { reproCalls++; return `[exit 1] ${cmd} 失败断言`; },
      _runDag: async () => fakeResult('ROOT_CAUSE: CONFIRMED x'),
    });
    expect(reproCalls).toBe(1);
    expect(withRepro.redEvidence).toContain('失败断言');
    expect(withRepro.reportMarkdown).toContain('red 证据');

    const noRepro = await runDebug({
      ...BASE,
      _runRepro: async () => { reproCalls++; return 'should-not-run'; },
      _runDag: async () => fakeResult('ROOT_CAUSE: CONFIRMED x'),
    });
    expect(reproCalls).toBe(1); // 未再触发
    expect(noRepro.redEvidence).toBeUndefined();
  });

  test('空 failure → 抛', async () => {
    await expect(runDebug({ ...BASE, failure: '  ', _runDag: async () => fakeResult('x') })).rejects.toThrow();
  });
});
