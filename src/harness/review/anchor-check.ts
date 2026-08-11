/**
 * src/harness/review/anchor-check —— D-3 finding 反幻觉锚点闸
 * (蒸馏自 Cairness cc-subagent-evidence-check 的 E_EVIDENCE002 语义, SDD
 *  docs/plan/2026-08-10-cairness-distill-comparison.md)。
 *
 * 为什么: cross-model finding 幻觉引用是已知形态 —— 审查模型声称 `src/x.ts:9999` 有问题,
 * 而该文件只有 100 行 (或根本不存在), 锚点是编的。这个闸每条 finding 一次 stat 就能拦,
 * 零 LLM 成本 (INV-1: 确定性判据 + 非零退出码语义 + 失败输出含可定位证据)。
 *
 * 契约 (G-5): finding 锚 `src/x.ts:9999` 而文件仅 100 行 (或文件不存在) →
 *   该 finding 被标 invalid-anchor 且 Critical/Important 档降级记账;
 *   Given 整份 review 为未填模板 → 整体 skipped, 零误报。
 *
 * 判据 (确定性, 无模型):
 *   - valid        锚 = 仓库相对路径, 文件真实存在, 1 ≤ line ≤ 文件行数。
 *   - invalid-anchor  文件不存在 / line 越界 (或 ≤ 0) / 锚是绝对路径 (extract 契约要求
 *                    repo 相对路径, 绝对路径即出仓, 同属幻觉)。
 *   - no-anchor     finding 无 line (P0/P1 声称却拿不出锚点 = 无证据的 Critical 档)。
 *   - 降级记账:     P0/P1 档无合法锚点 (invalid-anchor 或 no-anchor) → 降级 (P0→P1,
 *                    P1→P2 非阻断档) 并进 downgrades 账本; red = 有降级 (闸红)。
 *   - 模板豁免:     整份产出未开始填 (无真 finding 行) → 整体 skipped, 零误报。
 */
import { isAbsolute, join } from 'node:path';
import type { ExtractedFinding } from './verify';

/** 单条 finding 的锚点裁定。 */
export type AnchorVerdict = 'valid' | 'invalid-anchor' | 'no-anchor';

export interface AnchorFindingResult {
  /** 原 finding (severity 保持原样 —— 账本记原档与降级后档, 不毁原证)。 */
  finding: ExtractedFinding;
  verdict: AnchorVerdict;
  /** 可定位证据 (INV-1): 锚原样 + 文件实情 (不存在 / 实有行数 / 绝对路径)。 */
  detail: string;
  /** P0/P1 档且无合法锚点 → 已降级。 */
  downgraded: boolean;
  /** 降级后档位: P0→P1, P1→P2 (P2 = 非阻断档, 不在 P0/P1 阻断集)。 */
  downgradedSeverity: 'P1' | 'P2';
}

export interface AnchorCheckResult {
  /** 整份产出未开始填 (无真 finding 行) → 整体跳过, 零误报 (G-5 第二 Given)。 */
  skipped: boolean;
  /** 每条 finding 的裁定 (skipped 时为空)。 */
  results: AnchorFindingResult[];
  /** 降级记账 (ledger): 每条 P0/P1 无合法锚点的 finding。 */
  downgrades: AnchorFindingResult[];
  /** 闸红 (INV-1 非零退出码语义): downgrades 非空即红。 */
  red: boolean;
}

/** 物理行数: 尾随换行不产生新行 ("第 N 行" = 第 N 个 \n 前的段); 空文件 0 行。 */
function lineCount(text: string): number {
  if (text === '') return 0;
  return text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length;
}

/**
 * 确定性锚点校验: 每条 finding 一次 stat / 读行数, 零 LLM (INV-1)。
 * cwd = 被审仓库根 (finding.file 按 extract 契约是 repo 相对路径)。
 */
export async function checkFindingAnchors(
  findings: ExtractedFinding[],
  cwd: string,
): Promise<AnchorCheckResult> {
  // 模板豁免 (G-5 第二 Given): 整份 review 为未填模板 → extract 无任何真 finding 行 →
  // 整体 skipped, 零误报 —— 未填的模板不是"锚点全部非法", 闸不能拿占位文本开刀。
  if (findings.length === 0) {
    return { skipped: true, results: [], downgrades: [], red: false };
  }

  const results: AnchorFindingResult[] = [];
  for (const f of findings) {
    let verdict: AnchorVerdict;
    let detail: string;
    if (!f.file || isAbsolute(f.file)) {
      verdict = 'invalid-anchor';
      detail = `锚 ${f.file ?? '(空)'} 非仓库相对路径 (extract 契约要求 repo 相对路径)`;
    } else if (f.line === undefined) {
      verdict = 'no-anchor';
      detail = `finding 无 line 锚点 (${f.file}) — P0/P1 声称却拿不出 file:line 证据`;
    } else if (!Number.isInteger(f.line) || f.line < 1) {
      verdict = 'invalid-anchor';
      detail = `锚 ${f.file}:${f.line} — line 必须为正整数`;
    } else {
      const file = Bun.file(join(cwd, f.file));
      if (!(await file.exists())) {
        verdict = 'invalid-anchor';
        detail = `锚 ${f.file}:${f.line} — 文件不存在于仓库 (${cwd})`;
      } else {
        const actual = lineCount(await file.text());
        if (f.line > actual) {
          verdict = 'invalid-anchor';
          detail = `锚 ${f.file}:${f.line} — 文件仅 ${actual} 行, line 越界`;
        } else {
          verdict = 'valid';
          detail = `锚 ${f.file}:${f.line} 成立 (文件 ${actual} 行)`;
        }
      }
    }
    // Critical/Important 档 (P0/P1) 无合法锚点 → 降级记账 (G-5 / D-3 原文)。
    const downgraded = verdict !== 'valid';
    const downgradedSeverity: 'P1' | 'P2' = f.severity === 'P0' ? 'P1' : 'P2';
    results.push({ finding: f, verdict, detail, downgraded, downgradedSeverity });
  }

  const downgrades = results.filter((r) => r.downgraded);
  return { skipped: false, results, downgrades, red: downgrades.length > 0 };
}
