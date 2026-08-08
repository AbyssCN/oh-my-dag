/**
 * `HintedEditor` —— 空态在输入框里画一句提示符。
 *
 * ## 为什么加它(不是我想加的,是 gauntlet critic 的判词逼出来的)
 *
 * P3 件6 第 1 轮盲比(`docs/bars/gauntlet-p3-账本.md`):**全新上下文**的 critic 在
 * 不知道哪张帧是谁的情况下,给我方那一帧的缺口是
 * 「底部状态栏前出现了 2 个连续且完全相同的长分割线,产生冗余视觉干扰」。
 *
 * **核过帧,它说的是真的**:`01-empty` 的行 26/28 是两条满宽 `─`,中间行 27
 * **一个字都没有**(`04-narrow-80` 是行 18/20,同一形状)。那三行就是**空的输入框** ——
 * pi-tui `Editor.render()` 画「上框 / 内容 / 下框」,内容为空时中间那行就是空白,
 * 于是屏上读起来是"两条一样的线中间空无一物"。
 *
 * 这一格 G-6 rubric 早给过 1 分(`docs/bars/g6-视觉打分.md` V2:「空态看不到提示符」),
 * 当时判为**不追**,理由是"拿满要包一层猜 pi-tui 的输出结构"。**这一轮改判的依据是新的**:
 * 一个外部盲评把它挑成我方最大的缺口 ⇒ 它不只是一个纯观感分。
 *
 * ## 它是薄封装,不是第二套 Editor(台账 §5 的三问)
 *
 * 1. **pi-tui 有没有?** —— **没有**:`placeholder` 在 `dist/components/editor.js` 里 **0 命中**,
 *    `EditorOptions` 只有 `paddingX` / `autocompleteMaxVisible`(`editor.d.ts:29-32`)。
 * 2. **只动一行,而且形状不认识就一个字节都不动**:仅当 `getText() === ''`
 *    **且** `render()` 恰好回 3 行(上框/一行内容/下框)时,把提示**追加在中间那行后面**。
 *    行数不是 3(补全弹窗开着 / 滚动指示器 / 多行文本)⇒ 原样返回。
 * 3. **追加而不是替换** —— 中间那行在聚焦时带 `CURSOR_MARKER`(`\x1b_pi:c\x07`,零宽)
 *    与反显的假光标(`editor.js:429-437`)。**替换会把硬件光标定位吃掉**(IME 候选窗会跑位),
 *    所以这里只在它后面接字符,原有字节一个不改。
 *
 * ## 会红的闸在 `hinted-editor.test.ts`
 *
 * 空态出提示 · 有内容不出 · 四行(补全开着)不动 · 原字节不被改写 · 超宽不画。
 * **证伪方式写在每条断言旁**。
 */
import { Editor, type EditorTheme, type TUI, visibleWidth } from '@earendil-works/pi-tui';

/** 提示文案 —— 走 `CHROME` 过字形闸(`render/glyphs.test.ts` 只扫那一个对象)。 */
export interface HintedEditorDeps {
  /** 空态提示的文本(不含颜色)。 */
  hint: string;
  /** 上色函数(dim);测试里传恒等函数以便逐字节比对。 */
  paint: (s: string) => string;
}

export class HintedEditor extends Editor {
  constructor(
    tui: TUI,
    theme: EditorTheme,
    private readonly deps: HintedEditorDeps,
  ) {
    super(tui, theme);
  }

  override render(width: number): string[] {
    const lines = super.render(width);
    // 有内容 → 提示是多余的;形状不认识 → 不猜(这两条各有一条闸)。
    if (this.getText() !== '' || lines.length !== 3) return lines;
    const mid = lines[1];
    if (mid === undefined) return lines;
    /**
     * ⚠ **那一行不是"空的",它是「反显假光标 + 右填充到满宽」**(实测:`\x1b[7m \x1b[0m` + 79 个空格)。
     * 所以第一版写的 `mid + hint` **一条都没生效** —— 宽度判断 `visibleWidth(mid)+…>width` 恒真。
     * 正确做法是把提示**插进右侧填充里**,总可见宽度保持不变。
     */
    const trimmed = mid.replace(/ +$/, '');
    const used = visibleWidth(trimmed);
    const hint = this.deps.hint;
    const need = visibleWidth(hint) + 1; // 提示前留一个空格
    // 放不下就整条不画 —— 画一半的提示比没有提示更差(80 列窄终端会撞上)。
    if (used + need > width) return lines;
    const pad = ' '.repeat(width - used - need);
    return [lines[0] as string, `${trimmed} ${this.deps.paint(hint)}${pad}`, lines[2] as string];
  }
}
