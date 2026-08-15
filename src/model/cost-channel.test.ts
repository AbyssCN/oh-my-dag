/**
 * 订阅通道账契约(owner 验收 P2,2026-08-10):cost = NULL 非 $0,判别靠 channel 列。
 * 三态互斥的反向自检:计价(数字)/ unpriced(价表缺)/ subscription(不是美元资源)——
 * 三者在行上必须分得开,且周预算闸对订阅行**跳过而非读数不可用**。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { channelOf, computeCost } from './cost-ledger';
import { createTuiUsageLedger } from '../tui/usage/ledger';
import { checkWeeklyBudget, resetBudgetLedgerMemoForTest } from '../mcp/budget';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'omd-cost-channel-'));
  resetBudgetLedgerMemoForTest();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('computeCost 三态', () => {
  test('★ claude-code:* → costUsd=null + channel=subscription + unpriced=false(不是「缺价」是「不是美元」)', () => {
    const b = computeCost({ in: 100, out: 10 }, 'claude-code:claude-sonnet-5');
    expect(b).toEqual({ costUsd: null, cacheSavingsUsd: 0, unpriced: false, channel: 'subscription' });
    expect(channelOf('claude-code:claude-fable-5')).toBe('subscription');
    expect(channelOf('deepseek:deepseek-v4-flash')).toBe('api');
  });

  test('★ 三态互斥:计价行有数字、unpriced 行 0+旗、订阅行 null+列 —— 谁也不冒充谁', () => {
    // 数值跟着 DEFAULT_PRICES 走 (2026-08-14 核官网订正 0.27 → 0.14; 2026-08-15 owner 裁取
    // off-peak 档 0.14 → 0.22); 本测钉的是"计价行有数字", 不是这个具体价 —— 价表再变时改这一行,
    // 别把它读成"价格回归"。
    expect(computeCost({ in: 1e6, out: 0 }, 'deepseek:deepseek-v4-flash').costUsd).toBeCloseTo(0.22);
    const up = computeCost({ in: 1e6, out: 0 }, 'nobody:unknown');
    expect(up).toMatchObject({ costUsd: 0, unpriced: true });
    expect(up.channel).toBeUndefined();
  });
});

describe('账本行 + 合计', () => {
  test('★ 订阅行落 costUsd=null + channel 列;USD 合计合法跳过它(非 0 非 NaN)', () => {
    const ledger = createTuiUsageLedger({ dir });
    ledger.record({ in: 50, out: 5 }, 'deepseek:deepseek-v4-flash', 'engine');
    const sub = ledger.record({ in: 1000, out: 100, cacheHit: 200 }, 'claude-code:claude-sonnet-5', 'engine');
    expect(sub.costUsd).toBeNull();
    expect(sub.channel).toBe('subscription');
    const t = ledger.sessionTotal();
    expect(t.calls).toBe(2); // token 行照数
    expect(Number.isFinite(t.costUsd)).toBe(true); // 不许 NaN
    expect(t.costUsd).toBeGreaterThan(0); // deepseek 那笔还在
  });
});

describe('周预算闸', () => {
  test('★ 订阅行整行跳过:不进 USD 合计、不把闸读成不可用;API 行照常计', () => {
    const now = Date.now();
    const rows = [
      { ts: now, model: 'deepseek:deepseek-v4-flash', source: 'engine', in: 10, out: 1, cacheHit: 0, costUsd: 2.5, unpriced: false },
      { ts: now, model: 'claude-code:claude-sonnet-5', source: 'engine', in: 10, out: 1, cacheHit: 0, costUsd: null, unpriced: false, channel: 'subscription' },
    ];
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'tui-usage.jsonl'), `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
    const s = checkWeeklyBudget({ dir, env: { OMD_WEEKLY_BUDGET_USD: '50' } });
    expect(s.costUsd).toBe(2.5); // 只有 API 行;null = 读数不可用,这里必须是数字
    expect(s.calls).toBe(1); // 订阅行整行跳过(calls 也不计 —— 它不占美元预算的样本)
  });
});
