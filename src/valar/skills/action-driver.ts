/**
 * src/valar/skills/action-driver — substrate 运行时数据 → author/optimize 建议 (Phase 1, the owner 约束③)。
 *
 * 纯查询无副作用: 读 skills.use_count / latest description_trigger_delta / has_eval / decayCandidates,
 * 输出"造哪个/优化哪个/补 eval/退役哪个"的具体指令。**建议来自 SQL 不来自 LLM 猜** (约束③ 命门)。
 *
 * 三问决策树 (Phase 1 真有数据源的三条, anti-slop 不堆未用规则):
 *   ① delta 退化 → optimize: 某 skill 最新 description_trigger_delta < 阈值 (描述触发在变差)
 *   ② 高频无 eval → add-eval: use_count ≥ 阈值 但 has_eval=0 (用得多却无法进化, SK-INV-2)
 *   ③ 陈旧 → retire: decayCandidates (freq=0/staleDays, core/rare_critical 已豁免)
 */
import type { SkillRegistry, SkillRow } from './registry';

export type SkillActionKind = 'optimize' | 'add-eval' | 'retire';

export interface SkillAction {
  kind: SkillActionKind;
  skill: string;
  /** 人读理由, 携带触发该建议的真实数值。 */
  reason: string;
  /** 该建议的证据数值 (delta / use_count / 空闲天数), 供 --json 消费。 */
  evidence: Record<string, number | string | null>;
}

export interface SuggestOptions {
  /** description_trigger_delta 低于此判退化 (默认 0 = 任何负向)。 */
  regressThreshold?: number;
  /** use_count ≥ 此且无 eval → 建议补 eval (默认 3)。 */
  minUseForEval?: number;
  /** retire 的空闲天数 (默认 90, 透传 decayCandidates)。 */
  staleDays?: number;
}

/** 读 registry 当前态, 产出建议清单。确定性: 同库同入参 → 同输出。 */
export function suggestActions(registry: SkillRegistry, opts: SuggestOptions = {}): SkillAction[] {
  const regressThreshold = opts.regressThreshold ?? 0;
  const minUseForEval = opts.minUseForEval ?? 3;
  const staleDays = opts.staleDays ?? 90;

  const actions: SkillAction[] = [];
  const skills = registry.listSkills();

  for (const s of skills) {
    // ① delta 退化 → optimize
    const delta = registry.latestEventDelta(s.id, 'description_trigger_delta');
    if (delta !== null && delta < regressThreshold) {
      actions.push({
        kind: 'optimize',
        skill: s.name,
        reason: `description_trigger_delta=${delta} < ${regressThreshold} — 描述触发在退化, 建议 optimize`,
        evidence: { description_trigger_delta: delta, threshold: regressThreshold },
      });
    }
    // ② 高频无 eval → add-eval (无 eval 不能 skillopt, SK-INV-2)
    if (s.has_eval === 0 && s.use_count >= minUseForEval) {
      actions.push({
        kind: 'add-eval',
        skill: s.name,
        reason: `use_count=${s.use_count} ≥ ${minUseForEval} 但无 eval/ — 高频却无法进化, 建议 eval-generate`,
        evidence: { use_count: s.use_count, minUseForEval },
      });
    }
  }

  // ③ 陈旧 → retire (decayCandidates 已豁免 core/rare_critical)
  for (const d of registry.decayCandidates(staleDays) as SkillRow[]) {
    const idleDays = d.last_used_at === null ? -1 : Math.floor((Date.now() - d.last_used_at) / 86_400_000);
    actions.push({
      kind: 'retire',
      skill: d.name,
      reason: d.last_used_at === null
        ? `从未被用 (last_used_at=null) — 建议 retire 或确认 rare_critical`
        : `空闲 ${idleDays}d ≥ ${staleDays}d — 建议 retire`,
      evidence: { idle_days: idleDays, staleDays, last_used_at: d.last_used_at },
    });
  }

  return actions;
}
