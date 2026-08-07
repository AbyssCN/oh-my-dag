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
import { describe, expect, test } from 'bun:test';
import { type DialogHost, confirm, input, select } from './dialog';
import { createTheme } from '../theme';

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
