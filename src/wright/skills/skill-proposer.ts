/**
 * src/wright/skills/skill-proposer — Dream proposer → skill author 接缝 (Phase 2)。
 *
 * 闭合"复利产新能力"环: Dream 从 episodic memory 提炼**重复模式** → 候选 skill → quarantine 隔离观察 →
 * eval gate (T2 机械 trigger-rate) → 人工确认 → on-demand 启用。
 *
 * **SK-INV 铁律 (D67, SkillsBench 证全自主造 skill 平均零收益)**:
 *   - 禁全自主创建: 候选 → quarantine(dmi=1 不进 prompt, 隔离), **必经人工确认** (复用 ConfirmationQueue)。
 *   - 升级需 **T2 机械证据** (description_trigger_delta ≥ 0); **T4(LLM 自评)永不作主** —— 这里只认
 *     description_trigger_delta 这一机械信号, 天然排除 T4 (SK-INV-13)。
 *   - 不覆盖既有 skill (proposeSkillCandidate 遇同名既存即拒, 防 Dream 把 core 降级)。
 *
 * **接缝状态**: 契约 + gate + 人工确认 wiring 完整; **episodic 模式挖掘 (proposer fn) 是注入点** —— 真 LLM
 * miner 后续接 (flywheel opts.proposer)。无 miner 注入 → 不产候选 (seam dormant, 不空转)。
 */
import { skillId } from './scanner';
import type { SkillRegistry } from './registry';
import type { ConfirmationQueue } from './confirmation-queue';

/** Dream 提炼的候选 skill (proposer fn 产出)。 */
export interface SkillCandidate {
  name: string;
  description: string;
  /** 触发该提议的 episodic 模式 (人读溯源, 如 "repeated git-rebase cleanup, 5×")。 */
  source: string;
}

export type GateReason = 'not-found' | 'not-quarantine' | 'no-eval-evidence' | 'eval-negative';

/** 候选落 quarantine (dream-proposed, dmi=1 隔离)。同名既存 → 拒 (不覆盖)。 */
export function proposeSkillCandidate(
  registry: SkillRegistry,
  c: SkillCandidate,
): { created: boolean; reason?: 'exists' } {
  if (registry.getSkill(c.name)) return { created: false, reason: 'exists' };
  registry.upsertSkill({
    id: skillId(c.name),
    name: c.name,
    description: c.description,
    tier: 'quarantine',
    origin: 'dream-proposed',
    dmi: 1, // 隔离: 不进 prompt, 直到升级
  });
  return { created: true };
}

/** 升级闸 (SK-INV): 必 quarantine + 有 T2 eval 证据 (description_trigger_delta ≥ 0)。 */
export function canPromote(registry: SkillRegistry, name: string): { ok: true } | { ok: false; reason: GateReason } {
  const s = registry.getSkill(name);
  if (!s) return { ok: false, reason: 'not-found' };
  if (s.tier !== 'quarantine') return { ok: false, reason: 'not-quarantine' };
  const delta = registry.latestEventDelta(s.id, 'description_trigger_delta');
  if (delta === null) return { ok: false, reason: 'no-eval-evidence' }; // T4-only 在此被天然拒
  if (delta < 0) return { ok: false, reason: 'eval-negative' };
  return { ok: true };
}

/** 启用候选: quarantine→on-demand + dmi=0 (进 prompt)。gate 不过 → 拒 (返 reason)。 */
export function promoteSkill(registry: SkillRegistry, name: string): { ok: boolean; reason?: GateReason } {
  const v = canPromote(registry, name);
  if (!v.ok) return v;
  registry.setSkillTier(skillId(name), 'on-demand', 0);
  return { ok: true };
}

/** 把候选排进确认队 (apply=落 quarantine)。既存同名跳过。返新入队数。 */
export function enqueueProposals(registry: SkillRegistry, queue: ConfirmationQueue, candidates: SkillCandidate[]): number {
  let n = 0;
  for (const c of candidates) {
    if (registry.getSkill(c.name)) continue; // 既存 (真 skill 或已 quarantine)
    const added = queue.enqueue({
      key: `propose:${c.name}`,
      title: 'Dream 提议新 skill?',
      message: `从「${c.source}」提炼候选「${c.name}」: ${c.description}。起草进 quarantine (隔离观察, 需 eval+确认才启用)?`,
      apply: () => { proposeSkillCandidate(registry, c); },
    });
    if (added) n++;
  }
  return n;
}

/** 扫 quarantine 中 eval 已过的 → 排"启用"确认。返新入队数。 */
export function enqueuePromotions(registry: SkillRegistry, queue: ConfirmationQueue): number {
  let n = 0;
  for (const s of registry.listSkills({ tier: 'quarantine' })) {
    if (canPromote(registry, s.name).ok) {
      const added = queue.enqueue({
        key: `promote:${s.name}`,
        title: '启用 skill?',
        message: `quarantine skill「${s.name}」eval 已过 (T2 机械)。升为 on-demand 启用 (进 prompt)?`,
        apply: () => { promoteSkill(registry, s.name); },
      });
      if (added) n++;
    }
  }
  return n;
}
