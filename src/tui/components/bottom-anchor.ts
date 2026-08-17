/**
 * src/tui/components/bottom-anchor —— **转录贴底**(W3a 契约片 V1)。
 *
 * 内容不足一屏时,空腔在上不在下 —— 对话贴着输入框长(claude code 的形态)。
 * 机制:实测 pi-tui `ScrollView` 无对齐选项(scroll-view.d.ts 全表),所以在**子件侧**
 * 垫顶:渲染行数 < 视口高 → 前面垫空串行。
 *
 * - 内容 ≥ 视口 → **零垫,逐字 = 子件输出**(I3:贴底不改滚动语义,超屏行为与今相同)。
 * - 视口高走注入的 getter:ScrollView 与本件互相引用,惰性解环;首帧视口未知(0)→
 *   零垫,第二帧起就位 —— 一次冷启闪动,可接受。
 * - 垫出来的内容高恰好 = 视口高 ⇒ ScrollView 不出滚动条、follow:'end' 全量可见,稳定不振荡。
 */
import type { Component } from '@earendil-works/pi-tui';

export class BottomAnchor implements Component {
  constructor(
    private readonly child: Component,
    /** 当前视口高。未知时给 0(冷启第一帧)—— 0 与负数都按零垫处理。 */
    private readonly viewportHeight: () => number,
  ) {}

  render(width: number): string[] {
    const lines = this.child.render(width);
    const pad = Math.max(0, this.viewportHeight() - lines.length);
    return pad > 0 ? [...(Array(pad).fill('') as string[]), ...lines] : lines;
  }

  invalidate(): void {
    this.child.invalidate();
  }
}
