/**
 * L1 判据:设置面板(2026-08-07,owner 指出"设置完全没有")。
 *
 * 一个设置面板最容易变成一堆"看起来能调、点了没反应"的行。所以这里钉的全是
 * **每一项都答得出"现在是什么值"**,以及**答不上来时说的是真话**。
 */
import { describe, expect, test } from 'bun:test';
import type { ContextPressure } from '../harness/chat/usage';
import { buildSettings, formatSettings, parseSettingsCommand } from './settings';

const base = {
  seats: { conductor: 'a:1', leaf: 'b:2' },
  seatsError: null as string | null,
  sessionId: 'tui',
  sessionCount: 3 as number | null,
  pressure: null as ContextPressure | null,
  color: true,
  truecolor: true,
  extensions: [] as { name: string; ok: boolean; sandboxed?: boolean; missing?: string[] }[],
};
const find = (items: ReturnType<typeof buildSettings>, key: string) => items.find((i) => i.key === key);

describe('parseSettingsCommand', () => {
  test('/settings 与两个别名', () => {
    for (const t of ['/settings', '/set', '/config', ' /settings ']) expect(parseSettingsCommand(t)).toBe(true);
  });
  test('别的不接管', () => {
    for (const t of ['/settingsx', 'settings', '/seat']) expect(parseSettingsCommand(t)).toBe(false);
  });
});

describe('★ 每一项都答得出"现在是什么值"', () => {
  test('座位有值就显示值', () => {
    expect(find(buildSettings(base), 'seat:conductor')?.value).toBe('a:1');
  });

  test('★ 座位解析不到 → 写"(解析不到)"+原因, 不留空也不编一个', () => {
    const it = find(buildSettings({ ...base, seats: {}, seatsError: '座位未配' }), 'seat:conductor');
    expect(it?.value).toBe('(解析不到)');
    expect(it?.detail).toBe('座位未配');
  });

  test('★ verifier 没在 resolveEngineModels 里 → "(未配)", 不拿 leaf 冒充', () => {
    expect(find(buildSettings(base), 'seat:verifier')?.value).toBe('(未配)');
  });

  test('★ 会话数读不到 → "未读", 与"一条都没有"分得开', () => {
    expect(find(buildSettings({ ...base, sessionCount: null }), 'session')?.detail).toContain('未读');
    expect(find(buildSettings({ ...base, sessionCount: 0 }), 'session')?.detail).toContain('0');
  });

  test('★ 还没跑过一轮 → 上下文写真话, 不画一行 0', () => {
    expect(find(buildSettings(base), 'ctx')?.value).toBe('(还没跑过一轮)');
  });

  test('跑过之后显示分项', () => {
    const p: ContextPressure = {
      systemTokens: 12_000, harnessTokens: 8000, historyTokens: 34_000,
      usedTokens: 46_000, windowTokens: 200_000, ratio: 0.23,
    };
    const it = find(buildSettings({ ...base, pressure: p }), 'ctx');
    expect(it?.value).toContain('46k/200k 23%');
    expect(it?.detail).toContain('harness 8.0k');
  });

  test('★ 窗口未知时不画百分比', () => {
    const p: ContextPressure = {
      systemTokens: 1000, harnessTokens: 0, historyTokens: 500,
      usedTokens: 1500, windowTokens: 0, ratio: null,
    };
    expect(find(buildSettings({ ...base, pressure: p }), 'ctx')?.value).toContain('窗口未知');
  });
});

describe('配色与字形', () => {
  test('三档各自显示', () => {
    expect(find(buildSettings({ ...base, color: false }), 'theme')?.value).toContain('NO_COLOR');
    expect(find(buildSettings(base), 'theme')?.value).toContain('24 位');
    const fallback = find(buildSettings({ ...base, truecolor: false }), 'theme');
    expect(fallback?.value).toContain('16 色');
    expect(fallback?.detail).toContain('不照发');
  });

  test('★ 字形那一项说得出量没量过真终端', () => {
    const it = find(buildSettings(base), 'glyphs');
    expect(it?.value).toMatch(/\d+ 可用 \/ \d+ 待量 \/ \d+ 不用/);
    expect(it?.detail).toBeDefined();
  });
});

describe('★ 扩展:被拒的要说出缺什么', () => {
  test('没配 → 说清清单在哪', () => {
    const it = find(buildSettings(base), 'ext');
    expect(it?.value).toBe('(没配)');
    expect(it?.detail).toContain('.omd/extensions.json');
  });

  test('★ 被拒的逐个列出缺的 API —— 藏在日志里等于加载期硬失败白做了', () => {
    const it = find(
      buildSettings({
        ...base,
        extensions: [
          { name: 'good', ok: true, sandboxed: true },
          { name: 'greedy', ok: false, missing: ['ctx.fork', 'registerShortcut'] },
        ],
      }),
      'ext',
    );
    expect(it?.value).toBe('1 已装 / 1 被拒');
    expect(it?.detail).toContain('greedy');
    expect(it?.detail).toContain('ctx.fork');
  });

  test('全装上了就不画"被拒"那一行', () => {
    expect(find(buildSettings({ ...base, extensions: [{ name: 'a', ok: true }] }), 'ext')?.detail).toBeUndefined();
  });
});

describe('★ 只读项与可改项分得开', () => {
  test('只读项没有 action(选中它什么都不做, 这是刻意的)', () => {
    const items = buildSettings(base);
    expect(find(items, 'ctx')?.action).toBeUndefined();
    expect(find(items, 'theme')?.action).toBeUndefined();
    expect(find(items, 'glyphs')?.action).toBeUndefined();
  });

  test('可改项有 action', () => {
    const items = buildSettings(base);
    expect(find(items, 'seat:conductor')?.action).toBe('seat');
    expect(find(items, 'session')?.action).toBe('session');
    expect(find(items, 'ext')?.action).toBe('extensions');
  });
});

describe('formatSettings', () => {
  test('每一项都带值', () => {
    const out = formatSettings(buildSettings(base));
    expect(out).toContain('座位 conductor: a:1');
    expect(out).toContain('当前会话: tui');
  });
});
