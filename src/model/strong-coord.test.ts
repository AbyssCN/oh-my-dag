import { describe, expect, test } from 'bun:test';
import { conductorSystemPrompt } from '../harness/conductor-plan';
import { STRONG_INTELLIGENCE_FLOOR, isStrongCoord, lookupRating } from './model-ratings';

// S-P: conductor prompt 档位随座位模型档分派 (SDD 2026-07-25 S-P)。
// 此前硬编码 startsWith('kimi-coding:') —— conductor 座换 gpt-5.6-sol 当天该判据就失效。

describe('isStrongCoord (S-P 档位判据)', () => {
  test('两个真实 conductor 座位都判强 (k3 = A/B 验证点, sol = 现任座位)', () => {
    expect(isStrongCoord('kimi-coding:k3')).toBe(true);
    expect(isStrongCoord('openai-codex:gpt-5.6-sol')).toBe(true);
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

describe('S-P GWT: lean 档删的是教练段, 不是契约', () => {
  const full = conductorSystemPrompt({ profile: 'full' });
  const lean = conductorSystemPrompt({ profile: 'lean' });

  test('lean 比 full 短 (教练段真的被删了)', () => {
    expect(lean.length).toBeLessThan(full.length);
  });

  test('lean 仍含 plan JSON schema 契约 + 环境事实段 (删教练不删契约)', () => {
    for (const must of ['Output STRICTLY one JSON object', '"depends_on"', 'executor', '"tier"']) {
      expect(lean).toContain(must);
    }
  });

  test('lean 删掉了 goal 措辞教练段 (弱模型才需要的行为叮嘱)', () => {
    expect(full).toContain('Node goal phrasing (genre)');
    expect(lean).not.toContain('Node goal phrasing (genre)');
  });

  test('command 白名单 (S-1.5 审计补的) 两档都在 —— 它是环境事实不是教学', () => {
    for (const p of [full, lean]) expect(p).toContain('allowed binaries');
  });
});
