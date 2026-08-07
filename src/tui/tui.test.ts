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
import { CTRL_C_WINDOW_MS, decideCtrlC } from './tui';

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
