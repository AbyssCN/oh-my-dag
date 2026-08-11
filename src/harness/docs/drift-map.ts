// docs-map 解析器 —— docs/docs-map.md 是人读的真源, 本文件把它同源解析成结构化行,
// 供 D-2 确定性闸(drift-gates.test.ts)与 D-3 审计构造器(drift-audit.ts)消费。
// 见 docs/plan/2026-08-11-docs-drift.md 的 D-1。

export interface DocsMapRow {
  /** 用户面文档路径, 相对仓根, 如 `docs/guide/mcp-tools.md` */
  doc: string;
  /** 这份文档描述的实现在哪, 逗号分隔的多个 glob */
  sourceGlobs: string[];
  /** 文档赖以成立的字面锚(符号/参数名/路径), 空表示该行没有可判的锚(NULL, 非"没填") */
  anchors: string[];
}

const TABLE_ROW_RE = /^\|(.+)\|\s*$/;

/** 表分隔行形如 `|---|---|---|`, 每格只含 `-` `:` 空白 */
function isSeparatorRow(cells: string[]): boolean {
  return cells.every((c) => /^:?-+:?$/.test(c.trim()));
}

function splitCells(line: string): string[] {
  const match = TABLE_ROW_RE.exec(line);
  if (!match) return [];
  // md 表格子内的字面 `|` 会被 `\|` 转义; 按未转义的 `|` 切分
  const raw = match[1] ?? "";
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === "\\" && raw[i + 1] === "|") {
      cur += "|";
      i++;
      continue;
    }
    if (ch === "|") {
      cells.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

/** 去掉 markdown 反引号/链接包装, 只留裸文本, 如 `` `docs/x.md` `` -> `docs/x.md` */
function stripInlineCode(cell: string): string {
  return cell.replace(/`([^`]*)`/g, "$1").trim();
}

/**
 * 解析 docs/docs-map.md 表体(三列: 文档 | 覆盖源(glob) | 字面锚)。
 * 只认「三格且非分隔行且第一格非空」的行为数据行, 其余(标题行、说明行、空行)跳过。
 */
export function parseDocsMap(markdown: string): DocsMapRow[] {
  const rows: DocsMapRow[] = [];
  for (const line of markdown.split("\n")) {
    const cells = splitCells(line);
    if (cells.length !== 3) continue;
    if (isSeparatorRow(cells)) continue;
    const doc = stripInlineCode(cells[0] ?? "");
    if (!doc || doc === "文档") continue; // 空行或标题行

    const sourceGlobs = stripInlineCode(cells[1] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const anchorsCell = stripInlineCode(cells[2] ?? "");
    const anchors =
      anchorsCell === "-" || anchorsCell === ""
        ? []
        : anchorsCell
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);

    rows.push({ doc, sourceGlobs, anchors });
  }
  return rows;
}
