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
import { SELECT_CANCEL_KEYS, installOmdKeybindings, loadUserKeybindings } from './keys';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

describe('★ W4③ 键位文件 + omd 五键', () => {
  // 反向自检 (实跑): installOmdKeybindings 里 user 展开挪到 select.cancel 之前 → 「用户能覆盖」当场红;
  //   OMD_KEYBINDINGS 从并集里去掉 → 「五键默认在」当场红。
  test('★ 五键默认可匹配原字节; 用户文件能改默认', () => {
    const kb = installOmdKeybindings();
    expect(kb.matches('\x03', 'omd.quit')).toBe(true);
    expect(kb.matches('\x1b', 'omd.interrupt')).toBe(true);
    expect(kb.matches('\x0f', 'omd.thinkingToggle')).toBe(true);
    expect(kb.matches('\x10', 'omd.pathFull')).toBe(true);
    expect(kb.matches('\x07', 'omd.dagFull')).toBe(true);
    const re = installOmdKeybindings({ 'omd.thinkingToggle': 'ctrl+t' });
    expect(re.matches('\x14', 'omd.thinkingToggle')).toBe(true); // ctrl+t
    expect(re.matches('\x0f', 'omd.thinkingToggle')).toBe(false); // 旧键让位
  });

  test('用户文件能覆盖内置 select.cancel 补丁 (用户在后, 说的算)', () => {
    const kb = installOmdKeybindings({ 'tui.select.cancel': ['escape'] });
    expect(kb.getKeys('tui.select.cancel')).toEqual(['escape']);
    installOmdKeybindings(); // 收尾复位全局, 不污染别的测试
  });

  test('loadUserKeybindings: 缺席空表; 坏 JSON fail-open 且证据带回', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omd-kb-'));
    expect(loadUserKeybindings(dir)).toEqual({ config: {}, diagnostic: null });
    mkdirSync(join(dir, '.omd'), { recursive: true });
    writeFileSync(join(dir, '.omd', 'keybindings.json'), '{bad');
    const r = loadUserKeybindings(dir);
    expect(r.config).toEqual({});
    expect(r.diagnostic).toContain('keybindings.json');
  });
});
