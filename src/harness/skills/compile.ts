/**
 * src/harness/skills/compile —— skills → 引擎件编译器 (SDD 2026-07-25 S3)。
 *
 * 把用户已装 skills (<skillsRoot>/<name>/SKILL.md) 编译成 DAG 引擎认的产物:
 *  craft 型 (品味/方法论)            → agent 模板卡  .omd/agents/<name>.md (现有 loadAgentTemplates 直接载入);
 *  能力型 (自带可独立执行脚本)      → command 配方  .omd/recipes/<name>.md (conductor 排 executor:'command' 节点用);
 *  纯宿主工具 wrapper (登录态/MCP/浏览器) → 跳过并列明原因 (leaf 没有宿主工具, 搬进去只是幻觉源)。
 *
 * Invariants (SDD S3 契约):
 *  CMP-1 分类确定性: capability/skip 判据零 LLM (脚本存在且被 SKILL.md 引用 / 宿主标记正则); 仅 craft 蒸馏调模型。
 *  CMP-2 冻结缓存: 产物 frontmatter 记源 SKILL.md sha256 (source_hash); 重编译哈希相同 → cached 跳过 (derive once, freeze)。
 *  CMP-3 产物即注册: 卡落 .omd/agents 即进现有注册表, 零新加载机制; evidence 只收 KNOWN_EVIDENCE_CLASSES (词表外丢弃)。
 *  CMP-4 显式 opt-in: 只编译点名的 skill; suggest 仅分类列候选, 不写盘不调模型。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { z } from 'zod';
import { KNOWN_EVIDENCE_CLASSES } from '../agent-templates';
import { knownMcpServerNames } from '../../mcp/client/config';
import { splitFrontmatter } from './frontmatter';
import { logger } from '../logger';

// ---------------------------------------------------------------------------
// 源读取
// ---------------------------------------------------------------------------

export interface SkillSource {
  name: string;
  dir: string;
  /** SKILL.md 原文 (哈希源)。 */
  raw: string;
  fm: Record<string, unknown>;
  body: string;
  /** skill 目录内文件相对路径 (深度 ≤2, 略过隐藏目录/node_modules)。 */
  files: string[];
}

/** 枚举 skill 目录文件 (深度 ≤2 — omd-video 的 run.py 在顶层, 留一层余量给 scripts/ 子目录)。 */
function listSkillFiles(dir: string, depth = 0): string[] {
  if (depth > 1) return [];
  let out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out = out.concat(listSkillFiles(p, depth + 1));
    else out.push(p);
  }
  return out;
}

/** 读单个 skill 源。SKILL.md 缺失/读不了 → null (调用方报 error, 不抛)。 */
export function loadSkillSource(skillsRoot: string, name: string): SkillSource | null {
  const dir = join(skillsRoot, name);
  const mdPath = join(dir, 'SKILL.md');
  try {
    if (!existsSync(mdPath)) return null;
    const raw = readFileSync(mdPath, 'utf8');
    const { fm, body } = splitFrontmatter(raw);
    const files = listSkillFiles(dir).map((p) => relative(dir, p));
    return { name, dir, raw, fm, body, files };
  } catch (err) {
    logger.warn({ name, err }, '[omd/skills-compile] skill 源读取失败');
    return null;
  }
}

// ---------------------------------------------------------------------------
// CMP-1 分类 (确定性, 零 LLM)
// ---------------------------------------------------------------------------

export type SkillClass =
  | { kind: 'capability'; scriptFile: string; invocation: string }
  | { kind: 'skip'; reason: string }
  | { kind: 'craft' };

/** 可独立执行脚本扩展名 (SKILL.md 自身除外)。 */
const SCRIPT_RE = /\.(py|sh|ts|js|mjs)$/i;

/**
 * 宿主依赖标记: 命中 = skill 靠宿主 Claude 的工具/登录态干活, leaf/command 节点复现不了。
 * 词表刻意窄而具体 (specific > general): 误杀比误放贵 — 编译是显式 opt-in, 漏标记的 owner 会看到产物。
 */
const HOST_MARKER_RE = /mcp__[a-z][a-z0-9-]*|browser-harness|browser-act|scrapling|lark-cli|登录态|接管浏览器/i;

/**
 * 三分类, 优先序 capability > skip > craft:
 * 带自包含脚本的 skill 即便部分阶段依赖宿主 (omd-video 的 enumerate 要 browser-harness),
 * 其脚本主体仍可确定性执行 → 配方优先。
 */
export function classifySkill(src: SkillSource, cwd?: string): SkillClass {
  const scripts = src.files.filter((f) => SCRIPT_RE.test(f));
  for (const script of scripts) {
    const base = script.split('/').pop()!;
    if (!src.body.includes(base)) continue;
    return { kind: 'capability', scriptFile: script, invocation: extractInvocation(src.body, base) ?? script };
  }
  const text = `${JSON.stringify(src.fm)}\n${src.body}`;
  // D-S3-7: mcp__<server> 先查注册表; 已注册的不算宿主标记, 未注册照旧 skip。
  if (cwd) {
    const knownServers = knownMcpServerNames(cwd);
    // 扫全部标记 (用全局正则以捕获多个标记, 如同时含 mcp__foo 与 browser-harness)。
    const re = new RegExp(HOST_MARKER_RE.source, 'gi');
    const markers = [...text.matchAll(re)].map((m) => m[0]);
    for (const marker of markers) {
      if (marker.startsWith('mcp__')) {
        const serverName = marker.slice(5);
        if (knownServers.has(serverName)) continue; // 已注册 → 不算宿主标记, 继续查下一个
      }
      // 非 MCP 宿主标记 (browser-harness 等) 或未注册的 mcp__<server> → skip
      return { kind: 'skip', reason: `宿主依赖标记 "${marker}" — leaf 无宿主工具/登录态` };
    }
    // 全部标记都是已注册 mcp__<server> → craft
    return { kind: 'craft' };
  }
  // 无 cwd → 旧行为: 任何命中即 skip
  const marker = text.match(HOST_MARKER_RE);
  if (marker) return { kind: 'skip', reason: `宿主依赖标记 "${marker[0]}" — leaf 无宿主工具/登录态` };
  return { kind: 'craft' };
}

/** 从 fenced code block 里取第一条含脚本名的调用行 (确定性提取, 提不到退回脚本路径)。 */
export function extractInvocation(body: string, scriptBase: string): string | null {
  let inFence = false;
  for (const line of body.split('\n')) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    const t = line.trim();
    if (inFence && t.includes(scriptBase) && !t.startsWith('#') && !t.startsWith('//')) return t;
  }
  return null;
}

/**
 * 取第一个含脚本名的完整 fenced block (≤10 行) — 进配方 body 当用法上下文。
 * command: 单行是确定性锚, 可能只命中路径赋值行 (omd-video 形状); 完整块补齐真实调用序列。
 */
export function extractUsageBlock(body: string, scriptBase: string): string[] {
  let fence: string[] | null = null;
  for (const line of body.split('\n')) {
    if (/^\s*```/.test(line)) {
      if (fence) {
        if (fence.some((l) => l.includes(scriptBase))) return fence.slice(0, 10);
        fence = null;
      } else fence = [];
      continue;
    }
    if (fence) fence.push(line);
  }
  return [];
}

// ---------------------------------------------------------------------------
// CMP-2 哈希缓存
// ---------------------------------------------------------------------------

export function contentHash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** 读已编译产物的 source_hash (无文件/无字段 → undefined)。 */
export function readCompiledHash(filePath: string): string | undefined {
  try {
    if (!existsSync(filePath)) return undefined;
    const { fm } = splitFrontmatter(readFileSync(filePath, 'utf8'));
    return typeof fm.source_hash === 'string' ? fm.source_hash : undefined;
  } catch {
    return undefined; // 坏产物按未编译处理 → 重编译覆盖
  }
}

// ---------------------------------------------------------------------------
// craft 蒸馏 (唯一 LLM 步; schema 校验由 callModel INV-3 承担, 词表/量级后校验在此)
// ---------------------------------------------------------------------------

/** 蒸馏输出 schema (zod 默认 strip 未知键, 容忍弱模型加料)。 */
export const DISTILL_SCHEMA = z.object({
  description: z.string().min(1).max(220),
  body: z.string().min(40),
  evidence: z.string().nullable().optional(),
});
export type Distilled = z.infer<typeof DISTILL_SCHEMA>;

/** 蒸馏 prompt 输入截断 (超长 skill 取头部 — frontmatter+开篇含最高密度的方法论)。 */
const DISTILL_INPUT_CAP = 16_000;
/** body 词数硬顶 (目标 ~300, 超 600 = 模型没听指令 → error)。 */
const BODY_WORD_CAP = 600;

export function buildDistillPrompt(name: string, raw: string): string {
  return [
    `You are compiling the installed skill "${name}" into a frozen "agent template card" for a`,
    'multi-model execution engine. The card is injected into a cheap text-only worker model as its',
    'role prompt — it must carry the CRAFT of the skill (method, checklists, output discipline),',
    'not the harness mechanics.',
    '',
    'Return STRICT JSON: {"description": string, "evidence": string|null, "body": string}',
    '- description: ONE line (<=160 chars), third person, names the role and its deliverable.',
    '  It is the ONLY thing the planner sees, so it must say WHEN to pick this card.',
    '- body: <=300 words. Shape: one role sentence, then the method / craft checklist as terse',
    '  imperatives, then output discipline (what the final answer must contain). Keep every',
    '  domain-specific heuristic and red line; DROP all of: tool invocations, slash commands,',
    '  MCP/host references, file paths, install/usage instructions, marketing prose.',
    '- evidence: "ui-pixels" ONLY if the card\'s deliverable is user-visible UI (HTML/components/',
    '  pages/visual output) that must be judged from rendered pixels; otherwise null.',
    '',
    'SKILL DOCUMENT:',
    raw.slice(0, DISTILL_INPUT_CAP),
  ].join('\n');
}

/**
 * 蒸馏后校验 (确定性): 词数硬顶; description 压成单行; evidence 词表外丢弃 (CMP-3, 与加载器同规则)。
 * 返回 null = 产物不合格 (调用方记 error, 不写盘)。
 */
export function postValidateDistilled(name: string, d: Distilled): { description: string; body: string; evidence?: string } | null {
  const body = d.body.trim();
  const words = body.split(/\s+/).length;
  if (words > BODY_WORD_CAP) {
    logger.warn({ name, words }, '[omd/skills-compile] 蒸馏 body 超词数硬顶 → 不写盘');
    return null;
  }
  const description = d.description.replace(/\s+/g, ' ').trim();
  let evidence = typeof d.evidence === 'string' && d.evidence.trim() ? d.evidence.trim() : undefined;
  if (evidence && !KNOWN_EVIDENCE_CLASSES.has(evidence)) {
    logger.warn({ name, evidence }, '[omd/skills-compile] 蒸馏 evidence 词表外 → 丢弃字段');
    evidence = undefined;
  }
  return { description, body, ...(evidence ? { evidence } : {}) };
}

// ---------------------------------------------------------------------------
// 产物渲染 + 写盘
// ---------------------------------------------------------------------------

export function renderCardFile(name: string, hash: string, card: { description: string; body: string; evidence?: string }): string {
  return [
    '---',
    `name: ${name}`,
    `description: ${card.description}`,
    ...(card.evidence ? [`evidence: ${card.evidence}`] : []),
    `compiled_from: skill:${name}`,
    `source_hash: ${hash}`,
    '---',
    card.body,
    '',
  ].join('\n');
}

export function renderRecipeFile(
  name: string,
  hash: string,
  r: { description: string; scriptFile: string; invocation: string; usage?: string[] },
): string {
  return [
    '---',
    `name: ${name}`,
    `description: ${r.description}`,
    `script: ${r.scriptFile}`,
    `command: ${r.invocation}`,
    `compiled_from: skill:${name}`,
    `source_hash: ${hash}`,
    '---',
    `Capability recipe extracted from installed skill "${name}". The script is self-contained`,
    '(checks its own env keys and CLI deps). Schedule via an executor:"command" node; the node',
    'output should PRINT any produced artifact paths so downstream nodes can consume them.',
    ...(r.usage?.length ? ['', 'Usage (from the skill doc):', '```', ...r.usage, '```'] : []),
    '',
  ].join('\n');
}

/** 卡目录 (= agent-templates 的项目卡目录) 与配方目录。 */
export const CARD_DIR = '.omd/agents';
export const RECIPE_DIR = '.omd/recipes';

// ---------------------------------------------------------------------------
// 编译主流程
// ---------------------------------------------------------------------------

export type CompileOutcome =
  | { name: string; status: 'card'; path: string }
  | { name: string; status: 'recipe'; path: string }
  | { name: string; status: 'cached'; path: string }
  | { name: string; status: 'skip'; reason: string }
  | { name: string; status: 'error'; reason: string };

export interface CompileOpts {
  /** 目标 repo 根 (产物落 <root>/.omd/...)。 */
  root: string;
  skillsRoot: string;
  /** craft 蒸馏调用 (CLI 接 callModel+DISTILL_SCHEMA; 测试注 fake)。 */
  distill: (prompt: string) => Promise<Distilled>;
  /**
   * 显式分类覆盖 (CLI --as): 确定性判据的已知精度边界 — 带辅助脚本的 craft skill
   * (如 impeccable 的 live.mjs) 会被脚本优先规则误收成能力型; opt-in 语义下由 owner 点名纠正。
   * 'card' = 强制蒸卡; 'recipe' = 强制配方 (无被引用脚本时 error)。
   */
  as?: 'card' | 'recipe';
}

export async function compileSkill(name: string, opts: CompileOpts): Promise<CompileOutcome> {
  const src = loadSkillSource(opts.skillsRoot, name);
  if (!src) return { name, status: 'error', reason: `SKILL.md 不存在或读取失败: ${join(opts.skillsRoot, name)}` };

  let cls = classifySkill(src);
  if (opts.as === 'card') cls = { kind: 'craft' };
  else if (opts.as === 'recipe') {
    if (cls.kind !== 'capability') return { name, status: 'error', reason: '--as recipe 但未发现被 SKILL.md 引用的脚本' };
  } else if (cls.kind === 'skip') return { name, status: 'skip', reason: cls.reason };

  const hash = contentHash(src.raw);
  const outDir = join(opts.root, cls.kind === 'capability' ? RECIPE_DIR : CARD_DIR);
  const outPath = join(outDir, `${name}.md`);
  if (readCompiledHash(outPath) === hash) return { name, status: 'cached', path: outPath };

  const description = typeof src.fm.description === 'string' ? src.fm.description.replace(/\s+/g, ' ').trim().slice(0, 160) : name;

  if (cls.kind === 'capability') {
    mkdirSync(outDir, { recursive: true });
    const usage = extractUsageBlock(src.body, cls.scriptFile.split('/').pop()!);
    writeFileSync(outPath, renderRecipeFile(name, hash, { description, scriptFile: cls.scriptFile, invocation: cls.invocation, usage }));
    return { name, status: 'recipe', path: outPath };
  }

  // craft → 蒸馏
  try {
    const distilled = await opts.distill(buildDistillPrompt(name, src.raw));
    const card = postValidateDistilled(name, distilled);
    if (!card) return { name, status: 'error', reason: '蒸馏产物不过后校验 (词数/格式)' };
    mkdirSync(outDir, { recursive: true });
    writeFileSync(outPath, renderCardFile(name, hash, card));
    return { name, status: 'card', path: outPath };
  } catch (err) {
    return { name, status: 'error', reason: `蒸馏失败: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export async function compileSkills(names: string[], opts: CompileOpts): Promise<CompileOutcome[]> {
  const out: CompileOutcome[] = [];
  for (const name of names) out.push(await compileSkill(name, opts)); // 串行: 蒸馏是稀发一次性操作, 不值并发复杂度
  return out;
}

// ---------------------------------------------------------------------------
// CMP-4 suggest (只分类, 不写盘不调模型)
// ---------------------------------------------------------------------------

export interface SuggestEntry {
  name: string;
  description: string;
  kind: SkillClass['kind'];
  /** skip 原因 / capability 脚本 (craft 为空)。 */
  detail: string;
  /** 已有产物且哈希一致。 */
  cached: boolean;
}

export function suggestSkills(opts: { root: string; skillsRoot: string }): SuggestEntry[] {
  let dirs: string[];
  try {
    dirs = readdirSync(opts.skillsRoot).filter((d) => {
      try {
        return statSync(join(opts.skillsRoot, d)).isDirectory() && !d.startsWith('.') && !d.startsWith('_');
      } catch {
        return false;
      }
    });
  } catch (err) {
    logger.warn({ skillsRoot: opts.skillsRoot, err }, '[omd/skills-compile] skills 目录读取失败');
    return [];
  }
  const out: SuggestEntry[] = [];
  for (const name of dirs.sort()) {
    const src = loadSkillSource(opts.skillsRoot, name);
    if (!src) continue;
    const cls = classifySkill(src);
    const hash = contentHash(src.raw);
    const outPath = join(opts.root, cls.kind === 'capability' ? RECIPE_DIR : CARD_DIR, `${name}.md`);
    out.push({
      name,
      description: typeof src.fm.description === 'string' ? src.fm.description.replace(/\s+/g, ' ').trim().slice(0, 120) : '',
      kind: cls.kind,
      detail: cls.kind === 'skip' ? cls.reason : cls.kind === 'capability' ? cls.scriptFile : '',
      cached: readCompiledHash(outPath) === hash,
    });
  }
  return out;
}
