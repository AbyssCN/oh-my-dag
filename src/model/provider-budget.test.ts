/**
 * provider-budget 的**限流分型**与非 mimo 退避 (2026-08-27, bench 实证起票)。
 *
 * ## 这条是被咬出来的
 *
 * bench 一批 40 并发, MiniMax 回了 **1156 次**限流。它不用 429, 而是把错误码塞进 HTTP 200:
 * `{"choices": null, "base_resp": {"status_code": 2062, "status_msg": "已达到 Token Plan 速率限制…"}}`
 * 桥已把 2062 翻成 429 (`scripts/bench-bridge.ts`), 但引擎这一侧
 * `makeBudgetedCall` 对**非 mimo** 坐标是裸 `return rawCall(req)` —— 零重试。
 * 座位切成 18/18 MiniMax 之后, 这条无重试的路成了主干道: 每次限流都直接把 conductor
 * 打成「未产出有效 plan」→ 整个 run crash, 那批 72% trial 报废。
 *
 * ## 为什么要分两种限流 (第一次naive 修法被这条咬回来)
 *
 * 直接给非 mimo 套上退避 → `fanout.test.ts` 的「gen 波全挂 (配额耗尽)」超时红:
 * 那条测的错误是 `429 weekly quota exhausted` —— **周配额耗尽**, 退避 4 次只是把
 * 失败拖慢十几秒, 一次都不会成功。而 MiniMax 的 2062 是**随并发变化**的
 * (8 并发零命中 / 40 并发 1156 次), 退避确实能救。
 *
 * 所以判据不能是 HTTP 码, 得看错误文案里有没有**耗尽/余额**标记:
 *   · `is429` (宽) —— 「要不要溢出到备用模型」: 耗尽也该溢出, 故保持宽口径。
 *   · `isRetryableRateLimit` (窄) —— 「要不要重试**同一个**模型」: 耗尽时重试无意义。
 *
 * ## 反向自检 (每条都真跑过一次)
 *
 * · 把 `isRetryableRateLimit` 换回 `is429` → 「配额耗尽不重试」当场红 (退避 4 次)。
 * · 把非 mimo 分支换回裸 `rawCall` → 「非 mimo 也吃退避」当场红 (调用次数 1 而非 2)。
 * · 去掉 `is429` 的 429 判定 → 「明确 429 要退避」红。
 */
import { describe, expect, test, beforeEach } from 'bun:test';
import {
  is429,
  isRetryableRateLimit,
  makeBudgetedCall,
  setBackoffParams,
  resetBudget,
  PROVIDER_RPM_DEFAULTS,
  providerOf,
  providerRpmStats,
  setProviderRpm,
} from './provider-budget';

const err = (msg: string) => new Error(msg);

beforeEach(() => {
  resetBudget();
  setBackoffParams(1, 3); // 退避压到 1ms, 测试不等真实秒数
});

describe('限流分型: 宽口径 is429 vs 窄口径 isRetryableRateLimit', () => {
  test('★ 明确 429 / rate limit → 两个口径都认', () => {
    for (const e of [err('429 too many requests'), err('rate limited'), { status: 429 }]) {
      expect(is429(e)).toBe(true);
      expect(isRetryableRateLimit(e)).toBe(true);
    }
  });

  test('★ MiniMax 2062 文案 (桥翻成 429 后) → 可重试', () => {
    // 桥把 base_resp 2062 翻成 429 时带上原文, 见 scripts/bench-bridge.ts。
    const e = err('minimax base_resp 2062: 已达到 Token Plan 速率限制：请升级 Token Plan 套餐或切换为按量付费 API 使用。');
    expect(is429(e)).toBe(true);
    expect(isRetryableRateLimit(e)).toBe(true); // 实测随并发变化 ⇒ 可恢复
  });

  test('★ 配额耗尽: is429 仍认 (该溢出), 但**不可重试** (重试无意义)', () => {
    // 逐字取自 fanout.test.ts 那条被咬出来的用例。
    for (const e of [
      err('429 weekly quota exhausted'),
      err('429 you exhausted your current quota'),
      err('429 insufficient balance'),
      err('429 余额不足'), // 中文耗尽标记也要吃到 (单说「余额不足」不属 429 家族, 见下一条)
    ]) {
      expect(is429(e)).toBe(true);
      expect(isRetryableRateLimit(e)).toBe(false);
    }
  });

  test('★ 非限流错误 → 两个口径都不认', () => {
    // `余额不足` 不带任何限流标记时**不属于** 429 家族 —— 它是计费问题, 走别的路。
    for (const e of [err('boom'), err('500 internal'), err('余额不足'), null, undefined]) {
      expect(is429(e)).toBe(false);
      expect(isRetryableRateLimit(e)).toBe(false);
    }
  });
});

describe('非 mimo 坐标也要吃退避 (本次缺口)', () => {
  test('★ 非 mimo + 可重试限流 → 退避后重试并成功', async () => {
    let calls = 0;
    const call = makeBudgetedCall(async (_req: { model?: string }) => {
      calls++;
      if (calls === 1) throw err('429 rate limited');
      return 'ok';
    });
    await expect(call({ model: 'minimax-cn:MiniMax-M3' })).resolves.toBe('ok');
    expect(calls).toBe(2); // 换回裸 rawCall 这里是 1 → 红
  });

  test('★ 非 mimo + 配额耗尽 → 立即抛, 不退避 (快速失败)', async () => {
    let calls = 0;
    const call = makeBudgetedCall(async (_req: { model?: string }) => {
      calls++;
      throw err('429 weekly quota exhausted');
    });
    await expect(call({ model: 'minimax-cn:MiniMax-M3' })).rejects.toThrow(/quota exhausted/);
    expect(calls).toBe(1); // 用宽口径 is429 这里会是 4 → 红 (fanout 那条超时的根因)
  });

  test('★ 非 mimo + 非限流错误 → 原样抛, 零重试', async () => {
    let calls = 0;
    const call = makeBudgetedCall(async (_req: { model?: string }) => {
      calls++;
      throw err('boom');
    });
    await expect(call({ model: 'fake:x' })).rejects.toThrow('boom');
    expect(calls).toBe(1);
  });

  test('★ 非 mimo 顺利路径: 零额外开销, 调一次就返回', async () => {
    let calls = 0;
    const call = makeBudgetedCall(async (_req: { model?: string }) => {
      calls++;
      return 'ok';
    });
    await expect(call({ model: 'fake:x' })).resolves.toBe('ok');
    expect(calls).toBe(1);
  });
});

describe('按 provider 登记的 RPM 桶 (2026-09-04, MiniMax Token Plan 120 RPM)', () => {
  test('缺省登记: minimax-cn = 120; providerOf 取坐标前段', () => {
    expect(PROVIDER_RPM_DEFAULTS['minimax-cn']).toBe(120);
    expect(providerOf('minimax-cn:MiniMax-M3')).toBe('minimax-cn');
    expect(providerOf('nocolon')).toBeUndefined();
  });

  test('★ 登记的 provider: 桶空了就等下一张牌 (稳态不超 RPM), 没登记的不等', async () => {
    resetBudget();
    setProviderRpm('minimax-cn', 1200); // 20 张/秒, 排空后下一张要等 ~50ms
    let calls = 0;
    const call = makeBudgetedCall(async (_req: { model?: string }) => { calls++; return 'ok'; });
    for (let i = 0; i < 1200; i++) await call({ model: 'minimax-cn:MiniMax-M3' });
    const t0 = Date.now();
    await call({ model: 'minimax-cn:MiniMax-M3' });
    const waited = Date.now() - t0;
    // 证伪: 把 makeBudgetedCall 里 `await waitProviderToken(bucket)` 删掉 → waited ≈ 0, 这条红。
    expect(waited).toBeGreaterThanOrEqual(30);
    expect(calls).toBe(1201);
    // 没登记的 provider: 同样排空式调用 1201 次不等牌。
    const t1 = Date.now();
    for (let i = 0; i < 1201; i++) await call({ model: 'unregistered:model' });
    expect(Date.now() - t1).toBeLessThan(30);
    setProviderRpm('minimax-cn', 0);
    resetBudget();
  });

  test('providerRpmStats 可观测: limit 与余牌', () => {
    resetBudget();
    const st = providerRpmStats();
    expect(st['minimax-cn']).toEqual({ limit: 120, tokens: 120 });
  });
});
