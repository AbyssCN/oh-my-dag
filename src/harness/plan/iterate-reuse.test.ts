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
import { runExecutorDagWithPlan } from '../dag/engine';
import { merkleFingerprints } from '../plan-passes/semantic-key';
import type { ConductorPlan } from '../conductor-plan';
import type { ExecutorDagConfig, ExecutorDagResult, GenerateFn, PriorExec } from '../dag/types';

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
      // 带票 (rejectedNodes): D-4 之后, 拒了却一张票都开不出的轮次整体不复用 —— 见下面 fail-closed 组。
      judge: async () => ({ converged: ++round >= 2, score: round, reason: 'r', rejectedNodes: ['b'] }),
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

/**
 * D-4 毒集 (P1.5) — 「done 但被拒」不得复用。
 *
 * 上面那组钉的是"语义变了就重跑"; 这组钉的是它**挡不住**的那一半: 节点跑完了 (status='done')、
 * 字段一个没变 (指纹命中), 但产出被 review/judge 判为错的。没有毒集, 修复轮会把被拒的产出原样
 * 注入, 修不修得对全看 conductor 有没有从散文里猜中该改哪个节点。
 */
describe('D-4 指纹毒集 — 被拒产出不得复用', () => {
  const chainPlan: ConductorPlan = {
    name: 'chain',
    nodes: {
      a: { goal: '无关的活' },
      b: { goal: '被拒的活' },
      c: { goal: '吃 b 的活', depends_on: ['b'] },
    },
  };

  const runChain = async (poisonIds: string[]) => {
    const calls: string[] = [];
    const generate: GenerateFn = async (req) => {
      const user = req.messages.find((m) => m.role === 'user');
      const text = typeof user?.content === 'string' ? user.content : '';
      const id = /\[omd leaf: ([^\]]+)\]/.exec(text)?.[1] ?? '?';
      calls.push(id);
      return { text: `fresh:${id}`, usage: { in: 1, out: 1 } };
    };
    const cfg: ExecutorDagConfig = { conductorModel: 'c:m', leafModel: 'l:m', generate, agentTemplates: new Map() };
    const r1 = await runExecutorDagWithPlan(chainPlan, cfg);
    // 全部 done —— 被拒的 b 也是 done (拒的是质量, 不是状态)。这正是状态闸挡不住它的原因。
    expect(Object.values(r1.results).every((r) => r.status === 'done')).toBe(true);

    const fps = merkleFingerprints(chainPlan);
    const poisoned = new Set(poisonIds.map((id) => fps.get(id)!));
    calls.length = 0;
    // 轮 2 与轮 1 **同一张图** (conductor 没猜到该改哪个节点 —— 最坏也最常见的情形)。
    const r2 = await runExecutorDagWithPlan(chainPlan, cfg, { plan: r1.plan, results: r1.results, poisoned });
    return { calls, r2 };
  };

  test('无毒集 = 缺陷现场: 同一张图第二轮整图复用, 被拒的 b 原样端出来', async () => {
    const { calls, r2 } = await runChain([]);
    expect(calls).toEqual([]); // 零 LLM
    expect([...(r2.reusedNodes ?? [])].sort()).toEqual(['a', 'b', 'c']);
    expect(r2.results.b?.output).toBe('fresh:b'); // 被拒的那份产出, 原样
  });

  test('毒 b → b 重跑, 且下游 c 连坐重跑 (前向闭包免费), a 仍复用', async () => {
    const { calls, r2 } = await runChain(['b']);
    expect(calls.sort()).toEqual(['b', 'c']);
    expect(r2.reusedNodes).toEqual(['a']);
    expect(r2.results.a?.skipped).toBe(true);
    expect(r2.results.b?.skipped).toBeUndefined(); // 真跑了
  });

  test('毒根节点 a (无下游) 只影响它自己', async () => {
    const { calls, r2 } = await runChain(['a']);
    expect(calls).toEqual(['a']);
    expect([...(r2.reusedNodes ?? [])].sort()).toEqual(['b', 'c']);
  });
});

describe('D-4 铸票 — judge 点名的本轮 id 当场翻成指纹带进下一轮', () => {
  const plan: ConductorPlan = { name: 'p', nodes: { a: { goal: '不变的活' }, b: { goal: '要修的活' } } };

  /** 跑 2 轮, 第 1 轮判不收敛并点名 rejected; 回收每轮拿到的 prior。 */
  const run = async (rejectedNodes: string[]) => {
    const priors: (PriorExec | undefined)[] = [];
    let round = 0;
    await iterateExecutorDag('修好它', {
      conductorModel: 'c:m',
      leafModel: 'l:m',
      maxRounds: 2,
      judge: async () => {
        round++;
        return round >= 2
          ? { converged: true, score: 1 }
          : { converged: false, score: 0, failureReason: 'b 的产出是编的', rejectedNodes };
      },
      _runDag: async (_task, _cfg, prior) => {
        priors.push(prior);
        return stub(plan, ['a', 'b']);
      },
    });
    return priors;
  };

  test('第 2 轮的 prior 带着第 1 轮点名节点的指纹 (不晚一轮)', async () => {
    const priors = await run(['b']);
    const fpB = merkleFingerprints(plan).get('b')!;
    expect(priors[0]).toBeUndefined();
    expect([...(priors[1]?.poisoned ?? [])]).toEqual([fpB]);
  });

  // fail-closed: 拒了整轮却开不出一张可解析的票 = 零信息。此时整轮不复用 (退回整图重跑基线),
  // 而不是"没票就当全批准" —— 后者会让一个偷懒的 judge 悄悄绕过整道闸, 且只在生产才发作。
  test('judge 判未收敛却没点名 → 下一轮拿不到 prior (整轮不复用)', async () => {
    const priors = await run([]);
    expect(priors[1]).toBeUndefined();
  });

  test('judge 点的 id 图里全不存在 → 同样按零信息处理, 不炸', async () => {
    const priors = await run(['不存在的节点']);
    expect(priors[1]).toBeUndefined();
  });

  test('票里混了一个幻觉 id, 但有一个真的 → 真的那张照铸, 复用面照常', async () => {
    const priors = await run(['b', '不存在的节点']);
    expect([...(priors[1]?.poisoned ?? [])]).toEqual([merkleFingerprints(plan).get('b')!]);
    expect(priors[1]?.plan).toBe(plan);
  });

  test('毒集累积不撤: 指纹含前驱闭包, 被拒事实不随轮次变假', async () => {
    const priors: (PriorExec | undefined)[] = [];
    let round = 0;
    await iterateExecutorDag('修好它', {
      conductorModel: 'c:m',
      leafModel: 'l:m',
      maxRounds: 3,
      // 轮 1 点 a, 轮 2 点 b, 轮 3 收工 → 轮 3 的 prior 该同时带 a 和 b。
      judge: async () => {
        round++;
        if (round >= 3) return { converged: true, score: 1 };
        return { converged: false, score: 0, failureReason: 'r', rejectedNodes: [round === 1 ? 'a' : 'b'] };
      },
      _runDag: async (_task, _cfg, prior) => {
        priors.push(prior);
        return stub(plan, ['a', 'b']);
      },
    });
    const fps = merkleFingerprints(plan);
    expect([...(priors[2]?.poisoned ?? [])].sort()).toEqual([fps.get('a')!, fps.get('b')!].sort());
  });
});
