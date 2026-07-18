/**
 * src/harness/plan/metis-stage.ts — Gap analysis stage (SDD D-4 / P2).
 *
 * MT-1: Independent mandatory stage after grill-me, before oracle.
 * MT-2: Outputs MetisReport = { gaps, coverage, assumptions }.
 * MT-3: Gaps sorted by severity: blocker > major > minor.
 * MT-4: Each gap has: description + impact scope + suggested fix.
 *
 * Zero AI calls — pure static analysis of SDD markdown.
 */
import { readFileSync } from 'node:fs';
import type { Gap, MetisReport, CoverageMap, GapSeverity } from './types';

// ── Coverage analysis ─────────────────────────────────────────────

interface SDDParsed {
  declaredFiles: string[];
  referencedSources: string[];
  gwtBlocks: string[];
  oracleCommands: string[];
  assumptions: string[];
  todos: string[];
  warnings: string[];
  contractSections: string[];
  migrationMentions: boolean;
}

function parseSDD(md: string): SDDParsed {
  // Files declared (backtick-wrapped paths ending in known extensions)
  const fileRe = /`([^`]+\.(?:tsx?|sql|json|ya?ml|md|css))`/gi;
  const declaredFiles: string[] = [];
  let fm: RegExpExecArray | null;
  while ((fm = fileRe.exec(md)) !== null) {
    declaredFiles.push(fm[1]!);
  }

  // Referenced sources (URLs and doc paths)
  const sourceRe = /(?:https?:\/\/[^\s)]+|docs\/[^\s)]+\.md|src\/[^\s)]+\.tsx?)/gi;
  const referencedSources: string[] = [];
  let sm: RegExpExecArray | null;
  while ((sm = sourceRe.exec(md)) !== null) {
    referencedSources.push(sm[0]);
  }

  // GWT blocks
  const gwtRe = /```ya?ml\s*\n(?:contract:|gwt:)[\s\S]*?```/gi;
  const gwtBlocks: string[] = [];
  let gm: RegExpExecArray | null;
  while ((gm = gwtRe.exec(md)) !== null) {
    gwtBlocks.push(gm[0]);
  }

  // Oracle commands (bun test, tsc, build) — scan code blocks for "bun " lines.
  // Non-greedy regex fails on adjacent blocks (yaml ``` then bash ```).
  // Instead: manually scan for block boundaries by index.
  const oracleCommands: string[] = [];
  let idx = 0;
  while (idx < md.length) {
    const openIdx = md.indexOf('```', idx);
    if (openIdx === -1) break;
    // Read optional language tag on this line
    const lineEnd = md.indexOf('\n', openIdx);
    const openLine = lineEnd === -1 ? md.slice(openIdx) : md.slice(openIdx, lineEnd);
    const closeIdx = md.indexOf('\n```', openIdx + 3);
    if (closeIdx === -1) break;
    const content = md.slice(lineEnd + 1, closeIdx);
    // Check for bun commands in this code block
    if (content.trim().length > 0) {
      const lines = content.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (/^bun\s+(test|run|tsc)\b/.test(trimmed)) {
          oracleCommands.push(trimmed);
        }
      }
    }
    idx = closeIdx + 4; // skip past closing ```
  }

  // Assumptions/TODOs/Warnings
  const assumptionRe = /(?:> \*\*⚠|assume|假设|TBD|TODO|FIXME|待定|待确认)/gi;
  const assumptions: string[] = [];
  let am: RegExpExecArray | null;
  while ((am = assumptionRe.exec(md)) !== null) {
    const line = getLineAt(md, am.index);
    assumptions.push(line.trim());
  }

  const todoRe = /^(?:- \[ \]|TODO:|FIXME:)/gim;
  const todos: string[] = [];
  let tm: RegExpExecArray | null;
  while ((tm = todoRe.exec(md)) !== null) {
    const line = getLineAt(md, tm.index);
    todos.push(line.trim());
  }

  const warnRe = /⚠\s*\*{0,2}[^*\n]+/g;
  const warnings: string[] = [];
  let wm: RegExpExecArray | null;
  while ((wm = warnRe.exec(md)) !== null) {
    warnings.push(wm[0].trim());
  }

  // Contract sections
  const contractRe = /```ya?ml\s*\ncontract:[\s\S]*?```/gi;
  const contractSections: string[] = [];
  let cm: RegExpExecArray | null;
  while ((cm = contractRe.exec(md)) !== null) {
    contractSections.push(cm[0]);
  }

  const migrationMentions = /migration/i.test(md);

  return {
    declaredFiles,
    referencedSources,
    gwtBlocks,
    oracleCommands,
    assumptions,
    todos,
    warnings,
    contractSections,
    migrationMentions,
  };
}

function getLineAt(md: string, idx: number): string {
  const start = md.lastIndexOf('\n', idx) + 1;
  const end = md.indexOf('\n', idx);
  return end === -1 ? md.slice(start) : md.slice(start, end);
}

// ── Severity ordering ─────────────────────────────────────────────

const SEVERITY_ORDER: Record<GapSeverity, number> = {
  blocker: 0,
  major: 1,
  minor: 2,
};

// ── Metis analysis ────────────────────────────────────────────────

function analyzeGaps(parsed: SDDParsed): Gap[] {
  const gaps: Gap[] = [];

  // Blocker: no GWT blocks found
  if (parsed.gwtBlocks.length === 0 && parsed.oracleCommands.length === 0) {
    gaps.push({
      severity: 'blocker',
      description: 'SDD 缺少 GWT 契约块 (```yaml contract:/gwt:) 且无 oracle 命令',
      impactScope: '无法验证实现是否符合设计规格',
      suggestedFix: '为每个模块添加 contract: 和 gwt: yaml 块，定义可测契约',
    });
  }

  // Blocker: no oracle commands with GWT
  if (parsed.gwtBlocks.length > 0 && parsed.oracleCommands.length === 0) {
    gaps.push({
      severity: 'blocker',
      description: '有 GWT 契约但缺少 oracle 命令 (bun test / bun tsc)',
      impactScope: '契约定义了但无法运行验证，形同虚设',
      suggestedFix: '在 Oracle 节添加 `bun test --test-glob` 命令',
    });
  }

  // Major: declared files without contract coverage
  if (parsed.declaredFiles.length > 0 && parsed.contractSections.length === 0) {
    gaps.push({
      severity: 'major',
      description: `声明了 ${parsed.declaredFiles.length} 个文件但无 contract sections`,
      impactScope: '接口契约缺失 → 实现可能偏离设计',
      suggestedFix: '为核心模块添加 contract: yaml 段 (不变量 + GWT)',
    });
  }

  // Major: migration mentioned but no rollback plan
  if (parsed.migrationMentions) {
    const hasRollback = /rollback|回滚|down.*migration/i.test(
      parsed.declaredFiles.join(' ') + ' ' + parsed.referencedSources.join(' '),
    );
    if (!hasRollback) {
      gaps.push({
        severity: 'major',
        description: '涉及 migration 但未提及回滚方案',
        impactScope: '数据库迁移无回滚路径 = 生产风险',
        suggestedFix: '添加回滚 SQL 或 migration down 说明',
      });
    }
  }

  // Major: open TODOs
  if (parsed.todos.length > 0) {
    gaps.push({
      severity: 'major',
      description: `${parsed.todos.length} 个开放的 TODO/FIXME`,
      impactScope: parsed.todos.slice(0, 3).join('; '),
      suggestedFix: '关闭所有 TODO 或转为 tracked issue',
    });
  }

  // Minor: assumptions present
  for (const a of parsed.assumptions.slice(0, 3)) {
    gaps.push({
      severity: 'minor',
      description: `未验证假设: ${a.substring(0, 80)}`,
      impactScope: '假设错误可能导致实现方向偏差',
      suggestedFix: '将假设转为可验证的 GWT 用例或标注验证方式',
    });
  }

  // Minor: warnings
  for (const w of parsed.warnings.slice(0, 5)) {
    if (!gaps.some((g) => g.description.includes(w.substring(0, 20)))) {
      gaps.push({
        severity: 'minor',
        description: `警告: ${w.substring(0, 80)}`,
        impactScope: '标记的风险点未消除',
        suggestedFix: '消除警告或显式接受并记录原因',
      });
    }
  }

  return gaps.sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
  );
}

function buildCoverageMap(parsed: SDDParsed): CoverageMap {
  const refSet = new Set(
    parsed.referencedSources.map((s) => s.replace(/^.*\//, '')),
  );
  const fileSet = new Set(
    parsed.declaredFiles.map((f) => f.replace(/^.*\//, '')),
  );

  const covered: string[] = [];
  const uncovered: string[] = [];

  for (const f of fileSet) {
    if (refSet.has(f) || [...refSet].some((r) => f.includes(r) || r.includes(f))) {
      covered.push(f);
    } else {
      uncovered.push(f);
    }
  }

  return { covered, uncovered };
}

// ── MetisStage ─────────────────────────────────────────────────────

export class MetisStage {
  /**
   * Analyze an SDD markdown file and produce a gap report.
   * MT-1: Independent stage. MT-2: Returns MetisReport.
   */
  analyze(planPath: string): MetisReport {
    let md: string;
    try {
      md = readFileSync(planPath, 'utf-8');
    } catch {
      return {
        gaps: [
          {
            severity: 'blocker',
            description: `无法读取计划文件: ${planPath}`,
            impactScope: '无法进行缺口分析',
            suggestedFix: '确认文件路径正确且可读',
          },
        ],
        coverage: { covered: [], uncovered: [] },
        assumptions: [],
      };
    }

    const parsed = parseSDD(md);
    const gaps = analyzeGaps(parsed);
    const coverage = buildCoverageMap(parsed);
    const assumptions = parsed.assumptions;

    return { gaps, coverage, assumptions };
  }

  /**
   * Analyze from raw markdown string.
   */
  analyzeString(md: string): MetisReport {
    const parsed = parseSDD(md);
    return {
      gaps: analyzeGaps(parsed),
      coverage: buildCoverageMap(parsed),
      assumptions: parsed.assumptions,
    };
  }
}

/** Convenience: run Metis analysis on a plan file. */
export function analyzePlan(planPath: string): MetisReport {
  return new MetisStage().analyze(planPath);
}
