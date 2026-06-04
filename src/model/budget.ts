/**
 * src/model/budget.ts — EvaluateBudget impl (ECON-3·fail-open, V2-ECON FROZEN CONTRACT).
 *
 * Budget state machine:
 *   limitUsd<=0 → fraction=0 + level='ok'  (无限额, 不降级)
 *   fraction>=1  → 'exhausted'
 *   fraction>=warnFraction (default 0.8) → 'warn'
 *   else         → 'ok'
 *
 * spentUsd 负值 clamp 到 0 (计量不下沉 ≈ 0 花费)。
 */
import type { EvaluateBudget } from './econ-types';

export const evaluateBudget: EvaluateBudget = (spentUsd, limitUsd, opts = {}) => {
  const warnFraction = opts.warnFraction ?? 0.8;

  // ECON-3: 无限额 / 无效限额 → 不降级, fraction=0
  if (limitUsd <= 0) {
    return { spentUsd, limitUsd, fraction: 0, level: 'ok' };
  }

  const fraction = Math.max(0, spentUsd) / limitUsd;

  const level = fraction >= 1 ? 'exhausted' : fraction >= warnFraction ? 'warn' : 'ok';

  return { spentUsd, limitUsd, fraction, level };
};
