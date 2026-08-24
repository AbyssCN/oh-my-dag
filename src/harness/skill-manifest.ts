/**
 * src/harness/skill-manifest —— skill 清单 (manifest.json + SKILL.md) 装载 + 工具池收窄 + 散文禁令探测。
 *
 * 只依赖 zod + node:fs (无第三方读文件库)。三块独立职责:
 *   1. loadSkillManifest / listSkills — 读一个/多个 skill 目录, 校验 manifest.json, 走 INV-15 三分支。
 *   2. intersectToolPool — INV-14 单向收紧 (natural ∩ allowed ∩ ¬red_lines ∩ ¬plan.deny)。
 *      skill.allowed_tools \ natural → 提权信号, 供 PP-S02 (skill_priv_escalation, 不可抑制) 消费。
 *   3. detectProseViolation — INV-15 分支 2 启发式, **只**返布尔 + 命中坐标,
 *      不摘录禁令内容 (INV-5/I-10: 函数名/变量名须避开两组禁词, 由全仓 ugrep 零命中硬闸保护)。
 *
 * 不变量:
 *   INV-14: 工具池是**集合收窄**, ∪ / ⊇ 一律拒。提权 = skill 声明自然池外的工具, 必触发 PP-S02。
 *   INV-15: 装载分三支 — (a) 有 checks → 脚本即闸; (b) 无 checks 无 red_lines 但正文含禁令句
 *            → PP-S03 信号 + 工具池**零扩展** (skill.allowed_tools 在 intersectToolPool 调用方
 *            传空数组实现); (c) 干净 → 正常装载。
 *   INV-5 / I-10: 散文探测只返 (boolean, 命中坐标), 不返回周围文本/句子/摘录。
 */
import { z } from 'zod';
import { logger } from '../logger';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

// ── zod schema (SKILL manifest.json 形状) ────────────────────────────────────

/** 单条 check (skill 声明的硬闸脚本/内联断言)。 */
export const SkillCheckSchema = z.object({
  name: z.string().min(1),
  type: z.enum(['script', 'inline']),
  pass_rule: z.string().min(1),
  timeout_sec: z.number().int().positive(),
});
export type SkillCheck = z.infer<typeof SkillCheckSchema>;

/** 单条 red_line (skill 声明的 deny-by-tool 规则)。action 锁死 'deny'。 */
export const SkillRedLineSchema = z.object({
  action: z.literal('deny'),
  target_tool: z.string().min(1),
  arg_match: z.string(),
});
export type SkillRedLine = z.infer<typeof SkillRedLineSchema>;

/** skill 清单主体。body_ref 锁死 "SKILL.md" (INV-15 body 必读 SKILL.md)。 */
export const SkillManifestSchema = z.object({
  skill_id: z.string().min(1),
  skill_version: z.string().min(1),
  description: z.string(),
  body_ref: z.literal('SKILL.md'),
  checks: z.array(SkillCheckSchema).default([]),
  red_lines: z.array(SkillRedLineSchema).default([]),
  allowed_tools: z.array(z.string()).default([]),
  schema_version: z.string().min(1),
});
export type SkillManifest = z.infer<typeof SkillManifestSchema>;

// ── INV-14: tool pool 交集 ────────────────────────────────────────────────────

/** 计划层 deny 规则 (与 SkillRedLine 同形但来源是 plan.deny, 非 skill)。 */
export interface PlanDeny {
  target_tool: string;
  arg_match: string;
}

/**
 * intersectToolPool 返回值 — INV-14 收窄后的 effective 池 + 提权信号。
 * ppS02=true 时 PP-S02 (skill_priv_escalation, 不可抑制) 必须亮。
 */
export interface ToolPoolResult {
  /** natural ∩ effective_allowed ∩ ¬red_lines.deny ∩ ¬plan.deny, 已排序去重。 */
  effective: string[];
  /** skill.allowed_tools \ natural → 提权清单 (供 PP-S02 evidence)。 */
  escalations: string[];
  /** true ⇔ escalations.length > 0 (供 PP-S02 一键消费)。 */
  ppS02: boolean;
}

/**
 * INV-14 单向收紧。effective ⊆ natural 恒成立; 任何 ∪ / ⊇ 操作都不存在本函数中。
 *
 * 提权判据: skill 声明了 natural 没有的工具 → 越权声明, 必须上报 PP-S02。
 * 调用方 (orchestrator) 负责根据 PP-S02 决定 fail / 降级 / 警告。
 *
 * @param natural    宿主自然池 (不可变只读)。
 * @param skill      skill 清单中与工具有关的两片: allowed_tools + red_lines。
 * @param planDenies 可选, 计划层 deny 规则 (同形于 SkillRedLine 但来源是 plan.deny)。
 */
export function intersectToolPool(
  natural: readonly string[],
  skill: { allowed_tools: readonly string[]; red_lines: readonly SkillRedLine[] },
  planDenies: readonly PlanDeny[] = [],
): ToolPoolResult {
  const naturalSet = new Set(natural);
  const allowedSet = new Set(skill.allowed_tools);
  const deniedBySkill = new Set(skill.red_lines.map((r) => r.target_tool));
  const deniedByPlan = new Set(planDenies.map((p) => p.target_tool));

  // 提权清单 = skill 声明的 allowed_tools 中不在 natural 内的部分
  const escalations: string[] = [];
  for (const t of allowedSet) {
    if (!naturalSet.has(t)) escalations.push(t);
  }

  // 收窄: 从 natural 起, 逐层 ∩, 永不 ∪
  const effective: string[] = [];
  for (const t of naturalSet) {
    if (!allowedSet.has(t)) continue; // skill 未声明 → 不授
    if (deniedBySkill.has(t)) continue; // skill 自己 deny
    if (deniedByPlan.has(t)) continue; // 计划 deny
    effective.push(t);
  }

  effective.sort();
  escalations.sort();
  return { effective, escalations, ppS02: escalations.length > 0 };
}

// ── INV-15: 散文禁令探测 (boolean + 坐标 ONLY) ──────────────────────────────

/**
 * 保守启发式命中集 (INV-15 分支 2 用)。命中即视为正文含禁令句,
 * 触发 PP-S03 (skill_constraints_unverified, 可抑制)。
 * 英文小写匹配; 中文按字面匹配 (无大小写概念)。
 */
const PROSE_BAN_MARKERS = ['绝对禁止', '严禁', 'never', 'must not'] as const;

export interface ProseBanHit {
  /** 1-indexed 行号。 */
  line: number;
  /** 1-indexed 列号 (marker 起点, 非整句起点)。 */
  col: number;
  /** 命中的 marker 字面 (供 PP-S03 evidence 用, **不**包含周围文本)。 */
  marker: string;
}

export interface ProseBanResult {
  /** true ⇔ hits.length > 0。 */
  hasBan: boolean;
  /** 所有命中坐标 + marker 字面; 不含上下文/句子/摘录 (INV-5/I-10)。 */
  hits: ProseBanHit[];
}

/**
 * INV-15 分支 2 启发式探测。**严格**只返布尔与命中坐标 (line/col/marker),
 * 永不提取、摘录、复述或概括禁令内容 — 函数/变量命名刻意回避 "extract" / "summarize" / "parse"。
 * 命名由全仓 ugrep 零命中硬闸保护 (见 docs/silent-failures.md INV-5)。
 */
export function detectProseViolation(body: string): ProseBanResult {
  const hits: ProseBanHit[] = [];
  if (!body) return { hasBan: false, hits };

  const lines = body.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lower = line.toLowerCase();
    for (const marker of PROSE_BAN_MARKERS) {
      const needle = marker.toLowerCase();
      let from = 0;
      while (true) {
        const idx = lower.indexOf(needle, from);
        if (idx < 0) break;
        hits.push({ line: i + 1, col: idx + 1, marker });
        from = idx + needle.length;
      }
    }
  }
  return { hasBan: hits.length > 0, hits };
}

// ── INV-15: 三分支装载 ────────────────────────────────────────────────────────

/** 装载结果三态 (kind 即分支识别, 调用方按 kind 路由): */
export type SkillLoadOutcome =
  | { kind: 'loaded'; manifest: SkillManifest }
  | { kind: 'ban'; manifest: SkillManifest; ban: ProseBanResult; ppS03: true }
  | { kind: 'invalid'; error: string };

/**
 * 读 <skillDir>/manifest.json + <skillDir>/SKILL.md, 校验后按 INV-15 路由:
 *   - 有 checks           → 'loaded'           (分支 a, 脚本即闸)
 *   - 无 checks 无 red_lines 且正文含禁令句 → 'ban' + ppS03=true (分支 b, 保守默认装载)
 *   - 其它                → 'loaded'           (分支 c, 干净装载)
 *
 * 校验失败 (manifest.json 缺/坏/SKILL.md 缺/zod 拒/body_ref≠"SKILL.md") → 'invalid'。
 *
 * 分支 b 的"工具池零扩展"不在本函数内执行 — 由 orchestrator 收到 'ban' 后传空 allowed_tools
 * 给 intersectToolPool 实现 (intersectToolPool 始终是纯集合运算, 无策略分支)。
 */
export async function loadSkillManifest(skillDir: string): Promise<SkillLoadOutcome> {
  const manifestPath = join(skillDir, 'manifest.json');
  const bodyPath = join(skillDir, 'SKILL.md');

  let manifestRaw: string;
  let bodyRaw: string;
  try {
    [manifestRaw, bodyRaw] = await Promise.all([
      readFile(manifestPath, 'utf8'),
      readFile(bodyPath, 'utf8'),
    ]);
  } catch (e) {
    // fail-open 留证据 (catch-evidence 纪律): invalid 结果上层会消费, 但读失败的原文这里就记。
    logger.warn({ skillDir, err: (e as Error).message }, '[skill-manifest] 读 manifest/body 失败 → invalid');
    return { kind: 'invalid', error: `read ${skillDir}: ${(e as Error).message}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestRaw);
  } catch (e) {
    logger.warn({ skillDir, err: (e as Error).message }, '[skill-manifest] manifest.json 非法 JSON → invalid');
    return { kind: 'invalid', error: `manifest.json not JSON: ${(e as Error).message}` };
  }

  const result = SkillManifestSchema.safeParse(parsed);
  if (!result.success) {
    return { kind: 'invalid', error: `zod: ${result.error.message}` };
  }
  const manifest = result.data;
  if (manifest.body_ref !== 'SKILL.md') {
    return { kind: 'invalid', error: `body_ref must be "SKILL.md", got "${manifest.body_ref}"` };
  }

  const hasChecks = manifest.checks.length > 0;
  const hasRedLines = manifest.red_lines.length > 0;
  const ban = detectProseViolation(bodyRaw);

  if (hasChecks) return { kind: 'loaded', manifest };
  if (!hasRedLines && ban.hasBan) {
    return { kind: 'ban', manifest, ban, ppS03: true };
  }
  return { kind: 'loaded', manifest };
}

/**
 * 扫 <rootDir> 下所有子目录, 调 loadSkillManifest, 跳过 'invalid'。
 * 顺序按目录名升序; 不抛错 (个别 skill 坏不污染整批)。
 */
export async function listSkills(rootDir: string): Promise<SkillManifest[]> {
  const entries = await readdir(rootDir, { withFileTypes: true });
  const dirs = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  const out: SkillManifest[] = [];
  for (const name of dirs) {
    const outcome = await loadSkillManifest(join(rootDir, name)).catch(() => null);
    if (!outcome) continue;
    if (outcome.kind === 'loaded' || outcome.kind === 'ban') {
      out.push(outcome.manifest);
    }
  }
  return out;
}