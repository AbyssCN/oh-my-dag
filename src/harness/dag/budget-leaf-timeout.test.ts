/**
 * P2e (2026-09-02 修订): 单个 agent leaf 的超时 = 剩余目标预算, 不是固定 1h 兜底
 * (batch-7 现场: 40min 预算实跑到 54min —— dispatchBudgetHit 只在轮边界/子图 pump 查,
 * 单个 leaf 在轮中能跑多久与目标预算完全脱节)。
 *
 * 首版实现 `Math.max(1, msCap - spent)` 在预算已耗尽时把超时夹到字面 **1ms**: agent-leaf
 * 在第一轮内 abort, 返回空文本 + `timedOut:true`, 而 engine.ts 从不读 `r.timedOut`
 * (只读 `r.stalled`/`r.spinFused`) —— 无产物声明的节点就此被判 `done` 空产出静默通过,
 * 正是仓规 §静默坑要挡的谎报完工。本次修订: 剩余不够一个可用切片 (`LEAF_MIN_SLICE_MS`)
 * 就不派发, 结构化成 `budgetStopped` (与轮边界预算耗尽同词表), 不是塞一个必死的计时器。
 *
 * 反向自检 (怎么让它红): 把 `engine.ts` 里 `leafDispatchBudgetStopped` 的调用点删掉
 * (或把 `remainingBudgetMs` 改回 `Math.min(3_600_000, Math.max(1, msCap - spent))`) →
 * 「预算已耗尽」两条当场红: `captured` 会被赋值 (agentRunner 仍被调用), 节点判 `done` 而非
 * `failed`。
 */
import { describe, expect, test } from 'bun:test';
import { runExecutorDagWithPlan } from './engine';
import type { ConductorPlan } from '../conductor-plan';
import type { AgentLeafInput } from '../leaf-runners';
import type { ExecutorDagConfig, GenerateFn } from './types';

const plan: ConductorPlan = {
  name: 'p2e-plan',
  nodes: { W: { goal: '只读检查(无产物声明)', executor: 'agent' } },
};

const noopGenerate: GenerateFn = async () => ({ text: 'ok', usage: { in: 1, out: 1 } });

function makeConfig(extra: Partial<ExecutorDagConfig>): ExecutorDagConfig {
  return {
    conductorModel: 'test:conductor',
    leafModel: 'test:leaf',
    generate: noopGenerate,
    agentTemplates: new Map(),
    ...extra,
  };
}

describe('P2e: agent leaf 超时 ≤ 剩余目标预算', () => {
  test('预算未耗尽 (剩余 > 最小切片) → leafTimeoutMs 收紧但为正', async () => {
    let captured: AgentLeafInput | undefined;
    const cfg = makeConfig({
      loopBudget: { ms: 20_000 },
      _budgetAnchor: Date.now() - 5_000, // 已用 5s, 剩余约 15s
      agentRunner: async (input) => {
        captured = input;
        return { text: 'done', usage: { in: 1, out: 1 } };
      },
    });
    const r = await runExecutorDagWithPlan(plan, cfg);
    expect(captured).toBeDefined();
    expect(captured!.leafTimeoutMs).toBeGreaterThan(0);
    expect(captured!.leafTimeoutMs!).toBeLessThan(3_600_000); // 收紧过, 不是历史默认 1h
    expect(r.results.W!.status).toBe('done');
  });

  test('未配预算 → leafTimeoutMs 字段缺席, 老调用方零回归', async () => {
    let captured: AgentLeafInput | undefined;
    const cfg = makeConfig({
      agentRunner: async (input) => {
        captured = input;
        return { text: 'done', usage: { in: 1, out: 1 } };
      },
    });
    const r = await runExecutorDagWithPlan(plan, cfg);
    expect(captured).toBeDefined();
    expect(captured!.leafTimeoutMs).toBeUndefined();
    expect(r.results.W!.status).toBe('done');
  });

  test('预算已耗尽 (剩余 < 0) → agent 叶不派发, 判 failed+budgetStopped, 不是 1ms 静默 done', async () => {
    let captured: AgentLeafInput | undefined;
    const cfg = makeConfig({
      loopBudget: { ms: 10_000 },
      _budgetAnchor: Date.now() - 60_000, // 预算早烧完 (超支 50s)
      agentRunner: async (input) => {
        captured = input;
        return { text: '', usage: { in: 0, out: 0 } };
      },
    });
    const r = await runExecutorDagWithPlan(plan, cfg);
    expect(captured).toBeUndefined(); // 一发都没打 —— 这正是"拒派"与"派了个 1ms"的差别
    expect(r.results.W!.status).toBe('failed');
    expect(r.results.W!.budgetStopped).toBeDefined();
    expect(r.results.W!.budgetStopped).toContain('预算');
  });

  test('临近耗尽边界 (剩余 2s < LEAF_MIN_SLICE_MS 5s) → 同样拒派, 不给近零计时器', async () => {
    let captured: AgentLeafInput | undefined;
    const cfg = makeConfig({
      loopBudget: { ms: 10_000 },
      _budgetAnchor: Date.now() - 8_000, // 剩余约 2s, 低于最小可用切片
      agentRunner: async (input) => {
        captured = input;
        return { text: '', usage: { in: 0, out: 0 } };
      },
    });
    const r = await runExecutorDagWithPlan(plan, cfg);
    expect(captured).toBeUndefined();
    expect(r.results.W!.status).toBe('failed');
    expect(r.results.W!.budgetStopped).toBeDefined();
  });
});
