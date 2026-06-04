/**
 * src/wright/skills/scanner — SKILL.md → registry 影子填充 (Phase 1 step 1)。
 *
 * 扫一个 skills 目录, 解析每个 <name>/SKILL.md 的 frontmatter, 调 registry.upsertSkill 把
 * **影子元数据**写进 sqlite。**不取代 pi** (R6 ①): pi 仍内部发现 + 组装 prompt; registry 只为我们
 * 自己的 curator/evolution/CLI 提供可查询的运行时镜像。
 *
 * 容错: frontmatter 字段缺失 (caveman 只有 name/description) 不报错; 单个 SKILL.md 坏不阻断整体扫描
 * (收集到 errors[] 返回, 弱模型/脏盘容错对齐 searchGenes)。
 *
 * tier 判定走 bundle.isCoreSkill (单一真理源), **不信** SKILL.md 自带的 `tier: foundation`
 * (那是另一套 taxonomy)。DMI 镜像 frontmatter `disable-model-invocation` (true→dmi=1 不进 prompt)。
 */
import { Database } from 'bun:sqlite';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { SkillRegistry, type SkillTier } from './registry';
import { isCoreSkill } from './bundle';

/** 解析后的单个 skill 描述 (落 registry 前的中间态)。 */
export interface ScannedSkill {
  id: string;
  name: string;
  description: string;
  tier: SkillTier;
  dmi: 0 | 1;
  has_body: 0 | 1;
  has_eval: 0 | 1;
  /** provenance (vendored 第三方溯源, 读 <skill>/provenance.json)。null = 第一方。 */
  upstream_repo: string | null;
  license: string | null;
  upstream_commit: string | null;
  /** 原始 frontmatter (留作调试 / 后续字段扩展, 不入库)。 */
  raw: Record<string, unknown>;
}

/** <skill>/provenance.json 的形状 (全可选, 缺即第一方)。 */
interface Provenance {
  upstream_repo?: string;
  license?: string;
  upstream_commit?: string;
}

export interface ScanResult {
  skills: ScannedSkill[];
  errors: { dir: string; reason: string }[];
}

/** id 规范化: 'grill-me' → 'sk_grill_me' (sqlite PK 友好 + 稳定可重算)。 */
export function skillId(name: string): string {
  return 'sk_' + name.replace(/[^a-zA-Z0-9]+/g, '_').toLowerCase();
}

/** 从 SKILL.md 文本切出 frontmatter YAML + body。无 frontmatter → {fm:{}, body:全文}。 */
export function splitFrontmatter(text: string): { fm: Record<string, unknown>; body: string } {
  // 必须以 '---' 起 (允许前置 BOM/空行)
  const m = text.match(/^﻿?\s*---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { fm: {}, body: text };
  const parsed = yaml.load(m[1]!);
  const fm = parsed != null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  return { fm, body: m[2] ?? '' };
}

/** 单个 skill 目录 → ScannedSkill (抛错由 scanSkillsDir 捕获)。 */
function parseSkillDir(skillsRoot: string, dir: string): ScannedSkill {
  const skillMd = join(skillsRoot, dir, 'SKILL.md');
  const text = readFileSync(skillMd, 'utf8');
  const { fm, body } = splitFrontmatter(text);

  const name = typeof fm.name === 'string' && fm.name.trim() ? fm.name.trim() : dir;
  const description = typeof fm.description === 'string' ? fm.description.trim() : '';
  // DMI: frontmatter disable-model-invocation:true → 不进 prompt (dmi=1)。缺省 = 可被模型调 (dmi=0)。
  const dmi: 0 | 1 = fm['disable-model-invocation'] === true ? 1 : 0;
  // core 永远 dmi=0 (进 prompt) — bundle 契约硬覆盖, 防误把核心藏起来。
  const core = isCoreSkill(name);
  const evalsDir = join(skillsRoot, dir, 'evals');
  const has_eval: 0 | 1 = existsSync(evalsDir) && statSync(evalsDir).isDirectory() ? 1 : 0;

  // provenance.json (vendored 溯源) — 坏 JSON 不阻断, 退第一方。
  let prov: Provenance = {};
  const provPath = join(skillsRoot, dir, 'provenance.json');
  if (existsSync(provPath)) {
    try {
      const parsed = JSON.parse(readFileSync(provPath, 'utf8'));
      if (parsed && typeof parsed === 'object') prov = parsed as Provenance;
    } catch { /* 坏 provenance → 当第一方, 不阻断扫描 */ }
  }

  return {
    id: skillId(name),
    name,
    description,
    tier: core ? 'core' : 'on-demand',
    dmi: core ? 0 : dmi,
    has_body: body.trim().length > 0 ? 1 : 0,
    has_eval,
    upstream_repo: typeof prov.upstream_repo === 'string' ? prov.upstream_repo : null,
    license: typeof prov.license === 'string' ? prov.license : null,
    upstream_commit: typeof prov.upstream_commit === 'string' ? prov.upstream_commit : null,
    raw: fm,
  };
}

/**
 * 扫目录下所有 <child>/SKILL.md。不递归到孙级 (skill = 一层子目录约定)。
 * 坏 SKILL.md 收进 errors 不阻断。
 */
export function scanSkillsDir(skillsRoot: string): ScanResult {
  const skills: ScannedSkill[] = [];
  const errors: { dir: string; reason: string }[] = [];
  let entries: string[];
  try {
    entries = readdirSync(skillsRoot);
  } catch (e) {
    return { skills, errors: [{ dir: skillsRoot, reason: `readdir failed: ${String(e)}` }] };
  }
  for (const dir of entries) {
    const skillMd = join(skillsRoot, dir, 'SKILL.md');
    if (!existsSync(skillMd)) continue; // 非 skill 目录 (scripts/assets 等) 静默跳过
    try {
      skills.push(parseSkillDir(skillsRoot, dir));
    } catch (e) {
      errors.push({ dir, reason: String(e) });
    }
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));
  return { skills, errors };
}

export interface SyncReport {
  scanned: number;
  upserted: number;
  core: number;
  errors: { dir: string; reason: string }[];
}

/**
 * 扫 + 落 registry。幂等 (upsertSkill ON CONFLICT 保留 use_count/last_used_at 运行时字段)。
 * registry 可传入 (与 ValalMemory 共享 db), 或给 path 新建。
 */
export function syncSkillsToRegistry(
  skillsRoot: string,
  opts: { registry?: SkillRegistry; path?: string; db?: Database } = {},
): SyncReport {
  const registry = opts.registry ?? new SkillRegistry({ path: opts.path, db: opts.db });
  const { skills, errors } = scanSkillsDir(skillsRoot);
  let core = 0;
  for (const s of skills) {
    registry.upsertSkill({
      id: s.id,
      name: s.name,
      description: s.description,
      tier: s.tier,
      dmi: s.dmi,
      has_body: s.has_body,
      has_eval: s.has_eval,
      origin: 'human',
      upstream_repo: s.upstream_repo,
      license: s.license,
      upstream_commit: s.upstream_commit,
    });
    if (s.tier === 'core') core++;
  }
  return { scanned: skills.length, upserted: skills.length, core, errors };
}
