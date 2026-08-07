/**
 * src/tui/theme —— **主题面**(TUI SDD §7.5.4,切片 S8 起用;S18 换成 Catppuccin Mocha 的逐值)。
 *
 * ## 这一片只定形状,不定颜色
 *
 * SDD §7.5.4 的分界线:**内嵌**的是 theme **契约**(那组 `(text) => string` 的形状),
 * **配置**的才是具体 hex。所以这里给的是一组能跑的默认值,S18 把值换掉即可,
 * 组件一行都不用动。
 *
 * ## NO_COLOR 不是可选项
 *
 * 判据(§7.5.4):"换个人来用,这个会不会崩 / 难看?" —— 管道里、CI 里、
 * `NO_COLOR=1` 的终端里,ANSI 序列会变成一堆可见垃圾字符。所以关色是**恒等函数**,
 * 不是"换一组浅色"。
 *
 * ⚠ 关色之后 `visibleWidth` 读数不变(ANSI 本来就不计宽),所以宽度闸两种模式同一个结论。
 */
import type { EditorTheme, MarkdownTheme } from '@earendil-works/pi-tui';
import { createHighlightCode } from './render/highlight';

/** `NO_COLOR` 约定:**只要这个变量存在**(哪怕是空串)就关色。 */
export function colorEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NO_COLOR === undefined;
}

const identity = (t: string) => t;

/** SGR 包一层。收尾一律 `\x1b[0m` —— §9.2:行末会被 TUI 追加 reset,**样式不许跨行**。 */
function sgr(code: string): (t: string) => string {
  return (t: string) => `\x1b[${code}m${t}\x1b[0m`;
}

export interface OmdTuiTheme {
  markdown: MarkdownTheme;
  editor: EditorTheme;
  /** chrome 用的几档语义色。组件只认这几个名字,不认具体 SGR 码。 */
  chrome: {
    dim: (t: string) => string;
    accent: (t: string) => string;
    warn: (t: string) => string;
    user: (t: string) => string;
  };
}

export function createTheme(opts: { color?: boolean } = {}): OmdTuiTheme {
  const on = opts.color ?? colorEnabled();
  const c = (code: string) => (on ? sgr(code) : identity);
  const dim = c('2');
  const accent = c('36'); // cyan
  const warn = c('33'); // yellow
  const user = c('32'); // green

  const theme: OmdTuiTheme = {
    markdown: {
      heading: c('1;36'),
      link: c('4;36'),
      linkUrl: dim,
      code: c('33'),
      codeBlock: identity, // 代码块正文交给 highlightCode (S7);这里不再叠一层底色
      codeBlockBorder: dim,
      quote: dim,
      quoteBorder: dim,
      hr: dim,
      listBullet: accent,
      bold: c('1'),
      italic: c('3'),
      strikethrough: c('9'),
      underline: c('4'),
    },
    editor: {
      borderColor: dim,
      selectList: {
        selectedPrefix: accent,
        selectedText: c('1'),
        description: dim,
        scrollInfo: dim,
        noMatch: dim,
      },
    },
    chrome: { dim, accent, warn, user },
  };
  // S7: 代码高亮挂在 theme 上 —— 组件不认识 highlight 这回事, 换主题即换高亮配色。
  // 后挂是因为 highlightCode 要拿到 chrome 那几档语义色, 而它们就在这个对象里。
  theme.markdown.highlightCode = createHighlightCode(theme);
  return theme;
}
