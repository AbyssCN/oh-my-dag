/**
 * L2 判据:对话框四样(2026-08-07)。
 *
 * 静态体检读数:16 个已装 pi extension 里 **13 个要对话框 UI**,而 omd 一个都没建。
 * 这一片先按 omd 自己的需求建(`/seat` `/session` 用它),扩展宿主将来把 `ctx.ui.*` 映过来。
 *
 * `DialogHost` 走替身 —— 真宿主要 `TuiMainScreen` + 终端,而这里要测的是**交互语义**:
 * Esc 与"选了空值"分不分得开 · 一次只开一个 · 关掉之后 editor 回不回来。
 */
import type { Component } from '@earendil-works/pi-tui';
import { beforeAll, describe, expect, test } from 'bun:test';
import { type DialogBox, type DialogHost, confirm, input, inputComponent, select } from './dialog';
import { createTheme } from '../theme';
import { installOmdKeybindings } from '../keys';

const theme = createTheme({ color: false });

/** 假宿主:记下开了什么、关了几次,并把按键喂给当前焦点。 */
function fakeHost() {
  let current: Component | null = null;
  const log: string[] = [];
  const host: DialogHost = {
    get busy() {
      return current !== null;
    },
    open(component) {
      if (current) return false;
      current = component;
      log.push('open');
      return true;
    },
    close() {
      if (!current) return;
      current = null;
      log.push('close');
    },
    requestRender() {},
  };
  const key = (data: string): void => {
    (current as unknown as { handleInput?: (d: string) => void })?.handleInput?.(data);
  };
  return { host, key, log, render: (w = 60) => (current?.render(w) ?? []).join('\n'), get open() { return current !== null; } };
}

const OPTIONS = [
  { value: 'a', label: '第一个', description: '说明 A' },
  { value: 'b', label: '第二个' },
];

describe('select', () => {
  test('Enter 选中当前项', async () => {
    const h = fakeHost();
    const p = select(h.host, theme, { title: '挑一个', options: OPTIONS });
    h.key('\r');
    expect(await p).toBe('a');
    expect(h.log).toEqual(['open', 'close']);
  });

  test('★ Esc 返回 null —— 与"选了一个空值"分得开', async () => {
    const h = fakeHost();
    const p = select(h.host, theme, { title: '挑一个', options: OPTIONS });
    h.key('\x1b');
    expect(await p).toBeNull();
    expect(h.open).toBe(false);
  });

  test('★ 没有可选项时**不开框** —— 开一个空框让人按 Esc 是耍人', async () => {
    const h = fakeHost();
    expect(await select(h.host, theme, { title: 'x', options: [] })).toBeNull();
    expect(h.log).toEqual([]);
  });

  test('★ 已经有框开着 → 第二个直接返回 null, 不叠加', async () => {
    const h = fakeHost();
    const first = select(h.host, theme, { title: '第一个', options: OPTIONS });
    expect(await select(h.host, theme, { title: '第二个', options: OPTIONS })).toBeNull();
    h.key('\x1b');
    await first;
  });

  test('标题写清怎么操作(否则用户不知道能 Esc)', () => {
    const h = fakeHost();
    void select(h.host, theme, { title: '挑一个', options: OPTIONS });
    const out = h.render();
    expect(out).toContain('挑一个');
    expect(out).toContain('Esc 取消');
  });

  test('方向键交给 SelectList,不当成取消', async () => {
    const h = fakeHost();
    const p = select(h.host, theme, { title: 'x', options: OPTIONS });
    h.key('\x1b[B'); // ↓
    h.key('\r');
    expect(await p).toBe('b');
  });
});

describe('confirm', () => {
  test('是 / 否', async () => {
    const h1 = fakeHost();
    const p1 = confirm(h1.host, theme, '要不要?');
    h1.key('\r');
    expect(await p1).toBe(true);

    const h2 = fakeHost();
    const p2 = confirm(h2.host, theme, '要不要?');
    h2.key('\x1b[B');
    h2.key('\r');
    expect(await p2).toBe(false);
  });

  test('★ Esc 是 null 不是 false —— 取消与拒绝是两回事', async () => {
    const h = fakeHost();
    const p = confirm(h.host, theme, '要不要?');
    h.key('\x1b');
    expect(await p).toBeNull();
  });
});

describe('input', () => {
  test('打字 + Enter', async () => {
    const h = fakeHost();
    const p = input(h.host, theme, { title: '输入' });
    for (const c of 'hej') h.key(c);
    h.key('\r');
    expect(await p).toBe('hej');
  });

  test('★ Esc 返回 null;空串是**合法输入**不折算成 null', async () => {
    const h1 = fakeHost();
    const p1 = input(h1.host, theme, { title: 'x' });
    h1.key('\x1b');
    expect(await p1).toBeNull();

    const h2 = fakeHost();
    const p2 = input(h2.host, theme, { title: 'x' });
    h2.key('\r');
    expect(await p2).toBe('');
  });

  test('退格', async () => {
    const h = fakeHost();
    const p = input(h.host, theme, { title: 'x', initial: 'abc' });
    h.key('\x7f');
    h.key('\r');
    expect(await p).toBe('ab');
  });

  test('★ 方向键不许画出 `[A` 那种假回显', async () => {
    const h = fakeHost();
    const p = input(h.host, theme, { title: 'x' });
    h.key('\x1b[A');
    h.key('\r');
    expect(await p).toBe('');
  });

  test('initial 预填', async () => {
    const h = fakeHost();
    const p = input(h.host, theme, { title: 'x', initial: '预填' });
    h.key('\r');
    expect(await p).toBe('预填');
  });
});

describe('★ 输入框换成 pi-tui `Input`(2026-08-08,还台账最大的那笔欠账)', () => {
  /**
   * 每条钉的都是**手搓那版根本做不到**的事 —— 所以这一组的证伪方式统一是:
   * 把 `inputComponent` 的非遮蔽分支改回手搓的 buf 版 → **前四条全红**。
   * (遮蔽那条相反:它钉的是"这一档**仍然**是手搓的",改成走 `Input` 会红。)
   */
  const THEME = createTheme({ color: false });
  const drive = (opts: { initial?: string; mask?: boolean }, keys: string[]): { value: string | null; box: DialogBox } => {
    let value: string | null = null;
    let settled = false;
    const box = inputComponent(THEME, { title: 't', ...opts }, (v) => {
      value = v;
      settled = true;
    }, () => {});
    for (const k of keys) {
      if (settled) break;
      box.handleInput(k);
    }
    return { value, box };
  };
  const shown = (box: DialogBox): string => box.render(60).join('\n').replace(/\x1b\[[0-9;]*m/g, '');

  test('★ 光标能往回移, 在中间插字(手搓版做不到 —— 它只能往后加)', () => {
    // 打 abc → ← ← → 在 a 与 b 之间插 X → 期望 aXbc
    const { value } = drive({}, ['a', 'b', 'c', '\x1b[D', '\x1b[D', 'X', '\r']);
    expect(value).toBe('aXbc');
  });

  test('★ 按词删除(ctrl+w)—— 手搓版只有退一格', () => {
    const { value } = drive({}, ['h', 'e', 'j', ' ', 'd', 'u', '\x17', '\r']);
    expect(value).toBe('hej ');
  });

  test('★ undo(ctrl+-)撤掉刚打的', () => {
    const { value } = drive({}, ['a', 'b', 'c', '\x1f', '\r']);
    // 撤掉之后不该还是 abc —— 具体撤到哪由 Input 的 undo 栈定, 这里只钉"它真的变了"。
    expect(value).not.toBe('abc');
  });

  test('Esc 仍然返回 null(与"输入了空串"分得开)', () => {
    const { value } = drive({}, ['a', '\x1b']);
    expect(value).toBeNull();
  });

  test('initial 会被带进去, 直接回车原样返回', () => {
    expect(drive({ initial: '900' }, ['\r']).value).toBe('900');
  });

  test('★ 遮蔽档**仍然是手搓的**, 且真的打星(`Input` 不支持遮蔽, 已核实)', () => {
    const { box } = drive({ mask: true }, ['s', 'k', '-', 'x']);
    const out = shown(box);
    expect(out).toContain('****');
    expect(out).not.toContain('sk-x'); // ★ 一个字符都不许上屏
  });
});

describe('★ 取消/确认键走 pi-tui 键位表(2026-08-08,还台账最后一笔欠账)', () => {
  /**
   * 判据钉的是**三种编码全认** —— 而这正是换之前做不到的:
   * 手列的 `Set` 认 `\x1b` 与 `\x1b\x1b`,**不认 kitty 的 `\x1b[27u`**(多字节序列, 集合收不齐)。
   *
   * **证伪方式**:把 `isCancel` 改回 `new Set(['\x1b','\x1b\x1b']).has` → kitty 那条当场红。
   * ⚠ 双 ESC 那条能绿, 靠的是 `installOmdKeybindings()` 把 `ctrl+alt+[` 加进了
   * `tui.select.cancel`(`keys.ts`)—— 所以这里**必须先装**, 否则是在量别的东西。
   */
  beforeAll(() => installOmdKeybindings());

  const cancelWith = async (key: string): Promise<string | null> => {
    const h = fakeHost();
    const p = select(h.host, theme, { title: 'x', options: [{ value: 'a', label: 'A' }] });
    h.key(key);
    return p;
  };

  test('裸 ESC 关得掉', async () => {
    expect(await cancelWith('\x1b')).toBeNull();
  });

  test('★ 双 ESC 关得掉(pi-tui 默认表不认它 —— 靠 keys.ts 补的)', async () => {
    expect(await cancelWith('\x1b\x1b')).toBeNull();
  });

  test('★ kitty 协议的 ESC 关得掉(手列 Set **收不齐**的那一种)', async () => {
    expect(await cancelWith('\x1b[27u')).toBeNull();
  });

  test('确认键:回车与换行都认', async () => {
    for (const k of ['\r', '\n']) {
      const h = fakeHost();
      const p = select(h.host, theme, { title: 'x', options: [{ value: 'a', label: 'A' }] });
      h.key(k);
      expect(await p).toBe('a');
    }
  });
});
