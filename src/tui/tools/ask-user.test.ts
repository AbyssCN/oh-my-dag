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
 * - 「档位是 read」→ 把 policy 里那行删掉 → 当场红(未登记 fail-closed 归 write)。
 */
import { describe, expect, test } from 'bun:test';
import type { Component } from '@earendil-works/pi-tui';
import { DEFAULT_APPROVAL_CONFIG, classifyToolCall } from '../approval/policy';
import type { DialogHost } from '../components/dialog';
import { createTheme } from '../theme';
import { ASK_USER_BUSY, ASK_USER_CANCELLED, type AskUserUi, createAskUserTool } from './ask-user';

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
    expect(notices.join('\n')).toContain('你选了: 乙');
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

  test('★ 档位必须是 read —— 否则"想问一句话"要先请人批准', () => {
    const c = classifyToolCall('ask_user', QUESTION, DEFAULT_APPROVAL_CONFIG);
    expect(c.tier).toBe('read');
  });

  test('反测:未登记的工具确实 fail-closed 归 write —— 证明上一条不是白给的', () => {
    // 上一条若换成任何没登记的名字就该是 write。这条钉的是"那张表真的在起作用"。
    expect(classifyToolCall('some_unregistered_tool', {}, DEFAULT_APPROVAL_CONFIG).tier).toBe('write');
  });

  test('schema 要求 2–8 个选项 —— 一个选项的"选择"不是选择', () => {
    const [tool] = createAskUserTool(() => null);
    const schema = (tool as unknown as { parameters: { properties: { options: { minItems: number; maxItems: number } } } }).parameters;
    expect(schema.properties.options.minItems).toBe(2);
    expect(schema.properties.options.maxItems).toBe(8);
  });
});
