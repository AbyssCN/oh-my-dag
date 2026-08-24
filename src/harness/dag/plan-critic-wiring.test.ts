/**
 * src/harness/dag/plan-critic-wiring.test —— #247 plan-critic 进活规划环的接缝测试。
 *
 * **新文件 (INV-5b, 2026-08-24 假 done 教训)**。实装前不存在 ⇒ verify 首段天然红。
 * 4 个 GWT (与契约对齐):
 *   1. 二发重问: stub 首次返无四字段 plan、二发返带字段 plan;gate on → generate 恰调 2 次, 终 plan 带字段。
 *   2. fail-open: stub 恒返无字段 plan;gate on → 拒回 2 次后 fail-open 放行, warn 含 PP-I02, 计数入 run 记录。
 *   3. 零回归: gate 未设;stub 返无字段 plan → generate 恰调 1 次 (闸根本不入, 字节不变)。
 *   4. INV-12 拒回: plan 带 bypass;gate on → 拒回, correction 点名删字段。
 *
 * 全程 stub generate, 零模型调用, 零 IO。
 */
import { describe, expect, test } from 'bun:test';
import { runExecutorDag } from './engine';
import { setCoreLogger, type CoreLogger } from '../logger';
import type { ExecutorDagConfig, GenerateFn } from './types';

/** stub generate: 按 traceName 分桶 (conductor:plan vs leaf); 配 planSequence 喂 conductor。 */
function makeStub(opts: {
  planSequence: ReadonlyArray<unknown>;
  leafText?: string;
}): { generate: GenerateFn; conductorCalls: () => number; lastPlan: () => unknown; captured: { corrections: string[] } } {
  let conductorCalls = 0;
  let lastPlan: unknown = null;
  const captured = { corrections: [] as string[] };
  const generate: GenerateFn = async (req) => {
    const tn = req.traceName ?? '';
    if (tn === 'conductor:plan' || tn === 'escalation:plan') {
      const planIdx = conductorCalls;
      conductorCalls++;
      const p = opts.planSequence[Math.min(planIdx, opts.planSequence.length - 1)];
      lastPlan = p;
      // 抓 correction: 用户的最后一条消息里包含重问文本
      const userMsg = req.messages.find((m) => m.role === 'user');
      const text = typeof userMsg?.content === 'string' ? userMsg.content : '';
      // 抓闸拒回的所有诊断行 (D-2 形如 "- PP-I02 <id>: ..."),一行一码
      for (const line of text.split('\n')) {
        if (/^- (PP-[A-Z]\d{2}|INV-\d{2})\s/.test(line)) captured.corrections.push(line);
      }
      return { text: JSON.stringify(p), usage: { in: 1, out: 1 } };
    }
    // leaf 调用: 返一段完成文本, 让 engine 走完后续
    return { text: opts.leafText ?? 'leaf done', usage: { in: 1, out: 1 } };
  };
  return { generate, conductorCalls: () => conductorCalls, lastPlan: () => lastPlan, captured };
}

function baseConfig(generate: GenerateFn, extra: Partial<ExecutorDagConfig> = {}): ExecutorDagConfig {
  return {
    conductorModel: 'test:conductor',
    leafModel: 'test:leaf',
    generate,
    agentTemplates: new Map(),
    ...extra,
  };
}

/** 最小 plan: 缺 oracleKind → PP-I02 必命中; 缺 whyNoFanout → 单叶时 PP-I01 必命中。 */
const planMissingFields = { name: 'P', nodes: { only: { goal: 'g' } } };

/** 同 plan 但补 oracleKind + whyNoFanout + budgetBasis。 */
const planWithFields = {
  name: 'P',
  nodes: {
    only: {
      goal: 'g',
      oracleKind: 'cheap',
      whyNoFanout: 'single node, no fanout needed',
      budgetBasis: { calls: 1, tokensIn: 0, tokensOut: 0, costUsdCeiling: 0.01, estimatedBy: 'stub' },
    },
  },
};

/** plan 带顶层 bypass → INV-12 必命中。 */
const planWithBypass = { name: 'P', bypass: true, nodes: { only: { goal: 'g' } } };

interface Captured { msg: string; payload: Record<string, unknown> }

/**
 * 装一只捕获 logger (用于 GWT-2 验证 fail-open warn)。
 * 注: 用 setCoreLogger 注入而非 `console.warn` 猴补 ——
 * 仓里别的测试 (rescue-anchor.test.ts / replan-round-log.test.ts) 经 `setCoreLogger` 替换全局,
 * 跨文件跑时猴补漏收 (实跑: 全量 bun test 下 GWT-2 红)。
 */
function withCapturedLogger<T>(fn: (lines: Captured[]) => Promise<T>): Promise<T> {
  const captured: Captured[] = [];
  const capture: CoreLogger = {
    debug: () => {},
    info: (obj, msg) => captured.push({ msg: msg ?? '', payload: (obj ?? {}) as Record<string, unknown> }),
    warn: (obj, msg) => captured.push({ msg: msg ?? '', payload: (obj ?? {}) as Record<string, unknown> }),
    error: () => {},
  };
  setCoreLogger(capture);
  return fn(captured);
}

/** 还原默认 console 薄壳, 不污染后续测试。 */
function restoreConsoleLogger(): void {
  setCoreLogger({
    debug: () => {},
    info: (o, m) => console.log(m ?? '', typeof o === 'string' ? o : JSON.stringify(o ?? {})),
    warn: (o, m) => console.warn(m ?? '', typeof o === 'string' ? o : JSON.stringify(o ?? {})),
    error: (o, m) => console.error(m ?? '', o),
  });
}

describe('plan-critic 进活规划环 (#247)', () => {
  // ── GWT-1: 二发重问 ─────────────────────────────────────────────────────────
  test('GWT-1: stub 首次无字段、二发带字段 + gate on → generate 恰调 2 次, 终 plan 带字段', async () => {
    const stub = makeStub({ planSequence: [planMissingFields, planWithFields] });
    const r = await runExecutorDag('task', baseConfig(stub.generate, { planCriticGate: true }));
    expect(stub.conductorCalls()).toBe(2);
    expect(stub.captured.corrections.length).toBeGreaterThanOrEqual(1);
    // 单叶无字段 plan → PP-I01 + PP-I02 必同时出现 (INLOOP_ENFORCED_CODES 收齐)
    // 注意: correction text 里 PP-I01 在 PP-I02 之前 (critique 输出顺序), 不能用 ^ 锚定首行。
    const allCorrections = stub.captured.corrections.join('\n');
    expect(allCorrections).toMatch(/- PP-I02 /);
    expect(allCorrections).toMatch(/- PP-I01 /);
    // 终 plan = 二发的 planWithFields
    const final = r.plan as { nodes: Record<string, Record<string, unknown>> };
    const onlyNode = final.nodes.only!;
    expect(onlyNode.oracleKind).toBe('cheap');
    expect(onlyNode.budgetBasis).toBeDefined();
  });

  // ── GWT-2: fail-open (预算尽 → 响亮留证 + 放行) ──────────────────────────────
  test('GWT-2: stub 恒返无字段 plan + gate on → 拒回 2 次后 fail-open, warn 含 PP-I02', async () => {
    try {
      await withCapturedLogger(async (captured) => {
        const stub = makeStub({ planSequence: [planMissingFields] });
        const r = await runExecutorDag('task', baseConfig(stub.generate, { planCriticGate: true }));
        // 拒回 2 次 (PLAN_CRITIC_MAX_REJECTS) + 1 次放行轮 = 3 次 conductor 调用
        expect(stub.conductorCalls()).toBe(3);
        const final = r.plan as { nodes: Record<string, Record<string, unknown>> };
        // 终 plan 仍是没字段的那版 (fail-open 不修改 plan)
        expect(final.nodes.only!.oracleKind).toBeUndefined();
        // fail-open 警告必须落, 且包含 PP-I02 与残余诊断
        const failOpen = captured.find((c) => c.msg.includes('plan-critic') && c.msg.includes('fail-open'));
        expect(failOpen).toBeDefined();
        const blob = JSON.stringify(failOpen!.payload);
        expect(blob).toContain('PP-I02');
      });
    } finally {
      restoreConsoleLogger();
    }
  });

  // ── GWT-3: 零回归 (gate 未设 → 闸不入场, 字节不变) ─────────────────────────
  test('GWT-3: gate 未设 + stub 返无字段 plan → generate 恰调 1 次 (零字节回归)', async () => {
    const stub = makeStub({ planSequence: [planMissingFields] });
    const r = await runExecutorDag('task', baseConfig(stub.generate /* planCriticGate 未设 */));
    expect(stub.conductorCalls()).toBe(1);
    expect(stub.captured.corrections.length).toBe(0);
    const final = r.plan as { nodes: Record<string, Record<string, unknown>> };
    expect(final.nodes.only!.oracleKind).toBeUndefined();
  });

  // ── GWT-4: INV-12 拒回 (plan 带 bypass) ────────────────────────────────────
  test('GWT-4: plan 带 bypass + gate on → INV-12 拒回, correction 点名删字段', async () => {
    const stub = makeStub({ planSequence: [planWithBypass] });
    await runExecutorDag('task', baseConfig(stub.generate, { planCriticGate: true }));
    expect(stub.conductorCalls()).toBeGreaterThanOrEqual(1);
    // INV-12 必须出现在 correction 中 (含 <plan> 节点标识)
    expect(stub.captured.corrections.some((c) => /^- INV-12 /.test(c) && c.includes('<plan>'))).toBe(true);
  });
});