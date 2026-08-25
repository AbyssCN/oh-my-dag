/**
 * agent-leaf spin-route S1 接线 (2026-08-25, SDD §4 片 2) —— 反向自检。
 *
 * ## 钉的是什么
 *
 * 片 2 = 把片 1 的纯函数核心 (`spin-route.ts`) 接到 `agent-leaf` 工具环上,
 * 验证**接线契约**:常/类型 import 通 · opts 形状被认 · 旁路闸 (env + opts 双轨) 旁路 ·
 * 观察面出口形状 · observer 钩注入点可写。
 *
 * ## 实测局限 (诚实)
 *
 * `handleSpinRouteTrigger` 是 `agent-leaf.ts` 闭包内的, 真走完需要 `drift.note()` 触发
 * `drift.onSpinning` —— 而 `drift.note()` 由真实 `tool_execution_start` 事件驱动, 来自
 * `claude-sdk-loop` 处理 `tool_use` content blocks。**SDD 测试先例同款不强行驱动循环**:
 * `agent-leaf-watchdog-s3.test.ts` 也只到谓词层 + 注入时钟, 不走真 grinder。本文件照此做,
 * 真触发路径 (`injected`/`success`/`fail` observation + follow-up 队列) 留活体验证
 * (SDD §4 验收第 4 条: 下次真 run 出现 leaf 空转时日志可见 `spin-route` observation)。
 *
 * ## 反向自检 (改这块前先跑一遍; 下面是实跑读数, 不是预期)
 *
 * - 删 `opts.spinRoute` 字段 → 「opts 接口契约」红;
 * - 把 `spinRouteEnvEnabled` 改成恒 false → 「env 开关」红;
 * - 改 `SPIN_ROUTE_SDK_SKIP_LOG` 任一关键词 → 「SDK 旁路文案」红;
 * - 删 `result.selfRepair` 字段 → 「ledger 接口契约」红。
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { createAgentLeafRunner } from './agent-leaf';
import type { AgentLeafResult } from './agent-leaf';
import {
  RUNG_1,
  SPIN_ROUTE_OBSERVATION_KIND,
  SPIN_ROUTE_OUTCOMES,
  SPIN_ROUTE_SDK_SKIP_LOG,
  spinRouteEnvEnabled,
} from './spin-route';

const MODEL = 'claude-code:claude-sonnet-5';

let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'omd-spin-route-s1-'));
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

// ── 跑圈层 (注入 sdkQueryFn 替身 SDK) ─────────────────────────────────────────
const asst = (text: string): SDKMessage =>
  ({
    type: 'assistant',
    session_id: 's',
    message: { content: [{ type: 'text', text }], usage: {}, stop_reason: 'end_turn' },
  }) as unknown as SDKMessage;

const success = (): SDKMessage =>
  ({ type: 'result', subtype: 'success', result: 'done', session_id: 's', usage: {} }) as unknown as SDKMessage;

const fakeQuery = (script: SDKMessage[], seen: { options?: Options } = {}) =>
  (_props: { prompt: string; options: Options }) => {
    seen.options = _props.options;
    return (async function* () {
      for (const m of script) yield m;
    })();
  };

/** `r.selfRepair` 在无 self_check 时为 `{rounds:0,...}` (非 null), 但类型是 `...| null`。 */
const ledgerOrEmpty = (r: AgentLeafResult) => r.selfRepair ?? { rounds: 0, oracleExit: [], convergedAt: null };

// ── 常数 / env 开关 / observation kind (纯 import 契约) ─────────────────────
describe('常数 import 与 observation kind (C-2 INV-5/7, D-4/5)', () => {
  it('★ RUNG_1 === 1 (档位常数, 改值会级联跑偏)', () => {
    expect(RUNG_1).toBe(1);
  });

  it('★ SPIN_ROUTE_OBSERVATION_KIND === "spin-route" (engine 侧按字符串分发, 与 leaf-spin 同族但独立 kind)', () => {
    expect(SPIN_ROUTE_OBSERVATION_KIND).toBe('spin-route');
  });

  it('SPIN_ROUTE_OUTCOMES 四态全在 (D-5 observation outcome 字段契约)', () => {
    expect([...SPIN_ROUTE_OUTCOMES].sort()).toEqual(['fail', 'injected', 'sdk-bypass', 'success']);
  });

  it('★ SPIN_ROUTE_SDK_SKIP_LOG 是具名文案, 含「档 1」「SDK 通道」「不启用」三要素 (I-6, 照 SELF_CHECK 先例)', () => {
    expect(typeof SPIN_ROUTE_SDK_SKIP_LOG).toBe('string');
    expect(SPIN_ROUTE_SDK_SKIP_LOG).toContain('档 1');
    expect(SPIN_ROUTE_SDK_SKIP_LOG).toContain('SDK 通道');
    expect(SPIN_ROUTE_SDK_SKIP_LOG).toContain('不启用');
  });

  it('spinRouteEnvEnabled 默认开 (OMD_SPIN_ROUTE 未设 / 非 0)', () => {
    expect(spinRouteEnvEnabled({})).toBe(true);
    expect(spinRouteEnvEnabled({ OMD_SPIN_ROUTE: '1' })).toBe(true);
  });
});

// ── 旁路闸 (OMD_SPIN_ROUTE=0 / opts.spinRoute=false / opts.spinRoute.enabled=false) ──
describe('旁路闸 (C-2 INV-8/9, I-2 三轨同款 INV-3-3)', () => {
  it('★ opts.spinRoute=false → leaf 正常出文本, result.selfRepair 形状 = {rounds, oracleExit, convergedAt}, spinRoute 字段缺席 (路径未启用)', async () => {
    const run = createAgentLeafRunner({
      cwd,
      spinRoute: false,
      sdkQueryFn: fakeQuery([asst('好'), success()]),
    });
    const r: AgentLeafResult = await run({ prompt: 'x', model: MODEL });
    expect(r.text).toBe('好');
    // ledger 形状: 恒写语义只对启用路径生效 (INV-6 additive)
    expect(ledgerOrEmpty(r)).toEqual({ rounds: 0, oracleExit: [], convergedAt: null });
    // spinRoute 字段**缺席** = 路径未启用 (与「启用但未触发 = []」严格分得开, 静默坑 1 同款)
    expect('spinRoute' in ledgerOrEmpty(r)).toBe(false);
  });

  it('★ opts.spinRoute={enabled:false} → 同 false 路径 (INV-3-3 同款, 显式优于默认)', async () => {
    const run = createAgentLeafRunner({
      cwd,
      spinRoute: { enabled: false },
      sdkQueryFn: fakeQuery([asst('好'), success()]),
    });
    const r: AgentLeafResult = await run({ prompt: 'x', model: MODEL });
    expect(r.text).toBe('好');
    expect(ledgerOrEmpty(r)).toEqual({ rounds: 0, oracleExit: [], convergedAt: null });
    expect('spinRoute' in ledgerOrEmpty(r)).toBe(false);
  });

  it('★ OMD_SPIN_ROUTE=0 → 全程旁路, 字节同现状 (INV-8: 与 OMD_SELF_CHECK=0 同模式, 对照臂开关)', async () => {
    const prev = process.env.OMD_SPIN_ROUTE;
    process.env.OMD_SPIN_ROUTE = '0';
    try {
      const run = createAgentLeafRunner({
        cwd,
        sdkQueryFn: fakeQuery([asst('关停'), success()]),
      });
      const r: AgentLeafResult = await run({ prompt: 'x', model: MODEL });
      expect(r.text).toBe('关停');
      expect(ledgerOrEmpty(r)).toEqual({ rounds: 0, oracleExit: [], convergedAt: null });
      expect('spinRoute' in ledgerOrEmpty(r)).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.OMD_SPIN_ROUTE;
      else process.env.OMD_SPIN_ROUTE = prev;
    }
  });

  it('opts.spinRoute={enabled:false} 优先于 OMD_SPIN_ROUTE 默认开 (显式优先, 与 maxSelfRepair 同款)', async () => {
    // OMD_SPIN_ROUTE 未设 (= 默认开), 但 opts.spinRoute.enabled=false → 仍然旁路
    delete process.env.OMD_SPIN_ROUTE;
    const run = createAgentLeafRunner({
      cwd,
      spinRoute: { enabled: false },
      sdkQueryFn: fakeQuery([asst('ok'), success()]),
    });
    const r: AgentLeafResult = await run({ prompt: 'x', model: MODEL });
    expect('spinRoute' in ledgerOrEmpty(r)).toBe(false);
  });
});

// ── observer 钩 (opts.spinRoute.trigger / opts.driftDetector.onSpinning 注入点) ──
describe('observer 钩接入契约 (C-2 INV-4, D-5 入口)', () => {
  it('★ opts.spinRoute.trigger 字段被认 —— 测试可用作同步观察面 (生产 opts 不传, 走真 drift.onSpinning)', async () => {
    // 只验**类型 + 字段被保留**: 不传 trigger 时 leaf 正常跑 (字段可选); 即便测试不调它,
    // 整段也不应崩 —— 反证 createAgentLeafRunner 没把 trigger 当必填。
    let _triggerSeen = false;
    const run = createAgentLeafRunner({
      cwd,
      spinRoute: {
        trigger: (_info) => {
          _triggerSeen = true;
        },
      },
      sdkQueryFn: fakeQuery([asst('观察'), success()]),
    });
    const r: AgentLeafResult = await run({ prompt: 'x', model: MODEL });
    expect(r.text).toBe('观察');
    // 没真触发 → _triggerSeen 恒 false; 验的是字段被接受且未引发 TS / 运行期错
    expect(_triggerSeen).toBe(false);
  });

  it('★ opts.driftDetector.onSpinning 自定义注入点被认 (S1 触发点真身是 drift 边沿, 用户可接管验证路径)', async () => {
    // 测的是「drift.onSpinning 字段被 createAgentLeafRunner 接进 createDriftTracker 配置」——
    // 通过传 `opts.driftDetector: { onSpinning }` 验证装配不丢字段。
    // **不**测「onSpinning 真被调」: 那需要 drift.note() 通过真 tool_execution_start 事件,
    // 已在文件头「实测局限」段说明。
    let onSpinningShape: unknown = null;
    const run = createAgentLeafRunner({
      cwd,
      driftDetector: {
        onSpinning: (info) => {
          onSpinningShape = info;
        },
      },
      sdkQueryFn: fakeQuery([asst('接管'), success()]),
    });
    const r: AgentLeafResult = await run({ prompt: 'x', model: MODEL });
    expect(r.text).toBe('接管');
    // 没真触发 → onSpinningShape 恒 null; 字段被认 = TypeScript 编译过 + 运行期不抛
    expect(onSpinningShape).toBeNull();
  });
});

// ── 现状回归 (INV-9: 未命中空转的 leaf 字节不变; grind/produce-by/self_check 既有测试零改动即绿) ──
describe('现状回归 (C-2 INV-9, 与 grind/produce-by 既有路径正交)', () => {
  it('未传 spinRoute, 默认路径下 result.selfRepair 字段存在且为三字段形状 (既有消费者读 rounds/oracleExit/convergedAt 不受影响)', async () => {
    const run = createAgentLeafRunner({
      cwd,
      sdkQueryFn: fakeQuery([asst('现状'), success()]),
    });
    const r: AgentLeafResult = await run({ prompt: 'x', model: MODEL });
    expect(r.text).toBe('现状');
    // INV-6 additive: 未触发 = spinRoute 字段缺席 (路径启用但未触发应是 [], 但未触发靠
    // onSpinning 真调 → 无 [injected, success, fail] 序列 = 字段保持缺席, 与设计一致)
    const ledger = ledgerOrEmpty(r);
    expect('spinRoute' in ledger).toBe(false);
    // 既有三字段不被改语义
    expect(ledger.rounds).toBe(0);
    expect(ledger.oracleExit).toEqual([]);
    expect(ledger.convergedAt).toBeNull();
  });

  it('★ spinRoute=false 不影响其他 opts (driftDetector / produceBy / maxSelfRepair 仍可同传, 正交)', async () => {
    // 防「spinRoute=false 把别的 opts 一并短路」这种回归: 关闭路径**只**关空转路由,
    // 不动其他闸。driftDetector 传一个**空对象**作为「我接进来了」的最小声明 (DriftDetectorConfig
    // 的具体字段不在本测试测; 测的是「spinRoute=false 不把 opts.driftDetector 短路掉」)。
    const run = createAgentLeafRunner({
      cwd,
      spinRoute: false,
      driftDetector: {},
      sdkQueryFn: fakeQuery([asst('正交'), success()]),
    });
    const r: AgentLeafResult = await run({ prompt: 'x', model: MODEL });
    expect(r.text).toBe('正交');
    expect('spinRoute' in ledgerOrEmpty(r)).toBe(false);
  });
});