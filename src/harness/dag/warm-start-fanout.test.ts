/**
 * src/harness/dag/warm-start-fanout.test —— 暖发 (warmThenFanout) 不许无界霸占队头 (t-initial-pump)
 *
 * 承重事实 (2026-09-01 生产读数, run 32d16141-d7ec-4d61-8f57-34b721d0f5e3):
 * 图里 s1/s2/s3 三片 `depends_on: []`, 但 s1 独跑 925489ms 之后 s2/s3 才在**同一毫秒**起跑
 * (s1 startedAt 15:31:30.982 · s2 15:46:56.508 · s3 15:46:56.512)。原因不是 maxFanout /
 * kindFanout / channelFanout, 是 engine.ts 的暖发分支**整发 await 到 settle** 才放 pool ——
 * 而暖发要买的东西 (共享前缀写进 prompt-cache) 在**首个模型往返返回**时就已到手, 与这一发
 * 跑完与否无关。于是「一发串行延迟」被读成了「一整个 leaf 任务的墙钟」, 宽度 N 的平铺图
 * 白等 (N−1) 份。
 *
 * 三条 GWT:
 *   GWT-1 ★ 暖发开 + 3 个零依赖 agent 节点 ⇒ 三者起跑时刻跨度 < 一个执行时长 (并行起跑)。
 *           实装前**天然红**: 跨度 ≈ 2×SLEEP (串行三发)。
 *   GWT-2 ★ 对照基线: 暖发关, 同一张图 ⇒ 同样并行起跑 (证明这把尺子量的是暖发, 不是别的闸)。
 *   GWT-3 ★ 宽限窗口是**上界不是定长**: grace 给 10s 而暖发 50ms 就 settle ⇒ 其余节点在
 *           暖发 settle 后立刻起跑 (整个用例远早于 10s 结束), 且暖发节点自己照常 done。
 *
 * 反向自检 (本片手做, 两条各咬一个方向):
 *   ① 把 engine.ts 暖发分支改回 `await runNode(...)` 到 settle (删掉宽限窗口) ⇒ GWT-1 红
 *      (实测跨度 210ms > SLEEP 200ms), GWT-2 仍绿 —— 这一对红/绿证明尺子量的是暖发本身。
 *   ② 把暖发 settle 路径里的 `openGate()` 删掉 (即恒等满 grace 才放开) ⇒ GWT-3 红
 *      (耗时从 ~0.1s 变 ≈10s)。GWT-3 咬的是「宽限窗口退化成定长延迟」这个修法方向的坑,
 *      它在实装前就绿 —— 是**回归闸**不是复现用例, 别拿它当复现证据。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runExecutorDagWithPlan } from './engine';
import { CheckpointManager } from '../continuity/checkpoint-manager';
import type { ConductorPlan } from '../conductor-plan';
import type { ExecutorDagConfig, ExecutorDagResult, GenerateFn } from './types';

const SLEEP_MS = 200;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const PLAN: ConductorPlan = {
  name: 'warm-start-fanout',
  nodes: {
    A: { goal: '零依赖片 A', executor: 'agent' },
    B: { goal: '零依赖片 B', executor: 'agent' },
    C: { goal: '零依赖片 C', executor: 'agent' },
  },
} as unknown as ConductorPlan;

/** 跑一次图, 回收每个节点的**起跑时刻** (执行体第一行, 早于任何 await)。 */
async function runAndCollectStarts(opts: {
  warmThenFanout: boolean;
  warmGraceMs?: number;
  sleepMs?: number;
}): Promise<{ starts: Record<string, number>; result: ExecutorDagResult }> {
  const starts: Record<string, number> = {};
  const generate: GenerateFn = async () => ({ text: 'unused', usage: { in: 1, out: 1 } });
  const cfg = {
    conductorModel: 'test:conductor',
    leafModel: 'test:leaf',
    generate,
    agentTemplates: new Map(),
    warmThenFanout: opts.warmThenFanout,
    ...(opts.warmGraceMs === undefined ? {} : { warmGraceMs: opts.warmGraceMs }),
    // AgentLeafInput 里没有 nodeId 这一位, 节点身份从 prompt 里的 goal 原文认 (goal 三片互异)。
    agentRunner: async (input: { prompt: string }) => {
      const id = ['A', 'B', 'C'].find((n) => input.prompt.includes(`零依赖片 ${n}`)) ?? 'unknown';
      starts[id] = Date.now();
      await sleep(opts.sleepMs ?? SLEEP_MS);
      return { text: `done ${id}`, usage: { in: 1, out: 1 } };
    },
    continuity: {
      manager: new CheckpointManager(mkdtempSync(join(tmpdir(), 'omd-warm-ckpt-'))),
      runId: 'warm-start-fanout-run',
      repoRoot: process.cwd(),
      execRoot: process.cwd(),
    },
  } as unknown as ExecutorDagConfig;
  const result = await runExecutorDagWithPlan(PLAN, cfg);
  return { starts, result };
}

const spread = (starts: Record<string, number>): number => {
  const ts = Object.values(starts);
  return Math.max(...ts) - Math.min(...ts);
};

describe('暖发 (warmThenFanout) 不许把零依赖兄弟按到队尾', () => {
  test('★ GWT-1 暖发开 + 三片零依赖 ⇒ 起跑时刻跨度 < 一个执行时长', async () => {
    const { starts, result } = await runAndCollectStarts({ warmThenFanout: true, warmGraceMs: 5 });
    expect(Object.keys(starts).sort()).toEqual(['A', 'B', 'C']);
    // 串行三发时跨度 ≈ 2×SLEEP; 并行起跑时跨度 = 调度抖动 (≪ SLEEP)。
    expect(spread(starts)).toBeLessThan(SLEEP_MS);
    expect(Object.values(result.results).every((r) => r.status === 'done')).toBe(true);
  }, 20_000);

  test('★ GWT-2 对照基线: 暖发关 ⇒ 同一张图同样并行起跑', async () => {
    const { starts } = await runAndCollectStarts({ warmThenFanout: false });
    expect(spread(starts)).toBeLessThan(SLEEP_MS);
  }, 20_000);

  test('★ GWT-3 宽限窗口是上界: 暖发早 settle ⇒ 不等满 grace', async () => {
    const t0 = Date.now();
    const { starts, result } = await runAndCollectStarts({
      warmThenFanout: true,
      warmGraceMs: 10_000,
      sleepMs: 50,
    });
    // 暖发 50ms 就 settle → 其余两片在 settle 那一刻起跑, 全程远小于 10s 的 grace。
    expect(Date.now() - t0).toBeLessThan(3_000);
    expect(spread(starts)).toBeLessThan(1_000);
    expect(Object.values(result.results).every((r) => r.status === 'done')).toBe(true);
  }, 20_000);
});
