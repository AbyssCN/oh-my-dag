/**
 * 切片②:底栏行①②(L1)。
 *
 * 三条硬规矩各有一条闸(v5 第四节):
 * - 订阅制不折算美元 → subscription 段永远没有 `$`;
 * - 拿不到就写「未知」不画 0% → subscription 段有「额度未知」且没有 `%`;
 * - 本地估算要标注 → 计数带「本地」字样与 `+` 后缀。
 */
import { visibleWidth } from '@earendil-works/pi-tui';
import { describe, expect, test } from 'bun:test';
import type { WindowSummary } from '../usage/ledger';
import { fitLine } from './line';
import { fmtUsd, formatStatusLine, formatUsageLine } from './statusbar';

const win = (over: Partial<WindowSummary> = {}): WindowSummary => ({
  since: 0,
  calls: 3,
  in: 312_000,
  out: 18_400,
  cacheHit: 276_000,
  costUsd: 0.42,
  unpriced: false,
  byProvider: [],
  ...over,
});

describe('fmtUsd', () => {
  test('未计价在场 → 后缀 + (下界, 不冒充真值)', () => {
    expect(fmtUsd(0.83, false)).toBe('$0.83');
    expect(fmtUsd(0.83, true)).toBe('$0.83+');
    expect(fmtUsd(12.34, false)).toBe('$12.3');
  });
});

describe('行① formatStatusLine —— segment 模型: 没数据的段不画', () => {
  test('全量样张(v5 形状)', () => {
    const line = formatStatusLine({
      ws: { repo: 'oh-my-dag', branch: 'main', dirty: 2, worktree: 'fanin' },
      seat: 'kimi-coding:k3',
      pressure: { systemTokens: 12_000, harnessTokens: 8000, historyTokens: 34_000, usedTokens: 46_000, windowTokens: 200_000, ratio: 0.23 },
      session: { costUsd: 0.83, unpriced: false, calls: 3 },
      win: win(),
    });
    expect(line).toBe('oh-my-dag · main +2 · wt:fanin │ kimi-coding:k3 │ ctx 46k/200k 23% │ 会话 $0.83 │ 5h $0.42 · 3 次');
  });

  test('★ 没跑过一轮: 无 pressure/session/win 段(不画 0, 不画 $0)', () => {
    const line = formatStatusLine({
      ws: { repo: 'x', branch: 'main', dirty: 0, worktree: null },
      seat: 'a:b',
      pressure: null,
      session: null,
      win: null,
    });
    expect(line).toBe('x · main │ a:b');
    expect(line).not.toContain('$');
    expect(line).not.toContain('ctx');
  });

  test('★ 窗口未知 → 不画百分比(编分母算出的百分比比不画更坏)', () => {
    const line = formatStatusLine({
      ws: null,
      seat: 'a:b',
      pressure: { systemTokens: 4000, harnessTokens: 0, historyTokens: 1000, usedTokens: 5000, windowTokens: 0, ratio: null },
      session: null,
      win: null,
    });
    expect(line).toContain('ctx 5.0k 窗口未知');
    expect(line).not.toMatch(/\d+%/);
  });

  test('非 git 仓: 工作区段整个不画', () => {
    expect(formatStatusLine({ ws: null, seat: 'a:b', pressure: null, session: null, win: null })).toBe('a:b');
  });
});

describe('行② formatUsageLine —— 三条不许违反的', () => {
  test('★ 订阅制: 本地计数带标注 + 额度未知, 永远没有 $ 和 %', () => {
    const line = formatUsageLine(win({ byProvider: [{ provider: 'kimi-coding', calls: 3, in: 1, out: 1, cacheHit: 0, costUsd: 0, unpriced: false }] }));
    expect(line).toContain('kimi-coding 本地3+ 额度未知');
    const seg = line.split('│')[1] as string;
    expect(seg).not.toContain('$');
    expect(seg).not.toContain('%');
  });

  test('按量制: 画窗口花费; 未计价的画 + 后缀', () => {
    const line = formatUsageLine(
      win({ byProvider: [
        { provider: 'deepseek', calls: 2, in: 1, out: 1, cacheHit: 0, costUsd: 1.2, unpriced: false },
        { provider: 'nobody', calls: 1, in: 1, out: 1, cacheHit: 0, costUsd: 0, unpriced: true },
      ] }),
    );
    expect(line).toContain('deepseek $1.20');
    expect(line).toContain('nobody $0.00+');
  });

  test('★ 窗口空 → 空串(这一行不占位); cache 为 0 → cache 段不画', () => {
    expect(formatUsageLine(null)).toBe('');
    expect(formatUsageLine(win({ calls: 0 }))).toBe('');
    expect(formatUsageLine(win({ cacheHit: 0 }))).not.toContain('cache');
  });

  test('in/out/cache + 命中率(G-2 第二行的判据形状)', () => {
    const line = formatUsageLine(win(), { ssh: 'ms02', tmux: true });
    expect(line).toContain('in 312k out 18k cache 276k 88%');
    expect(line).toContain('ssh ms02 · tmux');
  });

  test('ssh/tmux 没有时尾段不画', () => {
    expect(formatUsageLine(win())).not.toContain('ssh');
    expect(formatUsageLine(win())).not.toContain('tmux');
  });

  test('状态行走 fitLine 截断后不超宽(窄屏)', () => {
    const line = formatUsageLine(win({ byProvider: [{ provider: 'kimi-coding', calls: 3, in: 1, out: 1, cacheHit: 0, costUsd: 0, unpriced: false }] }), { ssh: 'ms02', tmux: true });
    for (const w of [20, 40, 80]) expect(visibleWidth(fitLine(line, w))).toBeLessThanOrEqual(w);
  });
});
