/**
 * src/tui/components/hinted-editor.test —— 空态提示符那一行的闸。
 *
 * ## 它守的是什么
 *
 * P3 件6 轮1 的盲比判词:我方首屏「两条完全相同的长分割线中间空无一物」(帧 `01-empty` 行 26/28)。
 * 那三行是空的输入框。这一组钉的就是**那一行不再是空的**,同时钉住
 * **除它以外一个字节都没动**(pi-tui `Editor` 的光标标记 / 反显假光标必须原样保留)。
 *
 * ## 逐条证伪方式(都实跑过)
 *
 * - 「空态出提示」→ 把 `render` 里插提示那一段去掉 → 当场红。
 * - 「有内容不出提示」→ 把 `getText() !== ''` 那道判断删掉 → 当场红。
 * - 「形状不是 3 行就不动」→ 把 `lines.length !== 3` 删掉 → 当场红(多行文本那条)。
 * - 「光标那段字节不被改写 / 总宽不变」→ 把插入改成替换(`lines[1] = hint`)→ 当场红。
 * - 「放不下就不画」→ 把 `used + need > width` 删掉 → 当场红(8 列那条)。
 *
 * ⚠ 第一版这里写的是「提示**追加**在那一行后面」,而那样**一条都不生效** ——
 * 空内容行实际是「反显假光标 + 右填充到满宽」,宽度判断恒真。是这一组闸把它红出来的。
 */
import { describe, expect, test } from 'bun:test';
import { Editor, type EditorTheme, type TUI, visibleWidth } from '@earendil-works/pi-tui';
import { HintedEditor } from './hinted-editor';

const HINT = '问点什么, 或按 / 看命令';
/** pi-tui 的零宽硬件光标标记(`dist/tui.js:21`)—— 断言按字面钉,不 import 私有常量。 */
const CURSOR_MARKER = '\x1b_pi:c\x07';

/**
 * `Editor` 只用到 TUI 的三处:`requestRender` × 5、`terminal.rows` × 2(逐个数过,
 * `ugrep -o 'this\.tui[a-zA-Z.]*' dist/components/editor.js`)。所以桩只给这两样。
 */
function stubTui(rows = 40): TUI {
  return { requestRender: () => {}, terminal: { rows, columns: 120 } } as unknown as TUI;
}
const THEME = { borderColor: (s: string) => s } as unknown as EditorTheme;
const mk = (paint: (s: string) => string = (s) => s): HintedEditor =>
  new HintedEditor(stubTui(), THEME, { hint: HINT, paint });

describe('HintedEditor —— 空输入框里的提示符', () => {
  test('★ 空态:中间那一行不再是空的(它就是 critic 挑出来的那一行)', () => {
    const lines = mk().render(80);
    expect(lines.length).toBe(3);
    // 上下两行仍是满宽横线 —— 提示不许动框。
    expect(lines[0]).toMatch(/^─+$/);
    expect(lines[2]).toMatch(/^─+$/);
    expect(lines[1]).toContain(HINT);
  });

  test('★ 提示插进**右侧填充**里:光标那一段字节一个没改,总宽也没变', () => {
    /**
     * ⚠⚠ **第一版这条闸是空转的(本仓图鉴 S-26)。**
     * 它拿 `Object.getPrototypeOf(Object.getPrototypeOf(this))` 去取"父类实现",而对匿名子类
     * 实例来说那**正好是 `HintedEditor.prototype`** —— 于是"标准答案"里已经带着提示,
     * 把实装改成整行替换之后**照样 6 pass / 0 fail**(实跑过)。
     * ⇒ 改成显式调 pi-tui `Editor.prototype.render`:判据的来源与被测对象**不共用同一个符号**。
     * 同一个注入现在会红(实跑:5 pass / **1 fail**,红的就是这一条)。
     */
    const e = mk();
    const raw = (Editor.prototype.render as (this: Editor, w: number) => string[]).call(e, 80)[1] as string;
    const withHint = e.render(80)[1] as string;
    // ⚠ 判据钉的是**去掉右填充之后的前缀逐字节相同** —— 那一段里装着反显假光标(聚焦时还有零宽标记)。
    const prefix = raw.replace(/ +$/, '');
    expect(withHint.startsWith(prefix)).toBe(true);
    expect(withHint).toContain(HINT);
    // 总可见宽度不变 —— 提示是"占用填充"不是"把行撑长"(撑长了会被 pi-tui 按列切)。
    expect(visibleWidth(withHint)).toBe(visibleWidth(raw));
    // 光标标记在不在取决于聚焦态;在的时候必须仍在**提示之前**。
    if (prefix.includes(CURSOR_MARKER)) expect(withHint.indexOf(CURSOR_MARKER)).toBeLessThan(withHint.indexOf(HINT));
  });

  test('★ 一有内容就不画提示(它是空态提示,不是水印)', () => {
    const e = mk();
    e.setText('hello');
    const lines = e.render(80);
    expect(lines.join('\n')).not.toContain(HINT);
  });

  test('★ 形状不是「上框/一行/下框」就一个字节都不动 —— 多行文本', () => {
    const e = mk();
    e.setText('a\nb\nc');
    const lines = e.render(80);
    expect(lines.length).toBeGreaterThan(3);
    expect(lines.join('\n')).not.toContain(HINT);
  });

  test('★ 放不下就不画(80 列窄终端会撞上;画一半的提示比没有更差)', () => {
    // 宽度只留 8 列 —— 提示 20 列宽, 必须整条不画。
    const lines = mk().render(8);
    expect(lines[1] ?? '').not.toContain(HINT);
    expect(lines.length).toBe(3); // 框还在, 只是没提示
  });

  test('上色走 theme 的 dim(测试里用恒等函数, 生产里是暗色)', () => {
    const painted = new HintedEditor(stubTui(), THEME, { hint: HINT, paint: (s) => `<dim>${s}</dim>` }).render(80);
    expect(painted[1]).toContain(`<dim>${HINT}</dim>`);
  });
});
