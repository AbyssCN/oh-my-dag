/**
 * src/harness/skills/bundle — omd 开源 core skill bundle 清单 (Phase 1 step 2)。
 *
 * core bundle = omd 开源 curated bundle 的不变内核 (机械排除法选出: 见
 * docs/knowledge/research/omd-skill-system-architecture-2026-06-03.md §bundle)。
 * 这个清单是**单一真理源**: scanner 据此把 tier 判成 'core' (永不 decay, DMI 永远 0 = 进 prompt),
 * CLI tidy 据此守护 (拒绝把 core 设 DMI / tombstone), bundle 导出器据此挑文件进开源 repo。
 *
 * **不收**: lark/taste 系 (domain-specific, R5 不属 omd 通用核) · 任何 dream-proposed (origin≠human)。
 *
 * 修改此清单 = 改 bundle 契约, 走 commit message audit (Owner 自决)。
 */

/** oh-my-dag 开源 bundle 的 core skill (kebab name, 对齐 .claude/skills/<name>/SKILL.md)。
 *  两层结构 (2026-07-18 Owner 校准): harness 通用 12 (session/记忆/验证/审查工作流) +
 *  DAG 引擎 5 (每个是 scripts/dag-*.ts 的用法皮)。整包 = 完整 harness, 非单一 DAG 库。 */
export const CORE_BUNDLE = [
  // ── harness 通用 ──
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
  'council',      // 多视角并行生成 + 评判择优 (含 grounded 档)
  // ── DAG 引擎 ──
  'dag-research', // web 调研 DAG: 多 lens 检索 fanout → 综合判优
  'dag-council',  // 自动 author N persona → 并发出方案 → 多 lens judge 择优
  'dag-fanout',   // 手写 lens spec 直接 fanout (council 的手动挡)
  'dag-review',   // diff/PR 多镜头对抗审查 DAG
  'dag-build',    // 可分解编码任务: conductor 分解 → agent-leaf 并发建 → oracle 把关
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
  repo: 'oh-my-dag-skills',
  skillsRoot: 'skills',
  perSkillDir: (name: string) => `skills/${name}`,
  substrateDir: 'substrate',
  umbrellaPath: 'umbrella.md',
};
