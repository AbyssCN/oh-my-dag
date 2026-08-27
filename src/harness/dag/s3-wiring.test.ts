/**
 * S3 片 5: engine 接线 + 闸登记 (S3_RETRY_DOMAIN_WIRED)
 *
 * 验证 engine.ts 真正调动了片 1 / 片 2 的纯函数, 而不只是 import。
 * 五条不变量逐条落断言:
 *   · INV-2 oracle 域判否越过 max_retry
 *   · INV-3 「没能说话」保持现行重试语义 (逐字节不变)
 *   · INV-6 verifier 超时后重跑不覆盖已记录判词
 *   · INV-9 部分失败 join 留结构化痕迹
 *   · INV-11 闸登记与事件面同片对账
 *
 * ⚠ 锚串 `S3_RETRY_DOMAIN_WIRED` 必须逐字出现于本测试文件 (反作弊 EMPTY MATCH 那条);
 *   删掉它 = 闸空转 = 反向自检 1 咬不出来。
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runExecutorDagWithPlan } from './engine';
import { classifyRetryDomain, retryBudgetFor, type RetryDomain } from './retry-domain';
import { reconcileGateIds, scanGateVerdicts } from '../gates/gate-registry';
import type { ConductorPlan } from '../conductor-plan';
import type { ExecutorDagConfig, GenerateFn } from './types';
import { PLAN_BOUNDARY } from '../conductor-plan';
import { registerProvider } from '../../model/providers';

// 注册一个让升级模型能 ready 的假 provider (INV-6 测试要用 conductorEscalationModel 进升级轮)。
registerProvider('t', { baseUrl: 'http://127.0.0.1:9', apiKey: 'test-key', api: 'openai-compatible' });

const ROOT = join(import.meta.dir, '../../..');

// ── 真源锚 (扫 engine.ts + run-goal.ts, 同 gate-registry.test.ts 那一套) ─────
const ENGINE_SRC = readFileSync(join(ROOT, 'src/harness/dag/engine.ts'), 'utf8');
const RUN_GOAL_SRC = readFileSync(join(ROOT, 'src/harness/goal/run-goal.ts'), 'utf8');
const SOURCE_BY_FILE: Readonly<Record<string, string>> = {
  'src/harness/dag/engine.ts': ENGINE_SRC,
  'src/harness/goal/run-goal.ts': RUN_GOAL_SRC,
};

// ── 公共 fixture ────────────────────────────────────────────────────────────

const plan = (nodes: ConductorPlan['nodes']): ConductorPlan => ({ name: 's3-wiring', nodes });

const mkCfg = (
  generate: GenerateFn,
  extra: Partial<ExecutorDagConfig> = {},
): ExecutorDagConfig => ({
  conductorModel: 't:cond',
  leafModel: 't:leaf',
  generate,
  agentTemplates: new Map(),
  ...extra,
});

// 单叶跑通的 leaf generate: 按 prompt 头部找 id, 全部 done。
// 升级重规划轮的 REPLAN-PATCH / CONDUCTOR 提示返回同 plan JSON, 否则返 'out:<id>'。
const okGenerate: GenerateFn = async (req) => {
  const sysC = req.messages.find((m) => m.role === 'system')?.content;
  const sys = typeof sysC === 'string' ? sysC : '';
  if (sys.includes('REPLAN-PATCH') || sys.includes('CONDUCTOR')) {
    // 返回当前 plan 的 JSON —— 升级重规划走「原计划复用」通路, 叶片由 D-21 复用注入,
    // 不会真的再调 generate。
    return { text: JSON.stringify({ patch: {} }), usage: { in: 0, out: 0 } };
  }
  const user = req.messages.find((m) => m.role === 'user')?.content;
  const text = typeof user === 'string' ? user : (user ?? []).map((p) => (p.type === 'text' ? p.text : '')).join('');
  const id = /\[omd leaf: ([^\]]+)\]/.exec(text)?.[1] ?? '?';
  return { text: `out:${id}`, usage: { in: 0, out: 0 } };
};

// ── INV-2 / INV-3: retry 域在 runNode 内真的接上了 ──────────────────────────

describe('S3_RETRY_DOMAIN_WIRED · INV-2 oracle 域判否越过 max_retry', () => {
  test('command 节点 max_retry:3 + exitCode:1 (assert-failed) → commandRunner 恰 1 次', async () => {
    let calls = 0;
    const r = await runExecutorDagWithPlan(
      plan({
        A: { goal: 'oracle', executor: 'command', expect_exit: 0, max_retry: 3, command: 'noop' },
      }),
      mkCfg(okGenerate, {
        commandRunner: async () => {
          calls++;
          return { text: 'failed', usage: { in: 0, out: 0 }, timedOut: false, signal: null, exitCode: 1 };
        },
      }),
    );
    expect(calls).toBe(1);
    expect(r.results.A!.status).toBe('failed');
    expect(r.results.A!.failureKind).toBe('assert-failed');
  });

  test('max_retry 拉到 9 仍恰 1 次 (oracle 域判否越过一切显式 max_retry)', async () => {
    let calls = 0;
    const r = await runExecutorDagWithPlan(
      plan({
        A: { goal: 'oracle', executor: 'command', expect_exit: 0, max_retry: 9, command: 'noop' },
      }),
      mkCfg(okGenerate, {
        commandRunner: async () => {
          calls++;
          return { text: 'failed', usage: { in: 0, out: 0 }, timedOut: false, signal: null, exitCode: 1 };
        },
      }),
    );
    expect(calls).toBe(1);
    expect(r.results.A!.failureKind).toBe('assert-failed');
  });
});

describe('S3_RETRY_DOMAIN_WIRED · INV-3 timed-out 保持现行重试语义', () => {
  test('command 节点 max_retry:1 + timedOut → commandRunner 恰 2 次 (现行重试)', async () => {
    let calls = 0;
    const r = await runExecutorDagWithPlan(
      plan({
        A: { goal: 'cmd', executor: 'command', expect_exit: 0, max_retry: 1, command: 'noop' },
      }),
      mkCfg(okGenerate, {
        commandRunner: async () => {
          calls++;
          return { text: 'timed-out', usage: { in: 0, out: 0 }, timedOut: true, signal: null, exitCode: 124 };
        },
      }),
    );
    expect(calls).toBe(2);
    expect(r.results.A!.failureKind).toBe('timed-out');
  });
});

// ── INV-6: verifier 调不通 ≠ 覆写已记录判词 ─────────────────────────────────

describe('S3_RETRY_DOMAIN_WIRED · INV-6 verifier 超时不覆盖已记录判词', () => {
  test('轮 1 实质 fail → 轮 2 [verifier-error] → 终值仍是轮 1 判词', async () => {
    // 叶子只是为了让执行段不至于零节点: 单叶无依赖, 一次 okGenerate 就够。
    // 升级重规划轮的 conductor 也走 okGenerate (它视 conductor 为 leaf, 走相同通道)。
    let verifierCalls = 0;
    const r = await runExecutorDagWithPlan(
      plan({ A: { goal: 'leaf' } }),
      mkCfg(okGenerate, {
        verifier: async () => {
          verifierCalls++;
          if (verifierCalls === 1) {
            return { pass: false, reason: 'round-1-substantive: 缺条目 X', usage: { in: 0, out: 0 } };
          }
          // 轮 2: 模拟 verifier 调不通。engine 的 runVerifier 闭包内捕获并返回 [verifier-error]
          // 判词 + 设 verifierDown=true (这是现状, 本片不动 verifier 本体)。
          return {
            pass: false,
            reason: '[verifier-error] 判卷官调不通 (mock: S3 wiring test)',
            usage: { in: 0, out: 0 },
          };
        },
        conductorEscalationModel: 't:esc',
        maxEscalations: 1,
      }),
    );
    expect(verifierCalls).toBeGreaterThanOrEqual(2);
    expect(r.verification).toBeDefined();
    // 终值判词必须保留轮 1 的实质判词 —— 不能被 [verifier-error] 覆盖。
    expect(r.verification!.reason).toContain('round-1-substantive');
    expect(r.verification!.reason).not.toContain('[verifier-error]');
    // 引擎故障标志位必须为 true (这是新出现的「判卷官没坏但我们没问它」的一列)。
    expect(r.verification!.infraObserved).toBe(true);
  });
});

// ── INV-9: 部分失败 join 留结构化痕迹 ───────────────────────────────────────

describe('S3_RETRY_DOMAIN_WIRED · INV-9 部分失败 join 留结构化观察', () => {
  test('requires:"any" + 1 done / 2 failed → observations 含 partial-quorum-failure', async () => {
    const r = await runExecutorDagWithPlan(
      plan({
        a: { goal: 'leaf a' },
        b: { goal: 'leaf b', executor: 'command', expect_exit: 0, command: 'noop' },
        c: { goal: 'leaf c', executor: 'command', expect_exit: 0, command: 'noop' },
        sink: { goal: 'synth', depends_on: ['a', 'b', 'c'], requires: 'any' },
      }),
      mkCfg(okGenerate, {
        commandRunner: async () => ({ text: '', usage: { in: 0, out: 0 }, timedOut: false, signal: null, exitCode: 1 }),
      }),
    );
    // sink 必须照跑 (1 done >= 1, any 达标)
    expect(r.results.sink!.status).toBe('done');
    // 必须在 observations 里点名那 2 个未 done 的依赖 (仓规坑 1: 结构化 ≠ 散文)
    expect(r.observations).toBeDefined();
    const partials = r.observations!.filter((o) => o.kind === 'partial-quorum-failure');
    expect(partials).toHaveLength(1);
    const obs = partials[0]!;
    expect(obs.message).toMatch(/\bb\(/);
    expect(obs.message).toMatch(/\bc\(/);
  });

  test('requires:"any" + 全部 done → 不发 partial-quorum-failure (无失败不发噪声)', async () => {
    const r = await runExecutorDagWithPlan(
      plan({
        a: { goal: 'leaf a' },
        b: { goal: 'leaf b', executor: 'command', expect_exit: 0, command: 'noop' },
        sink: { goal: 'synth', depends_on: ['a', 'b'], requires: 'any' },
      }),
      mkCfg(okGenerate, {
        commandRunner: async () => ({ text: 'ok', usage: { in: 0, out: 0 }, timedOut: false, signal: null, exitCode: 0 }),
      }),
    );
    expect(r.results.sink!.status).toBe('done');
    const partials = (r.observations ?? []).filter((o) => o.kind === 'partial-quorum-failure');
    expect(partials).toHaveLength(0);
  });
});

// ── INV-11: 闸登记与事件面同片对账 ──────────────────────────────────────────

describe('S3_RETRY_DOMAIN_WIRED · INV-11 闸登记对账 (新引擎侧判词必须同片入表)', () => {
  test('retry-domain-mask 与 verifier-ledger 与 partial-quorum-failure 三条新闸均在 engine.ts 源码里', () => {
    expect(ENGINE_SRC).toContain('[omd/executor-dag][retry-domain-mask]');
    expect(ENGINE_SRC).toContain('[omd/executor-dag][verifier-ledger]');
    expect(ENGINE_SRC).toContain('[omd/executor-dag][partial-quorum-failure]');
  });

  test('真源对账: missing + unregistered 都为空 (含既有 15 条与本次新增)', () => {
    const reconciled = reconcileGateIds(SOURCE_BY_FILE);
    expect(reconciled.missing).toEqual([]);
    expect(reconciled.unregistered).toEqual([]);
    const verdicts = scanGateVerdicts(SOURCE_BY_FILE);
    expect(verdicts.has('retry-domain-mask')).toBe(true);
    expect(verdicts.has('verifier-ledger')).toBe(true);
    expect(verdicts.has('partial-quorum-failure')).toBe(true);
  });
});

// ── 反向自检 (反作弊条款: 把域判定改成恒返 generation / ledger 改成取最后一条) ──
//
// 这些断言保证 wiring 真的引用了片 1 / 片 2 的纯函数, 而不是把判定逻辑复制粘贴进 engine.ts:
//   · classifyRetryDomain 签名与 retryBudgetFor 签名必须稳定
//   · engine.ts 源码必须 import 这两个函数 (而不是把判定逻辑就地展开)
//
// 自检 1 (反 retry 域漂移): classifyRetryDomain('command', 'assert-failed') === 'oracle'
// 自检 2 (反覆写): retryBudgetFor('generation', undefined, true) === 1 (现行语义逐字节不变)
// 自检 3 (反 wiring 漂移): engine.ts 源码 grep 必须包含 'classifyRetryDomain' / 'retryBudgetFor'
//                          / 'verdictLedger' / 'partial-quorum-failure' 这 4 个标识符
//   (缺一个 = 没接到片 1/2/3 的纯函数, 即使测试通过也是测了空)
describe('S3_RETRY_DOMAIN_WIRED · 反向自检 · engine.ts 真的接上了片 1/2/3', () => {
  test('classifyRetryDomain(command, assert-failed) === oracle (片 1 纯函数活着)', () => {
    expect(classifyRetryDomain('command', 'assert-failed')).toBe<RetryDomain>('oracle');
    expect(classifyRetryDomain('command', 'timed-out')).toBe<RetryDomain>('generation');
    expect(classifyRetryDomain('agent', 'assert-failed')).toBe<RetryDomain>('generation');
  });

  test('retryBudgetFor(generation, undefined, true) === 1 (现行语义逐字节不变)', () => {
    expect(retryBudgetFor('generation', undefined, true)).toBe(1);
    expect(retryBudgetFor('generation', undefined, false)).toBe(0);
    expect(retryBudgetFor('generation', 5, false)).toBe(5);
    expect(retryBudgetFor('oracle', 9, false)).toBe(0); // INV-2
  });

  test('engine.ts 源码包含 4 个 wiring 标识符 (缺一 = 没接到)', () => {
    // 缺一个 = 反向自检 1/2/3/4 咬不出来, 闸白装。
    expect(ENGINE_SRC).toContain('classifyRetryDomain');
    expect(ENGINE_SRC).toContain('retryBudgetFor');
    expect(ENGINE_SRC).toContain("from './verdict-ledger'");
    expect(ENGINE_SRC).toContain("'partial-quorum-failure'");
  });
});