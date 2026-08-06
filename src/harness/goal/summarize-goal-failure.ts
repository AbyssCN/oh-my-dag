import type { RunGoalResult } from './run-goal';
import { RUN_OUTCOME_INFO } from '../run-outcome';

/**
 * 失败摘要 (只进 `runRegistry.fail`)。与成功/取消路径的 `summarizeGoal` 分工:
 * 那边带 `goal:` 行 (要回答「目标是什么」), 这边只回答「怎么结束的、下一步干嘛」——
 * 再带一遍 goal 原文 = 两份真相, 会漂。所以本函数**不含 goal 原文**:
 * 只印非 success 阶段、criteria 缺席时不编判据行。
 */
export function summarizeGoalFailure(r: RunGoalResult): string {
  const lines: string[] = [];
  const info = RUN_OUTCOME_INFO[r.outcome];
  lines.push(`终止原因: ${r.outcome} (${info.loopState ?? '—'}) · 下一步: ${info.nextAction}`);
  lines.push(`converged: ${r.converged ? '收敛' : '未收敛'}`);
  lines.push(`rounds: ${r.rounds} 轮`);
  if (r.criteria) {
    lines.push(`criteria.judge: ${r.criteria.judge ? '过' : '没过'}`);
    lines.push(`criteria.oracle: ${r.criteria.oracle ? '过' : '没过'}`);
  } else {
    // 契约段就结束 → 两条判据一条都没判过, 不编。
    lines.push('criteria.judge: 没判过 (execute 没跑到)');
    lines.push('criteria.oracle: 没判过 (execute 没跑到)');
  }
  // 失败摘要只看没成的阶段; 全 success 时此段零行 (没有可诊断的失败)。
  for (const s of r.stages) {
    if (s.outcome !== 'success') {
      lines.push(`  [${s.outcome}${s.status === 'done' ? '' : `/${s.status}`}] ${s.stage} — ${s.summary.slice(0, 200)}`);
    }
  }
  return lines.join('\n');
}
