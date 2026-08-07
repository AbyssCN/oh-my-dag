/**
 * src/tui/render/highlight —— **代码高亮接线**(TUI SDD §7.5.3,切片 S7)。
 *
 * ## 不写 tokenizer
 *
 * SDD 已裁决:接一个成熟 JS 库,不自己切词。用 `highlight.js`(11.x)——
 * 它给的是**带 class 的 HTML**,所以这里只做两件小事:
 *   ① 把 `<span class="hljs-x">…</span>` 换成主题给的 ANSI;
 *   ② 反转义 `&amp; &lt; &gt; &quot; &#x27;`。
 * 这不是 tokenizer,是一层 40 行的翻译。
 *
 * ## §9.2:样式不跨行
 *
 * TUI 会在**每行行末追加 reset**。所以一段样式若跨行,第二行开头就没有颜色了 ——
 * 屏幕上看到的是"第一行有色、后面全白"。⇒ **逐行独立上色**:先按 `\n` 切开,
 * 每行各自闭合。这也是为什么返回值是 `string[]` 而不是一个大字符串。
 *
 * ## 不认识的语言不是错误
 *
 * `highlight.js` 对未注册语言会抛。代码块标着 `lang=omd-dag` 之类的东西很常见,
 * 那时**原样返回**才对 —— 高亮是锦上添花,为它让整条渲染路径抛异常是本末倒置。
 */
import hljs from 'highlight.js';
import type { OmdTuiTheme } from '../theme';

/** hljs 的 class → 主题里的哪一档。没列到的 class 一律不上色(而不是随便挑一个)。 */
type Styler = (t: string) => string;

function classToStyle(theme: OmdTuiTheme): Record<string, Styler> {
  const { chrome, markdown } = theme;
  return {
    keyword: markdown.bold,
    built_in: chrome.accent,
    type: chrome.accent,
    literal: chrome.accent,
    number: chrome.accent,
    string: chrome.user,
    'meta string': chrome.user,
    regexp: chrome.user,
    comment: chrome.dim,
    doctag: chrome.dim,
    meta: chrome.dim,
    title: chrome.warn,
    'title function_': chrome.warn,
    'title class_': chrome.warn,
    function: chrome.warn,
    attr: chrome.warn,
    property: chrome.warn,
    variable: chrome.warn,
    params: chrome.dim,
    operator: chrome.dim,
    punctuation: chrome.dim,
  };
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#x27;': "'",
  '&#39;': "'",
};

function unescapeHtml(s: string): string {
  return s.replace(/&(?:amp|lt|gt|quot|#x27|#39);/g, (m) => ENTITIES[m] ?? m);
}

/**
 * `<span class="hljs-...">` 的 HTML → ANSI。
 *
 * ⚠ hljs 的 span **可以嵌套**(例如字符串里的转义序列)。这里用一个栈跟踪当前样式,
 * 出栈后**重新应用外层样式** —— 不这么做的话,内层结束时的 reset 会把外层的颜色也关掉,
 * 于是一个字符串从中间开始变白。
 */
function spansToAnsi(html: string, styles: Record<string, Styler>): string {
  const stack: Styler[] = [];
  let out = '';
  let i = 0;
  const OPEN = /^<span class="hljs-([a-z_ -]+)">/;
  while (i < html.length) {
    const rest = html.slice(i);
    const open = OPEN.exec(rest);
    if (open) {
      stack.push(styles[(open[1] as string).replace(/-/g, ' ')] ?? ((t: string) => t));
      i += (open[0] as string).length;
      continue;
    }
    if (rest.startsWith('</span>')) {
      stack.pop();
      i += 7;
      continue;
    }
    const next = html.indexOf('<', i + 1);
    const chunkEnd = next === -1 ? html.length : next;
    const text = unescapeHtml(html.slice(i, chunkEnd));
    // 只应用**栈顶**那一层: 嵌套时内层就是更具体的那个, 外层的语义已经被它覆盖。
    out += stack.length ? (stack.at(-1) as Styler)(text) : text;
    i = chunkEnd;
  }
  return out;
}

/**
 * 造一个能挂进 `MarkdownTheme.highlightCode` 的函数。
 *
 * @returns `(code, lang) => string[]` —— **逐行**,每行样式自闭合(§9.2)。
 */
export function createHighlightCode(theme: OmdTuiTheme): (code: string, lang?: string) => string[] {
  const styles = classToStyle(theme);
  return (code: string, lang?: string): string[] => {
    const lines = code.split('\n');
    if (!lang || !hljs.getLanguage(lang)) return lines; // 不认识的语言原样出, 不抛
    // ⚠ 逐行 highlight 而不是整段一次: 整段高亮出来的 span 会跨行, 而 TUI 每行行末
    // 追加 reset —— 跨行的样式在第二行就没了。逐行的代价是多行字符串/块注释的状态丢失,
    // 那是**可见的小错**;跨行则是"第一行有色后面全白"的大错。取前者。
    return lines.map((line) => {
      try {
        return spansToAnsi(hljs.highlight(line, { language: lang, ignoreIllegals: true }).value, styles);
      } catch {
        return line; // 高亮是锦上添花, 失败绝不阻断这一行的渲染
      }
    });
  };
}
