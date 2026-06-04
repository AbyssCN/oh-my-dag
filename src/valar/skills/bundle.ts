/**
 * src/valar/skills/bundle — valar 开源 core skill bundle 清单 (Phase 1 step 2)。
 *
 * core bundle = valar 开源 curated bundle 的不变内核 (机械排除法选出: 见
 * docs/knowledge/research/valar-skill-system-architecture-2026-06-03.md §bundle)。
 * 这个清单是**单一真理源**: scanner 据此把 tier 判成 'core' (永不 decay, DMI 永远 0 = 进 prompt),
 * CLI tidy 据此守护 (拒绝把 core 设 DMI / tombstone), bundle 导出器据此挑文件进开源 repo。
 *
 * **不收**: lark/taste 系 (domain-specific, R5 不属 valar 通用核) · 任何 dream-proposed (origin≠human)。
 *
 * 修改此清单 = 改 bundle 契约, 走 commit message audit (Owner 自决)。
 */

/** valar 开源 bundle 的 core skill (kebab name, 对齐 .claude/skills/<name>/SKILL.md)。 */
export const CORE_BUNDLE = [
  'caveman',      // token 极简执行器
  'start',        // session 初始化
  'handoff',      // session 收尾交接
  'commit',       // 智能提交 + zone gate
  'verify',       // 统一验证 gate
  'investigate',  // 系统化根因调查
  'recall',       // memory 主动召回
  'retro',        // git 历史复盘
  'review',       // 按需审计 / PR review
  'dream',        // memory consolidation
  'skill-creator', // 元技能: 造/改/测 skill
  'fanout',       // 多视角并行生成 + 评判择优 (best-of-n + research fanout)
] as const;

export type CoreSkillName = (typeof CORE_BUNDLE)[number];

const CORE_SET = new Set<string>(CORE_BUNDLE);

/** name ∈ 13 core? (tier 判定 / tidy 守护的唯一判据)。 */
export function isCoreSkill(name: string): boolean {
  return CORE_SET.has(name);
}

/**
 * 开源 repo 目录布局契约 (bundle 导出器 + README 生成据此)。
 * 单一来源, 避免散文 plan 与实际导出漂移。
 */
export interface BundleLayout {
  /** 开源 repo 名 (npm scope / GitHub repo)。 */
  readonly repo: string;
  /** core skill 落盘根目录 (相对 repo root)。 */
  readonly skillsRoot: string;
  /** 每个 skill 的子目录 = skillsRoot/<name>/ (含 SKILL.md + 可选 evals/scripts)。 */
  readonly perSkillDir: (name: string) => string;
  /** sqlite substrate schema 落盘位置 (registry.ts 的 CREATE TABLE 镜像)。 */
  readonly substrateDir: string;
  /** umbrella router prompt 落盘位置 (prompt-level, 非 code)。 */
  readonly umbrellaPath: string;
}

export const BUNDLE_LAYOUT: BundleLayout = {
  repo: 'valar-skills',
  skillsRoot: 'skills',
  perSkillDir: (name: string) => `skills/${name}`,
  substrateDir: 'substrate',
  umbrellaPath: 'umbrella.md',
};
