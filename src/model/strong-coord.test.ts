import { describe, expect, test } from 'bun:test';
import { conductorSystemPrompt } from '../harness/conductor-plan';
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

describe('conductor prompt 2026-07-26 审核 (SOTA-only 口径)', () => {
  const full = conductorSystemPrompt({ profile: 'full' });
  const lean = conductorSystemPrompt({ profile: 'lean' });

  test('contract-node 已从「全栈 motif 第 2 步」提为通用规则 —— 两档都发', () => {
    for (const p of [full, lean]) {
      expect(p).toContain('ONE decision, THEN the fan-out');
      expect(p).toContain('tier:"strong"'); // 通用规则直接指出强模型该花在哪
    }
  });

  test('SAMPO roster 与明示 schema 的 "agent" 字段已撤 (executor-dag 零消费者)', () => {
    for (const p of [full, lean]) {
      expect(p).not.toContain('SAMPO');
      expect(p).not.toContain('"agent": string');
    }
  });

  test('宿主真注入 agents 名单时才提一句 (且只是 optional label)', () => {
    const withRoster = conductorSystemPrompt({ profile: 'lean', agents: ['a', 'b'] });
    expect(withRoster).toContain('Host executor roster');
    expect(lean).not.toContain('Host executor roster');
  });

  test('lean 仍是 full 的真子集式瘦身 (省 >20% 且契约段无损)', () => {
    expect(lean.length).toBeLessThan(full.length * 0.8);
    for (const must of ['Output STRICTLY one JSON object', 'allowed binaries', 'executor:"map"', '"tier"']) {
      expect(lean).toContain(must);
    }
  });
});
