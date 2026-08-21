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
import { CHROME } from '../tui';
import { GROUND_TRUTH, NEEDS_TTY_GLYPHS, SAFE_GLYPH_WIDTHS, UNSAFE_GLYPHS } from './glyph-table';
import { classifyGlyph, findRiskyGlyphs } from './glyphs';
import { formatHelp } from '../commands';
import { formatSeatRows, seatRows } from '../seat-picker';
import { formatSessions } from '../sessions';
import { buildTreeRows, formatTree } from '../tree-picker';
import { buildSettings, formatSettings } from '../settings';
import { formatSkillList, listSkills } from '../skills';
import { fitLine } from './line';
import { renderGantt } from './dag-gantt';
import { renderDelta, renderFogLine } from './path-fog';
import { renderLayers } from './dag-layers';
import { formatStatusLine } from './statusbar';

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
  // 反向自检 (2026-08-07 实跑): 把 chrome 里的 '-' 换回 em dash '—'
  // → 这条当场红, 判词直接指出 U+2014 needs-tty。**这就是它第一次抓到的那个真问题。**
  // (原样本 CHROME.header 已随顶栏在切片②去掉 —— 信息下沉进底栏行①。)
  const samples: [string, string][] = [
    ['hint', CHROME.hint],
    // S-3: 欢迎屏正文。字标本身在 logo.test.ts 单独扫 —— 两处都要, 因为它们是两段不同的文案。
    ['welcomeBody', CHROME.welcomeBody({ engine: 'embedded://deepseek:deepseek-v4-flash', session: 'tui', width: 100 })],
    ['refused', CHROME.refused('embedded://deepseek:deepseek-v4-flash')],
    ['failed', CHROME.failed('ECONNREFUSED')],
    ['toolStart', CHROME.toolStart('run')],
    ['toolEnd(ok)', CHROME.toolEnd('run', true)],
    ['toolEnd(fail)', CHROME.toolEnd('run', false)],
    ['seatChanged', CHROME.seatChanged('conductor', 'kimi-coding:k3')],
    ['seatFailed', CHROME.seatFailed('coord is not provider:model')],
    ['seatUnresolved', CHROME.seatUnresolved('seat not configured')],
    ['noRunCapability', CHROME.noRunCapability('listRuns')],
    // Ctrl+K 去哪 (2026-08-22)。新增 chrome 文案一律进这张表, 否则它不过字形闸。
    ['paletteEmpty', CHROME.paletteEmpty()],
    ['paletteSessionsFailed', CHROME.paletteSessionsFailed('EACCES: permission denied')],
    ['resumeStarted', CHROME.resumeStarted('abc', 'runId: abc status: running')],
    ['resumeRefused', CHROME.resumeRefused('abc', 'no checkpoint')],
    ['skillArmed', CHROME.skillArmed('omd-council')],
    ['skillMissing', CHROME.skillMissing('omd-nope')],
    // 底栏行①② (切片②) 也是 chrome —— 新增文案一律进这张表, 否则它不过字形闸。
    ['statusbar:行①', formatStatusLine({
      ws: { repo: 'oh-my-dag', branch: 'main', dirty: 2, worktree: 'fanin' },
      seat: 'kimi-coding:k3',
      pressure: { systemTokens: 12000, harnessTokens: 8000, historyTokens: 34000, usedTokens: 46000, windowTokens: 200000, ratio: 0.23, source: 'estimate' },
      session: { costUsd: 0.83, unpriced: false, calls: 3 },
      win: { since: 0, calls: 5, in: 312000, out: 18400, cacheHit: 276000, costUsd: 0.42, unpriced: false, byProvider: [] },
    })],
    ['statusbar:行①(窗口未知)', formatStatusLine({
      ws: { repo: 'x', branch: null, dirty: 0, worktree: null },
      seat: 'a:b',
      pressure: { systemTokens: 4000, harnessTokens: 0, historyTokens: 1000, usedTokens: 5000, windowTokens: 0, ratio: null, source: 'estimate' },
      session: null,
      win: null,
    })],
    // 底栏现在只有**一行**(2026-08-09)。样本取**最长那种形态**:双 provider + ssh + tmux。
    ['statusbar:一行(最长形态)', formatStatusLine(
      {
        ws: { repo: 'oh-my-dag', branch: 'main', dirty: 2, worktree: 'fanin' },
        seat: 'kimi-coding:k3',
        pressure: { systemTokens: 12000, harnessTokens: 8000, historyTokens: 34000, usedTokens: 46000, windowTokens: 200000, ratio: 0.23, source: 'estimate' },
        session: { costUsd: 0.83, unpriced: false, calls: 3 },
        win: { since: 0, calls: 5, in: 312000, out: 18400, cacheHit: 276000, costUsd: 0.42, unpriced: false, byProvider: [
          { provider: 'deepseek', calls: 3, in: 200000, out: 10000, cacheHit: 180000, costUsd: 1.2, unpriced: false },
          { provider: 'mimo', calls: 2, in: 112000, out: 8400, cacheHit: 96000, costUsd: 0.3, unpriced: false },
        ] },
      },
      { ssh: 'ms02', tmux: true },
    )],
    ['help', formatHelp()],
    ['sessions(空)', formatSessions([], 'tui')],
    ['sessions(有)', formatSessions([{ id: 's-1', title: 'a title', updatedAt: 1760000000000 }, { id: 's-1-f9', title: '', updatedAt: 1760000000001, parent: 's-1' }], 's-1')],
    // §1.3 (2026-08-11): `/tree` 的树与三条回执。树里的 preview 是**数据**(消息原文),
    // 所以样例喂英文占位 —— 与 seatRows 那条注同一条道理:让这条闸量的确实是 chrome。
    ['tree', formatTree(buildTreeRows([
      { id: '019fee0a-1', parentId: null, seq: 1, kind: 'message/user', preview: 'a question' },
      { id: '019fee0a-2', parentId: '019fee0a-1', seq: 2, kind: 'message/assistant', preview: 'an answer' },
      { id: '019fee0a-3', parentId: '019fee0a-1', seq: 3, kind: 'branch_summary', preview: '[branch summary] the other branch' },
    ], '019fee0a-3'))],
    ['tree(空)', formatTree([])],
    ['treeBranched', CHROME.treeBranched('019fee0a-2', 'branched at 019fee0a-2; 4 entries were summarized')],
    ['treeBranchFailed', CHROME.treeBranchFailed('provider refused')],
    ['treeAtLeaf', CHROME.treeAtLeaf()],
    ['sessionForked', CHROME.sessionForked('forked tui-f9 from tui (2 messages)')],
    ['sessionForkFailed', CHROME.sessionForkFailed('session x does not exist')],
    ['sessionSwitched', CHROME.sessionSwitched('s-1', 4)],
    ['sessionNew', CHROME.sessionNew('s-2')],
    ['sessionFailed', CHROME.sessionFailed('no such session')],
    // 对话框标题也是 chrome —— ↑↓ 已在白名单(真终端读数量过)。
    ['dialog:select', 'Pick one  (↑↓ select · Enter ok · Esc cancel)'],
    ['settings', formatSettings(buildSettings({
      seats: { conductor: 'a:1' }, seatsError: null, sessionId: 'tui', sessionCount: 2, pressure: null, color: true, truecolor: true, extensions: [],
      // 切片⑥: 可改组的文案也要过字形闸
      ui: { sidebar: true, painterName: 'gantt' }, sandbox: { ok: false, reason: 'bwrap: No such file or directory' },
      providers: [{ id: 'deepseek', hasKey: true }, { id: 'kimi-coding', hasKey: false }],
    }))],
    ['login:done', CHROME.loginDone('deepseek', 'env', ['auth.json had an older key, it was overwritten'])],
    ['ui:written', CHROME.uiWritten('DAG sidebar default -> off', '/x/.omd/config.json')],
    // 切片⑧: 散雾图两画法 (chrome + 键位行; 票标题是数据, 但样例里的中文照扫无妨)。
    ['path:fog', renderFogLine(
      { destination: 'a destination', slug: 'omd-agent-tui', gens: [[{ id: 'd01', gist: 'stdio' }, { id: 'd05', gist: 'memory' }]], frontier: [
        { id: 't9', type: 'task', title: 'approval tiers', runId: 'run-78f1951c' },
        { id: 'g4', type: 'grill', title: 'ledger criteria' },
      ], blockedTickets: [{ id: 'b1', title: 'session tree fork' }], ruled: 2, total: 5, runs: ['run-78f1951c'] },
      { width: 100, height: 30, selected: 0 },
    ).join('\n')],
    ['path:delta', renderDelta(
      { destination: 'a destination', slug: 'omd-agent-tui', gens: [[{ id: 'd01', gist: 'stdio' }]], frontier: [{ id: 'r2', type: 'research', title: 'exa evaluation' }], blockedTickets: [], ruled: 1, total: 2, runs: [] },
      { width: 100, height: 30, selected: 0 },
    ).join('\n')],
    ['path:none', CHROME.noPathMaps()],
    ['dialog:input', 'Input  (Enter ok · Esc cancel)'],
    // ⚠ 两条判据在这一行分岔:字形闸要扫**真登记表**(座位说明是数据, 里面有什么字形都算数),
    //   而纯英文闸量的是 **chrome**(`does:` / `pick:` / `Usage:` 那几个词)。
    //   所以这里给真表, 纯英文闸把这一条按"数据"排除 —— 见下面那个 DATA_SAMPLES。
    ['seatRows', formatSeatRows(seatRows({ conductor: 'a:1' }))],
    ['skillList(空)', formatSkillList([])],
    // ⚠ **不把真 skill 列表放进来**:那些 description 来自 20 个 SKILL.md,是**数据不是 chrome**。
    //    实测它们里面就有 `✅` 和 `≠` —— 数据本来就可以是任意字形, 要求它干净是错的判据。
    //    数据侧要保的是"渲染它不会超宽", 见下面那个 describe。
    ['skillList(干净数据)', formatSkillList([{ name: 'omd-x', description: 'one line', root: '/r' }])],
    // ⚠ 2026-08-08 起 footer 不带后端坐标了(P1 密度:同一屏 3 次 → 2 次)。
    ['footer', CHROME.footer()],
    // ★ 等待态:文案 + **四个动画帧**一起过白名单。pi-tui 默认帧是盲文点阵(U+28xx),
    //   不在白名单里 —— 这一条就是拦"顺手用回默认帧"的。
    ['waiting', `${CHROME.waiting} \u2581\u2584\u2588`],
    ['footerArmed', CHROME.footerArmed()],
    // 切片③: 全屏两画法的 chrome (头行/轴/提示行)。树的字形已在 dag-tree 那批白名单里。
    ['dag:gantt', renderGantt(
      { runLabel: 'r1', nodes: [{ id: 'shard-1', kind: 'agent', status: 'running' as const, parent: null, deps: [], seq: 0, startAt: 0, endAt: null }] },
      { width: 90, height: 20, now: 71_000 },
    ).join('\n')],
    ['dag:layers', renderLayers(
      { runLabel: 'r1', nodes: [
        { id: 'a', kind: 'map', status: 'done' as const, parent: null, deps: [], seq: 0, startAt: null, endAt: null },
        { id: 'join', kind: 'agent', status: 'pending' as const, parent: null, deps: ['a', 'b'], seq: 1, startAt: null, endAt: null },
      ] },
      { width: 90, height: 20 },
    ).join('\n')],
    ['dag:fullscreen-hint', 'Tab switches view (now: gantt) · Ctrl+G exits'],
    // 切片⑤: 健康度一行 (createContextHealth 的 line() 形状)。
    ['health', 'Context health: read src/x.ts 3x already - it is most likely still in context, refer to it instead of reading again'],
    ['dag:no-run', '(no run yet - send one, then press Ctrl+G)'],
    ['hud:on', 'DAG sidebar: on (drawn when there is a run and the terminal is at least 90 columns; auto-hidden when narrower)'],
    ['hud:off', 'DAG sidebar: off (the table at the bottom is back)'],
    // 2026-08-13: 审批卡片删了, 换成沙箱降级告警那一行(它是 chrome, 要过字形闸)。
    ['sandbox:off', CHROME.sandboxOff('bwrap: Operation not permitted')],
    // 空输入框里的提示符(`HintedEditor`)—— P3 件6 轮1 的 critic 判词逼出来的那一行。
    ['editorHint', CHROME.editorHint],
  ];

  for (const [name, text] of samples) {
    test(`${name} 全字形已核实`, () => {
      expect(findRiskyGlyphs(text)).toEqual([]);
    });
  }

  /**
   * 这几条样本里**混着数据** —— 数据可以是中文(与下面「chrome 与数据是两条判据」同一条道理)。
   *
   * `seatRows`:座位说明来自**座位登记表** `src/model/seats.ts`,它同时喂 MCP 与文档,
   * 不是 TUI 的 chrome。它的 chrome 部分(`does:` / `pick:` / `Usage:`)已经是英文,
   * 而那几段中文说明要不要翻,是登记表自己的事,不在"TUI 纯英文"这条裁决的射程里。
   * ⚠ 它仍然过**字形闸** —— 排除的只有纯英文那一条。
   */
  const DATA_SAMPLES = new Set(['seatRows']);

  /**
   * ★★ **chrome 一律纯英文**(owner 裁决 2026-08-09)。
   *
   * owner 原话:「整个 tui 应该是纯英文的,如果用户想用中文那就是纯靠模型自己理解翻译。」
   * 一个实测好处:盲比的 `leakGuess` 里 critic 反复靠"中文"猜我们是某国产 CLI
   * (`docs/bars/gauntlet-p3-账本.md` 里逐条可查)⇒ 换纯英文之后剥标签更接近真盲。
   *
   * **扫的就是上面那张样本表** —— 它已经是 chrome 层的枚举(CHROME 常量有完整性闸钉着,
   * 函数型的手列在表里)。所以这条闸与那条完整性闸是一对:漏进表 → 那条红;
   * 进了表但是中文 → 这条红。
   *
   * ⚠ **数据不在此列**:样本里那些 `title` / `destination` / skill description 是**数据**,
   * 中文数据合法(下面那个 describe 讲的就是这件事)。所以表里凡是靠参数喂进去的中文
   * 一律改成了英文占位 —— 不是"为了让闸绿",是**让这条闸量的确实是 chrome**。
   *
   * 反向自检(实跑):把 `CHROME.waiting` 改回 `'在等模型回话…(Esc 打断)'` → 这条当场红,
   * 判词点出 `waiting` 与那几个汉字。
   */
  test('★★ chrome 文案一律纯英文 —— 中文只许出现在数据里', () => {
    const cjk = /[㐀-鿿　-〿＀-￯]/gu;
    const offenders = samples
      .filter(([name]) => !DATA_SAMPLES.has(name))
      .map(([name, text]) => [name, [...new Set(text.match(cjk) ?? [])].join('')] as const)
      .filter(([, hit]) => hit.length > 0)
      .map(([name, hit]) => `${name}: ${hit}`);
    expect(offenders).toEqual([]);
  });

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

  /**
   * ★ **完整性闸:`CHROME` 里每个字符串常量都得在上面那张样本表里出现。**
   *
   * 上面那张表是**手列的**。而 `tui.ts` 的注释写着「新增任何 chrome 文案都加到这里,
   * 否则它不过闸」—— 那句话只约束得住记得读它的人。本仓图鉴 **S-25**(一族上限里有一个不报)
   * 就是这个形状:一族里 N−1 个都被覆盖,漏掉的那一个**静默**escape。
   *
   * 这一条把"漏了"变成一条会红的断言。函数型的 `CHROME` 成员各自要造参数,不在此列
   * (它们仍靠手列),但**字符串常量**是最容易顺手加的那一类,先把它钉住。
   *
   * 反向自检(实跑过):把 `['editorHint', CHROME.editorHint]` 从样本表里删掉 → 这条当场红,
   * 判词直接点出 `editorHint`。
   */
  test('★ CHROME 的字符串常量一个都不许漏出这张样本表(S-25 形状)', () => {
    const listed = samples.map(([, text]) => text);
    const missing = Object.entries(CHROME)
      .filter(([, v]) => typeof v === 'string')
      .filter(([, v]) => !listed.some((t) => t.includes(v as string)))
      .map(([k]) => k);
    expect(missing).toEqual([]);
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
