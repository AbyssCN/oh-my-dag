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
    const it = find(buildSettings({ ...base, seats: {}, seatsError: 'seat not configured' }), 'seat:conductor');
    expect(it?.value).toBe('(unresolved)');
    expect(it?.detail).toBe('seat not configured');
  });

  test('★ verifier 没在 resolveEngineModels 里 → "(未配)", 不拿 leaf 冒充', () => {
    expect(find(buildSettings(base), 'seat:verifier')?.value).toBe('(not set)');
  });

  test('★ 会话数读不到 → "未读", 与"一条都没有"分得开', () => {
    expect(find(buildSettings({ ...base, sessionCount: null }), 'session')?.detail).toContain('unread');
    expect(find(buildSettings({ ...base, sessionCount: 0 }), 'session')?.detail).toContain('0');
  });

  test('★ 还没跑过一轮 → 上下文写真话, 不画一行 0', () => {
    expect(find(buildSettings(base), 'ctx')?.value).toBe('(no turn run yet)');
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
    expect(find(buildSettings({ ...base, pressure: p }), 'ctx')?.value).toContain('window unknown');
  });
});

describe('配色与字形', () => {
  test('三档各自显示', () => {
    expect(find(buildSettings({ ...base, color: false }), 'theme')?.value).toContain('NO_COLOR');
    expect(find(buildSettings(base), 'theme')?.value).toContain('24-bit');
    const fallback = find(buildSettings({ ...base, truecolor: false }), 'theme');
    expect(fallback?.value).toContain('16-color');
    expect(fallback?.detail).toContain('instead of emitting 24-bit codes');
  });

  test('★ 字形那一项说得出量没量过真终端', () => {
    const it = find(buildSettings(base), 'glyphs');
    expect(it?.value).toMatch(/\d+ usable \/ \d+ unmeasured \/ \d+ rejected/);
    expect(it?.detail).toBeDefined();
  });
});

describe('★ 扩展:被拒的要说出缺什么', () => {
  test('没配 → 说清清单在哪', () => {
    const it = find(buildSettings(base), 'ext');
    expect(it?.value).toBe('(not configured)');
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
    expect(it?.value).toBe('1 loaded / 1 rejected');
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
    expect(out).toContain('seat conductor: a:1');
    expect(out).toContain('current session: tui');
  });
});

describe('切片⑥: 可改组(界面/审批/provider)', () => {
  test('★ 省略 = 那一组不进表(答不上现状的项不列)', () => {
    const items = buildSettings(base);
    expect(find(items, 'ui-sidebar')).toBeUndefined();
    expect(find(items, 'approval-ttl')).toBeUndefined();
    expect(find(items, 'providers')).toBeUndefined();
  });

  test('给了就列, 且都有 action(能改)与来源说明', () => {
    const items = buildSettings({
      ...base,
      ui: { sidebar: true, painterName: '树' },
      approvalTtlSec: 600,
      providers: [
        { id: 'deepseek', hasKey: true },
        { id: 'kimi-coding', hasKey: false },
      ],
    });
    const sidebar = find(items, 'ui-sidebar');
    expect(sidebar?.value).toBe('on');
    expect(sidebar?.action).toBe('ui-sidebar');
    const ttl = find(items, 'approval-ttl');
    expect(ttl?.value).toBe('600s');
    expect(ttl?.detail).toContain('effective after restart'); // 闸启动时读一次 —— 现状要说真话
    // ⚠ detail 是**纯文本**(选择器 description 不渲染 markdown): 带星号会原样上屏。
    //   2026-08-08 帧库实测抓到过 `**重启生效**`。这条钉住不再回去。
    expect(ttl?.detail).not.toContain('**');
    const prov = find(items, 'providers');
    expect(prov?.value).toBe('1 configured / 1 missing');
    expect(prov?.detail).toContain('kimi-coding');
    // 只显示配没配, 不显示 key —— detail 里不该出现任何 key 形状的串
    expect(prov?.detail).not.toMatch(/sk-|key=/i);
  });
});

describe('advisor 行(座位属性, owner 点名可配 2026-08-10)', () => {
  test('★ 配了显示坐标, 没配显示 (none) —— 两态都答得出现状; action=seat 复用座位子层', () => {
    const items = buildSettings({ ...base, advisors: { conductor: 'claude-code:claude-opus-5', leaf: undefined } });
    const c = find(items, 'seat:advisor.conductor');
    const l = find(items, 'seat:advisor.leaf');
    expect(c?.value).toBe('claude-code:claude-opus-5');
    expect(l?.value).toBe('(none)');
    expect(c?.action).toBe('seat');
    expect(c?.detail).toContain('.omd/config.json');
  });

  test('整组省略 = 不进表(与 ui/approval 同约定)', () => {
    expect(find(buildSettings(base), 'seat:advisor.conductor')).toBeUndefined();
  });
});
