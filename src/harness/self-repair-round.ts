/**
 * 自修环 R2 轮表纯函数。
 *
 * 接线只消费这里的模板、判据 diff、集合比对和策略槽。判据 diff 保留三种状态：
 * 首轮没有历史、当前输出不可解析、两侧都有可解析红集；不把 null 缩成空数组。
 */
export type CriteriaDiff =
  | { kind: 'first-round'; literal: typeof FIRST_ROUND_LITERAL }
  | { kind: 'unparsable'; literal: typeof UNPARSABLE_LITERAL }
  | { kind: 'diff'; added: string[]; removed: string[] };

/**
 * 两种「没有 diff」各带**逐字**的字面（照 spin-route 的 `no-history` 先例）。
 *
 * 读 follow-up 的是模型，不是编译器：裸写 `first-round` / `unparsable` 这两个英文单词，
 * 它得不到「为什么没有 diff」这条信息，而两种缺席该让它做的事恰好相反 ——
 * 首轮该照常修，不可解析该去看判据本身跑的是什么。
 */
export const FIRST_ROUND_LITERAL = '本轮是第 1 轮，没有上一轮红集可比' as const;
export const UNPARSABLE_LITERAL = '判据判红但输出里没有可解析的 (fail) 行，无判据可 diff' as const;

/** 四槽全部必填。缺任一槽由 TypeScript 拒绝，不提供默认值或 Partial。 */
export interface RepairFollowUpSlots {
  criteriaScene: string;
  criteriaDiff: CriteriaDiff;
  previousAttempt: string;
  strategy: string;
}

/** 两侧红集的机械差异；两份清单都排序去重，交集只保留在语义上未变化。 */
export interface CriteriaFailuresDiff {
  added: string[];
  removed: string[];
}

/**
 * 比较上一轮和本轮可解析红集。
 * 集合比较本身只接受非 null；接线层负责把 null 先构为三态判据 diff。
 */
export function compareCriteriaFailures(
  previous: readonly string[],
  current: readonly string[],
): CriteriaFailuresDiff {
  const previousSet = new Set(previous);
  const currentSet = new Set(current);
  return {
    added: [...currentSet].filter((failure) => !previousSet.has(failure)).sort(),
    removed: [...previousSet].filter((failure) => !currentSet.has(failure)).sort(),
  };
}

/**
 * 依据两轮红集构造显式三态；null 永不伪装成稳定。
 *
 * ⚠ `previousFailures === null` 有**两个**来源，它们必须分开（静默坑 1：NULL ≠ NULL）：
 * ① 根本没有上一轮（首轮）；② 有上一轮，但那一轮的输出不可解析。
 * 光看 `previousFailures` 分不出来，所以「有没有上一轮」由调用方显式给 —— 缺省沿用
 * 老口径（`previousFailures !== null` 即视为有上一轮），既有两参调用零行为变化。
 *
 * 不分开的后果是实测出来的：判据是 `tsc` 这类从不产 (fail) 行的命令时，每一轮的红集都是
 * null，于是**每一轮**都报 first-round —— 三态在这个判据身上退化成一态，而它恰是生产常用判据。
 */
export function buildCriteriaDiff(
  previousFailures: readonly string[] | null,
  currentFailures: readonly string[] | null,
  hasPreviousRound: boolean = previousFailures !== null,
): CriteriaDiff {
  if (!hasPreviousRound) return { kind: 'first-round', literal: FIRST_ROUND_LITERAL };
  if (previousFailures === null || currentFailures === null) {
    return { kind: 'unparsable', literal: UNPARSABLE_LITERAL };
  }
  return { kind: 'diff', ...compareCriteriaFailures(previousFailures, currentFailures) };
}

function formatCriteriaDiff(diff: CriteriaDiff): string {
  if (diff.kind === 'first-round') return `first-round —— ${diff.literal}`;
  if (diff.kind === 'unparsable') return `unparsable —— ${diff.literal}`;
  return `diff\nadded: [${diff.added.join(', ')}]\nremoved: [${diff.removed.join(', ')}]`;
}

/** 把四个冻结槽拼成一条 follow-up 正文，槽标题和顺序固定。 */
export function buildRepairFollowUp(slots: RepairFollowUpSlots): string {
  return (
    `[判据现场]\n${slots.criteriaScene}\n\n` +
    `[判据 diff]\n${formatCriteriaDiff(slots.criteriaDiff)}\n\n` +
    `[上轮尝试与结果]\n${slots.previousAttempt}\n\n` +
    `[本轮策略]\n${slots.strategy}`
  );
}

/** R1–R4 策略槽冻结表；超出范围夹到 R4，不回绕。 */
export const REPAIR_STRATEGIES = [
  'M7：先把它修到位，再用同一条判据跑一遍验证；只根据本次失败输出调整产物。',
  'M1：先写清上轮为什么红，定位根因后再动手；不要跳过 RCA。',
  'M4：先查仓内相关实现与引用，带证据再修；不要凭猜测改判据外路径。',
  'M3：缩 scope，只修最后一处红；不扩大相关改动，不回退已修部分。',
] as const;

/** `OMD_REPAIR_M_ROTATE=0` ⇒ 恒发 R1 档；其他值(含未设)使用轮换表。 */
export function repairMRotateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OMD_REPAIR_M_ROTATE !== '0';
}

/** 轮次到策略槽映射；env 开关关闭时恒返 R1。 */
export function strategyForRound(round: number, env: NodeJS.ProcessEnv = process.env): string {
  if (!repairMRotateEnabled(env)) return REPAIR_STRATEGIES[0]!;
  const index = Math.max(0, Math.min(REPAIR_STRATEGIES.length - 1, Math.trunc(round) - 1));
  return REPAIR_STRATEGIES[index]!;
}
