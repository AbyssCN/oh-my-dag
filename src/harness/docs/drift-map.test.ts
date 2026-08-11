import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDocsMap } from "./drift-map";

describe("parseDocsMap", () => {
  test("解析真实 docs/docs-map.md 表体", () => {
    const md = readFileSync(join(import.meta.dir, "../../../docs/docs-map.md"), "utf8");
    const rows = parseDocsMap(md);

    expect(rows.length).toBeGreaterThan(0);
    const mcpTools = rows.find((r) => r.doc === "docs/guide/mcp-tools.md");
    expect(mcpTools).toBeDefined();
    // 2026-08-11 收割集成修正后的真值: 覆盖 glob 指工具真源 (src/mcp/tools/** + 别名表),
    // 锚含当天新参数 (sddPath/slug —— goal 指令点名的需求样本)。
    expect(mcpTools?.sourceGlobs).toEqual(["src/mcp/tools/**/*.ts", "src/mcp/tool-renames.ts"]);
    expect(mcpTools?.anchors).toEqual(["sddPath", "slug", "detached", "map_prefetch", "path_prefetch"]);
  });

  test("跳过表头行与分隔行", () => {
    const md = ["| 文档 | 覆盖源 (glob) | 字面锚 (逗号分隔) |", "|---|---|---|", "| `a.md` | `src/a.ts` | `foo` |"].join(
      "\n",
    );
    const rows = parseDocsMap(md);
    expect(rows).toEqual([{ doc: "a.md", sourceGlobs: ["src/a.ts"], anchors: ["foo"] }]);
  });

  test("锚为 `-` 解析成空数组(NULL, 非未填)", () => {
    const md = "| `a.md` | `src/a.ts` | `-` |";
    const rows = parseDocsMap(md);
    expect(rows).toEqual([{ doc: "a.md", sourceGlobs: ["src/a.ts"], anchors: [] }]);
  });

  test("多个 glob / 多个锚按逗号拆分并去空白", () => {
    const md = "| `a.md` | `src/a.ts, src/b.ts` | `foo, bar,baz` |";
    const rows = parseDocsMap(md);
    expect(rows[0]?.sourceGlobs).toEqual(["src/a.ts", "src/b.ts"]);
    expect(rows[0]?.anchors).toEqual(["foo", "bar", "baz"]);
  });

  test("非表格行(说明文字、空行)不产生数据行", () => {
    const md = [
      "# 标题",
      "",
      "> 一段说明, 里面也可能出现 | 字符但不是表格。",
      "普通段落没有竖线包裹",
    ].join("\n");
    expect(parseDocsMap(md)).toEqual([]);
  });

  test("单元格内转义的 `\\|` 不被当成列分隔符", () => {
    const md = "| `a.md` | `src/a.ts` | `a\\|b` |";
    const rows = parseDocsMap(md);
    expect(rows[0]?.anchors).toEqual(["a|b"]);
  });

  test("反向自检: 三列数不对的行(格式坏掉的表)不会被误判成数据行", () => {
    const md = "| `a.md` | `src/a.ts` |"; // 只有两格, 缺锚列
    expect(parseDocsMap(md)).toEqual([]);
  });
});
