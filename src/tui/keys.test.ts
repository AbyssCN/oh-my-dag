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
import type { KeybindingsConfig } from '@earendil-works/pi-tui';
import { describe, expect, test } from 'bun:test';
import { getKeybindings } from '@earendil-works/pi-tui';
import { SELECT_CANCEL_KEYS, findKeyClashes, formatKeyClashes, installOmdKeybindings, loadUserKeybindings } from './keys';
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

  /**
   * ★ **`omd.palette` 抢的是 pi 的 `tui.editor.deleteToLineEnd`**(2026-08-22)。
   *
   * 这条闸看的不是"能不能匹配"(上面那条已经看了), 是**这次抢占仍然成立**:
   * omd 五键由 input listener 在焦点分派**之前** `consume`, 所以 `ctrl+k` 装上之后
   * 编辑器里的「删到行尾」是**静默**没的。而 `findKeyClashes` 抓不到它(两条都是默认值,
   * 判据要求"至少一条是用户改的")⇒ 除了这条闸和 keys.ts 的注释, 它没有别的痕迹。
   *
   * 上游哪天把 `ctrl+k` 挪走, 这条会红 —— 那时该做的是回去把 keys.ts 那段取舍注释删掉。
   * 证伪:把 `omd.palette` 的 defaultKeys 改成 `ctrl+e` → 第二个断言当场红。
   */
  test('★ omd.palette 的 ctrl+k 是从 tui.editor.deleteToLineEnd 手里抢的(记录, 不是意外)', () => {
    const kb = installOmdKeybindings();
    expect(kb.matches('\x0b', 'omd.palette')).toBe(true); // \x0b = ctrl+k
    expect(kb.getKeys('tui.editor.deleteToLineEnd')).toEqual(['ctrl+k']);
    // 还得回去 —— 这就是取舍能被接受的前提。
    const re = installOmdKeybindings({ 'omd.palette': 'ctrl+e' });
    expect(re.matches('\x0b', 'omd.palette')).toBe(false);
    installOmdKeybindings(); // 收尾复位全局, 不污染别的测试
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

/**
 * ★ 生效后的键位冲突(2026-08-21)。
 *
 * ## 它要杀死的失效形态
 *
 * 用户在 `.omd/keybindings.json` 里把某条绑到**已被占用**的键上,得到的是
 * 「一条无声死掉」——零提示,而 `loadUserKeybindings` 的 diagnostic 通道一直空着。
 *
 * ## 为什么不用 pi 的 `getConflicts()`
 *
 * 它**只比用户绑定之间**(`dist/keybindings.js:137-151` 的 `userClaims`),
 * **不拿用户绑定去比默认绑定**。而真实场景恰恰是后者。本组第一条就把这件事钉住:
 * 同一份配置下 `getConflicts()` 返回空,而 `findKeyClashes` 必须报出来。
 *
 * 证伪方式:把 `findKeyClashes` 里 `ids.some((id) => id in user)` 那行删掉 →
 * 「默认态零噪音」当场红(会报出 9 条天然重复)。
 */
describe('★ findKeyClashes —— 生效后的冲突, 不是 pi 的 getConflicts', () => {
  test('★ 默认态零噪音 —— 9 处天然重复(跨上下文)不许报', () => {
    const kb = installOmdKeybindings({});
    // 天然重复确实存在(up / ctrl+c / escape …), 但它们是设计不是冲突。
    const resolved = kb.getResolvedBindings();
    expect(Object.keys(resolved).length).toBeGreaterThan(30);
    expect(findKeyClashes(kb, {})).toEqual([]);
    expect(formatKeyClashes([])).toBeNull();
  });

  test('★ 绑到「默认键」上 —— pi 的 getConflicts 看不见, 这条必须看得见', () => {
    const user: KeybindingsConfig = { 'omd.dagFull': 'ctrl+o' }; // ctrl+o 是 omd.thinkingToggle 的默认键
    const kb = installOmdKeybindings(user);
    expect(kb.getConflicts()).toEqual([]); // ← pi 的判据在这里是瞎的
    const clashes = findKeyClashes(kb, user);
    expect(clashes).toHaveLength(1);
    expect(clashes[0]!.key).toBe('ctrl+o');
    expect(clashes[0]!.ids.sort()).toEqual(['omd.dagFull', 'omd.thinkingToggle']);
  });

  test('两条用户绑定互撞也报(pi 那条能看见的, 这条也得看见)', () => {
    // ⚠ 键要挑**真空闲**的。第一版用了 ctrl+y —— 它是 tui.editor.yank, 于是多出一条
    //   本该报的冲突, 是测试数据错不是代码错(而我当时是「假设它空」没去查)。
    const user: KeybindingsConfig = { 'omd.dagFull': 'ctrl+q', 'omd.pathFull': 'ctrl+q' };
    const kb = installOmdKeybindings(user);
    const clashes = findKeyClashes(kb, user);
    expect(clashes).toHaveLength(1);
    expect(clashes[0]!.ids.sort()).toEqual(['omd.dagFull', 'omd.pathFull']);
  });

  test('挪到没人占的键上 → 不报(不许把「改了键位」本身当冲突)', () => {
    const user: KeybindingsConfig = { 'omd.dagFull': 'f5' }; // f5 实测空闲
    expect(findKeyClashes(installOmdKeybindings(user), user)).toEqual([]);
  });

  test('文案点名键与全部抢占者, 并给出下一步', () => {
    const out = formatKeyClashes([{ key: 'ctrl+o', ids: ['omd.thinkingToggle', 'omd.dagFull'] }])!;
    expect(out).toContain('ctrl+o');
    expect(out).toContain('omd.thinkingToggle / omd.dagFull');
    expect(out).toContain('只有一条会生效');
  });
});
