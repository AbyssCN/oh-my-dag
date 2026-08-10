/**
 * TUI 骨架的 L1 判据(SDD §9 第一层:纯函数,时钟注入)。
 * 命令面六项 (/compact /logout /status /export /new /fork /quit) 的 L1 侧在
 * 本文件末尾三个 describe:回执形状 (CHROME)、/status 真话行 (formatStatus)、
 * /export markdown 形状与缺省路径 (export.ts) —— 全是纯函数,不碰盘不碰模型。
 *
 * L3(真 PTY)在 `tui-pty.test.ts` —— 分文件是因为那条 lane **要真起进程**,
 * 慢一个量级;混在一起会让"改一行纯函数"也得等 PTY。
 *
 * ⚠ **永不做 ANSI 快照**(openclaw `src/tui/AGENTS.md` 那条):
 * 快照会因任何布局微调全红,等于没有测试。
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Component } from '@earendil-works/pi-tui';
import { CHROME, CTRL_C_WINDOW_MS, decideCtrlC, pathHudVisible, withLeftGutter } from './tui';
import { defaultExportPath, exportTranscriptMarkdown } from './export';
import { formatStatus } from './status';

describe('Ctrl+C 双击判定 (§4.1 第 1 条)', () => {
  // 反向自检: 把 decideCtrlC 改成恒 'exit' → 「单击只预备」红;
  //          改成恒 'arm' → 「窗口内第二击退出」红; 把 <= 改成 < → 「边界上算退出」红。
  test('没有预备中的 → 单击只预备, 不退', () => {
    expect(decideCtrlC(null, 1000)).toBe('arm');
  });

  test('窗口内第二击 → 退出', () => {
    expect(decideCtrlC(1000, 1000 + CTRL_C_WINDOW_MS - 1)).toBe('exit');
  });

  test('★ 边界上算退出 (<=, 不是 <) —— 边界归属是判据不是口味, 写死它', () => {
    expect(decideCtrlC(1000, 1000 + CTRL_C_WINDOW_MS)).toBe('exit');
    expect(decideCtrlC(1000, 1000 + CTRL_C_WINDOW_MS + 1)).toBe('arm');
  });

  test('★ 超窗的第二击重新预备, 不是退出 —— 否则"隔十分钟按两次"会误退', () => {
    expect(decideCtrlC(1000, 99999)).toBe('arm');
  });
});

describe('★ 命令面回执形状 —— CHROME 是 PTY 闸锚点的单测钉 (CMP-1/OUT-1/EXP-1)', () => {
  /**
   * 回执串是 scripts/tui-pty-check.mjs 新场景判据锚的**源** —— 接线侧改文案会把
   * PTY 闸一起带红, 所以形状在这里冻结。反向自检: 把 compactDone 的 before/after
   * 任何一个数丢掉 → 「两个估读数都进回执」当场红。
   */
  test('/compact 回执带压缩前后**两个** token 估读数 + 消息数', () => {
    const r = CHROME.compactDone('s-123', 4021, 731, 12);
    expect(r).toContain('Compacted s-123:');
    expect(r).toContain('~4021 -> ~731 tokens');
    expect(r).toContain('(12 messages');
  });

  test('/compact 空会话 → 写真话, 不编数 (null 路径)', () => {
    expect(CHROME.compactNone()).toContain('Nothing to compact');
  });

  test('/logout 回执写明删了**哪个文件的哪个键**', () => {
    const r = CHROME.logoutDone('deepseek', [{ file: '.env', key: 'DEEPSEEK_API_KEY' }], []);
    expect(r).toContain('Removed deepseek credential');
    expect(r).toContain('DEEPSEEK_API_KEY in .env');
  });

  test('/logout 无凭证 → 写真话 nothing removed, 不假装删过', () => {
    const r = CHROME.logoutNone('mimo', []);
    expect(r).toContain('No stored credential for mimo');
    expect(r).toContain('nothing removed');
  });

  test('★ /logout 选单 Esc 取消 → 零副作用回执 (反向自检: 取消也调 removeKeyHeadless 就红)', () => {
    expect(CHROME.logoutCancelled()).toBe('logout cancelled, nothing removed');
  });

  test('claude-code 只指路 claude CLI, 不假装能删', () => {
    expect(CHROME.logoutClaude()).toContain('claude logout');
    expect(CHROME.logoutClaude()).not.toContain('removed');
  });
  test('/export 回执带消息数 + 绝对路径', () => {
    const r = CHROME.exportDone(3, '/abs/.omd/exports/s-1-2024.md');
    expect(r).toContain('Exported 3 messages');
    expect(r).toContain('/abs/.omd/exports/s-1-2024.md');
  });
});

describe('★ /status —— 四段真话 (formatStatus, 只读零副作用)', () => {
  /**
   * 每段读不到就写真话 —— NULL ≠ 0, 不编数。反向自检: 把某段的 null 分支改成
   * 编一个默认值 → 对应真话行那条当场红。
   */
  test('全空: 座位/压力/账本各写真话行', () => {
    const out = formatStatus({ seat: null, sessionId: 's-1', pressure: null, usageToday: null });
    expect(out).toContain('conductor: (no seat configured)');
    expect(out).toContain('session: s-1');
    expect(out).toContain('context: no turn yet');
    expect(out).toContain('usage today: (no daily readout available)');
  });

  test('座位有值 → 原样列出', () => {
    const out = formatStatus({ seat: 'deepseek:deepseek-chat', sessionId: 's-1', pressure: null, usageToday: null });
    expect(out).toContain('conductor: deepseek:deepseek-chat');
  });

  test('★ ratio === null → 不画百分比 (窗口未知 ≠ 0%, 不拿编的分母算)', () => {
    const out = formatStatus({
      seat: null,
      sessionId: 's-1',
      pressure: { systemTokens: 0, harnessTokens: 0, historyTokens: 0, usedTokens: 100, windowTokens: 1000, ratio: null },
      usageToday: null,
    });
    expect(out).toContain('context: 100 (window unknown)');
    expect(out).not.toMatch(/%/);
  });

  test('★ usedTokens 0 → no turn yet (0 不是"压成空的", 是没跑过)', () => {
    const out = formatStatus({
      seat: null,
      sessionId: 's-1',
      pressure: { systemTokens: 0, harnessTokens: 0, historyTokens: 0, usedTokens: 0, windowTokens: 1000, ratio: 0 },
      usageToday: null,
    });
    expect(out).toContain('context: no turn yet');
  });

  test('账本有现成读数 → 标明窗口口径列出', () => {
    const out = formatStatus({ seat: null, sessionId: 's-1', pressure: null, usageToday: '$0.01 · ↑1k ↓2k · 3 calls (24h window)' });
    expect(out).toContain('usage today: $0.01 · ↑1k ↓2k · 3 calls (24h window)');
  });
});

describe('★ /export —— markdown 形状与缺省路径 (export.ts 纯函数半边)', () => {
  /**
   * 文件系统副作用在 tui.ts handleExport, 这里只钉形状与路径格式。
   * 反向自检: 把每消息的 `## role · ts` 行改成别样 → 「role 与 iso 时间戳原样落盘」红。
   */
  const ts = new Date('2024-01-02T03:04:05.000Z').getTime();
  const userMsg = (t: string): AgentMessage => ({ role: 'user', content: t, timestamp: ts }) as unknown as AgentMessage;

  test('表头 + 每消息 `## <role> · <iso ts>` + 文本块', () => {
    const md = exportTranscriptMarkdown([userMsg('hello 世界')], { sessionId: 's-1' });
    expect(md).toContain('# Session s-1');
    expect(md).toContain('## user · 2024-01-02T03:04:05.000Z');
    expect(md).toContain('hello 世界');
  });

  test('空消息 → `(no text)` 真话, 不编内容', () => {
    const md = exportTranscriptMarkdown([userMsg('')], { sessionId: 's-1' });
    expect(md).toContain('(no text)');
  });

  test('空历史 → 只有表头, 不编消息', () => {
    const md = exportTranscriptMarkdown([], { sessionId: 's-1' });
    expect(md).toBe('# Session s-1\n');
  });

  test('缺省路径 `.omd/exports/<sessionId>-<ts>.md`, 冒号与点剥掉 (Windows 文件名合法)', () => {
    const p = defaultExportPath('s-1', new Date('2024-01-01T12:34:56.789Z').getTime());
    expect(p).toBe(join('.omd', 'exports', 's-1-2024-01-01T12-34-56-789Z.md'));
    expect(p).not.toContain(':');
    expect(p).toMatch(/T12-34-56-789Z\.md$/);
  });
});

describe('★ /quit —— 与双击 Ctrl+C 同一条干净退出路 (命令面第 6 条)', () => {
  /**
   * 执行侧: handleQuit 与 Ctrl+C 的 'exit' 分支**共调闭包内同一个 requestCleanExit**
   * (tui.ts "干净退出的唯一路径", 745-762) —— L1 够不着闭包, 同 fn 由 commands.test.ts
   * 接线闸 (handler='requestCleanExit' 调用点存在) + tui-pty.test.ts 真 PTY 钉;
   * 判定本身 (decideCtrlC) 已由本文件上面五条钉死。这里钉屏上那句等价承诺:
   */
  test('★ 屏上承诺 Ctrl+C 两次 = 退出 —— /quit 的等价声明', () => {
    expect(CHROME.editorHint).toContain('Ctrl+C twice to quit');
    expect(CHROME.footer()).toContain('Ctrl+C twice to quit');
  });
});

describe('★ 左槽 —— 正文不许贴着终端左边缘(P1)', () => {
  /**
   * ## 为什么值得一条单测(而不是只看帧)
   *
   * `docs/bars/refs/omd/*` 的帧是**证据不是闸**(`bars-capture.mjs` 文件头写着理由),
   * 所以"正文有没有贴边"如果只有帧看得见,它就会静默回归。这条把它变成会红的东西。
   *
   * ## 实测读数(同一把尺子,七张重采过的帧)
   *
   * 起始列为 0 的行数:`01-empty` 11→**0** · `02` 13→**0** · `03` 11→**0** ·
   * `04-narrow-80` 11→**0** · `05` 11→**0** · `06` 11→**0** · `07-settings` 26→**0**。
   * ⚠ `08-streaming` / `09-long-scroll` **没重采**(那两格要 `--live` 真打模型),
   * 所以它们不算数 —— 别把没重采的帧算进改善。
   *
   * **证伪方式**:把 `GUTTER_COLS` 改成 0 → 第一条当场红(已实跑验证)。
   * ⚠ 第一版的判据写成 `c >= GUTTER_COLS`, **拿常量验自己**, 槽宽归 0 时恒真 —— 那种闸永远不会红。
   */
  const fake = (lines: string[]): Component => ({
    render: () => lines,
    invalidate: () => {},
  });
  const startCol = (line: string): number => {
    const plain = line.replace(/\x1b\[[0-9;]*m/g, '').replace(/\x1b\]8;;\x07/g, '');
    const m = /\S/.exec(plain);
    return m ? m.index : -1;
  };

  test('包了左槽之后, 每一行内容都不在第 0 列', () => {
    const out = withLeftGutter(fake(['AAA', 'BBB', 'engine  embedded://x'])).render(60);
    const cols = out.map(startCol).filter((c) => c >= 0);
    expect(cols.length).toBeGreaterThan(0);
    // ⚠ 判据是**字面量 0**, 不是 `GUTTER_COLS` —— 第一版写的是 `c >= GUTTER_COLS`,
    //   那是拿常量自己去验自己:把 `GUTTER_COLS` 改成 0 之后 `c >= 0` 恒真, 闸永远绿。
    //   实跑证伪过一次才发现(2026-08-08)。**闸要钉不变量, 不是复述常量。**
    for (const c of cols) expect(c).toBeGreaterThan(0);
  });

  test('★ 反测:槽宽 0 时内容**回到第 0 列** —— 证明这条闸量的是槽, 不是别的', () => {
    const out = withLeftGutter(fake(['AAA']), 0).render(60);
    expect(out.map(startCol).filter((c) => c >= 0)).toContain(0);
  });

  test('内容一个字都没丢(槽只挪位置, 不吃字)', () => {
    const out = withLeftGutter(fake(['engine  embedded://kimi-coding:k3'])).render(60).join('\n');
    expect(out).toContain('engine  embedded://kimi-coding:k3');
  });

  test('窄屏(80 列)下槽仍在, 且没把可用宽度吃穿', () => {
    const out = withLeftGutter(fake(['x'.repeat(70)])).render(80);
    expect(out.map(startCol).filter((c) => c >= 0).every((c) => c > 0)).toBe(true);
    expect(out.join('\n')).toContain('x'.repeat(70));
  });
});

describe('★ 侧栏 pathfinder 摘要的可见判据(P3 件3 轮1)', () => {
  /**
   * 判词:「流式回答下方混入与本题无关的仪表盘内容(进度条 8/23、前沿票工单表、阻塞集)」——
   * 三跑全部判我方输。核过帧 `08-streaming` 行 22-26:那 5 行夹在回答与输入框之间。
   *
   * ⚠ 为什么是这条闸而不是 PTY:pi-tui 差分重绘 ⇒ "还在屏上"在累积字节流里看不见,
   * 我先写的那条 PTY 断言在注入下没红(空转),已撤。重绘那一半的证据是重采的帧。
   *
   * 证伪方式(实跑过):把 `pathHudVisible` 改成 `!s.pathFullOn` → 「有对话就收起」当场红。
   */
  test('还没开口 → 画', () => {
    expect(pathHudVisible({ pathFullOn: false, hasDialogue: false })).toBe(true);
  });

  test('★ 有对话 → 收起', () => {
    expect(pathHudVisible({ pathFullOn: false, hasDialogue: true })).toBe(false);
  });

  test('全屏散雾图开着 → 不重复画(同一张图画两遍会读成两张)', () => {
    expect(pathHudVisible({ pathFullOn: true, hasDialogue: false })).toBe(false);
    expect(pathHudVisible({ pathFullOn: true, hasDialogue: true })).toBe(false);
  });
})
