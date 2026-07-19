/**
 * src/harness/slim/debt-scan —— `ponytail:` 刻意捷径标记的纯扫描件 (零 LLM, 零 IO)。
 *
 * 约定 (与 skills/ponytail SKILL.md 同步): 刻意简化处留结构化注释, 两个逗号分隔字段:
 *   `// ponytail: <ceiling>, <upgrade trigger>`    (`#` 与 `/*` 前缀同理)
 * **前缀强制**: 注释符后紧跟 (仅隔空白) `ponytail:` 才算标记 — 散文/字符串里顺嘴提到
 * "ponytail:" 不入账 (`// see ponytail: docs` 也不算)。容错解析: 缺 upgrade → '-' (rot 风险行)。
 *
 * scripts/omd-debt.ts 是 shell 包装 (ugrep→grep 兜底定位候选行), 本文件是解析真理源 + 测试面。
 */

export interface DebtMarker {
  file: string;
  /** 1-based 行号。 */
  line: number;
  /** 标记同行注释前的代码片段 (独立注释行 → '-')。 */
  what: string;
  /** 第一个逗号前: 捷径的天花板 (什么被简化了/上限在哪)。 */
  ceiling: string;
  /** 第一个逗号后: 升级触发条件。缺 → '-' (静默腐烂风险)。 */
  upgrade: string;
}

/** 注释符后紧跟 ponytail: (仅隔空白) — 前缀强制的核心。 */
const MARKER_RE = /(?:#|\/\/|\/\*)\s*ponytail:\s*(.*)$/;

/**
 * 单行文本 → 标记字段 (非标记行 → null)。
 * payload 按**第一个**逗号切 ceiling/upgrade (upgrade 内的逗号保留); 块注释的收尾符剥掉。
 */
export function parseDebtLine(text: string): Omit<DebtMarker, 'file' | 'line'> | null {
  const m = MARKER_RE.exec(text);
  if (!m) return null;
  const payload = m[1]!.replace(/\*\/\s*$/, '').trim();
  const comma = payload.indexOf(',');
  const ceiling = (comma < 0 ? payload : payload.slice(0, comma)).trim() || '-';
  const upgrade = (comma < 0 ? '' : payload.slice(comma + 1).trim()) || '-';
  const what = text.slice(0, m.index).trim() || '-';
  return { what, ceiling, upgrade };
}

/** 一个文件的行数组 → 标记清单 (1-based 行号)。纯函数, 测试面。 */
export function scanDebtLines(lines: string[]): Omit<DebtMarker, 'file'>[] {
  const out: Omit<DebtMarker, 'file'>[] = [];
  lines.forEach((text, i) => {
    const parsed = parseDebtLine(text);
    if (parsed) out.push({ line: i + 1, ...parsed });
  });
  return out;
}

/**
 * ledger 渲染: 按文件分组 (首现序), 一行一条
 * `<file>:<line> — <what>. ceiling: <x>. upgrade: <y>`, 尾行统计 (缺 upgrade = rot 风险计数)。
 */
export function formatLedger(markers: DebtMarker[]): string {
  const byFile = new Map<string, DebtMarker[]>();
  for (const m of markers) {
    const arr = byFile.get(m.file) ?? [];
    arr.push(m);
    byFile.set(m.file, arr);
  }
  const doc: string[] = [];
  for (const [file, rows] of byFile) {
    doc.push(`## ${file}`);
    for (const r of rows) doc.push(`${r.file}:${r.line} — ${r.what}. ceiling: ${r.ceiling}. upgrade: ${r.upgrade}`);
    doc.push('');
  }
  const noTrigger = markers.filter((m) => m.upgrade === '-').length;
  doc.push(`${markers.length} markers, ${noTrigger} with no upgrade trigger.`);
  return doc.join('\n');
}
