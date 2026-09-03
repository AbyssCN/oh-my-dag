import { describe, expect, test } from 'bun:test';
import { STRONG_INTELLIGENCE_FLOOR, isStrongCoord, lookupRating } from './model-ratings';

// S-P: conductor prompt 档位随座位模型档分派 (SDD 2026-07-25 S-P)。
// 此前硬编码 startsWith('kimi-coding:') —— conductor 座换 gpt-5.6-sol 当天该判据就失效。

describe('isStrongCoord (S-P 档位判据)', () => {
  test('三个真实 conductor 座位都判强 (k3 = A/B 验证点, sol 与 opus-5 = 历任座位)', () => {
    expect(isStrongCoord('kimi-coding:k3')).toBe(true);
    expect(isStrongCoord('openai-codex:gpt-5.6-sol')).toBe(true);
    // F5 (issue #145 §6): 补快照前 opus-5 走命名启发 ('opus' ∈ STRONG_KEYWORDS) 拿 45 分,
    // 低于 floor 57 → 现任 conductor 座**整程吃的是弱模型教练段**。补 AA 真值 59 后翻正。
    // 证伪方式: 删掉 model-ratings.json 的 'claude opus 5' 条目 → 落回 45 → 这条红。
    expect(isStrongCoord('claude-code:claude-opus-5')).toBe(true);
  });

  test('leaf/agent 座 (MiniMax-M3) 仍判弱 —— 补快照没有顺手放宽档位', () => {
    // AA 真值 45 与兜底同分, 所以这一格补账**不**改分档行为, 只把假价格 0.5 改成真的 0.22。
    expect(isStrongCoord('minimax-cn:MiniMax-M3')).toBe(false);
  });

  test('量产/校验座位判弱 → 保 full (零回归)', () => {
    expect(isStrongCoord('mimo:mimo-v2.5-pro')).toBe(false);
    expect(isStrongCoord('opencode-go:glm-5.2')).toBe(false);
    expect(isStrongCoord('deepseek:deepseek-v4-flash')).toBe(false);
  });

  test('未知坐标 → 启发兜底分数低于门槛 → 保守走 full', () => {
    expect(isStrongCoord('nonsense:zzz')).toBe(false);
  });

  test('门槛钉在 k3 的实测分上 (改门槛前须重跑 A/B)', () => {
    expect(lookupRating('kimi-coding:k3')?.intelligence).toBe(STRONG_INTELLIGENCE_FLOOR);
  });
});


