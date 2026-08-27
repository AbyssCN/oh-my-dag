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

// ── 闸④ 注释引用反向(代码 → 文档) ───────────────────────────────────────────
// 闸①②③ 走的都是「文档 → 代码」;本闸补反向的一半: 代码注释里引用的本仓文档, 盘上必须存在。
// 腐烂的引用比没有引用更贵 —— 既照收 token, 又把读者支去一个不存在的地方(2026-08-27 实测抓到
// 4 条真断链, 其中 2 条是文档改名后注释没跟上: fanin 契约改中文名 · docs-drift SDD 加 -tracking 后缀)。
//
// 三条窄口(取舍同闸③: 宁可漏红, 不做噪声闸), 每条都有实测支撑:
//  · 只判**注释行** —— 字符串字面量里的路径是数据不是引用;
//  · 只判**带引用标记**的(见/详见/对应/契约/SDD/Contract/←) —— 裸扫命中的 31 条"死引用"里有 18 条
//    是散文举例(如复述 live 抓到的原命令 `grep -q "相同" docs/from-api.md`), 无标记的闸信噪比 4:6;
//  · 只判**本仓文档根**(`docs/` 与 `harness/docs/`)的裸引用 —— 外仓文档按约定写仓前缀
//    (`$FUSANG_HOME/docs/…` · `bluebell/docs/…`), 前置字符是 `/`, 天然出局。
//
// 刻意不判 `.ts` 路径引用: 实测 187 处里 41 处指向盘上没有的文件, 而**全部** 41 处都是测试的合成
// fixture 名(`src/a.ts` · `src/foo.ts` · `src/keep30.ts`), 真信号 0; 带行号的子集(9 处)同样 3/3
// 是合成名。那正是闸③非目标里点名拒绝的噪声形状, 不接。

interface CommentDocRefViolation {
  file: string;
  line: number;
  target: string;
}

/** 逐行提取注释行(跟踪块注释), 返回 1-based 行号 + 该行原文。 */
function commentLinesOf(source: string): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = [];
  let inBlock = false;
  source.split("\n").forEach((raw, i) => {
    const t = raw.trim();
    if (!t) return;
    let isComment = false;
    if (inBlock) {
      isComment = true;
      if (t.includes("*/")) inBlock = false;
    } else if (t.startsWith("/*")) {
      isComment = true;
      if (!t.includes("*/")) inBlock = true;
    } else if (t.startsWith("//")) isComment = true;
    if (isComment) out.push({ line: i + 1, text: t });
  });
  return out;
}

/** 本仓文档根的裸引用; 前置字符类排除引号/括号/`/`/`$`, 即散文里的举例路径与外仓前缀引用。 */
const DOC_REF = /(?:^|[^\w/'"`(<.$-])((?:harness\/)?docs\/[^\s)）,,;;:："'`]*\.md)/g;
/** 引用标记必须紧贴在路径左边(≤12 字符窗口内), 否则算散文提及而非引用。 */
const CITATION_MARKER = /(?:详见|参见|见|对应|契约|出处|SDD|Contract|←)[::]?\s*$/;

/** 闸④: 注释行里带引用标记的本仓文档路径, 逐条核对盘上存在(INV-1: 点名文件+行号+目标)。 */
function checkCommentDocRefs(
  files: Array<{ file: string; source: string }>,
  root: string,
): CommentDocRefViolation[] {
  const violations: CommentDocRefViolation[] = [];
  for (const { file, source } of files) {
    for (const { line, text } of commentLinesOf(source)) {
      for (const m of text.matchAll(DOC_REF)) {
        const target = m[1]!;
        if (target.includes("*")) continue; // glob 通配是模式不是路径
        const at = m.index! + (m[0].length - target.length);
        if (!CITATION_MARKER.test(text.slice(Math.max(0, at - 12), at))) continue;
        if (!existsSync(join(root, target))) violations.push({ file, line, target });
      }
    }
  }
  return violations;
}

describe("D-2 闸④ 注释引用反向(代码 → 文档)", () => {
  test("反向自检(G-4): 注释引用的文档被改名 → 红且点名文件+行号+目标", () => {
    // 真实腐烂形状: 契约文档改成中文名, 注释里的旧英文名没跟上(2026-08-27 抓到的原样本)。
    const source = [
      "/**",
      " * #153 fan-in 摘要视图保引文。",
      " * 契约: docs/plan/2026-08-25-fanin-verbatim-contract.md",
      " */",
    ].join("\n");
    expect(checkCommentDocRefs([{ file: "src/fake.ts", source }], REPO_ROOT)).toEqual([
      { file: "src/fake.ts", line: 3, target: "docs/plan/2026-08-25-fanin-verbatim-contract.md" },
    ]);
  });

  test("正例: 引用的文档存在 → 不违规", () => {
    const source = "// 见 docs/plan/2026-08-11-docs-drift-tracking-sdd.md 的 D-1。";
    expect(checkCommentDocRefs([{ file: "src/fake.ts", source }], REPO_ROOT)).toEqual([]);
  });

  test("窄口①: 只判注释, 代码里的字符串字面量路径是数据不是引用", () => {
    const source = `const p = "docs/plan/从来没有过的文件.md"; // 见 上面那个常量`;
    expect(checkCommentDocRefs([{ file: "src/fake.ts", source }], REPO_ROOT)).toEqual([]);
  });

  test("窄口②: 无引用标记的散文举例不判(复述 live 命令原文 = 别人世界里的文件)", () => {
    // 原样本 src/harness/goal/acceptance-gate.ts: 冻结的命令是 `grep -q "相同" docs/from-api.md`,
    // 那个路径属于当年那个任务的临时世界, 判它就是判错人。
    const source = `// 那次冻结的命令是 grep -q "相同" docs/from-api.md —— 它匹配得上「不相同」。`;
    expect(checkCommentDocRefs([{ file: "src/fake.ts", source }], REPO_ROOT)).toEqual([]);
  });

  test("窄口③: 外仓引用带仓前缀 → 出局(本闸只对本仓盘负责)", () => {
    const source = [
      "// Contract: $FUSANG_HOME/docs/plan/mimo-leaf-execution-contract.md (未入本仓)。",
      "// SDD: bluebell/docs/migration/0010-u2-discovery-loop-sdd.md (未入本仓)。",
    ].join("\n");
    expect(checkCommentDocRefs([{ file: "src/fake.ts", source }], REPO_ROOT)).toEqual([]);
  });

  test("glob 通配是模式不是路径, 不判(docs/plan/*.md 这类)", () => {
    const source = "// 见 docs/plan/*.md 里最新的那份。";
    expect(checkCommentDocRefs([{ file: "src/fake.ts", source }], REPO_ROOT)).toEqual([]);
  });

  test("真实 src/**/*.ts: 逐条核对, 零违规", () => {
    // 施工时本闸在真盘抓到 4 条真断链 + 5 条前缀写错(harness/docs/ 写成 docs/ · 外仓文档写成
    // 本仓路径), 已在同一次改动里修完(2026-08-27)。现状零违规是**修出来的**, 不是闸哑 ——
    // 红的可证性由上方 G-4 合成样本钉着。
    const glob = new Glob("src/**/*.ts");
    const files = [...glob.scanSync({ cwd: REPO_ROOT })].map((file) => ({
      file,
      source: readFileSync(join(REPO_ROOT, file), "utf8"),
    }));
    expect(checkCommentDocRefs(files, REPO_ROOT)).toEqual([]);
  });
});
