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
import { GROUND_TRUTH, NEEDS_TTY_GLYPHS, SAFE_GLYPH_WIDTHS, UNSAFE_GLYPHS } from './glyph-table';
import { classifyGlyph, findRiskyGlyphs } from './glyphs';
import { formatHelp } from '../commands';
import { formatSeatRows, seatRows } from '../seat-picker';
import { formatSessions } from '../sessions';
import { buildSettings, formatSettings } from '../settings';
import { formatSkillList, listSkills } from '../skills';
import { fitLine } from './line';
import { formatPressure } from './pressure';

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

  test('探针真的量到了东西 —— SAFE / UNSAFE 都不为空(防止生成脚本静默产出空表)', () => {
    expect(SAFE_GLYPH_WIDTHS.size).toBeGreaterThan(10);
    expect(UNSAFE_GLYPHS.size).toBeGreaterThan(0);
  });

  test('★ NEEDS_TTY 为空只有在**真终端裁决过**时才合法', () => {
    // ⚠ 这条判据是 2026-08-07 拿到真终端读数之后**改过**的, 记下为什么:
    // 原来写的是"三张表都不为空", 意图是防生成脚本静默产出空表。拿到真值之后
    // 歧义那一档被裁决完了 (43 个全部并进 SAFE), NEEDS_TTY 合法地空了 ——
    // 老判据会红, 而那**不是回归**。
    // 但"空"仍有两种读法, 靠 GROUND_TRUTH 分 (本仓 NULL ≠ 0 ≠ 不适用):
    //   true + 空  = 裁决完了 ✅
    //   false + 空 = 生成脚本出问题 (候选集里明明有歧义字形) ❌
    if (NEEDS_TTY_GLYPHS.size === 0) expect(GROUND_TRUTH, 'NEEDS_TTY 空但没量过真终端 = 生成脚本坏了').toBe(true);
  });

  test('★ 真终端裁决过的表里, 歧义字形必须**已归档** —— 不许两边都不在', () => {
    // 候选集里的歧义字形 (em dash / box drawing / block) 要么进 SAFE 要么进 UNSAFE,
    // 悬空 = 探针漏了它, 而漏了的字形会走 classifyGlyph 的兜底路径判成 unmeasured。
    if (!GROUND_TRUTH) return;
    for (const g of ['—', '─', '█', '→']) {
      expect(SAFE_GLYPH_WIDTHS.has(g) || UNSAFE_GLYPHS.has(g), `${g} 两边都不在`).toBe(true);
    }
  });
});

describe('classifyGlyph —— 四态各自认得出来', () => {
  test('ASCII 与 CJK 表意字是 safe', () => {
    expect(classifyGlyph('a')).toBe('safe');
    expect(classifyGlyph('好')).toBe('safe');
    expect(classifyGlyph('龘')).toBe('safe'); // 不在探针表里, 但 EAW = W 不歧义
  });

  test('★ 歧义宽度: 真终端裁决过 → safe; 没裁决过 → needs-tty(两者不是一回事)', () => {
    // 2026-08-07 起本机读数已进表, 所以这里是 safe。GROUND_TRUTH 为假时它该是 needs-tty ——
    // 判据跟着表走, 不写死一个答案。
    const expected = GROUND_TRUTH ? 'safe' : 'needs-tty';
    expect(classifyGlyph('—')).toBe(expected);
    expect(classifyGlyph('─')).toBe(expected);
  });

  test('emoji / ZWJ / 变体选择符是 unsafe', () => {
    expect(classifyGlyph('🔥')).toBe('unsafe');
    expect(classifyGlyph('⚠️')).toBe('unsafe'); // U+26A0 + VS16: 带 VS16 与不带是两个宽度
    expect(classifyGlyph('👨‍👩‍👧')).toBe('unsafe');
  });

  test('探针没覆盖到的窄非 ASCII 报 unmeasured, 不冒充 safe', () => {
    expect(classifyGlyph('ʧ')).toBe('unmeasured');
  });

  test('★ 换行放行(它是行分隔符不是字形), 但 **tab 不放行**(制表位宽度终端相关)', () => {
    expect(classifyGlyph('\n')).toBe('safe');
    expect(classifyGlyph('\t')).toBe('unmeasured');
  });
});

describe('★ 字形闸: TUI 的 chrome 文案里不许有画不准的字形', () => {
  // 反向自检 (2026-08-07 实跑): 把 CHROME.header 的 '-' 换回 em dash '—'
  // → 这条当场红, 判词直接指出 U+2014 needs-tty。**这就是它第一次抓到的那个真问题。**
  const samples: [string, string][] = [
    ['header', CHROME.header('/home/nick/repos/oh-my-dag')],
    ['hint', CHROME.hint],
    // S-3: 欢迎屏正文。字标本身在 logo.test.ts 单独扫 —— 两处都要, 因为它们是两段不同的文案。
    ['welcomeBody', CHROME.welcomeBody({ engine: 'embedded://deepseek:deepseek-v4-flash', session: 'tui', width: 100 })],
    ['refused', CHROME.refused('embedded://deepseek:deepseek-v4-flash')],
    ['failed', CHROME.failed('ECONNREFUSED')],
    ['toolStart', CHROME.toolStart('run')],
    ['toolEnd(ok)', CHROME.toolEnd('run', true)],
    ['toolEnd(fail)', CHROME.toolEnd('run', false)],
    ['seatChanged', CHROME.seatChanged('conductor', 'kimi-coding:k3')],
    ['seatFailed', CHROME.seatFailed('coord 格式非法')],
    ['seatUnresolved', CHROME.seatUnresolved('座位未配')],
    ['noRunCapability', CHROME.noRunCapability('listRuns')],
    ['resumeStarted', CHROME.resumeStarted('abc', 'runId: abc status: running')],
    ['resumeRefused', CHROME.resumeRefused('abc', 'no checkpoint')],
    ['skillArmed', CHROME.skillArmed('omd-council')],
    ['skillMissing', CHROME.skillMissing('omd-nope')],
    // 上下文压力行也是 chrome —— 新增文案一律进这张表, 否则它不过字形闸。
    ['pressure', formatPressure({ systemTokens: 12000, harnessTokens: 8000, historyTokens: 34000, usedTokens: 46000, windowTokens: 200000, ratio: 0.23 }, { in: 46000, out: 800, cacheHit: 41000 }) as string],
    ['help', formatHelp()],
    ['sessions(空)', formatSessions([], 'tui')],
    ['sessions(有)', formatSessions([{ id: 's-1', title: '标题', updatedAt: 1760000000000 }], 's-1')],
    ['sessionSwitched', CHROME.sessionSwitched('s-1', 4)],
    ['sessionNew', CHROME.sessionNew('s-2')],
    ['sessionFailed', CHROME.sessionFailed('no such session')],
    // 对话框标题也是 chrome —— ↑↓ 已在白名单(真终端读数量过)。
    ['dialog:select', '挑一个  (↑↓ 选, Enter 确认, Esc 取消)'],
    ['settings', formatSettings(buildSettings({ seats: { conductor: 'a:1' }, seatsError: null, sessionId: 'tui', sessionCount: 2, pressure: null, color: true, truecolor: true, extensions: [] }))],
    ['dialog:input', '输入  (Enter 确认, Esc 取消)'],
    ['seatRows', formatSeatRows(seatRows({ conductor: 'a:1' }))],
    ['skillList(空)', formatSkillList([])],
    // ⚠ **不把真 skill 列表放进来**:那些 description 来自 20 个 SKILL.md,是**数据不是 chrome**。
    //    实测它们里面就有 `✅` 和 `≠` —— 数据本来就可以是任意字形, 要求它干净是错的判据。
    //    数据侧要保的是"渲染它不会超宽", 见下面那个 describe。
    ['skillList(干净数据)', formatSkillList([{ name: 'omd-x', description: '一句话', root: '/r' }])],
    ['pressure(窗口未知)', formatPressure({ systemTokens: 4000, harnessTokens: 0, historyTokens: 1000, usedTokens: 5000, windowTokens: 0, ratio: null }) as string],
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

  test('闸本身会红 —— 给它一个画不准的字形, 它必须报出来', () => {
    // 一条永远绿的闸比没有闸更坏, 所以在这里当场证伪一次。
    // ⚠ 这条原来用 em dash `—`。2026-08-07 真终端读数进表之后它变 safe 了, 这条就绿得没意义 ——
    // 换成 emoji: 它**无论真终端量出什么都判 unsafe**(字体/终端相关, 量了也只对一台机器成立),
    // 所以这条自证伪不会再因为表更新而失效。
    expect(findRiskyGlyphs('omd tui 🔥 /x')).toEqual([{ glyph: '🔥', codepoint: 'U+1F525', verdict: 'unsafe' }]);
  });

  test('同一个字形只报一次, 按首次出现顺序', () => {
    expect(findRiskyGlyphs('🔥❌🔥').map((r) => r.glyph)).toEqual(['🔥', '❌']);
  });
});

describe('★ chrome 与**数据**是两条不同的判据', () => {
  /**
   * 上面那个闸管的是 **chrome** —— 我写死在代码里的字符串。
   * 而 skill 描述、座位坐标、run 列表是**数据**:来自文件、工具、模型,里面可以是任意字形
   * (真跑一次就看到了:`client-skills` 的 description 里有 `✅` 和 `≠`)。
   *
   * ⇒ 对数据要求"干净"是错的判据。数据侧要保的是 **UI 扛得住脏数据**:渲染出来不超宽。
   * (残余风险说清楚:一个 `unmeasured` 字形上 `visibleWidth` 可能与真终端不一致 ——
   *  那对任意数据是**消不掉**的,只能靠"每行都过 fitLine/wrap"把伤害限制在一行内。)
   */
  test('skill 列表里带 emoji / 未量字形, 渲染出来仍不超宽', () => {
    const dirty = formatSkillList([
      { name: 'omd-a', description: '带 ✅ 与 ≠ 与 🔥 的描述', root: '/r' },
      { name: 'omd-b', description: null, root: '/r' },
    ]);
    for (const w of [20, 40, 80]) {
      for (const line of dirty.split('\n')) {
        expect(visibleWidth(fitLine(line, w)), `w=${w}`).toBeLessThanOrEqual(w);
      }
    }
  });

  test('真 skill 列表(数据脏)渲染出来也不超宽', () => {
    const real = formatSkillList(listSkills());
    for (const line of real.split('\n')) {
      expect(visibleWidth(fitLine(line, 80))).toBeLessThanOrEqual(80);
    }
  });
});
