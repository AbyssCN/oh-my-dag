/**
 * src/harness/docs/drift-audit —— D-3 语义审计图构造器 + D-4 票出口(docs-drift SDD,
 * `docs/plan/2026-08-11-docs-drift.md`)。
 *
 * 两段纯函数,零 LLM(跑模型的那半是 dag_run 平铺图 + skill,不在本文件写集里):
 *  - buildDriftAuditPlan: docs-map 声明表(D-1, parseDocsMap 产物)× 自上次审计 stamp 以来
 *    变更的文件集合(diff, 调用方给 —— 本模块不跑 git, 保持纯核可测)→ 每对"文档 ↔ 命中
 *    变更"一条便宜叶任务。覆盖源没变的文档不生成任务(省 Sonnet 调用, 也是 D-3「为什么跑
 *    得动」的一部分:map 把上下文裁到 KB 级)。
 *  - buildSuggestionDrafts: 叶回填的 DriftAuditLeafResult[] → 复用 D-3 反幻觉闸
 *    (`../review/anchor-check` 的 checkFindingAnchors)过滤幻觉锚, 只把合法锚的 finding
 *    转成 S-1 建议草稿(`../pathfinder/suggest` 的 SuggestionDraft), 供调用方 mutateMap 时
 *    走 applySuggestions 落 suggested 票(D-4)。
 *
 * 判据窄(D-3 原文): finding 必须引用文档原句(docQuote, 逐字, 不许转述)+ 给出矛盾代码锚
 * (file:line); 无矛盾 = 叶明确回 driftFound=false + findings=[](「未见漂移」), 不许泛泛
 * 建议。NULL≠0: 「未见漂移」(driftFound=false, 明确判过)与「没审到」(这对根本没生成任务 /
 * 叶跑挂了, 调用方另记)是两个状态, 本模块不把二者抹平成同一个空数组。
 */
import { checkFindingAnchors, type AnchorFindingResult } from "../review/anchor-check";
import type { SuggestionDraft } from "../pathfinder/suggest";
import type { DocsMapRow } from "./drift-map";

/**
 * glob → 正则。docs-map 表里目前只出现单层 `*.ext`(如 `src/harness/*.ts`), 不支持 `**`
 * —— 表里没出现过就不先猜着支持, 出现时再加(YAGNI, 同 D-2 的裁窄原则)。
 */
function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*");
  return new RegExp(`^${escaped}$`);
}

function matchesAnyGlob(file: string, globs: string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(file));
}

/** D-3 输入: 一份文档 ↔ 命中它覆盖源的变更文件子集, 喂给一个便宜叶。 */
export interface DriftAuditTask {
  doc: string;
  sourceGlobs: string[];
  anchors: string[];
  /** changedFiles 里落进 sourceGlobs 命中的那部分(触发这条任务的具体变更)。 */
  changedFiles: string[];
}

/**
 * D-3 审计图构造器。changedFiles = 自上次审计 stamp(盘上记 commit)以来的 diff 文件列表,
 * 调用方算好传入(git 交互不在本模块 —— 保持纯函数可测)。
 *
 * 覆盖源与 changedFiles 无交集的行不生成任务: 这一轮该文档描述的实现没动, 没有可疑的余地,
 * 生成空任务只是白花一次 Sonnet 调用。
 */
export function buildDriftAuditPlan(rows: DocsMapRow[], changedFiles: string[]): DriftAuditTask[] {
  const tasks: DriftAuditTask[] = [];
  for (const row of rows) {
    const hits = changedFiles.filter((f) => matchesAnyGlob(f, row.sourceGlobs));
    if (hits.length === 0) continue;
    tasks.push({ doc: row.doc, sourceGlobs: row.sourceGlobs, anchors: row.anchors, changedFiles: hits });
  }
  return tasks;
}

/**
 * 单条语义漂移证据。结构上是 `ExtractedFinding`(`../review/anchor-check` 消费的形状)的
 * 超集 —— 复用同一把反幻觉闸,不重造锚点校验。severity 固定按非阻断档(见下), 文档漂移不
 * 分 P0/P1 语义, 只是借闸的降级记账通道。
 */
export interface DriftAuditFinding {
  /** 触发这条 finding 的文档(docs-map 的 doc 列)。 */
  doc: string;
  /** 判据核心: 文档原句, 逐字引用(不许转述 —— 转述等于凭印象, 拦不出真漂移)。 */
  docQuote: string;
  /** 矛盾代码锚, 仓库相对路径。 */
  file: string;
  line?: number;
  /** 为什么这处代码和 docQuote 矛盾。 */
  claim: string;
  symbols: string[];
  dimension: string;
  /** anchor-check 复用需要的档位字段; 固定 'P1'(非阻断, 只是借闸的降级记账通道)。 */
  severity: "P0" | "P1";
}

/** 一个 DriftAuditTask 跑完一个叶后的回填。 */
export interface DriftAuditLeafResult {
  task: DriftAuditTask;
  /** 明确判定, 不是"没跑到"的默认值: true = findings 非空; false = 叶主动说"未见漂移"。 */
  driftFound: boolean;
  findings: DriftAuditFinding[];
}

export interface DriftAuditPlanResult {
  /** 合法锚点的 finding 转成的建议草稿, 供调用方 applySuggestions 落 suggested 票(D-4)。 */
  drafts: SuggestionDraft[];
  /** anchor-check 降级记账(幻觉锚 / 无锚 finding): 未落票, 但留痕 — 不是沉默丢弃。 */
  downgraded: AnchorFindingResult[];
}

/** 建议票标题长度上限(与 S-1 ticket-board 展示宽度对齐, 避免超长标题撑爆看板)。 */
const TITLE_MAX = 200;

/**
 * D-4 票出口: 汇总所有叶结果的 findings, 过 D-3 反幻觉闸(checkFindingAnchors), 只把
 * verdict='valid' 的那些转成 SuggestionDraft。幻觉锚 / 无锚 finding 被闸降级记账后原样
 * 透出(downgraded), 由调用方决定要不要另行告警 — 本函数不吞它们, 只是不让它们落票。
 */
export async function buildSuggestionDrafts(
  leafResults: DriftAuditLeafResult[],
  opts: { runId: string; cwd: string },
): Promise<DriftAuditPlanResult> {
  const allFindings = leafResults.flatMap((r) => r.findings);
  const check = await checkFindingAnchors(allFindings, opts.cwd);
  const validFindings = new Set(check.results.filter((r) => r.verdict === "valid").map((r) => r.finding));

  const drafts: SuggestionDraft[] = [];
  for (const f of allFindings) {
    if (!validFindings.has(f)) continue; // 幻觉锚 / 无锚: 已被闸降级记账, 不落票
    const title = `docs-drift: ${f.doc} 与 ${f.file}${f.line !== undefined ? `:${f.line}` : ""} 矛盾 — ${f.claim}`;
    drafts.push({ type: "task", title: title.slice(0, TITLE_MAX), suggestedBy: opts.runId });
  }
  return { drafts, downgraded: check.downgrades };
}
