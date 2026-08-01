/**
 * src/harness/skills/frontmatter —— SKILL.md 的 `--- yaml ---` 头切分。
 *
 * ## 为什么它单住一个文件 (2026-08-02, 交接文 14)
 *
 * 它原本住在 `scanner.ts` 里。砍 TUI 之后 `scanner.ts` 的其余部分 (扫目录 → 填 sqlite 影子表)
 * **一个调用方都不剩** —— 唯一的调用方是已删的 `tui.ts`。但整个文件不能直接删: `agent-templates.ts`
 * 与 `compile.ts` 还在用这一个函数。
 *
 * 于是照本仓那条老约定办 ——「**要复用的东西搬出那个文件**, 别为了一个函数留着整个模块」
 * (同 `execute-extension.ts` → `execute-slice.ts` 那次)。留着 `scanner.ts` 的代价不只是行数:
 * 它 import `registry.ts` + `bundle.ts`, 于是两个同样零消费者的文件会**因为它而继续"可达"**,
 * 在任何按 import 图算的死码扫描里都显示为活的。
 *
 * 这个函数本身与 skill 无关 —— 就是个 YAML frontmatter 切分器。放在 `skills/` 下只是因为
 * 目前两个调用方都在读 SKILL.md;哪天别处要用, 直接往上提一层, 没有依赖拦着。
 */
import yaml from 'js-yaml';

/** 从 SKILL.md 文本切出 frontmatter YAML + body。无 frontmatter → {fm:{}, body:全文}。 */
export function splitFrontmatter(text: string): { fm: Record<string, unknown>; body: string } {
  // 必须以 '---' 起 (允许前置 BOM/空行)
  const m = text.match(/^﻿?\s*---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { fm: {}, body: text };
  const parsed = yaml.load(m[1]!);
  const fm = parsed != null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  return { fm, body: m[2] ?? '' };
}
