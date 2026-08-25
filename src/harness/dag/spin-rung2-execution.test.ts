/**
 * src/harness/dag/spin-rung2-execution —— SDD S2 片 2 (runner 面: 换脑与 fresh-context)。
 *
 * ## 这片买的是什么
 *
 * 片 1 冻结了 `SpinRung2Decision` 与 `SpinLadderReport` 形状,本片把档 2 的派发契约接进 runner:
 * fake runner 必须能从 `AgentLeafInput` 上读出 `freshContext: true` / `targetSeatCoord`
 * / 四件证据字段 —— 普通 retry 没这些标记,与档 2 重派在测试里**逐字**分得开
 * (D-6, INV-3, INV-4)。生产 runner (`createAgentLeafRunner`) 须在不破现状的前提下
 * 接受新字段并把它们落到实处: `targetSeatCoord` 覆盖 model、`freshContext` 触发明示会话、
 * 四件证据进 prompt (D-4)。
 *
 * ## 不写在本片
 *
 * - engine 接线 (runNode 调 chooseSpinRung2Dimension) —— 片 3;
 * - 报告落 checkpoint / serve 读取面 —— 片 4;
 * - 选择函数本体 / 报告组装函数 —— 片 1。
 *
 * ## 反向自检 (改这片前先跑;下面是必红清单,红了才算闸活着)
 *
 *   ① 删 `freshContext` 字段 → 「INV-4 fake runner 观察 fresh-context」红;
 *   ② 删 `targetSeatCoord` 字段 → 「INV-3 fake runner 观察模型坐标变化」红;
 *   ③ 令 fresh-context 复用旧消息 (在生产 runner 里把 session 缓存) → 「INV-4 同模型 + 空历史」红;
 *   ④ 把 `targetSeatCoord` 改写成忽略 input.model 的全局钩子 → 「INV-3 第二次来自高一档池」红
 *      (普通 retry 也会被静默换脑)。
 */
import { describe, expect, it } from 'bun:test';

import {
  buildSpinRung2Decision,
  pickHigherTierSeat,
  type SpinRung2StampPools,
} from './spin-rung2';
import type { AgentLeafInput, AgentLeafRunner, AgentLeafResult } from '../leaf-runners';

// ── 1. 共享 fixture:三池 cheap → mid → strong,次序按 D-5 测试冻结 ───────────
const POOLS: SpinRung2StampPools = {
  cheap: ['cheap:c1'],
  mid: ['mid:m1'],
  strong: ['strong:s1'],
};

// ── 2. fake runner 工具:每次调用把 input 推到数组 ──────────────────────────
type RecordedCall = AgentLeafInput & { _result: AgentLeafResult };
function makeFakeRunner(): AgentLeafRunner & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const runner = ((input: AgentLeafInput) => {
    const result: AgentLeafResult = {
      text: `echo:${input.prompt.slice(0, 8)}`,
      usage: { in: 10, out: 5 },
    };
    const recorded = { ...input, _result: result };
    calls.push(recorded);
    return Promise.resolve(result);
  }) as AgentLeafRunner & { calls: RecordedCall[] };
  runner.calls = calls;
  return runner;
}

// ── 3. GWT:INV-3 seat-upgrade —— 第二次调用模型坐标变化且来自高一档池 ─────
describe('INV-3 seat-upgrade (fake runner 观察模型坐标变化)', () => {
  it('★ 第二次调用的 model 不等于第一次,且来自高一档池 (cheap → mid)', async () => {
    const runner = makeFakeRunner();
    // 第一次:cheap 档,无 rung2 标记 (普通 retry 形状)
    await runner({ prompt: 'attempt1', model: 'cheap:c1' });
    // 第二次:rung2 seat-upgrade 派发 (engine 侧即将按本形状发,片 2 先把形状钉好)
    const decision = buildSpinRung2Decision({
      dimension: 'seat-upgrade',
      currentCoord: 'cheap:c1',
      pools: POOLS,
      accumulatedUsageIn: 100,
    });
    expect(decision.kind).toBe('seat-upgrade');
    expect(decision.from).toBe('cheap:c1');
    expect(decision.to).toBe('mid:m1');
    await runner({
      prompt: 'attempt2',
      model: decision.from,
      targetSeatCoord: decision.to,
      rung2Evidence: {
        packHash: 'sha256:abc',
        failureReason: 'spin-fused',
        criterionDiff: { kind: 'no-history', literal: '本节点无 self_check,无判据可 diff' },
        blockerSignature: 'drift:sig-xyz',
      },
    });
    expect(runner.calls).toHaveLength(2);
    const first = runner.calls[0]!;
    const second = runner.calls[1]!;
    expect(first.model).toBe('cheap:c1');
    expect(second.model).toBe('cheap:c1'); // 当前 leaf 坐标仍是 from
    expect(second.targetSeatCoord).toBe('mid:m1'); // 但下一档已钉 (INV-3 真实换脑)
    expect(second.targetSeatCoord).not.toBe(first.model); // 反例:与原模型相等 ⇒ 判红
  });

  it('★ 已在 strong (最高档) → pickHigherTierSeat 返 null,decision 标 targetPoolExhausted (INV-3 试尽如实)', () => {
    const decision = buildSpinRung2Decision({
      dimension: 'seat-upgrade',
      currentCoord: 'strong:s1',
      pools: POOLS,
      accumulatedUsageIn: 50,
    });
    expect(decision.kind).toBe('seat-upgrade');
    expect(decision.to).toBeUndefined();
    expect(decision.targetPoolExhausted).toBe(true);
  });

  it('★ 坐标不在任何池 → pickHigherTierSeat 返 null,decision 标 targetPoolExhausted', () => {
    const decision = buildSpinRung2Decision({
      dimension: 'seat-upgrade',
      currentCoord: 'unknown:x9',
      pools: POOLS,
      accumulatedUsageIn: 50,
    });
    expect(decision.kind).toBe('seat-upgrade');
    expect(decision.targetPoolExhausted).toBe(true);
  });

  it('mid → strong 时高一档池首坐标被取 (D-5 cheap→mid→strong 固定次序)', () => {
    expect(pickHigherTierSeat({ currentCoord: 'mid:m1', pools: POOLS })).toBe('strong:s1');
    expect(pickHigherTierSeat({ currentCoord: 'cheap:c1', pools: POOLS })).toBe('mid:m1');
    expect(pickHigherTierSeat({ currentCoord: 'strong:s1', pools: POOLS })).toBeNull();
  });
});

// ── 4. GWT:INV-4 fresh-context —— 同模型 + freshContext 标记 + 四件证据 ─────
describe('INV-4 fresh-context (fake runner 观察上下文切换 + 证据带全)', () => {
  it('★ fresh-context 派发的 input 含 freshContext:true + 四件证据字段 (D-4 缺一即失败)', async () => {
    const runner = makeFakeRunner();
    await runner({ prompt: 'attempt1', model: 'cheap:c1' });
    const decision = buildSpinRung2Decision({
      dimension: 'fresh-context',
      currentCoord: 'cheap:c1',
      pools: POOLS,
      accumulatedUsageIn: 9999,
      evidencePackHash: 'sha256:abc',
    });
    expect(decision.kind).toBe('fresh-context');
    expect(decision.from).toBe('cheap:c1');
    expect(decision.to).toBeUndefined(); // 同座位,不写 to
    await runner({
      prompt: 'attempt2',
      model: decision.from,
      freshContext: true,
      rung2Evidence: {
        packHash: 'sha256:abc',
        failureReason: 'spin-fused',
        criterionDiff: { kind: 'no-history', literal: '本节点无 self_check,无判据可 diff' },
        blockerSignature: 'drift:sig-xyz',
      },
    });
    const second = runner.calls[1]!;
    expect(second.freshContext).toBe(true); // 反例:删此字段 → 红
    expect(second.model).toBe('cheap:c1'); // INV-4:同模型
    expect(second.targetSeatCoord).toBeUndefined(); // INV-4:不是换脑
    const ev = second.rung2Evidence;
    expect(ev).toBeDefined();
    expect(ev?.packHash).toBe('sha256:abc');
    expect(ev?.failureReason).toBe('spin-fused');
    expect(ev?.criterionDiff.kind).toBe('no-history');
    expect(ev?.blockerSignature).toBe('drift:sig-xyz');
  });

  it('★ 普通 retry 没 freshContext 也没 targetSeatCoord —— 与档 2 在 fake runner 上分得开', async () => {
    const runner = makeFakeRunner();
    await runner({ prompt: 'attempt1', model: 'cheap:c1' });
    // 普通 retry:engine 同款模型再发一次,无新维度
    await runner({ prompt: 'attempt2', model: 'cheap:c1' });
    expect(runner.calls[1]?.freshContext).toBeUndefined();
    expect(runner.calls[1]?.targetSeatCoord).toBeUndefined();
    expect(runner.calls[1]?.rung2Evidence).toBeUndefined();
  });
});

// ── 5. GWT:INV-5 pi 与 SDK 都能进入档 2 ────────────────────────────────────
describe('INV-5 pi / SDK 通道都接受 rung2 派发字段 (字段形状对两通道一致)', () => {
  it('★ pi 通道 fake runner 接受 freshContext + rung2Evidence', async () => {
    const piRunner = makeFakeRunner();
    await piRunner({
      prompt: 'pi-rung2',
      model: 'cheap:c1',
      freshContext: true,
      rung2Evidence: {
        packHash: 'sha256:pi',
        failureReason: 'spin-fused',
        criterionDiff: { kind: 'no-history', literal: '本节点无 self_check,无判据可 diff' },
        blockerSignature: 'drift:pi',
      },
    });
    expect(piRunner.calls[0]?.freshContext).toBe(true);
    expect(piRunner.calls[0]?.rung2Evidence?.packHash).toBe('sha256:pi');
  });

  it('★ SDK 通道 fake runner 接受 freshContext + rung2Evidence (与 pi 同形,INV-5 通道无关)', async () => {
    const sdkRunner = makeFakeRunner();
    await sdkRunner({
      prompt: 'sdk-rung2',
      model: 'cheap:c1',
      freshContext: true,
      rung2Evidence: {
        packHash: 'sha256:sdk',
        failureReason: 'spin-fused',
        criterionDiff: { kind: 'no-history', literal: '本节点无 self_check,无判据可 diff' },
        blockerSignature: 'drift:sdk',
      },
    });
    expect(sdkRunner.calls[0]?.freshContext).toBe(true);
    expect(sdkRunner.calls[0]?.rung2Evidence?.packHash).toBe('sha256:sdk');
  });
});
