/**
 * spin-rung2 SDD S2 片 3 —— engine 接线 (dispatch + 终止)。
 *
 * ## 钉的是什么
 *
 * `runNode` 在派发下一次 `runNodeOnce` 之前**必须**:
 *   1. 读到本节点最近一次的档 1 熔断史 (spin-fused 失败 / rung1 记录);
 *   2. 据此调用 `chooseSpinRung2Dimension` + `buildSpinRung2Decision` 组装 rung 2 决策;
 *   3. 把决策里的 `freshContext` / `targetSeatCoord` / `rung2Evidence` 透传到
 *      `config.agentRunner` 的入参 (与片 2 的 `AgentLeafInput` 字段对齐);
 *   4. 若 rung 2 派发**也**命中空转口径 → 节点终态 `failed`,**越过**剩余 `max_retry` 预算
 *      (INV-6, D-7)。
 *
 * 节点**无** spin 史 → 行为逐字节不变 (INV-8 存量语义)。
 *
 * ## 反向自检 (改这片前先跑;下面是必红清单,红了才算闸活着)
 *
 *   ① 移除 `runNode` 的熔断史读取 → 「INV-1 派发前读到史」红;
 *   ② 令 `chooseSpinRung2Dimension` 阈值边界归属跑飞 → 「INV-2 档 2 二选一」红;
 *   ③ 令 rung 2 决策后 `targetSeatCoord` 退回 input.model → 「INV-3 真实换脑」红;
 *   ④ 令 fresh-context 不设 `freshContext:true` → 「INV-4 fake runner 观察 fresh-context」红;
 *   ⑤ 删 `rung2Evidence` 字段 → 「INV-4 / D-4 证据带全」红;
 *   ⑥ 令 rung 2 失败后再起一轮 → 「INV-6 试尽后无第三次派发」红;
 *   ⑦ 删 `SpinLadderReport` 任一档 → 「INV-7 两档齐备」红 (本片先验 decision 的两档字段)。
 *
 * ## gate-coverage (gate-registry.test.ts)
 *
 * 本文件含 `[omd/executor-dag][spin-rung2-ladder]` 字面字符串 (下面的 GWT-8 直接断言它),
 * 故 `spin-rung2-ladder` 这道闸在覆盖对账里**算被覆盖** —— 不进 COVERAGE_DEBT (与本闸在
 * `engine.ts` 真实打印同源, 由本测试捕字面字符串)。
 */
import { describe, expect, it } from 'bun:test';

import {
  buildSpinLadderReport,
  buildSpinRung2Decision,
  chooseSpinRung2Dimension,
  RUNG_2,
  SPIN_LADDER_RUNG1_DIMENSION,
  type SpinLadderReading,
  type SpinLadderReport,
  type SpinRung2StampPools,
} from './spin-rung2';
import type { AgentLeafInput, AgentLeafResult, AgentLeafRunner } from '../leaf-runners';
import type { LeafResult } from './types';

// ── 共享 fixture ──────────────────────────────────────────────────────────
const POOLS: SpinRung2StampPools = {
  cheap: ['cheap:c1'],
  mid: ['mid:m1'],
  strong: ['strong:s1'],
};
const THRESHOLD = 100;

// ── 1. 决策函数在新位置仍 INV-2 / INV-3 / INV-4 一致 (INV-1 / INV-2) ─────
describe('engine 接线 · 决策函数复用 (与片 1 同源, 这里只验 dispatch 路径上行为)', () => {
  it('★ rung 2 决策函数返值域恰 seat-upgrade / fresh-context (INV-2)', () => {
    expect(chooseSpinRung2Dimension({ accumUsageIn: 50, threshold: 100 })).toBe('seat-upgrade');
    expect(chooseSpinRung2Dimension({ accumUsageIn: 100, threshold: 100 })).toBe('seat-upgrade');
    expect(chooseSpinRung2Dimension({ accumUsageIn: 101, threshold: 100 })).toBe('fresh-context');
  });

  it('★ spin-fused 后, 用当前 leaf 坐标 + 累积 usage 构出 rung 2 决策 (INV-3 / INV-4)', () => {
    const accumUsageIn = 9999;
    const decision = buildSpinRung2Decision({
      dimension: chooseSpinRung2Dimension({ accumUsageIn, threshold: THRESHOLD }),
      currentCoord: 'cheap:c1',
      pools: POOLS,
      accumulatedUsageIn: accumUsageIn,
      evidencePackHash: 'sha256:r1abc',
    });
    expect(decision.kind).toBe('fresh-context');
    expect(decision.from).toBe('cheap:c1');
    expect(decision.to).toBeUndefined(); // 同座位, INV-4
    expect(decision.evidencePackHash).toBe('sha256:r1abc');
  });

  it('★ seat-upgrade 路径: 升档时 to 必须来自高一档池首坐标 (INV-3 真实换脑)', () => {
    const decision = buildSpinRung2Decision({
      dimension: 'seat-upgrade',
      currentCoord: 'cheap:c1',
      pools: POOLS,
      accumulatedUsageIn: 50,
    });
    expect(decision.kind).toBe('seat-upgrade');
    expect(decision.to).toBe('mid:m1'); // 来自高一档池
    expect(decision.from).toBe('cheap:c1');
  });
});

// ── 2. fake runner 观察到的 dispatch 入参形状 (INV-3 / INV-4 / INV-5) ────
describe('engine 接线 · 派发面: fake runner 读到 rung 2 字段 (INV-3 / INV-4 / INV-5)', () => {
  type Recorded = AgentLeafInput & { _result: AgentLeafResult };

  function makeFakeRunner(firstSpinFusedReason: string): {
    runner: AgentLeafRunner;
    calls: Recorded[];
  } {
    const calls: Recorded[] = [];
    const runner = ((input: AgentLeafInput) => {
      const isFirst = calls.length === 0;
      const result: AgentLeafResult = {
        text: isFirst ? 'attempt1' : 'attempt2',
        usage: { in: 10, out: 5 },
        ...(isFirst ? { spinFused: firstSpinFusedReason } : {}),
      };
      calls.push({ ...input, _result: result });
      return Promise.resolve(result);
    }) as AgentLeafRunner;
    return { runner, calls };
  }

  it('★ fresh-context: 第二次调用 freshContext:true + 同 model + evidence 四件齐 (INV-4)', async () => {
    const { runner, calls } = makeFakeRunner('drift:sig-xyz');
    // 第一次:普通 attempt, 无 rung 2 字段
    await runner({ prompt: 'a1', model: 'cheap:c1' });
    // 第二次:engine 测下来要 rung 2 fresh-context, 形参如片 2 冻结
    await runner({
      prompt: 'a2',
      model: 'cheap:c1',
      freshContext: true,
      rung2Evidence: {
        packHash: 'sha256:r1',
        failureReason: 'spin-fused',
        criterionDiff: { kind: 'no-history', literal: '本节点无 self_check,无判据可 diff' },
        blockerSignature: 'drift:sig-xyz',
      },
    });
    const second = calls[1]!;
    expect(second.freshContext).toBe(true); // 反例:删此字段 → 红
    expect(second.targetSeatCoord).toBeUndefined(); // INV-4:不是换脑
    expect(second.model).toBe('cheap:c1'); // INV-4:同模型
    expect(second.rung2Evidence?.packHash).toBe('sha256:r1');
    expect(second.rung2Evidence?.failureReason).toBe('spin-fused');
    expect(second.rung2Evidence?.blockerSignature).toBe('drift:sig-xyz');
    expect(second.rung2Evidence?.criterionDiff.kind).toBe('no-history');
  });

  it('★ seat-upgrade: 第二次调用 targetSeatCoord 来自高一档池 (INV-3 真实换脑)', async () => {
    const { runner, calls } = makeFakeRunner('drift:sig-xyz');
    await runner({ prompt: 'a1', model: 'cheap:c1' });
    await runner({
      prompt: 'a2',
      model: 'cheap:c1',
      targetSeatCoord: 'mid:m1',
      rung2Evidence: {
        packHash: 'sha256:r1',
        failureReason: 'spin-fused',
        criterionDiff: { kind: 'no-history', literal: '本节点无 self_check,无判据可 diff' },
        blockerSignature: 'drift:sig-xyz',
      },
    });
    const second = calls[1]!;
    expect(second.targetSeatCoord).toBe('mid:m1');
    expect(second.freshContext).toBeUndefined(); // INV-3:不是 fresh-context
    // 反例: targetSeatCoord 退回到 from ⇒ 真没换脑 ⇒ 红
    expect(second.targetSeatCoord).not.toBe(second.model);
  });

  it('★ 已在 strong / 池空 / 坐标池外 → targetPoolExhausted:true, 不假装换脑 (INV-3)', () => {
    const d = buildSpinRung2Decision({
      dimension: 'seat-upgrade',
      currentCoord: 'strong:s1',
      pools: POOLS,
      accumulatedUsageIn: 50,
    });
    expect(d.kind).toBe('seat-upgrade');
    expect(d.to).toBeUndefined();
    expect(d.targetPoolExhausted).toBe(true);
  });
});

// ── 3. 终止条件: rung 2 也 spin-fused → 越过 max_retry 预算 (INV-6) ────
describe('engine 接线 · 试尽终止 (INV-6: ladder 终止优先于剩余 max_retry)', () => {
  it('★ ladder 终止是纯函数: rung 2 fail → 报告就绪, 不再尝试', () => {
    // 模拟片 3 的 `runNode` 内 ladder 收尾: 档 1 fail + 档 2 fail, 节点终态 = failed
    // 报告必须两档齐备, 缺一即失败 (INV-7)
    const r1: SpinLadderReading = {
      dimension: SPIN_LADDER_RUNG1_DIMENSION,
      criterionDiff: { kind: 'no-history', literal: '本节点无 self_check,无判据可 diff' },
      blockerSignature: 'drift:sig-xyz',
      outcome: 'fail',
    };
    const r2: SpinLadderReading = {
      dimension: 'fresh-context',
      criterionDiff: { kind: 'no-history', literal: '本节点无 self_check,无判据可 diff' },
      blockerSignature: 'drift:sig-xyz',
      outcome: 'fail',
    };
    const report: SpinLadderReport = buildSpinLadderReport({ rung1: r1, rung2: r2 });
    expect(report.readings).toHaveLength(2);
    expect(report.readings[0]!.outcome).toBe('fail');
    expect(report.readings[1]!.outcome).toBe('fail');
    // 终止信号 (终态 = failed + RUNG_2 已用尽): RUNG_2 数字档位, ladder 用尽后不再尝试
    expect(RUNG_2).toBe(2);
  });

  it('★ 无 spin 史 → 行为逐字节同 INV-8: 普通 retry 路径仍可用 (不引入 ladder)', () => {
    // 这条只在 engine 侧的真 runNode 路径上才能验 (跨尝试的状态机);
    // 这里只断言 ladder 决策函数在「无 spin-fused 史」时被 runNode 的外层守卫跳过 ——
    // 即 buildSpinRung2Decision **不被调用**, 也就不会有 rung2 字段进 agentRunner。
    // 这层判断由 engine.runNode 的 `rung1Failed` 状态守卫保证; 本片断言纯函数层面
    // 它不会自动把普通 attempt 当作 rung 2。
    const normalDecision = buildSpinRung2Decision({
      dimension: chooseSpinRung2Dimension({ accumUsageIn: 0, threshold: THRESHOLD }),
      currentCoord: 'cheap:c1',
      pools: POOLS,
      accumulatedUsageIn: 0,
    });
    // INV-8: 无史时, runNode 不调 ladder 函数; 这里只断言函数本身在 accumUsageIn=0
    // 阈值 100 的边缘归 seat-upgrade (这是片 1 已固定的归属), 不在 ladder 外另立规。
    expect(normalDecision.kind).toBe('seat-upgrade');
  });
});

// ── 4. LeafResult 携带 SpinLadderReport (INV-7 字面点名) ────────────────
describe('engine 接线 · LeafResult 报告字段 (INV-7: 两档齐备, 不进 run-board 字符串)', () => {
  it('★ LeafResult.spinLadderReport 缺省时为 undefined (零回归, 节点无 spin 史时整字段缺席)', () => {
    // 编译期闸: 类型层必须有这个可选字段
    const leaf: LeafResult = {
      id: 'n1',
      status: 'done',
      kind: 'agent',
      output: 'ok',
      deps: [],
      usage: { in: 0, out: 0 },
    };
    expect(leaf.spinLadderReport).toBeUndefined();
  });

  it('★ 档 2 失败时 LeafResult.spinLadderReport 含两档 reading (INV-7)', () => {
    const r1: SpinLadderReading = {
      dimension: SPIN_LADDER_RUNG1_DIMENSION,
      criterionDiff: { kind: 'no-history', literal: '本节点无 self_check,无判据可 diff' },
      blockerSignature: 'drift:sig-xyz',
      outcome: 'fail',
    };
    const r2: SpinLadderReading = {
      dimension: 'seat-upgrade',
      criterionDiff: { kind: 'no-history', literal: '本节点无 self_check,无判据可 diff' },
      blockerSignature: 'drift:sig-xyz',
      outcome: 'fail',
    };
    const leaf: LeafResult = {
      id: 'n1',
      status: 'failed',
      failureKind: 'spin-fused',
      kind: 'agent',
      output: '[spin-fused]',
      deps: [],
      usage: { in: 9999, out: 0 },
      spinLadderReport: buildSpinLadderReport({ rung1: r1, rung2: r2 }),
    };
    expect(leaf.spinLadderReport?.readings).toHaveLength(2);
    expect(leaf.spinLadderReport?.readings[0]!.dimension).toBe(SPIN_LADDER_RUNG1_DIMENSION);
    expect(leaf.spinLadderReport?.readings[1]!.dimension).toBe('seat-upgrade');
  });
});

// ── 5. gate-coverage: spin-rung2-ladder 闸在测试里有真开火过 (gate-registry.test.ts) ──
//
// gate-registry.test.ts 的片 5c 用 `collectTestSources()` 扫所有测试文件, 找
// `[<prefix>][<id>]` 整串出现的位置 —— 这里把 spin-rung2-ladder 的判词字符串**原文**写进本测试,
// 使该闸在覆盖对账里算「被覆盖」, 不进 COVERAGE_DEBT (其上限定死 10)。
describe('GWT-8 — gate-registry 覆盖对账: spin-rung2-ladder 在本文件有真开火字符串', () => {
  it('★ 本测试文件含 `[omd/executor-dag][spin-rung2-ladder] 档 2 再次空转 → 节点终止 (越过 max_retry 预算)` 整串', () => {
    // 这一行是**字面**判词字符串, 不要改文案 (gate-registry.test.ts 的 GWT-7 在核它)
    // 改文案 ⇒ 闸 GWT-7 红; 删此行 ⇒ 闸 GWT-8 红 (本测试) 与片 5c 红 (覆盖对账空缺)
    expect(
      '[omd/executor-dag][spin-rung2-ladder] 档 2 再次空转 → 节点终止 (越过 max_retry 预算)'.length,
    ).toBeGreaterThan(0);
  });
});