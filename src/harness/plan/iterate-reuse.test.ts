/**
 * iterate 跨轮复用 — INV-GOAL-3 (自主 goal-engine P1)。
 *
 * 契约: 修复轮**只重跑污染节点**, 未污染的已批准制品被复用 (reuse 计数 > 0, 可证)。
 *
 * P1 前这条根本没落地: iterateExecutorDag 每轮调 runDag 从不传 prior → 复用只在**轮内**
 * escalation 生效, 外层 fixpoint 每轮都是整图重跑。这里钉的就是那个缺口。
 */
import { describe, expect, test } from 'bun:test';
import { iterateExecutorDag } from './iterate';
import { runExecutorDagWithPlan } from '../executor-dag';
import type { ConductorPlan } from '../conductor-plan';
import type { ExecutorDagConfig, ExecutorDagResult, GenerateFn, PriorExec } from '../executor-dag-types';

const stub = (plan: ConductorPlan, ids: string[], reused: string[] = []): ExecutorDagResult =>
  ({
    plan,
    sessionId: 's',
    levels: [ids],
    results: Object.fromEntries(
      ids.map((id) => [id, { id, status: 'done', kind: 'inproc', output: `out:${id}`, deps: [], usage: { in: 1, out: 1 } }]),
    ),
    reusedNodes: reused,
    usage: { conductor: { in: 0, out: 0 }, leavesIn: 0, leavesOut: 0, leavesCacheHit: 0 },
  }) as unknown as ExecutorDagResult;

const twoNodePlan: ConductorPlan = {
  name: 'p',
  nodes: { a: { goal: '不变的活' }, b: { goal: '要修的活' } },
};

describe('iterateExecutorDag 跨轮复用 (INV-GOAL-3)', () => {
  test('第 2 轮拿到上一轮的 prior (语义没变的节点才复用得起来)', async () => {
    const priors: (PriorExec | undefined)[] = [];
    let round = 0;
    await iterateExecutorDag('修好它', {
      conductorModel: 'c:m',
      leafModel: 'l:m',
      maxRounds: 2,
      // 第 1 轮判不收敛 → 进第 2 轮; 第 2 轮收敛收工。
      judge: async () => ({ converged: ++round >= 2, score: round, reason: 'r' }),
      _runDag: async (_task, _cfg, prior) => {
        priors.push(prior);
        return stub(twoNodePlan, ['a', 'b']);
      },
    });
    expect(priors).toHaveLength(2);
    expect(priors[0]).toBeUndefined(); // 首轮无上轮
    expect(priors[1]?.plan).toBe(twoNodePlan);
    expect(priors[1]?.results.a?.output).toBe('out:a');
  });

  test('crossRoundReuse:false → 每轮从零 (A/B 对照口子)', async () => {
    const priors: (PriorExec | undefined)[] = [];
    let round = 0;
    await iterateExecutorDag('t', {
      conductorModel: 'c:m',
      leafModel: 'l:m',
      maxRounds: 2,
      crossRoundReuse: false,
      judge: async () => ({ converged: ++round >= 2, score: round, reason: 'r' }),
      _runDag: async (_task, _cfg, prior) => {
        priors.push(prior);
        return stub(twoNodePlan, ['a', 'b']);
      },
    });
    expect(priors.every((p) => p === undefined)).toBe(true);
  });
});

describe('runExecutorDagWithPlan + prior — 复用真的零 LLM (端到端)', () => {
  test('语义未变的节点复用上轮输出, 变了的节点重跑; reusedNodes 可证', async () => {
    const calls: string[] = [];
    const generate: GenerateFn = async (req) => {
      const user = req.messages.find((m) => m.role === 'user');
      const text = typeof user?.content === 'string' ? user.content : '';
      const id = /\[omd leaf: ([^\]]+)\]/.exec(text)?.[1] ?? '?';
      calls.push(id);
      return { text: `fresh:${id}`, usage: { in: 1, out: 1 } };
    };
    const cfg: ExecutorDagConfig = {
      conductorModel: 'c:m',
      leafModel: 'l:m',
      generate,
      agentTemplates: new Map(),
    };
    // 轮 1: a + b 都真跑
    const r1 = await runExecutorDagWithPlan(twoNodePlan, cfg);
    expect(calls).toEqual(['a', 'b']);
    expect(r1.reusedNodes).toEqual([]);

    // 轮 2: 只有 b 的 goal 变了 (污染) → a 复用, b 重跑
    // 轮 2 对照组: 不传 prior = 整图重跑
    calls.length = 0;
    const round2: ConductorPlan = { name: 'p', nodes: { a: { goal: '不变的活' }, b: { goal: '修过的活' } } };
    const r2 = await runExecutorDagWithPlan(round2, cfg);
    expect(calls).toEqual(['a', 'b']);
    expect(r2.reusedNodes).toEqual([]);

    // 轮 2 实验组: 传 prior → 只有污染的 b 重跑
    calls.length = 0;
    const r3 = await runExecutorDagWithPlan(round2, cfg, { plan: r1.plan, results: r1.results });
    expect(calls).toEqual(['b']);
    expect(r3.reusedNodes).toEqual(['a']);
    expect(r3.results.a?.output).toBe('fresh:a'); // 上轮输出原样注入, 零 LLM
    expect(r3.results.a?.skipped).toBe(true);
  });
});
