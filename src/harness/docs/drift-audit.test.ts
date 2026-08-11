import { describe, expect, test } from "bun:test";
import { buildDriftAuditPlan, buildSuggestionDrafts, type DriftAuditFinding, type DriftAuditLeafResult } from "./drift-audit";
import type { DocsMapRow } from "./drift-map";

const rows: DocsMapRow[] = [
  { doc: "docs/guide/mcp-tools.md", sourceGlobs: ["src/harness/*.ts"], anchors: ["map_prefetch"] },
  { doc: "docs/README.md", sourceGlobs: ["docs/guide/*.md"], anchors: ["guide/getting-started.md"] },
];

describe("buildDriftAuditPlan", () => {
  test("覆盖源命中变更文件 → 生成任务, 只带命中的那部分变更", () => {
    const tasks = buildDriftAuditPlan(rows, ["src/harness/cli.ts", "src/other/x.ts"]);
    expect(tasks).toEqual([
      {
        doc: "docs/guide/mcp-tools.md",
        sourceGlobs: ["src/harness/*.ts"],
        anchors: ["map_prefetch"],
        changedFiles: ["src/harness/cli.ts"],
      },
    ]);
  });

  test("覆盖源与变更无交集 → 不生成任务(省一次 Sonnet 调用)", () => {
    expect(buildDriftAuditPlan(rows, ["src/unrelated/y.ts"])).toEqual([]);
  });

  test("多行同时命中同一 glob 分别各自生成任务", () => {
    const tasks = buildDriftAuditPlan(rows, ["src/harness/cli.ts", "docs/guide/getting-started.md"]);
    expect(tasks.map((t) => t.doc)).toEqual(["docs/guide/mcp-tools.md", "docs/README.md"]);
  });

  test("`*` 不跨目录: `src/harness/*.ts` 不命中子目录里的文件", () => {
    expect(buildDriftAuditPlan(rows, ["src/harness/sub/deep.ts"])).toEqual([]);
  });
});

describe("buildSuggestionDrafts", () => {
  const task = buildDriftAuditPlan(rows, ["src/harness/cli.ts"])[0]!;

  test("G-4 正面: 合法锚点 finding → 落一张 suggested 建议草稿, 携文档原句与代码锚", async () => {
    const finding: DriftAuditFinding = {
      doc: "docs/guide/mcp-tools.md",
      docQuote: "字面锚 = 文档赖以成立的符号/参数名/路径",
      file: "src/harness/docs/drift-map.ts",
      line: 5,
      claim: "该行早已改名, 文档原句指向的字段不再存在",
      symbols: ["DocsMapRow"],
      dimension: "docs-drift",
      severity: "P1",
    };
    const leafResults: DriftAuditLeafResult[] = [{ task, driftFound: true, findings: [finding] }];
    const result = await buildSuggestionDrafts(leafResults, { runId: "run-abc", cwd: process.cwd() });

    expect(result.downgraded).toEqual([]);
    expect(result.drafts).toHaveLength(1);
    expect(result.drafts[0]?.suggestedBy).toBe("run-abc");
    expect(result.drafts[0]?.type).toBe("task");
    expect(result.drafts[0]?.title).toContain("docs/guide/mcp-tools.md");
    expect(result.drafts[0]?.title).toContain("src/harness/docs/drift-map.ts:5");
    expect(result.drafts[0]?.title).toContain(finding.claim);
  });

  test("反幻觉(D-3 反幻觉闸复用): 幻觉锚(行号越界)finding 不落票, 只降级记账", async () => {
    const hallucinated: DriftAuditFinding = {
      doc: "docs/guide/mcp-tools.md",
      docQuote: "字面锚 = 文档赖以成立的符号/参数名/路径",
      file: "src/harness/docs/drift-map.ts",
      line: 99999, // 文件仅 81 行, 越界 — 编的锚
      claim: "编的矛盾",
      symbols: [],
      dimension: "docs-drift",
      severity: "P1",
    };
    const leafResults: DriftAuditLeafResult[] = [{ task, driftFound: true, findings: [hallucinated] }];
    const result = await buildSuggestionDrafts(leafResults, { runId: "run-abc", cwd: process.cwd() });

    expect(result.drafts).toEqual([]);
    expect(result.downgraded).toHaveLength(1);
    expect(result.downgraded[0]?.verdict).toBe("invalid-anchor");
  });

  test("G-4 反面: 无漂移对(叶明确说「未见漂移」)→ 零票, 不是「没审到」的沉默空", async () => {
    const leafResults: DriftAuditLeafResult[] = [{ task, driftFound: false, findings: [] }];
    const result = await buildSuggestionDrafts(leafResults, { runId: "run-abc", cwd: process.cwd() });

    expect(result.drafts).toEqual([]);
    expect(result.downgraded).toEqual([]);
  });

  test("空叶结果列表(还没跑任何叶)同样零票 — 与「未见漂移」的空数组结构相同, 由调用方另记状态区分", async () => {
    const result = await buildSuggestionDrafts([], { runId: "run-abc", cwd: process.cwd() });
    expect(result.drafts).toEqual([]);
    expect(result.downgraded).toEqual([]);
  });
});
