/**
 * src/harness/slim/findings —— dag-slim finding 行的提取 + 单行报告格式化 (纯件, 零 IO)。
 *
 * 出口纪律: 一条 finding 恰好一行 `<kind>: <file:line> — cut <what>, replace with <what>`,
 * Global 组在前 Local 组在后。模型输出容错 (bullet/加粗/全角冒号), 非 kind 前缀行一律丢弃。
 */
import type { SlimFindingKind } from './prompts';

/**
 * 从 reviewer 原文提取 finding 行 (只认给定 kinds 的前缀; 容忍 `- ` bullet / `**加粗**` /
 * 全角冒号)。归一化为 `<kind>: <rest>`。无命中 → [] (LEAN/散文皆然)。
 */
export function extractFindingLines(text: string, kinds: SlimFindingKind[]): string[] {
  const names = kinds.map((k) => k.kind).join('|');
  const re = new RegExp(`^(?:[-*•]\\s*)?(${names})\\s*[::]\\s*(.+)$`);
  const out: string[] = [];
  for (const raw of text.split('\n')) {
    const m = raw.replace(/\*\*/g, '').trim().match(re);
    if (m) out.push(`${m[1]}: ${m[2]!.trim()}`);
  }
  return out;
}

/**
 * 终端单行报告: 按传入顺序分组 (调用方保证 Global 在前 Local 在后), 组内一行一条。
 * 全部为空 → `Lean already. Ship.`。
 */
export function formatReport(sections: { title: string; lines: string[] }[]): string {
  if (sections.every((s) => s.lines.length === 0)) return 'Lean already. Ship.';
  return sections
    .map((s) => [`## ${s.title}`, ...(s.lines.length > 0 ? s.lines : ['(无 finding)'])].join('\n'))
    .join('\n\n');
}
