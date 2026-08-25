/**
 * src/harness/dag/escalation-paralysis.test.ts —— #249 外环瘫痪绊线 + #244 活环扩集 (2026-08-25, 片 2)。
 *
 * 4 个 GWT 与契约对齐 (C-2 GWT 表):
 *   1. 三红全类内 (gate-rejected × 3) → 升级环**不开**重规划 (escalation generate 零调用),
 *      STALLED 出口 (circuitBroken=true), observation 点名节点 id 与败因, log 含 `[fuse-paralysis]`。
 *   2. 三红含 1 个 assert-failed (混因) → 照常重规划 (generate 被调), fuse **不**触发。
 *      反向自检 INV-9: 「混因」是阻熔断条件, 不是顺熔断条件 —— 删掉 `every(...)` 中"全员"的
 *      限制会把它误放过去。
 *   3. 二红全类内 → 数量不足, 照常重规划 (fuse 不触发)。反向自检 INV-9: 「阈值」判据
 *      (≥PARALYSIS_MIN_RED=3), 不是「≥1」就熔断 —— 删掉 `>= PARALYSIS_MIN_RED` 会把它误放。
 *   4. 规划环 PP-O02 (planCriticGate=true): stub 首发「写节点无 oracleKind 无 command」
 *      图、二发补 `oracleKind:'judge'` → generate 恰调 2 次, 终 plan 是二发
 *      (验 INLOOP_ENFORCED_CODES 扩集 — INV-8 一处改)。
 *
 * 全程 stub generate / verifier / commandRunner, 零模型调用, 零 IO, 零真实文件系统。
 */
import { describe, expect, test, beforeAll } from 'bun:test';
import { runExecutorDag } from './engine';
import { setCoreLogger, type CoreLogger } from '../logger';
import { registerProvider } from '../../model/providers';
import type { ConductorPlan } from '../conductor-plan';
import type { CommandLeafResult } from '../leaf-runners';
import type { ExecutorDagConfig, GenerateFn, LeafResult } from './types';

interface Captured { msg: string; payload: Record<string, unknown> }

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

function restoreConsoleLogger(): void {
  setCoreLogger({
    debug: () => {},
    info: (o, m) => console.log(m ?? '', typeof o === 'string' ? o : JSON.stringify(o ?? {})),
    warn: (o, m) => console.warn(m ?? '', typeof o === 'string' ? o : JSON.stringify(o ?? {})),
    error: (o, m) => console.error(m ?? '', o),
  });
}

/**
 * stub generate: 按 traceName 分桶 (conductor:plan vs escalation:plan vs leaf)。
 *  - conductorCalls() 仅计数规划层 (conductor + escalation), 不算 leaf。
 *  - planSequence 喂 conductor/escalation;leaf 返一段完成文本。
 */
function makeStub(opts: {
  planSequence: ReadonlyArray<unknown>;
  leafText?: string;
}): { generate: GenerateFn; conductorCalls: () => number; lastPlan: () => unknown } {
  let conductorCalls = 0;
  let lastPlan: unknown = null;
  const generate: GenerateFn = async (req) => {
    const tn = req.traceName ?? '';
    if (tn === 'conductor:plan' || tn === 'escalation:plan') {
      const p = opts.planSequence[Math.min(conductorCalls, opts.planSequence.length - 1)];
      conductorCalls++;
      lastPlan = p;
      return { text: JSON.stringify(p), usage: { in: 1, out: 1 } };
    }
    return { text: opts.leafText ?? 'leaf done', usage: { in: 1, out: 1 } };
  };
  return { generate, conductorCalls: () => conductorCalls, lastPlan: () => lastPlan };
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

/**
 * 造一份 commandRunner: 按节点 id → exitCode 映射。出口 -1 = gate-rejected, 1 = assert-failed,
 * 0 = done (不会触发熔断, 因为没红节点)。仅本测试用。
 */
function commandRunnerByExitCode(exitByNode: Record<string, number>): NonNullable<ExecutorDagConfig['commandRunner']> {
  return async ({ command: cmd }): Promise<CommandLeafResult> => {
    // command 串里包含节点 id; 简化: 用第一个匹配 exitByNode 的 key。
    const id = Object.keys(exitByNode).find((k) => cmd?.includes(k)) ?? Object.keys(exitByNode)[0]!;
    const code = exitByNode[id]!;
    return {
      text: code === 0 ? 'ok' : `[exit ${code}]`,
      usage: { in: 0, out: 0 },
      timedOut: false,
      signal: null,
      exitCode: code,
    };
  };
}

describe('#249 外环瘫痪绊线 + #244 活环扩集 (片 2)', () => {
  // 升级环要求 escalation provider 已注册 (escalationProviderReady) → 注册假 provider
  // (fake generate, 零真调用; 与 engine.test.ts:308-309 同形)。
  beforeAll(() => {
    registerProvider('escx', { baseUrl: 'http://127.0.0.1:9', apiKey: 'test-key', api: 'openai-compatible' });
  });
  // ─────────────────────────────────────────────────────────────────────────
  // GWT-1: 三红全类内 → 升级环不开, STALLED 出口, observation 点名, log 含 [fuse-paralysis]
  // ─────────────────────────────────────────────────────────────────────────
  test('GWT-1: 3 红全部 gate-rejected → 不开重规划 (escalation generate 零调用), STALLED, observation 点名', async () => {
    try {
      await withCapturedLogger(async (captured) => {
        // 第二次 (escalation) 调用本应**永不发生**: 给一个永不用的 plan 让它一旦被调就抛错证伪。
        const stub = makeStub({
          planSequence: [
            {
              name: 'first',
              nodes: {
                a: { goal: 'gA', executor: 'command', command: 'echo a' },
                b: { goal: 'gB', executor: 'command', command: 'echo b' },
                c: { goal: 'gC', executor: 'command', command: 'echo c' },
              },
            },
          ],
        });
        const r = await runExecutorDag(
          'task',
          baseConfig(stub.generate, {
            commandRunner: commandRunnerByExitCode({ a: -1, b: -1, c: -1 }),
            verifier: async () => ({ pass: false, reason: 'verifier rejects', usage: { in: 1, out: 1 } }),
            conductorEscalationModel: 'escx:strong',
            maxEscalations: 3,
          }),
        );
        // ① conductor 恰调 1 次 (首发), 升级环因熔断零调用
        expect(stub.conductorCalls()).toBe(1);
        // ② STALLED 出口 = circuitBroken=true
        expect(r.verification!.circuitBroken).toBe(true);
        expect(r.verification!.pass).toBe(false);
        // ③ log 含 [fuse-paralysis]
        const fuse = captured.find((c) => c.msg.includes('[omd/executor-dag][fuse-paralysis]')); // 整串前缀 = 片5c 覆盖对账的捕判词判据
        expect(fuse).toBeDefined();
        // ④ observation 点名三节点
        const blame = r.observations?.find((o) => o.message.includes('#249 外环瘫痪绊线'));
        expect(blame).toBeDefined();
        expect(blame!.nodes.sort()).toEqual(['a', 'b', 'c']);
        // ⑤ 三节点 failureKind = gate-rejected (闸拒生效)
        for (const id of ['a', 'b', 'c']) {
          const leaf = r.results[id] as LeafResult;
          expect(leaf.status).toBe('failed');
          expect(leaf.failureKind).toBe('gate-rejected');
        }
      });
    } finally {
      restoreConsoleLogger();
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GWT-2: 三红含 1 个 assert-failed (混因) → fuse 不触发, 重规划照常
  // ─────────────────────────────────────────────────────────────────────────
  test('GWT-2: 3 红中 1 个 assert-failed → 照常重规划 (generate 被调), fuse 不触发', async () => {
    try {
      await withCapturedLogger(async (captured) => {
        // 注: c = assert-failed 会触发 oracle-red 短路, verifier 不会被调用
        // (见 oracle-red.ts:81 — kind='command' AND failureKind='assert-failed' 才计入)。
        // 这反而是本测试**真正**考验的形状: 短路判词触发后, 升级环仍要按"混因不熔断"开。
        // 抓 first-call generate 的 plan 输入 (含 a/b/c 节点形状) 间接验证红节点分布。
        const stub = makeStub({
          planSequence: [
            {
              name: 'first',
              nodes: {
                a: { goal: 'gA', executor: 'command', command: 'echo a' },
                b: { goal: 'gB', executor: 'command', command: 'echo b' },
                c: { goal: 'gC', executor: 'command', command: 'echo c' },
              },
            },
            {
              name: 'second',
              nodes: {
                x: { goal: 'gx', executor: 'command', command: 'echo x' },
              },
            },
          ],
        });
        // commandRunner: a/b = gate-rejected (-1), c = assert-failed (1, ≠ expect_exit)
        const r = await runExecutorDag(
          'task',
          baseConfig(stub.generate, {
            commandRunner: commandRunnerByExitCode({ a: -1, b: -1, c: 1 }),
            verifier: async () => ({ pass: false, reason: 'verifier rejects', usage: { in: 1, out: 1 } }),
            conductorEscalationModel: 'escx:strong',
            maxEscalations: 1,
          }),
        );
        // ① conductor 调 2 次 (首发 + escalation), 升级环**开了** — 这就是混因不熔断的证据
        expect(stub.conductorCalls()).toBe(2);
        // ② fuse **不**触发 → circuitBroken 缺席 (D-6 同形出口未启用)
        expect(r.verification!.circuitBroken).toBeUndefined();
        // ③ log **不**含 [fuse-paralysis]
        const fuse = captured.find((c) => c.msg.includes('[omd/executor-dag][fuse-paralysis]')); // 整串前缀 = 片5c 覆盖对账的捕判词判据
        expect(fuse).toBeUndefined();
      });
    } finally {
      restoreConsoleLogger();
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GWT-3: 二红全类内 → 数量不足, fuse 不触发, 重规划照常
  // ─────────────────────────────────────────────────────────────────────────
  test('GWT-3: 2 红全类内 → 数量不足 (阈值=3), 照常重规划 (generate 被调), fuse 不触发', async () => {
    try {
      await withCapturedLogger(async (captured) => {
        const seenResults: Array<Record<string, LeafResult>> = [];
        const stub = makeStub({
          planSequence: [
            {
              name: 'first',
              nodes: {
                a: { goal: 'gA', executor: 'command', command: 'echo a' },
                b: { goal: 'gB', executor: 'command', command: 'echo b' },
                // 第三个节点成功 (exit 0) → 只有 a/b 两个红
                ok: { goal: 'gOK', executor: 'command', command: 'echo ok' },
              },
            },
            {
              name: 'second',
              nodes: {
                x: { goal: 'gx', executor: 'command', command: 'echo x' },
              },
            },
          ],
        });
        const r = await runExecutorDag(
          'task',
          baseConfig(stub.generate, {
            commandRunner: commandRunnerByExitCode({ a: -1, b: -1, ok: 0 }),
            verifier: async ({ results }) => {
              seenResults.push(JSON.parse(JSON.stringify(results)) as Record<string, LeafResult>);
              return { pass: false, reason: 'verifier rejects', usage: { in: 1, out: 1 } };
            },
            conductorEscalationModel: 'escx:strong',
            maxEscalations: 1,
          }),
        );
        // ① 第一轮只有 2 红 (ok 节点 exit 0 → done), 阈值 3 不满足
        expect(seenResults[0]!.a!.failureKind).toBe('gate-rejected');
        expect(seenResults[0]!.b!.failureKind).toBe('gate-rejected');
        expect(seenResults[0]!.ok!.status).toBe('done');
        // ② conductor 调 2 次 (首发 + escalation)
        expect(stub.conductorCalls()).toBe(2);
        // ③ fuse **不**触发
        expect(r.verification!.circuitBroken).toBeUndefined();
        // ④ log **不**含 [fuse-paralysis]
        const fuse = captured.find((c) => c.msg.includes('[omd/executor-dag][fuse-paralysis]')); // 整串前缀 = 片5c 覆盖对账的捕判词判据
        expect(fuse).toBeUndefined();
      });
    } finally {
      restoreConsoleLogger();
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GWT-4: 规划环 PP-O02 扩集 — 写节点无 oracleKind 无 command → 被闸拒回, 二发改 oracleKind:'judge' 放行
  // ─────────────────────────────────────────────────────────────────────────
  test('GWT-4: planCriticGate=true + 写节点无 oracleKind 无 command → generate 恰调 2 次, 终 plan 是二发', async () => {
    const stub = makeStub({
      planSequence: [
        // 首发: 写节点 + 无 command + 无 oracleKind → PP-O02 必命中
        {
          name: 'first',
          nodes: {
            doc: { goal: '写文档', output_type: 'file' } as unknown as ConductorPlan['nodes'][string],
          },
        },
        // 二发: 同形状, 加 oracleKind:'judge' (文档类交付合法判据)
        {
          name: 'second',
          nodes: {
            doc: {
              goal: '写文档',
              oracleKind: 'judge',
              whyNoFanout: 'single node, no fanout needed',
              budgetBasis: { calls: 1, tokensIn: 0, tokensOut: 0, costUsdCeiling: 0.01, estimatedBy: 'stub' },
              output_type: 'file',
            } as ConductorPlan['nodes'][string],
          },
        },
      ],
    });
    const r = await runExecutorDag(
      'task',
      baseConfig(stub.generate, {
        planCriticGate: true,
        // 无 commandRunner / verifier → 走完执行后默认通过 (本次测试焦点在规划环, 不在执行结果)
      }),
    );
    // ① generate 恰调 2 次 (首发拒回 + 二发放行)
    expect(stub.conductorCalls()).toBe(2);
    // ② 终 plan = 二发 (plan.name === 'second')
    expect(r.plan.name).toBe('second');
    // ③ 二发节点的 oracleKind = judge (PP-O02 不再触发)
    expect((r.plan.nodes.doc as { oracleKind?: string }).oracleKind).toBe('judge');
  });
});
