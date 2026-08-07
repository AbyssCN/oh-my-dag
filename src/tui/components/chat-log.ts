/**
 * src/tui/components/chat-log —— **对话记录**(TUI SDD 切片 S8)。
 *
 * ## 三种条目,三种画法,理由不同
 *
 * - `user` —— 用户打的原文。**不当 markdown 渲染**:用户打的 `*` `#` 是他打的字符,
 *   不是排版指令,渲染掉等于篡改回显。
 * - `assistant` —— 走 pi-tui 的 `Markdown`(内部 `marked`)。代码高亮是 S7 从 theme 挂进来的,
 *   这里不认识 highlight 这回事。
 * - `notice` —— 引擎/后端说的话(含**断链说明卡**:后端拒绝时的原因句)。
 *   刻意与 assistant 分开:一句"引擎没接通"被画成助手发言,读起来就像模型在回答。
 *
 * ## 流式:一条消息,不是一堆消息
 *
 * `appendAssistantChunk` 往**同一条**消息里追加。写成"每个 chunk 一条消息"会让
 * 64 个 token 变成 64 条记录 —— 屏幕上看着像在动,其实是错的。判据就是
 * "整段文本恰好出现一次"(`chat-log.test.ts`)。
 */
import { type Component, Markdown, Text } from '@earendil-works/pi-tui';
import type { OmdTuiTheme } from '../theme';

export type ChatRole = 'user' | 'assistant' | 'notice';

interface Entry {
  role: ChatRole;
  /** assistant 用 Markdown,其余用 Text —— 两者都实现 `Component`。 */
  component: Component;
  /** 流式累积缓冲;只有 assistant 用得上。 */
  buffer: string;
  /** 还在流式追加中?**收尾之后不许再往里追加**,否则两轮回复会粘成一条。 */
  open: boolean;
}

/** 前缀一律纯 ASCII —— S6 的白名单里 `>` `!` 都在,箭头/圆点那些全在「待真终端」档。 */
const PREFIX: Record<ChatRole, string> = { user: '> ', assistant: '', notice: '! ' };

export class ChatLog implements Component {
  private entries: Entry[] = [];

  constructor(private theme: OmdTuiTheme) {}

  /** @returns 条目数 —— 测试用它区分"追加进同一条"与"新开一条"。 */
  get length(): number {
    return this.entries.length;
  }

  /** 最后一条的完整文本(测试与流式收尾用)。没有条目时返回 `null`,不是空串。 */
  get lastText(): string | null {
    return this.entries.at(-1)?.buffer ?? null;
  }

  appendUser(text: string): void {
    this.closeStreaming();
    this.entries.push({
      role: 'user',
      component: new Text(this.theme.chrome.user(PREFIX.user + text)),
      buffer: text,
      open: false,
    });
  }

  /**
   * 后端/引擎说的话。`reason` 那一类(断链说明卡)走这里。
   */
  appendNotice(text: string): void {
    this.closeStreaming();
    this.entries.push({
      role: 'notice',
      component: new Text(this.theme.chrome.warn(PREFIX.notice + text)),
      buffer: text,
      open: false,
    });
  }

  /**
   * 流式追加。第一个 chunk 开一条新消息,后续 chunk 进**同一条**。
   *
   * ⚠ 追加之后必须由调用方 `tui.requestRender()` —— 组件改了内容**不会自己重绘**
   * (实读 `components/text.js:20-25`;S2 的 PTY lane 第一次跑就死在这条上)。
   */
  appendAssistantChunk(chunk: string): void {
    const last = this.entries.at(-1);
    if (last?.role === 'assistant' && last.open) {
      last.buffer += chunk;
      (last.component as Markdown).setText(last.buffer);
      return;
    }
    this.entries.push({
      role: 'assistant',
      component: new Markdown(chunk, 0, 0, this.theme.markdown),
      buffer: chunk,
      open: true,
    });
  }

  /** 收尾当前流式消息。**幂等** —— 没有开着的消息时什么都不做。 */
  closeStreaming(): void {
    const last = this.entries.at(-1);
    if (last?.open) last.open = false;
  }

  render(width: number): string[] {
    // 条目之间空一行:没有分隔的话两条消息读起来是一段。首条前面不空。
    return this.entries.flatMap((e, i) => (i === 0 ? e.component.render(width) : ['', ...e.component.render(width)]));
  }

  invalidate(): void {
    for (const e of this.entries) e.component.invalidate();
  }
}
