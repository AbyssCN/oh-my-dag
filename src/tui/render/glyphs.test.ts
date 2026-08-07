/**
 * L1 判据:字形安全(TUI SDD §7.5.2,切片 S6)。
 *
 * 两件事:
 *  ① **回归钉** —— 白名单里每个字形的 `visibleWidth` 必须还等于探针记下的那个数。
 *     pi-tui 升级动了宽度表,这条当场红,而不是等某天画面在别人机器上花掉。
 *  ② **真闸** —— 拿 `findRiskyGlyphs` 扫 TUI 的全部 chrome 文案。
 *     ⚠ 这条第一次跑就抓到了一个真的:头部原来的 em dash `—` 是歧义宽度。
 */
import { visibleWidth } from '@earendil-works/pi-tui';
import { describe, expect, test } from 'bun:test';
import { formatContextLine } from '../context';
import { CHROME } from '../tui';
import { NEEDS_TTY_GLYPHS, SAFE_GLYPH_WIDTHS, UNSAFE_GLYPHS } from './glyph-table';
import { classifyGlyph, findRiskyGlyphs } from './glyphs';

describe('★ 回归钉: 探针读数 vs 今天的 pi-tui', () => {
  // 反向自检: 把 glyph-table 里 '你' 的 2 改成 1 → 这条当场红。
  test('白名单每个字形的列宽都还是探针记下的那个数', () => {
    const drifted = [...SAFE_GLYPH_WIDTHS].filter(([g, w]) => visibleWidth(g) !== w);
    expect(drifted).toEqual([]);
  });

  test('三张表互不重叠 —— 一个字形只能有一种判定', () => {
    for (const g of NEEDS_TTY_GLYPHS) {
      expect(SAFE_GLYPH_WIDTHS.has(g)).toBe(false);
      expect(UNSAFE_GLYPHS.has(g)).toBe(false);
    }
  });

  test('探针真的量到了东西 —— 三张表都不为空(防止生成脚本静默产出空表)', () => {
    expect(SAFE_GLYPH_WIDTHS.size).toBeGreaterThan(10);
    expect(NEEDS_TTY_GLYPHS.size).toBeGreaterThan(10);
    expect(UNSAFE_GLYPHS.size).toBeGreaterThan(0);
  });
});

describe('classifyGlyph —— 四态各自认得出来', () => {
  test('ASCII 与 CJK 表意字是 safe', () => {
    expect(classifyGlyph('a')).toBe('safe');
    expect(classifyGlyph('好')).toBe('safe');
    expect(classifyGlyph('龘')).toBe('safe'); // 不在探针表里, 但 EAW = W 不歧义
  });

  test('★ 歧义宽度是 needs-tty, 不是 unsafe —— 两者不是一回事', () => {
    expect(classifyGlyph('—')).toBe('needs-tty');
    expect(classifyGlyph('─')).toBe('needs-tty');
  });

  test('emoji / ZWJ / 变体选择符是 unsafe', () => {
    expect(classifyGlyph('🔥')).toBe('unsafe');
    expect(classifyGlyph('⚠️')).toBe('unsafe'); // U+26A0 + VS16: 带 VS16 与不带是两个宽度
    expect(classifyGlyph('👨‍👩‍👧')).toBe('unsafe');
  });

  test('探针没覆盖到的窄非 ASCII 报 unmeasured, 不冒充 safe', () => {
    expect(classifyGlyph('ʧ')).toBe('unmeasured');
  });
});

describe('★ 字形闸: TUI 的 chrome 文案里不许有画不准的字形', () => {
  // 反向自检 (2026-08-07 实跑): 把 CHROME.header 的 '-' 换回 em dash '—'
  // → 这条当场红, 判词直接指出 U+2014 needs-tty。**这就是它第一次抓到的那个真问题。**
  const samples: [string, string][] = [
    ['header', CHROME.header('/home/nick/repos/oh-my-dag')],
    ['hint', CHROME.hint],
    ['refused', CHROME.refused('embedded://deepseek:deepseek-v4-flash')],
    ['failed', CHROME.failed('ECONNREFUSED')],
    ['toolStart', CHROME.toolStart('run')],
    ['toolEnd(ok)', CHROME.toolEnd('run', true)],
    ['toolEnd(fail)', CHROME.toolEnd('run', false)],
    ['seatChanged', CHROME.seatChanged('conductor', 'kimi-coding:k3')],
    ['seatFailed', CHROME.seatFailed('coord 格式非法')],
    ['seatUnresolved', CHROME.seatUnresolved('座位未配')],
    ['footer', CHROME.footer('embedded://deepseek:deepseek-v4-flash')],
    ['footerArmed', CHROME.footerArmed('embedded://deepseek:deepseek-v4-flash')],
    ['harness(有)', formatContextLine([{ path: '/x/.claude/CLAUDE.md', content: '' }], { cwd: '/x', home: '/h' })],
    ['harness(无)', formatContextLine([], { cwd: '/x', home: '/h' })],
  ];

  for (const [name, text] of samples) {
    test(`${name} 全字形已核实`, () => {
      expect(findRiskyGlyphs(text)).toEqual([]);
    });
  }

  test('闸本身会红 —— 给它一个歧义字形, 它必须报出来', () => {
    // 一条永远绿的闸比没有闸更坏, 所以在这里当场证伪一次。
    expect(findRiskyGlyphs('omd tui — /x')).toEqual([{ glyph: '—', codepoint: 'U+2014', verdict: 'needs-tty' }]);
  });

  test('同一个字形只报一次, 按首次出现顺序', () => {
    expect(findRiskyGlyphs('—→—').map((r) => r.glyph)).toEqual(['—', '→']);
  });
});
