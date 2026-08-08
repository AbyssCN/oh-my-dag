/**
 * 边框族 token 的**闸**(TUI 重建 plan P1)。
 *
 * 它证明两件事:
 * 1. `card` / `rule` 画出来的东西是对的(形状 + 窄屏不崩);
 * 2. ★ **框线字形不许再散回各组件** —— 除白名单外,`src/tui` 的代码里不许出现框线字符。
 *
 * ## 这条闸自己会红吗
 *
 * 会。写它的时候证伪过:把 `components/dialog.ts` 从白名单外的状态放进扫描,
 * 未迁移前它有 9 处命中,闸红;迁到 `card.*` 之后归零。
 * 本文件末尾还留了一条**常驻反测**(见 `扫描器本身会不会永远绿`),
 * 因为一个"扫源码"的闸最容易悄悄退化成扫了个空集。
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { BORDER, card, rule } from './tokens';

const TUI_ROOT = join(import.meta.dir, '..');

/**
 * 本职就是画图的地方 —— 它们**应该**直接用字形,不该被收编进 token。
 * 往这张表里加名字前先问:它画的是"卡片/分隔线"(该走 token),
 * 还是"一张图"(该留在自己那儿)。
 */
const ALLOWED = new Set([
  'design/tokens.ts', // token 真源本身
  'render/glyphs.ts', // 字形白名单真源
  'render/glyph-table.ts', // 探针量出来的表
  'render/path-fog.ts', // 雾场画布
  'components/dag-tree.ts', // 树形
  'render/dag-gantt.ts', // 甘特
]);

/** 框线字形:**字面量与转义形都要认**。 */
const BORDER_CHARS = '─│┌┐└┘├┤┬┴┼━┃┏┓┗┛═║╔╗╚╝╭╮╰╯';
const LITERAL = new RegExp(`[${BORDER_CHARS}]`, 'gu');
/** `'─'` 这种写法 —— chat-log 当初就是这么藏住的,两次字面量扫描都没扫到它。 */
const ESCAPED = /\\u(?:25[0-9a-f]{2})/gi;

function tsFiles(dir: string, base = ''): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const rel = base ? `${base}/${name}` : name;
    if (statSync(full).isDirectory()) out.push(...tsFiles(full, rel));
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) out.push(rel);
  }
  return out;
}

/** 去掉注释 —— `// ── 座位 ────` 是注释装饰,不是画框。 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n');
}

function borderHits(rel: string): number {
  const code = stripComments(readFileSync(join(TUI_ROOT, rel), 'utf8'));
  return (code.match(LITERAL)?.length ?? 0) + (code.match(ESCAPED)?.length ?? 0);
}

describe('边框族 token', () => {
  it('rule 给出等宽横线, 窄屏给空串不抛', () => {
    expect(rule(5)).toBe('─────');
    expect(rule(0)).toBe('');
    expect(rule(-3)).toBe(''); // repeat(负数) 会抛 —— 一条画不下的线不值得让 UI 崩
  });

  it('card 三件拼出闭合的框', () => {
    const w = 20;
    const top = card.top('标题', w, 4);
    const bottom = card.bottom(w);
    expect(top.startsWith(BORDER.tl)).toBe(true);
    expect(top.endsWith(BORDER.tr)).toBe(true);
    expect(bottom).toBe(`${BORDER.bl}${'─'.repeat(18)}${BORDER.br}`);
    expect(card.side('x', 3)).toBe('│ x    │');
  });

  it('side 的 pad 为负时不抛(内容比框宽的退化情形)', () => {
    expect(() => card.side('很长很长的内容', -5)).not.toThrow();
  });

  /**
   * ★ 主闸。
   */
  it('框线字形不散在组件里 —— 只允许白名单里那几个画图的地方', () => {
    const offenders = tsFiles(TUI_ROOT)
      .filter((rel) => !ALLOWED.has(rel))
      .map((rel) => ({ rel, n: borderHits(rel) }))
      .filter((x) => x.n > 0);
    expect(offenders).toEqual([]);
  });

  /**
   * ★ **反测:扫描器本身会不会永远绿。**
   *
   * 一个"扫源码找违规"的闸,最常见的坏法不是漏判,是**扫了个空集**
   * (路径写错 / 后缀过滤把文件全滤掉 / 正则不匹配)。所以这里正面证明:
   * 白名单里那几个文件**确实**能被扫出框线字形 —— 扫描器是活的。
   */
  it('反测: 扫描器在已知含框线的文件上确实命中', () => {
    expect(borderHits('render/glyphs.ts')).toBeGreaterThan(0);
    expect(borderHits('render/path-fog.ts')).toBeGreaterThan(0);
    expect(tsFiles(TUI_ROOT).length).toBeGreaterThan(30); // 真的走到文件了
  });

  it('反测: 转义写法也算命中(chat-log 当初就是这么藏住的)', () => {
    const code = "const x = '\\u2500'.repeat(3);";
    expect((code.match(ESCAPED) ?? []).length).toBe(1);
  });
});
