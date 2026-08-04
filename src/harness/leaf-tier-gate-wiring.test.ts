/**
 * g1 闸的**接线**回归 (planAndExecute 拒回环) —— 判据本体的红/绿在 plan/leaf-tier-gate.test.ts,
 * 这里钉三件接线层的事: ① 违规 plan 被拒回且改写建议进了下一问 ② 有界重问用尽 fail-open 放行
 * (顽固 conductor 不挂死生产) ③ 闸不开时行为逐字同旧 (零回归)。
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { runExecutorDag } from './executor-dag';
import type { ExecutorDagConfig, GenerateFn } from './executor-dag-types';

/** 真实存在的文件 (仓根 README) —— 闸的 stat 走真盘, 确定路径必须真的存在才触发。 */
const REAL_FILE = join(process.cwd(), 'README.md');

const violating = JSON.stringify({
  name: 'v',
  nodes: { ext: { executor: 'agent', output_type: 'structured', goal: `完整阅读 ${REAL_FILE} 并提取要点` } },
});
const compliant = JSON.stringify({ name: 'c', nodes: { sum: { goal: '总结要点' } } });

/** 记录每次调用: 规划问 (system 含 CONDUCTOR) 按剧本出 plan, leaf 问回 ok。 */
const makeGenerate = (planScript: string[], seen: { planPrompts: string[] }): GenerateFn => {
  let planCalls = 0;
  return async (req) => {
    const sys = req.messages.find((m) => m.role === 'system');
    const user = req.messages.find((m) => m.role === 'user');
    const userText = typeof user?.content === 'string' ? user.content : '';
    if (typeof sys?.content === 'string' && sys.content.includes('CONDUCTOR')) {
      seen.planPrompts.push(userText);
      const text = planScript[Math.min(planCalls, planScript.length - 1)]!;
      planCalls++;
      return { text, usage: { in: 1, out: 1 } };
    }
    return { text: 'ok', usage: { in: 1, out: 1 } };
  };
};

const cfg = (generate: GenerateFn, gate: boolean): ExecutorDagConfig => ({
  conductorModel: 'c:m',
  leafModel: 'l:m',
  generate,
  agentTemplates: new Map(),
  ...(gate ? { leafTierGate: true, leafTierThresholdBytes: 1_500_000 } : {}),
});

describe('g1 闸接线 (planAndExecute 拒回环)', () => {
  test('违规 plan 被拒回, 改写建议进下一问, 第二版合规 plan 被采纳', async () => {
    const seen = { planPrompts: [] as string[] };
    const r = await runExecutorDag('测试任务', cfg(makeGenerate([violating, compliant], seen), true));
    expect(seen.planPrompts).toHaveLength(2);
    expect(seen.planPrompts[1]).toContain('档位闸拒回');
    expect(seen.planPrompts[1]).toContain('ext'); // 建议点名违规节点
    expect(r.results.sum?.status).toBe('done'); // 采纳的是第二版
    expect(r.results.ext).toBeUndefined();
  });

  test('有界: 顽固违规 → 1+2 次重问后 fail-open 放行执行 (不挂死)', async () => {
    const seen = { planPrompts: [] as string[] };
    const r = await runExecutorDag('测试任务', cfg(makeGenerate([violating], seen), true));
    expect(seen.planPrompts).toHaveLength(3); // 首问 + LEAF_TIER_MAX_REJECTS=2 次重问
    expect(r.results.ext?.status).toBe('done'); // 放行后照跑 (无 agentRunner → inproc 降级执行)
  });

  test('闸不开 → 违规 plan 一次通过 (零回归)', async () => {
    const seen = { planPrompts: [] as string[] };
    const r = await runExecutorDag('测试任务', cfg(makeGenerate([violating], seen), false));
    expect(seen.planPrompts).toHaveLength(1);
    expect(r.results.ext?.status).toBe('done');
  });
});
