/**
 * QuotaWindow 查表冷却测试 (切片1, G-4/G-6):
 *  · cooldownMsFor 403 + 注入登记条目 → 按窗口边界算剩余冷却 ms
 *  · 未登记 / 边界不可算 → 保守兜底 PERIOD_COOLDOWN_MS (6h), 与既有 403 语义逐字节等价
 *  · INV-3 守卫: 真 registry 每条登记必有官方 sourceUrl + 原文引句; 另抽出可注入纯校验函数
 *    validateQuotaEntry/validateQuotaRegistry, 测试拿违规样本证伪 (G-6) —— 闸不随 registry 为空而空转。
 * 只注入测试自造的 registry, 绝不污染真 CHANNEL_QUOTA_REGISTRY。
 */
import { describe, expect, test } from 'bun:test';
import { CHANNEL_QUOTA_REGISTRY, validateQuotaEntry, validateQuotaRegistry } from './channels';
import type { ChannelQuotaEntry, QuotaWindow } from './channels';
import { PERIOD_COOLDOWN_MS, cooldownMsFor } from './provider-health';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** 测试自造登记条目 (注入用, 不进真 registry)。 */
function entry(channelId: string, ...windows: QuotaWindow[]): ChannelQuotaEntry {
  return { channelId, windows };
}

describe('cooldownMsFor 查表 (G-4 注入登记条目)', () => {
  test('billing-cycle: 403 + 距月边界 3 天 → 冷却 ≈ 72h (到月边界, 窗过重试一次)', () => {
    const now = Date.UTC(2026, 7, 29, 0, 0, 0); // 2026-08-29T00:00Z, 9-1 月边界前整 3 天
    const registry = [
      entry('claude-code:session', {
        windowKind: 'billing-cycle',
        boundaryRule: '每月 UTC 月初重置',
        sourceUrl: 'https://example.invalid/quota', // 注入 fixture: https + 引句非空 → 过 INV-3 运行时校验
        officialQuote: 'quota resets at the start of each month (injected fixture)',
      }),
    ];
    const ms = cooldownMsFor(403, { channel: 'claude-code:session', registry, now });
    expect(ms).toBeGreaterThanOrEqual(72 * HOUR - 1000);
    expect(ms).toBeLessThanOrEqual(72 * HOUR + 1000);
  });

  test('rolling: 登记 windowMs=5h → 403 冷却 5h (从首次故障起算整窗)', () => {
    const registry = [
      entry('kimi:session', {
        windowKind: 'rolling',
        windowMs: 5 * HOUR,
        sourceUrl: 'https://example.invalid/quota',
        officialQuote: 'rolling five-hour window (injected fixture)',
      }),
    ];
    expect(cooldownMsFor(403, { channel: 'kimi:session', registry, now: 1_000_000 })).toBe(5 * HOUR);
  });

  test('未登记 channel: 403 → 兜底 PERIOD_COOLDOWN_MS (6h, 逐字节等价)', () => {
    expect(cooldownMsFor(403, { channel: 'nobody:session', registry: [], now: 1_000_000 })).toBe(
      PERIOD_COOLDOWN_MS,
    );
  });

  test('registry 空 / 不传 channel → 同样兜底 6h (fail-safe, 空 registry 合法)', () => {
    expect(cooldownMsFor(403, { channel: 'x:y', registry: [], now: 1_000_000 })).toBe(PERIOD_COOLDOWN_MS);
    expect(cooldownMsFor(403, { now: 1_000_000 })).toBe(PERIOD_COOLDOWN_MS);
    expect(cooldownMsFor(403)).toBe(PERIOD_COOLDOWN_MS); // 既有调用点: 不传 opts 行为不变
  });

  test('登记渠道 429 → 仍是瞬时档 30s (查表不劫持瞬时档)', () => {
    const registry = [
      entry('claude-code:session', {
        windowKind: 'rolling',
        windowMs: 5 * HOUR,
        sourceUrl: 'https://example.invalid/quota',
        officialQuote: 'injected fixture',
      }),
    ];
    expect(cooldownMsFor(429, { channel: 'claude-code:session', registry })).toBe(30_000);
  });
});

describe('INV-3 守卫: 真 registry 每条登记必有官方出处 (G-6 反向自检)', () => {
  // 真 registry 逐条校验。证伪方式 (当场验过路径): 往 CHANNEL_QUOTA_REGISTRY 注入一条
  // sourceUrl 为空的条目 (或删掉某条 sourceUrl/officialQuote) → 本测试红; 恢复后绿。
  // 空 registry 亦合法 (fail-safe): 查不到官方原文的渠道一律不登记, 运行时落回 PERIOD_COOLDOWN_MS。
  test('每条登记: channelId 非空 + sourceUrl 为 https URL + officialQuote 非空', () => {
    for (const e of CHANNEL_QUOTA_REGISTRY) {
      expect(e.channelId.length).toBeGreaterThan(0);
      for (const w of e.windows) {
        expect(w.sourceUrl).toMatch(/^https:\/\/.+/);
        expect(w.officialQuote.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('INV-3 校验函数: 违规样本注入 → 抛错 (G-6 证伪)', () => {
  // G-6 证伪: 下列样本故意违规, 只喂给可注入纯校验函数 validateQuotaEntry /
  // validateQuotaRegistry (不进真 registry)。它们证明闸是活的 —— 即使真
  // CHANNEL_QUOTA_REGISTRY 为空 (空表合法), 闸也仍可变红, 不随空表空转。
  test('缺 sourceUrl → validateQuotaEntry 抛错', () => {
    expect(() =>
      validateQuotaEntry(
        entry('x:session', {
          windowKind: 'rolling',
          windowMs: 1,
          sourceUrl: '', // 违规样本: 官方文档 URL 缺失
          officialQuote: 'quoted',
        }),
      ),
    ).toThrow(/INV-3/);
  });

  test('非 https sourceUrl → validateQuotaEntry 抛错', () => {
    expect(() =>
      validateQuotaEntry(
        entry('x:session', {
          windowKind: 'rolling',
          windowMs: 1,
          sourceUrl: 'http://example.com/quota', // 违规样本: 非 https 官方 URL
          officialQuote: 'quoted',
        }),
      ),
    ).toThrow(/INV-3/);
  });

  test('空引句 → validateQuotaEntry 抛错', () => {
    expect(() =>
      validateQuotaEntry(
        entry('x:session', {
          windowKind: 'rolling',
          windowMs: 1,
          sourceUrl: 'https://example.com/quota',
          officialQuote: '', // 违规样本: 官方原文引句为空
        }),
      ),
    ).toThrow(/INV-3/);
  });

  test('registry 层: 好条目 + 一条违规 → validateQuotaRegistry 抛错 (逐条校验)', () => {
    const good = entry('good:session', {
      windowKind: 'rolling',
      windowMs: 1,
      sourceUrl: 'https://example.com/quota',
      officialQuote: 'quoted',
    });
    const bad = entry('bad:session', {
      windowKind: 'rolling',
      windowMs: 1,
      sourceUrl: 'https://example.com/quota',
      officialQuote: '', // 违规样本藏在好条目后面, 逐条校验必须揪出
    });
    expect(() => validateQuotaRegistry([good, bad])).toThrow(/INV-3/);
  });

  test('运行时闸: cooldownMsFor 403 + 违规 registry → 抛错, 不静默兜底', () => {
    const bad = entry('x:session', {
      windowKind: 'rolling',
      windowMs: 1,
      sourceUrl: 'ftp://example.com/quota', // 违规样本: 非 https
      officialQuote: 'quoted',
    });
    expect(() => cooldownMsFor(403, { channel: 'x:session', registry: [bad], now: 1_000_000 })).toThrow(/INV-3/);
    // 瞬时档不查表: 429 + 违规 registry 仍走 30s (闸只管配额路径)
    expect(cooldownMsFor(429, { channel: 'x:session', registry: [bad] })).toBe(30_000);
  });
});
