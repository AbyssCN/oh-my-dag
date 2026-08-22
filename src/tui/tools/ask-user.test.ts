/**
 * src/tui/tools/ask-user.test —— `ask_user` 的闸。
 *
 * ## 这一族真正会咬人的不是"能不能问出来",是**答不上来的时候回什么**
 *
 * 三种"没答案"必须**分得开**且**都不抛**:框被占 · 用户按 Esc · UI 还没建好。
 * 抛了的话模型会认为工具坏了然后**重试**,而重试会**再弹一次框** —— 用户会看到
 * 同一个问题连弹两遍。所以每一条都断言"回了话且没抛"。
 *
 * 逐条证伪方式:
 * - 「框被占时不开框」→ 把 `busy` 判断删掉 → 当场红(它会真去 open)。
 * - 「Esc 是答案不是错误」→ 把 `null` 分支改成 `throw` → 当场红。
 */
import { describe, expect, test } from 'bun:test';
import type { Component } from '@earendil-works/pi-tui';
import type { DialogHost } from '../components/dialog';
import { createTheme } from '../theme';
import { ASK_USER_BUSY, ASK_USER_CANCELLED, ASK_USER_DISCUSS, type AskUserUi, createAskUserTool } from './ask-user';

const THEME = createTheme({ color: false });

/** 假宿主:记下开没开框, 并允许外部替它按键。 */
function fakeHost(opts: { busy?: boolean } = {}): DialogHost & { opened: Component | null; press: (d: string) => void } {
  let opened: Component | null = null;
  const h = {
    get busy() {
      return opts.busy ?? opened !== null;
    },
    open(component: Component) {
      if (opts.busy) return false;
      opened = component;
      return true;
    },
    close() {
      opened = null;
    },
    requestRender() {},
    get opened() {
      return opened;
    },
    press(d: string) {
      (opened as { handleInput?: (s: string) => void } | null)?.handleInput?.(d);
    },
  };
  return h as unknown as DialogHost & { opened: Component | null; press: (d: string) => void };
}

function mk(ui: AskUserUi | null): { run: (p: unknown) => Promise<{ content: { text?: string }[]; details?: unknown }> } {
  const [tool] = createAskUserTool(() => ui);
  return { run: (p) => (tool as { execute: (i: string, p: unknown) => Promise<{ content: { text?: string }[]; details?: unknown }> }).execute('c1', p) };
}
const text = (r: { content: { text?: string }[] }): string => r.content.map((c) => c.text ?? '').join('');
const QUESTION = { question: '选哪个?', options: [{ label: '甲' }, { label: '乙', description: '第二个' }] };

describe('ask_user', () => {
  test('★ 正常问答:开出框, 选中回给模型, 并在记录里留痕', async () => {
    const host = fakeHost();
    const notices: string[] = [];
    const p = mk({ host, theme: THEME, appendNotice: (t) => notices.push(t) }).run(QUESTION);
    await Bun.sleep(0);
    expect(host.opened).not.toBeNull(); // 框真开了
    host.press('\x1b[B'); // ↓ 到「乙」
    host.press('\r');
    const r = await p;
    expect(text(r)).toContain('乙');
    expect(r.details).toMatchObject({ answered: true, index: 1, label: '乙' });
    // 留痕:问了什么 + 选了什么, 框关掉之后还回看得到
    expect(notices.join('\n')).toContain('选哪个?');
    expect(notices.join('\n')).toContain('you chose: 乙');
  });

  test('★ Esc 是**答案**不是错误 —— 回话且不抛', async () => {
    const host = fakeHost();
    const p = mk({ host, theme: THEME, appendNotice: () => {} }).run(QUESTION);
    await Bun.sleep(0);
    host.press('\x1b');
    const r = await p;
    expect(text(r)).toBe(ASK_USER_CANCELLED);
    expect(r.details).toMatchObject({ answered: false, reason: 'cancelled' });
  });

  test('★ 框被占:**不开第二个框**, 按"问不出来"回', async () => {
    const host = fakeHost({ busy: true });
    const r = await mk({ host, theme: THEME, appendNotice: () => {} }).run(QUESTION);
    expect(text(r)).toBe(ASK_USER_BUSY);
    expect(host.opened).toBeNull(); // ← 一个框都没开
  });

  test('★ UI 还没建好(装配环那一刻):同样回话不抛', async () => {
    const r = await mk(null).run(QUESTION);
    expect(text(r)).toBe(ASK_USER_BUSY);
  });


  /**
   * ★★ **owner 裁决 R5**(plan §1):「问答弹窗要有 "Chat about this" 选项」。
   *
   * 这一组钉的**不是"有这一项"**, 而是**它与 Esc 分得开** —— 那才是这条裁决的价值:
   * Esc =「你自己拿主意」;先聊聊 =「别拿主意, 先把取舍讲清楚」。
   * 抹成同一个回值就等于告诉模型"随便挑一个吧"。
   *
   * **证伪方式**:让 DISCUSS 分支返回 `ASK_USER_CANCELLED` → 第二条当场红。
   */
  test('★ R5:选项表末尾恒有「先聊聊这个」, 且不由模型决定给不给', async () => {
    const host = fakeHost();
    const p = mk({ host, theme: THEME, appendNotice: () => {} }).run(QUESTION);
    await Bun.sleep(0);
    const shownText = (host.opened as { render: (w: number) => string[] }).render(70).join('\n');
    expect(shownText).toContain('talk it through first');
    host.press('\x1b');
    await p;
  });

  test('★★ R5:「先聊聊」与 Esc **回的不是同一句话**', async () => {
    const host = fakeHost();
    const p = mk({ host, theme: THEME, appendNotice: () => {} }).run(QUESTION);
    await Bun.sleep(0);
    // 两个真选项 + 「先聊聊」= 第 3 项;↓↓ 到它
    host.press('\x1b[B');
    host.press('\x1b[B');
    host.press('\r');
    const r = await p;
    expect(text(r)).toBe(ASK_USER_DISCUSS);
    expect(text(r)).not.toBe(ASK_USER_CANCELLED); // ★ 分得开
    expect(r.details).toMatchObject({ answered: false, reason: 'discuss' });
    // 措辞要让模型看得懂"别按默认继续"
    expect(text(r)).toContain('Do not default');
  });

  test('schema 要求 2–8 个选项 —— 一个选项的"选择"不是选择', () => {
    const [tool] = createAskUserTool(() => null);
    const schema = (tool as unknown as { parameters: { properties: { options: { minItems: number; maxItems: number } } } }).parameters;
    expect(schema.properties.options.minItems).toBe(2);
    expect(schema.properties.options.maxItems).toBe(8);
  });
});
