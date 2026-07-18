/**
 * src/harness/plan/momus-gate.ts — Quantitative plan gate (SDD D-4 / P2).
 *
 * MG-1: MomusGate.check(plan) → { pass, scores, failures }
 * MG-2: 5 criteria, independently configurable thresholds
 * MG-3: REJECT → specific failing criteria
 * MG-4: Zero AI calls, pure code
 * MG-5: Accepts SDD markdown path, parses GWT blocks + impl scope tables
 */
import { existsSync, readFileSync } from 'node:fs';
import type {
  MomusResult,
  MomusScores,
  MomusThresholds,
  PlanMetrics,
} from './types';
import { DEFAULT_THRESHOLDS } from './types';

// ── Markdown parsing helpers ──────────────────────────────────────

/** Extract GWT yaml blocks from markdown. Returns array of parsed yaml-like key-value blocks. */
function extractGWTBlocks(md: string): string[] {
  const blocks: string[] = [];
  const re = /```ya?ml\s*\n(contract:|gwt:)[\s\S]*?```/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md)) !== null) {
    blocks.push(m[0]);
  }
  return blocks;
}

/** Parse a markdown table into rows (each row = array of column values). */
function parseMarkdownTable(md: string, sectionHeader: string): string[][] {
  // Find the section header, then the first table after it
  const headerIdx = md.indexOf(sectionHeader);
  if (headerIdx === -1) return [];

  const afterHeader = md.slice(headerIdx);
  // Match markdown table: header row, separator row, data rows
  const tableRe = /\|([^\n]+)\|\n\|[-:\s|]+\|\n((?:\|[^\n]+\|\n?)+)/;
  const m = tableRe.exec(afterHeader);
  if (!m) return [];

  const dataRows = m[2]!.trim().split('\n');
  return dataRows
    .map((row) =>
      row
        .split('|')
        .slice(1, -1) // strip leading/trailing |
        .map((cell) => cell.trim()),
    )
    .filter((row) => row.length > 0);
}

/** Extract "实现范围" / "Implementation scope" table rows. */
function extractImplScopeTable(md: string): string[][] {
  // Try multiple common headers
  for (const header of ['实现范围', 'Implementation scope', '实现计划', 'Implementation plan']) {
    const rows = parseMarkdownTable(md, header);
    if (rows.length > 0) return rows;
  }
  // Fallback: find any table after "### 实现" or "### Implement"
  const implSection = /###\s*(实现|Implement)[^\n]*\n([\s\S]*?)(?=\n##|\n###|$)/.exec(md);
  if (implSection) {
    const tableRe = /\|([^\n]+)\|\n\|[-:\s|]+\|\n((?:\|[^\n]+\|\n?)+)/;
    const tm = tableRe.exec(implSection[2]!);
    if (tm) {
      return tm[2]!.trim().split('\n').map((row) =>
        row.split('|').slice(1, -1).map((cell) => cell.trim()),
      ).filter((row) => row.length > 0);
    }
  }
  return [];
}

/** Count GWT test cases (lines matching "given/when/then" in GWT blocks). */
function countGWTCases(gwtBlocks: string[]): number {
  let count = 0;
  for (const block of gwtBlocks) {
    const gwtRe = /^\s*(given|when|then)\s*:/gim;
    const matches = block.match(gwtRe);
    if (matches) count += matches.length;
  }
  return count;
}

/** Check if a declared file exists (relative to cwd). */
function fileHasRef(declaredFile: string): boolean {
  // Clean the path: strip backticks, leading/trailing whitespace
  const clean = declaredFile.replace(/`/g, '').trim();
  if (!clean || clean === '—' || clean === '-') return false;
  return existsSync(clean);
}

/** Check if a task description mentions a testable acceptance criterion. */
function hasTestableAcceptance(cells: string[]): boolean {
  const text = cells.join(' ').toLowerCase();
  const indicators = [
    'oracle:', 'gwt:', 'bun test', 'tsc', 'test:', '验收',
    'assert', 'expect(', 'verify', '验证',
  ];
  return indicators.some((i) => text.includes(i));
}

/** Check if a task requires business logic assumptions. */
function hasBusinessAssumptions(cells: string[]): boolean {
  const text = cells.join(' ').toLowerCase();
  const indicators = [
    'assume', '假设', 'should probably', 'likely', 'maybe',
    'TBD', 'TODO', '待定', '待确认',
  ];
  return indicators.some((i) => text.includes(i));
}

/** Check if a task has critical red flags. */
function hasCriticalRedFlag(cells: string[]): boolean {
  const text = cells.join(' ').toLowerCase();
  const flags = [
    '⚠', 'critical', 'blocker', 'P0', '安全', 'security',
    '数据丢失', 'data loss', 'DROP', 'DELETE',
    'schema change', 'migration', '无回滚',
  ];
  return flags.some((f) => text.includes(f));
}

// ── Metrics extraction ────────────────────────────────────────────

function extractMetrics(md: string): PlanMetrics {
  const gwtBlocks = extractGWTBlocks(md);
  const implRows = extractImplScopeTable(md);

  // File analysis
  const fileRe = /(?:`([^`]+\.(?:ts|tsx|sql|md|json|ya?ml))`|(?:\*\*文件\*\*.*?`([^`]+)`))/gi;
  const declaredFiles = new Set<string>();
  let fm: RegExpExecArray | null;
  while ((fm = fileRe.exec(md)) !== null) {
    const f = fm[1] || fm[2];
    if (f) declaredFiles.add(f);
  }

  // Fallback: extract files from "文件" column in impl scope table
  for (const row of implRows) {
    // First column is usually the file path
    const fileCol = row[0]?.replace(/`/g, '').trim();
    if (fileCol && /\.[a-z]{2,4}$/i.test(fileCol)) {
      declaredFiles.add(fileCol);
    }
  }

  const totalDeclaredFiles = declaredFiles.size;
  const filesWithRef = [...declaredFiles].filter((f) => fileHasRef(f)).length;

  // Task analysis from impl scope table
  const totalTasks = implRows.length;
  let tasksWithSource = 0;
  let tasksWithTestableAcceptance = 0;
  let tasksWithBusinessAssumptions = 0;
  let tasksWithCriticalRedFlags = 0;

  for (const row of implRows) {
    // Check for reference source (column with URL, file path, or doc reference)
    const hasSource = row.some(
      (cell) =>
        cell.startsWith('http') ||
        cell.startsWith('docs/') ||
        cell.startsWith('src/') ||
        cell.startsWith('.') ||
        cell.includes('参考') ||
        cell.includes('reference'),
    );
    if (hasSource) tasksWithSource++;

    if (hasTestableAcceptance(row)) tasksWithTestableAcceptance++;
    if (hasBusinessAssumptions(row)) tasksWithBusinessAssumptions++;
    if (hasCriticalRedFlag(row)) tasksWithCriticalRedFlags++;
  }

  // GWT-based fallback for testable acceptance
  const gwtCases = countGWTCases(gwtBlocks);
  if (gwtCases > 0 && tasksWithTestableAcceptance === 0) {
    // If no tasks explicitly mention test acceptance but there are GWT blocks,
    // assume at least some tasks are testable (conservative estimate)
    tasksWithTestableAcceptance = Math.max(tasksWithTestableAcceptance, Math.min(totalTasks, gwtCases));
  }

  return {
    totalDeclaredFiles,
    filesWithRef,
    totalTasks,
    tasksWithSource,
    tasksWithTestableAcceptance,
    tasksWithBusinessAssumptions,
    tasksWithCriticalRedFlags,
  };
}

// ── Scoring ───────────────────────────────────────────────────────

function computeScores(m: PlanMetrics): MomusScores {
  return {
    fileRefCoverage: m.totalDeclaredFiles > 0
      ? m.filesWithRef / m.totalDeclaredFiles
      : 1,
    referenceSourceRatio: m.totalTasks > 0
      ? m.tasksWithSource / m.totalTasks
      : 1,
    testableAcceptance: m.totalTasks > 0
      ? m.tasksWithTestableAcceptance / m.totalTasks
      : 1,
    businessAssumptions: m.tasksWithBusinessAssumptions,
    criticalRedFlags: m.tasksWithCriticalRedFlags,
  };
}

function evaluateScores(
  scores: MomusScores,
  thresholds: MomusThresholds,
): string[] {
  const failures: string[] = [];

  if (scores.fileRefCoverage < thresholds.fileRefCoverage) {
    failures.push(
      `文件引用覆盖 ${(scores.fileRefCoverage * 100).toFixed(0)}% < ${(thresholds.fileRefCoverage * 100).toFixed(0)}%`,
    );
  }

  if (scores.referenceSourceRatio < thresholds.referenceSourceRatio) {
    failures.push(
      `参考源比率 ${(scores.referenceSourceRatio * 100).toFixed(0)}% < ${(thresholds.referenceSourceRatio * 100).toFixed(0)}%`,
    );
  }

  if (scores.testableAcceptance < thresholds.testableAcceptance) {
    failures.push(
      `可测验收比率 ${(scores.testableAcceptance * 100).toFixed(0)}% < ${(thresholds.testableAcceptance * 100).toFixed(0)}%`,
    );
  }

  if (scores.businessAssumptions > thresholds.businessAssumptions) {
    failures.push(
      `${scores.businessAssumptions} 个业务逻辑假设任务（阈值=${thresholds.businessAssumptions}）`,
    );
  }

  if (scores.criticalRedFlags > thresholds.criticalRedFlags) {
    failures.push(
      `${scores.criticalRedFlags} 个 critical red flag 任务（阈值=${thresholds.criticalRedFlags}）`,
    );
  }

  return failures;
}

// ── MomusGate ─────────────────────────────────────────────────────

export class MomusGate {
  private readonly thresholds: MomusThresholds;

  constructor(thresholds: Partial<MomusThresholds> = {}) {
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...thresholds };
  }

  /**
   * Check a plan (SDD markdown file path) against Momus criteria.
   * MG-1/MG-5: reads file, extracts metrics, scores, returns result.
   */
  check(planPath: string): MomusResult {
    let md: string;
    try {
      md = readFileSync(planPath, 'utf-8');
    } catch {
      return {
        pass: false,
        scores: {
          fileRefCoverage: 0,
          referenceSourceRatio: 0,
          testableAcceptance: 0,
          businessAssumptions: 0,
          criticalRedFlags: 0,
        },
        failures: [`无法读取计划文件: ${planPath}`],
      };
    }

    const metrics = extractMetrics(md);
    const scores = computeScores(metrics);
    const failures = evaluateScores(scores, this.thresholds);

    return { pass: failures.length === 0, scores, failures };
  }

  /**
   * Check a plan from raw markdown string (for in-memory testing).
   */
  checkString(md: string): MomusResult {
    // Special case: truly empty/whitespace-only plan
    if (md.trim().length === 0) {
      return {
        pass: false,
        scores: {
          fileRefCoverage: 0,
          referenceSourceRatio: 0,
          testableAcceptance: 0,
          businessAssumptions: 0,
          criticalRedFlags: 0,
        },
        failures: ['计划文件为空 — 无任何内容可评估'],
      };
    }

    const metrics = extractMetrics(md);
    const scores = computeScores(metrics);
    const failures = evaluateScores(scores, this.thresholds);

    // Additional check: if no tasks and no files declared, plan is incomplete
    if (metrics.totalTasks === 0 && metrics.totalDeclaredFiles === 0) {
      failures.push('计划未声明任何文件或任务 — 缺少实现范围表');
    }

    return { pass: failures.length === 0, scores, failures };
  }

  get thresholdsConfig(): MomusThresholds {
    return { ...this.thresholds };
  }
}

/** Convenience: create default MomusGate and check a plan path. */
export function checkPlan(
  planPath: string,
  thresholds?: Partial<MomusThresholds>,
): MomusResult {
  const gate = new MomusGate(thresholds);
  return gate.check(planPath);
}
