/**
 * src/harness/skills/bundle — omd 开源 skill bundle 清单 (Phase 1 step 2 · 2026-07 分层重构)。
 *
 * **两层语义 (Smart Zone 分层)**:
 *   - core bundle (CORE_BUNDLE) = **shipped set**: 开源 bundle 收录的全部 skill。
 *     scanner 据此判 tier='core', bundle 导出器据此挑文件进开源 repo。
 *   - resident core (RESIDENT_CORE) = **DMI-0 子集** (Smart Zone 预算): 唯一常驻 prompt 的
 *     几个 skill。LLM 只在 context 前 ~120k token 保持锐度, 每条 model-invoked skill description
 *     永久占用这段黄金区 → "skill 越多越笨"。药方: 常驻内核压到 ≤5, 其余全部
 *     disable-model-invocation:true, 靠 /omd 路由伞 + 用户显式 /<name> 唤起。
 *
 * 这个清单是**单一真理源**: 导出/守护/tier 判定都从这里读, 不散落硬编码。
 *
 * ⚠️ 已知跟进 (scanner/cli 属别的 owner, 本次不动): scanner 的 dmi 硬覆盖与 cli 的
 * set-dmi/tidy 守护仍走 isCoreSkill (= shipped set)。分层后它们语义上应改走
 * isResidentSkill (只有 resident 才 "永远 dmi=0"); 迁移前, registry 影子表对 routed
 * skill 的 dmi 镜像会与磁盘 frontmatter 不一致 (prompt 层行为以 frontmatter 为准, 不受影响)。
 *
 * **不收**: lark/taste 系 (domain-specific, R5 不属 omd 通用核) · 任何 dream-proposed (origin≠human)。
 *
 * 修改此清单 = 改 bundle 契约, 走 commit message audit (Owner 自决)。
 */

/**
 * RESIDENT core — 常驻 prompt 的 DMI-0 子集 (Smart Zone 预算 ≤5)。
 * 入选标准: **模型必须能自发想起来调用**的 skill (无用户提示词可依赖):
 *   - verify: 宣称 "做完了" 之前自发验证
 *   - recall: 推理卡住时自发查记忆
 *   - investigate: 见 bug 自发根因调查 (Iron Law: 无根因不修)
 *   - codebase-design: 深模块设计词汇表, 其他 skill (dag-deepen/dag-slim) 引用的公共语言
 * 其余一律 routed (用户 /<name> 或 /omd 路由伞唤起), 不占 Smart Zone。
 */
export const RESIDENT_CORE = [
  'verify',          // 统一验证 gate (claim done 之前必过)
  'recall',          // memory 主动召回 (卡住时查历史)
  'investigate',     // 系统化根因调查
  'codebase-design', // 深模块设计词汇表 (dag-deepen/dag-slim 的公共语言)
] as const;

/**
 * ROUTED bundle — shipped 但 disable-model-invocation:true (不进 prompt 自动列举)。
 * 唤起路径: 用户 /<name>, 或经 /omd 路由伞 (umbrella.md 常驻一条入口)。
 */
export const ROUTED_BUNDLE = [
  // ── 会话 / 工作流 ──
  'caveman',      // token 极简执行器
  'start',        // session 初始化
  'handoff',      // session 收尾交接
  'commit',       // 智能提交 + zone gate
  'retro',        // git 历史复盘
  'review',       // 按需审计 / PR review
  'dream',        // memory consolidation
  'skill-creator', // 元技能: 造/改/测 skill
  'council',      // 多视角并行生成 + 评判择优 (含 grounded 档)
  'ponytail',     // 最懒可行解压迫器 (反过度工程)
  // ── DAG 引擎 (每个是 scripts/dag-*.ts 的用法皮) ──
  'dag-research', // web 调研 DAG: 多 lens 检索 fanout → 综合判优
  'dag-council',  // 自动 author N persona → 并发出方案 → 多 lens judge 择优
  'dag-fanout',   // 手写 lens spec 直接 fanout (council 的手动挡)
  'dag-review',   // diff/PR 多镜头对抗审查 DAG
  'dag-build',    // 可分解编码任务: conductor 分解 → agent-leaf 并发建 → oracle 把关
  'dag-deepen',   // 全库找浅模块 → 深化重构目标 (codebase-design 词汇)
  'dag-slim',     // 全库找可删项 (过度工程/死灵活性) → 瘦身目标
  // ── 路由伞本体 ──
  'omd',          // /omd: routed skill 一览表 (要记的唯一名字)
] as const;

/** oh-my-dag 开源 bundle 的全部 skill (kebab name, 对齐 skills/<name>/SKILL.md)。
 *  = resident + routed 两层拼接。保留此导出为向后兼容: isCoreSkill 语义 = "在 shipped bundle 里"。 */
export const CORE_BUNDLE = [...RESIDENT_CORE, ...ROUTED_BUNDLE] as const;

export type CoreSkillName = (typeof CORE_BUNDLE)[number];
export type ResidentSkillName = (typeof RESIDENT_CORE)[number];

const CORE_SET = new Set<string>(CORE_BUNDLE);
const RESIDENT_SET = new Set<string>(RESIDENT_CORE);

/** name ∈ shipped bundle? (bundle 导出/tier 判定的判据; 非 "常驻 prompt" — 那是 isResidentSkill)。 */
export function isCoreSkill(name: string): boolean {
  return CORE_SET.has(name);
}

/** name ∈ resident core? (唯一 "永远 DMI-0 / 常驻 prompt" 的子集 — Smart Zone 预算)。 */
export function isResidentSkill(name: string): boolean {
  return RESIDENT_SET.has(name);
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
