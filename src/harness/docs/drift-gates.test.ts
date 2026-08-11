// D-2 确定性三闸(零 LLM, 常驻 bun test)—— 见 docs/plan/2026-08-11-docs-drift-tracking-sdd.md。
//
// 三闸消费切片 1 的 `parseDocsMap`(docs/docs-map.md 同源解析)与真实盘上文件, 判词点名
// 「哪份文档哪个锚/哪条链接」(INV-1)。每闸都配一段反向自检(G-6): 用违规样本证明它真的会红,
// 不是永远绿的摆设。
//
// 闸③(工具面反向闸)按 SDD D-2 刻意「窄」: 不对 MCP 工具全部 75 个 inputSchema key 做反向
// (那正是非目标里点名拒绝的「全导出符号反向」噪声模式的同构版本 —— S-3 已实测 613 导出 35%
// 噪声做不成闸); 本切片只交付**可复用的判别函数** + 用 `slug`(G-3 指定样本)证明机制成立,
// 全量接线留给后续切片按窄口子集扩(O-3 同族决策, 等读数)。
import { describe, expect, test } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";
import { parseDocsMap, type DocsMapRow } from "./drift-map";

const REPO_ROOT = join(import.meta.dir, "../../..");

// ── 闸① 锚存在 ──────────────────────────────────────────────────────────────
// map 每行的每个字面锚, 必须在其覆盖源(glob 并集)里被字面命中; 命中不到 = 文档引用了死符号。

interface AnchorViolation {
  doc: string;
  anchor: string;
}

function globContent(root: string, globs: string[]): string {
  const chunks: string[] = [];
  for (const pattern of globs) {
    const glob = new Glob(pattern);
    for (const file of glob.scanSync({ cwd: root })) {
      chunks.push(readFileSync(join(root, file), "utf8"));
    }
  }
  return chunks.join("\n");
}

/** 闸①: 逐行逐锚在覆盖源里 grep 命中, 未命中的收进违规表(INV-1: 点名哪份文档哪个锚)。 */
function checkAnchorsExist(rows: DocsMapRow[], root: string): AnchorViolation[] {
  const violations: AnchorViolation[] = [];
  for (const row of rows) {
    if (row.anchors.length === 0) continue; // NULL(无可判锚), 非 0 违规
    const source = globContent(root, row.sourceGlobs);
    for (const anchor of row.anchors) {
      if (!source.includes(anchor)) violations.push({ doc: row.doc, anchor });
    }
  }
  return violations;
}

describe("D-2 闸① 锚存在", () => {
  test("反向自检(G-1): 锚在覆盖源里被删除 → 红且点名文档+锚", () => {
    const rows: DocsMapRow[] = [
      // 覆盖源指到单个真实文件(而非本文件所在目录的 *.ts glob), 避免这条测试自己的字符串
      // 字面量把自己算作"命中"(自指噪声)。
      { doc: "docs/fake.md", sourceGlobs: ["src/harness/docs/drift-map.ts"], anchors: ["parseDocsMapDoesNotExist"] },
    ];
    const violations = checkAnchorsExist(rows, REPO_ROOT);
    expect(violations).toEqual([{ doc: "docs/fake.md", anchor: "parseDocsMapDoesNotExist" }]);
  });
  test("正例: 锚在覆盖源里存在 → 不违规", () => {
    const rows: DocsMapRow[] = [
      { doc: "docs/fake.md", sourceGlobs: ["src/harness/docs/drift-map.ts"], anchors: ["parseDocsMap"] },
    ];
    expect(checkAnchorsExist(rows, REPO_ROOT)).toEqual([]);
  });
  test("真实 docs/docs-map.md: 逐行核对, 记录目前唯二的真实违规(证明闸在真实盘上会红, 不只在合成样本上会红)", () => {
    const md = readFileSync(join(REPO_ROOT, "docs/docs-map.md"), "utf8");
    const rows = parseDocsMap(md);
    // 施工时本闸在真盘抓过三条真实违规(glob 非递归漏定义处 ×2 + README 行锚语义错),
    // 收割集成时已修(2026-08-11: mcp-tools 行 glob 换 `src/mcp/tools/**` + tool-renames,
    // README 行锚改 `-`)。现状零违规是**修出来的**, 不是闸哑 —— 红的可证性由上方合成样本钉着。
    expect(checkAnchorsExist(rows, REPO_ROOT)).toEqual([]);
  });
});

// ── 闸② 死路径 ──────────────────────────────────────────────────────────────
// 用户面文档内的相对链接/路径引用 + `.dev/public-paths.txt` 每条, 盘上必须存在。

/** 提取 markdown 相对链接目标(跳过 http(s):// 与锚点 `#foo`)。 */
function extractRelativeLinks(markdown: string): string[] {
  const links: string[] = [];
  const re = /\]\(([^)]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown))) {
    const target = (m[1] ?? "").split("#")[0]!.trim();
    if (!target || /^[a-z]+:\/\//i.test(target)) continue;
    links.push(target);
  }
  return links;
}

interface DeadPathViolation {
  doc: string;
  target: string;
}

/** 闸②: 文档内相对链接 + 独立路径清单, 逐条核对盘上存在。 */
function checkDeadPaths(
  docs: Array<{ doc: string; markdown: string; baseDir: string }>,
  standalonePaths: Array<{ doc: string; target: string }>,
  root: string,
): DeadPathViolation[] {
  const violations: DeadPathViolation[] = [];
  for (const { doc, markdown, baseDir } of docs) {
    for (const target of extractRelativeLinks(markdown)) {
      if (!existsSync(join(root, baseDir, target))) violations.push({ doc, target });
    }
  }
  for (const { doc, target } of standalonePaths) {
    if (!existsSync(join(root, target))) violations.push({ doc, target });
  }
  return violations;
}

describe("D-2 闸② 死路径", () => {
  test("反向自检(G-2): 文档内链指向不存在路径(今天 404 样本形状)→ 红且点名文档+目标", () => {
    const docs = [
      { doc: "docs/fake.md", markdown: "见 [已删的页](guide/deleted-after-reorg.md) 了解详情。", baseDir: "docs" },
    ];
    expect(checkDeadPaths(docs, [], REPO_ROOT)).toEqual([
      { doc: "docs/fake.md", target: "guide/deleted-after-reorg.md" },
    ]);
  });

  test("正例: 文档内链指向存在的路径 → 不违规", () => {
    const docs = [{ doc: "docs/fake.md", markdown: "见 [README](README.md)。", baseDir: "docs" }];
    expect(checkDeadPaths(docs, [], REPO_ROOT)).toEqual([]);
  });

  test("跳过外链(http/https)与纯锚点, 不误判成死路径", () => {
    const docs = [
      {
        doc: "docs/fake.md",
        markdown: "外链 [x](https://example.com/y) 与锚点 [z](#section) 都不该被判。",
        baseDir: "docs",
      },
    ];
    expect(checkDeadPaths(docs, [], REPO_ROOT)).toEqual([]);
  });

  test("真实 docs/README.md: 逐条核对, 记录目前的真实死路径(=当年裂图样本的同族, 仍未修)", () => {
    const markdown = readFileSync(join(REPO_ROOT, "docs/README.md"), "utf8");
    // 施工时本闸在真盘抓到 `session/`、`articles/` 两条死链(链接私有目录, 公开面 404)——
    // 系统落地前就抓到第 5 起真实漂移。收割集成时已从 README 摘除(2026-08-11)。
    // 现状零违规是修出来的; 红的可证性由上方合成样本钉着。
    expect(checkDeadPaths([{ doc: "docs/README.md", markdown, baseDir: "docs" }], [], REPO_ROOT)).toEqual([]);
  });

  test("真实 .dev/public-paths.txt 每条盘上都存在(公开白名单 9 死条目样本已修)", () => {
    const lines = readFileSync(join(REPO_ROOT, ".dev/public-paths.txt"), "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
    const standalone = lines.map((target) => ({ doc: ".dev/public-paths.txt", target }));
    expect(checkDeadPaths([], standalone, REPO_ROOT)).toEqual([]);
  });
});

// ── 闸③ 工具面反向闸(窄) ─────────────────────────────────────────────────
// MCP 工具 inputSchema key 集合 ⊆ guide/mcp-tools.md 提及集(反引号包裹的字面提及, 不做子串
// 模糊匹配 —— 子串匹配会把 "id"/"type" 这类通用词判成"提及", 噪声等价于全导出符号反向)。

interface ToolSchemaViolation {
  key: string;
}

/** guide/mcp-tools.md 的「提及集」= 反引号内出现过的字面 token(与本仓文档 `` `foo` `` 惯例一致)。 */
function extractBacktickMentions(markdown: string): Set<string> {
  const mentions = new Set<string>();
  const re = /`([^`]+)`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown))) mentions.add(m[1]!.trim());
  return mentions;
}

/** 闸③: 给定一批 inputSchema key, 未被 doc 反引号提及集覆盖的收进违规表。 */
function checkToolSchemaCoverage(schemaKeys: string[], docText: string): ToolSchemaViolation[] {
  const mentions = extractBacktickMentions(docText);
  return schemaKeys.filter((key) => !mentions.has(key)).map((key) => ({ key }));
}

describe("D-2 闸③ 工具面反向闸(窄)", () => {
  test("反向自检(G-3, 指定样本 slug): 新增 schema key 未入文档 → 红且点名 key", () => {
    const docText = "| `map_open` | list / create / resume decision maps |";
    expect(checkToolSchemaCoverage(["slug"], docText)).toEqual([{ key: "slug" }]);
  });

  test("正例: schema key 已被反引号提及 → 不违规", () => {
    const docText = "接受 `slug` 参数, 省略 = 唯一开着的地图。";
    expect(checkToolSchemaCoverage(["slug"], docText)).toEqual([]);
  });

  test("窄口设计验证: 通用词只在裸文本(非反引号)出现不算提及, 拒绝子串误判噪声", () => {
    // "id" 作为英文单词到处出现, 但没有任何地方写成 `id` —— 若做子串匹配这里会被判"已提及"
    // 而实际没人真正记录过这个参数, 是假阴性(漏红)的噪声源, 窄口设计刻意拒绝它。
    const docText = "this tool takes a valid identifier and returns a rapid result.";
    expect(checkToolSchemaCoverage(["id"], docText)).toEqual([{ key: "id" }]);
  });
});
