/**
 * resolveSeatAdvisor 层级契约:env > config.advisors > seats.ts 默认(现全空)> undefined。
 * 反向自检:什么都没配必须是 undefined —— 「不自动选」是纪律不是缺省值巧合。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveSeatAdvisor } from './role-models';
import { SEATS } from './seats';

const configWith = (advisors: Record<string, string>): string => {
  const dir = mkdtempSync(join(tmpdir(), 'omd-advisor-cfg-'));
  const p = join(dir, 'config.json');
  mkdirSync(dir, { recursive: true });
  writeFileSync(p, JSON.stringify({ version: 2, advisors }));
  return p;
};

describe('resolveSeatAdvisor', () => {
  test('★ 全缺 = undefined(不自动选;seats.ts 出厂也必须全空)', () => {
    expect(resolveSeatAdvisor('agent', { env: {}, path: '/nonexistent/omd-config.json' })).toBeUndefined();
    // 出厂纪律闸:哪天有人在 SEATS 里 bake 一个 advisor 默认, 这条会红 —— 届时必须带 owner 裁决改这里。
    for (const s of SEATS) expect(s.advisor).toBeUndefined();
  });

  test('★ config.advisors 命中;env OMD_<SEAT>_ADVISOR 压过 config', () => {
    const p = configWith({ agent: 'claude-code:claude-opus-5' });
    expect(resolveSeatAdvisor('agent', { env: {}, path: p })).toBe('claude-code:claude-opus-5');
    expect(
      resolveSeatAdvisor('agent', { env: { OMD_AGENT_ADVISOR: 'openai-codex:gpt-5.6-sol' }, path: p }),
    ).toBe('openai-codex:gpt-5.6-sol');
  });
});
