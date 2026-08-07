/**
 * L2 判据:组件层(TUI SDD §9 第二层)—— `render(width)` 返回数组,不起终端。
 *
 * 与 L1 分工:L1 证明**算法**对(`fitLine` 怎么截),这里证明**组件真的把 width 传下去了**。
 * 少了这一层,一个 `render() { return [this.text] }` 的实现能让 L1 全绿而屏幕照样超宽。
 */
import { visibleWidth } from '@earendil-works/pi-tui';
import { describe, expect, test } from 'bun:test';
import { StatusLine } from './status-line';

describe('StatusLine', () => {
  // 反向自检 (2026-08-07 实跑): 把 render 改成 `return [this.text]` (不过 fitLine)
  // → 下面「窄屏不超宽」「setText 之后仍受宽度约束」两条当场红。
  test('★ 恒为一行 —— 再长也不折成两行', () => {
    expect(new StatusLine('x'.repeat(500)).render(40)).toHaveLength(1);
  });

  test('★ 窄屏不超宽(组件确实把 width 传给了 fitLine)', () => {
    const line = new StatusLine('omd tui — /home/someone/repos/a-rather-long-project-name');
    for (const w of [10, 40, 100]) {
      expect(visibleWidth(line.render(w)[0] as string)).toBeLessThanOrEqual(w);
    }
  });

  test('★ setText 之后仍受宽度约束(不是只在构造时截一次)', () => {
    const line = new StatusLine('short');
    line.setText('你好世界'.repeat(20));
    expect(visibleWidth(line.render(30)[0] as string)).toBeLessThanOrEqual(30);
  });

  test('放得下时原样出', () => {
    expect(new StatusLine('abc').render(80)).toEqual(['abc']);
  });
});
