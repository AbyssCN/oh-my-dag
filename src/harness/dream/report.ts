/**
 * src/harness/dream/report —— dream SDD §S6 report 生成器 (零 LLM)。
 *
 * 列 (两侧都写, SDD §S6):
 *   added / evolved / promoted / pruned / rejected(按 reason 分组) / NOOP /
 *   llmCalls / costUsd + 三态列 (never-extracted / extracted-then-pruned / not-applicable)。
 *
 * NULL ≠ 0 ≠ 不适用: 没记的写 NULL, 不补零。
 * rejected 按 reason 分组, 否则「闸太紧」与「LLM 太野」读数相同。
 */
import type { MergeReport } from './merge';
import type { PromoteReport } from './promote';
import type { GatherReport } from './gather';
import type { DreamCandidate } from './validate';

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export interface DreamRunReport {
  /** 本次 run id。 */
  runId: string;
  /** 总结果: true = 全部成功, false = 预算超限或阶段失败。 */
  ok: boolean;
  /** 失败原因 (ok=false 时有值)。 */
  failReason?: string;

  // ── 计数 (S2 merge) ──
  added: number;
  evolved: number;
  replaced: number;
  rejected: Array<{ candidate: DreamCandidate; reason: string }>;

  // ── 计数 (S3 promote + prune) ──
  promoted: number;
  pruned: number;

  // ── 计数 (S1 gather) ──
  dirtyTotal: number;
  /** 全 clean → true (零 LLM, SDD 判据 1)。 */
  skippedClean: boolean;

  // ── LLM 成本 ──
  llmCalls: number;
  costUsd: number;

  // ── 三态列 (S3 prune 级, SDD §S3 行 288-291; 本版记录, 清理动作留 TODO) ──
  neverExtracted: number | null;
  extractedThenPruned: number | null;
  notApplicable: number | null;

  // ── NOOP (两次跑结果相同) ──
  /** 同数据二跑 created-count 归零 (identityKey 兜底)。 */
  noop: boolean;
}

export interface DreamReportOpts {
  runId: string;
  gather: GatherReport;
  merge: MergeReport;
  promote: PromoteReport;
  llmCalls: number;
  costUsd: number;
  /** 可选: 三态计数 (prune 时一起算, 本版先记 NULL 占位)。 */
  neverExtracted?: number | null;
  extractedThenPruned?: number | null;
  notApplicable?: number | null;
}

// ---------------------------------------------------------------------------
// 构造
// ---------------------------------------------------------------------------

export function buildDreamReport(opts: DreamReportOpts): DreamRunReport {
  const report: DreamRunReport = {
    runId: opts.runId,
    ok: opts.merge.ok && opts.promote.ok,
    failReason: opts.merge.failReason,
    added: opts.merge.added,
    evolved: opts.merge.evolved,
    replaced: opts.merge.replaced,
    rejected: opts.merge.rejected,
    promoted: opts.promote.promoted,
    pruned: opts.promote.pruned,
    dirtyTotal: opts.gather.dirtyTotal,
    skippedClean: opts.gather.skippedClean,
    llmCalls: opts.llmCalls,
    costUsd: opts.costUsd,
    neverExtracted: opts.neverExtracted ?? null,
    extractedThenPruned: opts.extractedThenPruned ?? null,
    notApplicable: opts.notApplicable ?? null,
    noop: opts.gather.skippedClean && opts.merge.added === 0 && opts.merge.evolved === 0,
  };
  return report;
}

// ---------------------------------------------------------------------------
// 格式化
// ---------------------------------------------------------------------------

/**
 * rejected 按 reason 前缀(首个冒号前)分组。
 * 全串分组会让每条独特判词自成一组,「闸太紧」与「LLM 太野」仍读数相同
 * (SDD §S6 report 列的分组理由);前缀聚合与 S5 live 验收的分组口径一致。
 */
export function groupRejectedByReason(
  rejected: Array<{ candidate: DreamCandidate; reason: string }>,
): Record<string, number> {
  const groups: Record<string, number> = {};
  for (const { reason } of rejected) {
    const key = `${reason.split(':')[0]}:`;
    groups[key] = (groups[key] ?? 0) + 1;
  }
  return groups;
}

/** 人读报告行。 */
export function formatDreamReport(r: DreamRunReport): string {
  const lines: string[] = [];
  lines.push(`dream run ${r.runId} — ${r.ok ? 'OK' : 'FAIL'}`);
  if (r.failReason) lines.push(`  failReason: ${r.failReason}`);
  lines.push('');
  lines.push('── 采集 ──');
  lines.push(`  dirtyTotal: ${r.dirtyTotal}`);
  lines.push(`  skippedClean: ${r.skippedClean}`);
  lines.push('');
  lines.push('── 写入 ──');
  lines.push(`  added:     ${r.added}`);
  lines.push(`  evolved:   ${r.evolved}`);
  lines.push(`  replaced:  ${r.replaced}`);
  lines.push(`  promoted:  ${r.promoted}`);
  lines.push(`  pruned:    ${r.pruned}`);
  lines.push(`  NOOP:      ${r.noop}`);
  lines.push('');
  lines.push('── 拒入 ──');
  if (r.rejected.length === 0) {
    lines.push('  (none)');
  } else {
    const grouped = groupRejectedByReason(r.rejected);
    for (const [reason, count] of Object.entries(grouped)) {
      lines.push(`  ${reason}: ${count}`);
    }
  }
  lines.push('');
  lines.push('── 成本 ──');
  lines.push(`  llmCalls:  ${r.llmCalls}`);
  lines.push(`  costUsd:   $${r.costUsd.toFixed(6)}`);
  lines.push('');
  lines.push('── 三态 ──');
  lines.push(`  never-extracted:        ${r.neverExtracted === null ? 'NULL' : r.neverExtracted}`);
  lines.push(`  extracted-then-pruned:  ${r.extractedThenPruned === null ? 'NULL' : r.extractedThenPruned}`);
  lines.push(`  not-applicable:         ${r.notApplicable === null ? 'NULL' : r.notApplicable}`);
  return lines.join('\n');
}
