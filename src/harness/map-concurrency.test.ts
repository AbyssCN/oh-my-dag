/**
 * map 内层泵并发回归闸 (r1, 2026-08-04)。
 *
 * 钉住的缺陷: worker 生成循环的上界写成 `w < Math.min(childCap, queue.length)`, 而每个已生成
 * worker 的**同步序**里就有 `queue.shift()` —— 上界随生成过程一路缩, cap≥N/2 时恰好只起
 * ⌈N/2⌉ 个 worker。生产实测 (f2 三跑 + 今日基线 + 合成复现): 10 片恒 5 槽, 9 片 5 槽,
 * cap 放得越大越触发; cap<N/2 时反而正常 (上界被 cap 钉住)。
 *
 * 反向自检 (仓规: 每条闸都要证明它真的会红): 本测试先于修复写就, 在修复前的引擎上跑过一次,
 * 「cap 放开 → 全宽并发」那条按预期红 (实测 maxInFlight=5 ≠ 10); 修复 (上界起 worker 前
 * 一次算死) 后转绿。cap=3 那条在修复前后都绿 —— 它钉住的是"修复不许把 cap 语义修没了"。
 */
import { describe, expect, test } from 'bun:test';
import { runExecutorDagWithPlan } from './dag/engine';
import type { ConductorPlan } from './conductor-plan';
import type { ExecutorDagConfig, GenerateFn } from './dag/types';

const N = 10;
const LIST_JSON = JSON.stringify({ items: Array.from({ length: N }, (_, i) => ({ k: `p${i}` })) });

/** lister 发回清单; 子节点发耗时 20ms 的活, 全程记录同时在飞数。 */
const makeGenerate = (inflight: { now: number; max: number }): GenerateFn => async (req) => {
  const user = req.messages.find((m) => m.role === 'user');
  const text = typeof user?.content === 'string' ? user.content : '';
  if (text.includes('只回一个 JSON 对象')) return { text: LIST_JSON, usage: { in: 1, out: 1 } };
  inflight.now++;
  inflight.max = Math.max(inflight.max, inflight.now);
  await new Promise((r) => setTimeout(r, 20));
  inflight.now--;
  return { text: 'ok', usage: { in: 1, out: 1 } };
};

/**
 * 每测新造 plan —— 引擎的 map 展开会**原地改写**传入 plan 的 nodes (executor-dag runMapNode
 * 把子节点挂进 plan.nodes)。共享一个 plan 对象的话, 第二跑的外层调度器会把上一跑遗留的子节点
 * 当静态节点再跑一遍, 并发读数翻倍 (本测试第一版实测踩中: cap=3 量到 5)。
 */
const mapPlan = (): ConductorPlan =>
  ({
    name: 'map-conc',
    nodes: {
      fan: {
        executor: 'map',
        map: {
          lister: { goal: '枚举 items' },
          over: 'items',
          itemVar: 'it',
          keyBy: 'k',
          template: { goal: '处理 {{it.k}}' },
          maxItems: 16,
        },
      },
    },
  }) as unknown as ConductorPlan;

const cfg = (generate: GenerateFn, maxFanout: number): ExecutorDagConfig => ({
  conductorModel: 'c:m',
  leafModel: 'l:m',
  generate,
  agentTemplates: new Map(),
  maxFanout,
});

describe('map 内层泵并发 (r1)', () => {
  test('cap 放开 (MAX_SAFE_INTEGER) → N 片全宽并发, 不是 ⌈N/2⌉', async () => {
    const inflight = { now: 0, max: 0 };
    const r = await runExecutorDagWithPlan(mapPlan(), cfg(makeGenerate(inflight), Number.MAX_SAFE_INTEGER));
    expect(r.results.fan?.status).toBe('done');
    expect(inflight.max).toBe(N);
  });

  test('cap=3 → 恰好 3 槽 (修复不许把 cap 语义修没了)', async () => {
    const inflight = { now: 0, max: 0 };
    const r = await runExecutorDagWithPlan(mapPlan(), cfg(makeGenerate(inflight), 3));
    expect(r.results.fan?.status).toBe('done');
    expect(inflight.max).toBe(3);
  });
});
