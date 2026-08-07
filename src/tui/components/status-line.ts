/**
 * src/tui/components/status-line —— **一行状态行组件**(TUI SDD §9 第二层,切片 S5)。
 *
 * pi 的 `Text` 会折行,状态行不能折(理由见 `render/line.ts` 文件头)。这个组件薄到
 * 只剩一层:把 `render(width)` 接到 {@link fitLine} 上。**逻辑全在纯函数里**,
 * 于是 L1 测算法、L2 测"组件确实按 width 渲染",两层各测各的,不互相顶替。
 */
import type { Component } from '@earendil-works/pi-tui';
import { fitLine } from '../render/line';

export class StatusLine implements Component {
  constructor(private text: string) {}

  setText(text: string): void {
    this.text = text;
  }

  render(width: number): string[] {
    return [fitLine(this.text, width)];
  }

  /** 无缓存可清 —— 每次 render 都是纯计算。 */
  invalidate(): void {}
}
