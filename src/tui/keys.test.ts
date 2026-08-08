/**
 * src/tui/keys.test —— 键位表的闸。
 *
 * ## 每条都带**证伪方式**(本仓惯例:一条永远绿的闸不是闸)
 *
 * - 「双 ESC 能取消」:把 `SELECT_CANCEL_KEYS` 里的 `ctrl+alt+[` 删掉 → 当场红。
 * - 「ctrl+c 没被静默删掉」:把 `'ctrl+c'` 删掉 → 当场红。
 *   ⚠ 这一条**不是**在测 pi-tui,是在测"我们覆盖默认值时没漏项" —— 那是这次改动
 *   唯一可能造成静默回退的地方。
 * - 「没有冲突」:把 `'escape'` 改成 `'enter'` → `getConflicts()` 非空,当场红。
 */
import { describe, expect, test } from 'bun:test';
import { getKeybindings } from '@earendil-works/pi-tui';
import { SELECT_CANCEL_KEYS, installOmdKeybindings } from './keys';

describe('omd 键位覆盖', () => {
  test('装之前:pi-tui 默认表**认不出**双 ESC —— 这就是要补的那一格', () => {
    // ⚠ 键位管理器是**全局单例**, 清空会影响同进程里后跑的测试 → `finally` 里装回去。
    //   (不装回去的症状是"另一个文件里的 Esc 测试莫名其妙红了", 而且顺序一变就不复现。)
    getKeybindings().setUserBindings({});
    try {
      expect(getKeybindings().matches('\x1b\x1b', 'tui.select.cancel')).toBe(false);
      // 同一次量到的另一半:kitty 编码 pi-tui 认得, 而 omd 手列的 `ESC` 表不认。
      expect(getKeybindings().matches('\x1b[27u', 'tui.select.cancel')).toBe(true);
    } finally {
      installOmdKeybindings();
    }
  });

  test('装之后:三种编码都取消得了', () => {
    installOmdKeybindings();
    const kb = getKeybindings();
    expect(kb.matches('\x1b', 'tui.select.cancel')).toBe(true);
    expect(kb.matches('\x1b\x1b', 'tui.select.cancel')).toBe(true);
    expect(kb.matches('\x1b[27u', 'tui.select.cancel')).toBe(true);
  });

  test('★ ctrl+c 没被静默删掉(pi-tui 默认表里有它)', () => {
    installOmdKeybindings();
    expect(SELECT_CANCEL_KEYS).toContain('ctrl+c');
    expect(getKeybindings().getKeys('tui.select.cancel')).toContain('ctrl+c');
  });

  test('覆盖没有引入键位冲突', () => {
    installOmdKeybindings();
    expect(getKeybindings().getConflicts()).toEqual([]);
  });

  test('确认键没被顺手动过 —— 只覆盖 cancel 一条', () => {
    installOmdKeybindings();
    const kb = getKeybindings();
    expect(kb.matches('\r', 'tui.select.confirm')).toBe(true);
    expect(kb.matches('\x1b[A', 'tui.select.up')).toBe(true);
    expect(kb.matches('\x1b[B', 'tui.select.down')).toBe(true);
  });
});
