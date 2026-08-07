/**
 * L1 判据:代码高亮(TUI SDD §7.5.3 + §9.2,切片 S7)。
 *
 * 三条钉的都是**会静默出错**的地方:
 *  ① 高亮之后每行仍 ≤ width(ANSI 不计宽,算错了就超宽);
 *  ② **样式不跨行** —— TUI 每行行末追加 reset,跨行的样式在第二行就没了;
 *  ③ 不认识的语言原样返回,不抛。
 */
import { visibleWidth } from '@earendil-works/pi-tui';
import { describe, expect, test } from 'bun:test';
import { createTheme } from '../theme';
import { createHighlightCode } from './highlight';

const hl = createHighlightCode(createTheme({ color: true }));
const plain = createHighlightCode(createTheme({ color: false }));
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

describe('createHighlightCode', () => {
  // 反向自检 (2026-08-07 实跑): 把 spansToAnsi 换成"原样返回 html"
  // → 「HTML 标签不许漏进屏」与「实体被反转义」两条当场红。
  test('★ 真的上了色 —— 不是原样返回', () => {
    const out = hl('const x = 1;', 'ts');
    expect(out[0]).toContain('\x1b[');
    expect(strip(out[0] as string)).toBe('const x = 1;');
  });

  test('★ HTML 标签与实体一个都不许漏进屏(span / class / &lt; 都不是内容)', () => {
    // ⚠ 源码里写 `&` 而不是 `&amp;`: hljs 会把 `&` 转义成 `&amp;`, 所以"输出里没有 &amp;"
    //   才等价于"反转义做了"。用 `&amp;` 当输入的话它会被转成 `&amp;amp;` 再还原成
    //   `&amp;` —— 那是**对的**, 但断言会读成错的。(初版就是这么写错的。)
    const out = hl('const s = "<div>&</div>";', 'ts').join('\n');
    expect(out).not.toContain('<span');
    expect(out).not.toContain('hljs-');
    expect(out).not.toContain('&amp;');
    expect(out).not.toContain('&lt;');
    expect(strip(out)).toContain('"<div>&</div>"');
  });

  test('★ 样式不跨行 —— 每行结束时没有仍然生效的样式(§9.2)', () => {
    // ⚠ 判据是"行末没有**仍生效**的样式", 不是"这一行以 reset 结尾" ——
    //   `\x1b[1mconst\x1b[0m x = 1;` 是完全正确的, 它只是在 reset 之后还有普通字符。
    //   初版按"以 reset 结尾"写, 把对的实现判成了错的。
    const out = hl('/* 第一行\n第二行 */\nconst x = 1;', 'ts');
    expect(out).toHaveLength(3);
    for (const line of out) {
      const codes = [...(line as string).matchAll(/\x1b\[([0-9;]*)m/g)].map((m) => m[1]);
      if (codes.length === 0) continue;
      expect(codes.at(-1), `行末样式未关: ${JSON.stringify(line)}`).toBe('0');
    }
  });

  test('★ 行数与输入完全一致 —— 高亮不许吞行也不许加行', () => {
    const code = 'a\n\nb\n';
    expect(hl(code, 'ts')).toHaveLength(code.split('\n').length);
  });

  test('★ 不认识的语言原样返回, 不抛', () => {
    expect(hl('随便写点什么', 'omd-dag-lang')).toEqual(['随便写点什么']);
    expect(hl('无语言标注', undefined)).toEqual(['无语言标注']);
  });

  test('语法不合法的片段也不抛(ignoreIllegals)', () => {
    expect(() => hl('const ((( =', 'ts')).not.toThrow();
  });

  test('★ 高亮不改变可见宽度 —— ANSI 不计宽', () => {
    const code = 'const 名字 = "中文字符串"; // 注释';
    const [colored] = hl(code, 'ts');
    const [uncolored] = plain(code, 'ts');
    expect(visibleWidth(colored as string)).toBe(visibleWidth(uncolored as string));
    expect(visibleWidth(colored as string)).toBe(visibleWidth(code));
  });

  test('关色主题下不产生任何 ANSI(NO_COLOR 时代码块仍可读)', () => {
    expect(plain('const x = 1;', 'ts').join('')).not.toContain('\x1b[');
  });
});
