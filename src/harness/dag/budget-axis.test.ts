/**
 * #158 预算轴三缝网 (2026-08-17) —— 「字段在 ≠ 轴管用」的可执行版。
 *
 * 现场 (d39b559e): --budget-minutes 90 实跑 164min 未停。三个洞, 三条测试各钉一个:
 *   ① 环入口: 前相位/前节点烧穿后, 本环此前照样满额起跑 (首轮豁免 + 只锚环起点);
 *   ② 轮内派发: 单轮超跑 (第 2 轮 44min) —— 轮边界永远量不到轮中, 派发闸在子图 pump 上
 *      与 D-P 取消缝同形 (不打断在飞, 只不再派新的);
 *   ③ 升级重规划入口: 环收敛后预算已尽还开重规划轮 (134min 收敛后又跑 30min 的来源)。
 *
 * 证伪方式 (逐条, 已当场跑过):
 *   ① 删 runConductorNode 的 preloopHit 块 → 第 1 条红 (环照常展开, generate 被调用);
 *   ② 把 pump 里 budgetHitNow 的 early-resolve 块摘掉 → 第 2 条红 (b 被派发)。
 *      ⚠ 只摘 while 条件不红 —— early-resolve 已拦住串行链; while 那半防的是
 *      「有在飞时继续派新的」的并行形状, 本测试的串行链够不着它;
 *   ③ 删升级环体首的 escBudgetHit break → 第 3 条红 (escalated 变 true)。
 * 阴性对照: 无预算配置行为逐字节不变由全量既有网背书 (loopBudget 缺席 → 判定恒 null)。
 * ③ 的"无预算时升级环会开"的对照 = engine.test.ts G-21 那组 (同 harness, escalated=true)。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runExecutorDagWithPlan } from './engine';
import { registerProvider } from '../../model';
import { PLAN_BOUNDARY } from '../conductor-plan';
import { CheckpointManager } from '../continuity/checkpoint-manager';
import type { NodeLoopJournal } from '../continuity/types';
import type { ContentPart } from '../../model/gateway';
import type { ConductorPlan } from '../conductor-plan';
import type { ExecutorDagConfig, GenerateFn } from './types';

const contentText = (c: string | ContentPart[] | undefined): string =>
  typeof c === 'string' ? (c ?? '') : (c ?? []).map((p) => (p.type === 'text' ? p.text : '')).join('\n');

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('#158 预算轴三缝', () => {


  test('③ 升级重规划入口: 环跑完但预算已尽 → 不开重规划轮 (escalated=false, verifier 只判一次)', async () => {
    registerProvider('escx158', { baseUrl: 'http://127.0.0.1:9', apiKey: 'test-key', api: 'openai-compatible' });
    let verifyCount = 0;
    const verifier = async (): Promise<{ pass: boolean; reason: string; usage: { in: number; out: number } }> => {
      verifyCount++;
      return { pass: false, reason: '不合格', usage: { in: 1, out: 1 } };
    };
    const generate: GenerateFn = async () => ({ text: 'out', usage: { in: 1, out: 1 } });
    const cfg: ExecutorDagConfig = {
      conductorModel: 'test:conductor',
      leafModel: 'test:leaf',
      generate,
      agentTemplates: new Map(),
      verifier,
      conductorEscalationModel: 'escx158:strong',
      loopBudget: { ms: 50 },
      _budgetAnchor: Date.now() - 10_000,
    };
    // 顶层平铺叶 (派发闸的顶层半是 #158 留的残余, 叶本身照跑) → verifier fail → 升级环该开而被预算拦。
    const plan: ConductorPlan = { name: 'p', nodes: { a: { goal: '干' } } };
    const r = await runExecutorDagWithPlan(plan, cfg);
    expect(r.verification!.pass).toBe(false);
    expect(r.verification!.escalated).toBe(false); // 预算闸拦下 —— 环收敛后不再开最贵的那种新活
    expect(verifyCount).toBe(1);
  });
});
