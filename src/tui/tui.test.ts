/**
 * TUI 骨架的 L1 判据(SDD §9 第一层:纯函数,时钟注入)。
 *
 * L3(真 PTY)在 `tui-pty.test.ts` —— 分文件是因为那条 lane **要真起进程**,
 * 慢一个量级;混在一起会让"改一行纯函数"也得等 PTY。
 *
 * ⚠ **永不做 ANSI 快照**(openclaw `src/tui/AGENTS.md` 那条):
 * 快照会因任何布局微调全红,等于没有测试。
 */
import { describe, expect, test } from 'bun:test';
import type { Component } from '@earendil-works/pi-tui';
import { CTRL_C_WINDOW_MS, decideCtrlC, pathHudVisible, withLeftGutter } from './tui';

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
    const out = withLeftGutter(fake(['AAA', 'BBB', '引擎  embedded://x'])).render(60);
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
    const out = withLeftGutter(fake(['引擎  embedded://kimi-coding:k3'])).render(60).join('\n');
    expect(out).toContain('引擎  embedded://kimi-coding:k3');
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
