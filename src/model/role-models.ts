/**
 * src/model/role-models.ts — the role→model resolver + unified config center (D60 · omd config seam).
 *
 * callModel 的 provider registry 已是 config-driven (provider:modelId 经注册解析);
 * 这一层补"哪个 daemon 角色用哪个 model"的绑定 + 多模态池 + 用户自定 API。每个角色解析到
 * 一个坐标, 4 级优先:
 *
 *   in-memory override (CLI/test, 非持久)
 *     → file (.omd/config.json, 持久 + 跨进程, TUI /config·/setup 写它)
 *       → per-role env (OMD_PLAN_MODEL / OMD_CONDUCTOR_MODEL / …)
 *         → 出厂默认
 *
 * config.json schema v2 (向后兼容 v1):
 *   { version, models: {role→coord}, multimodalPool: [coord…], apis: [{id,baseUrl,keyEnv?,multimodal?}] }
 * multimodalPool = 多模态 leaf 的候选池 (从 provider 池里挑有多模态能力的, 如 mimo/gemini/kimi 多选);
 * apis = 用户自定 OpenAI-兼容端点, boot 时 registerProvidersFromConfig 注册进 callModel registry。
 *
 * 文件层 = omd 既有落盘约定 (.omd/* cwd-相对, 经 OMD_CONFIG_PATH 覆盖)。daemon 与 TUI 同从
 * repo root 跑, 共享同一 .omd/config.json; 下次 resolve 时 mtime 重读即捡到改动, 不重启。
 * INV: 永不返硬编码 URL — 只返 'provider' / 'provider:modelId' 坐标, callModel 经注册 provider 解析。
 */
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Daemon roles that drive callModel. plan = 审议座舱模型 (omd 对话脑子仍走 pi /model)。
 * continuity = session 交接 checkpoint 蒸馏 (opt-in, 便宜档);刻意不进 MODEL_ROLES —— 它是后台
 * 可选角色, 走 env/config/默认解析即可, 不进默认 config UI / 起跑坐席告警面 (避免未用该功能者被噪音)。
 */
export type ModelRole = 'plan' | 'conductor' | 'leaf' | 'verifier' | 'dream' | 'continuity' | 'review';

/** UX 顺序 (config 列表 / onboard 页展示): 规划 → 执行 → 校验 → 做梦。 */
export const MODEL_ROLES: readonly ModelRole[] = ['plan', 'conductor', 'leaf', 'verifier', 'dream'];

interface RoleSpec {
  /** per-role env override (在 file 之下、出厂默认之上)。 */
  envVar: string;
  /** 出厂默认坐标 ('provider' 或 'provider:modelId')。 */
  fallback: string;
}

const ROLE_SPECS: Record<ModelRole, RoleSpec> = {
  // Plan 审议座舱 = 强推理。默认 deepseek-v4-pro (完整坐标, 不依赖 provider defaultModel)。
  plan: { envVar: 'OMD_PLAN_MODEL', fallback: 'deepseek:deepseek-v4-pro' },
  // Conductor 分解。默认 mimo (provider 裸名 → provider defaultModel)。
  conductor: { envVar: 'OMD_CONDUCTOR_MODEL', fallback: 'mimo' },
  // Leaf 执行 = 单发廉价档。
  leaf: { envVar: 'OMD_LEAF_MODEL', fallback: 'mimo' },
  // Verifier 跨模型校验 = 对抗式审查。默认 'deepseek' (≠ mimo conductor/leaf, 故意跨模型避盲点)。
  verifier: { envVar: 'OMD_VERIFIER_MODEL', fallback: 'deepseek' },
  // Dream consolidation = 抽取推理。默认 'deepseek'。
  dream: { envVar: 'OMD_DREAM_MODEL', fallback: 'deepseek' },
  // Session 交接 checkpoint 蒸馏 = 便宜单发档 (同 dream 家族);opt-in。
  continuity: { envVar: 'OMD_CONTINUITY_MODEL', fallback: 'deepseek' },
  // Review find 层 = 对抗审查读码找 bug (verify 走 verifier 角色跨模型);opt-in, 不进 UI。
  // fallback 裸 provider (→ defaultModel), 无凭证经 roleModelWithFallback 顺延 — 不假设用户 key。
  review: { envVar: 'OMD_REVIEW_MODEL', fallback: 'deepseek' },
};

export type RoleModelSource = 'override' | 'file' | 'env' | 'default';

/**
 * Per-model 定义: 坐标后半 id + 能力声明。per-model 属性的单一真源已迁到 `~/.pi/agent/models.json`
 * (统一-registry D-1/C-1); 本类型仅余 {@link THINKING_DEFAULT} 引用其 thinkingDefault 字段类型。
 */
export interface ModelDef {
  id: string;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  thinkingDefault?: 'minimal' | 'low' | 'medium' | 'high' | 'max';
}
/** 思考默认档 (C-3) — 单一来源, 后续所有默认只准引用此常量。 */
export const THINKING_DEFAULT: NonNullable<ModelDef['thinkingDefault']> = 'max';
/** 输出上限默认 (C-3) — 单一来源。 */
export const MAX_TOKENS_DEFAULT = 32_768;

// ---------------------------------------------------------------------------
// in-memory override (highest, non-durable: CLI / test).
// ---------------------------------------------------------------------------
const overrides = new Map<ModelRole, string>();

// ---------------------------------------------------------------------------
// file layer — .omd/config.json (cwd-relative; OMD_CONFIG_PATH override).
// ---------------------------------------------------------------------------
const DEFAULT_CONFIG_PATH = '.omd/config.json';

/** Resolved config-file path: OMD_CONFIG_PATH or .omd/config.json (cwd-relative). */
export function configPath(): string {
  return process.env.OMD_CONFIG_PATH ?? DEFAULT_CONFIG_PATH;
}

interface ConfigFile {
  version?: number;
  /** role → 'provider:modelId' coordinate. Absent role = fall to env / default. */
  models?: Record<string, string>;
  /** 多模态 leaf 候选池 (坐标列表)。 */
  multimodalPool?: string[];
}

let fileCache: { path: string; mtimeMs: number; config: ConfigFile } | null = null;

/** Read the whole config, mtime-cached. Missing / unreadable / malformed → {} (silent, never throws). */
function fileConfig(path = configPath()): ConfigFile {
  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    fileCache = null;
    return {};
  }
  if (fileCache && fileCache.path === path && fileCache.mtimeMs === mtimeMs) {
    return fileCache.config;
  }
  let config: ConfigFile = {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as ConfigFile;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) config = parsed;
  } catch {
    config = {};
  }
  fileCache = { path, mtimeMs, config };
  return config;
}

/** Models section of the config (mtime-cached, derived from fileConfig). */
function fileModels(path = configPath()): Record<string, string> {
  const m = fileConfig(path).models;
  return m && typeof m === 'object' ? m : {};
}

/** Drop the mtime cache — test hook + after an out-of-band file write. */
export function resetConfigCache(): void {
  fileCache = null;
}

/**
 * Read-modify-write the config file, preserving all sections. Shared by every persist*.
 * New / unreadable file → start fresh (do not clobber beyond the mutated section).
 */
function mutateConfig(mutator: (cfg: ConfigFile) => void, path = configPath()): void {
  let cfg: ConfigFile = { version: 2 };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as ConfigFile;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) cfg = parsed;
  } catch {
    /* fresh */
  }
  if (cfg.version === undefined || cfg.version < 2) cfg.version = 2;
  mutator(cfg);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(cfg, null, 2)}\n`);
  fileCache = null; // invalidate so THIS process sees the write immediately
}

// ---------------------------------------------------------------------------
// role resolution + mutation
// ---------------------------------------------------------------------------

/** Resolve a role's model coordinate. Priority: override → file → env → default. */
export function resolveRoleModel(
  role: ModelRole,
  env: Record<string, string | undefined> = process.env,
): string {
  const override = overrides.get(role);
  if (override) return override;
  const fromFile = fileModels()[role]?.trim();
  if (fromFile) return fromFile;
  const fromEnv = env[ROLE_SPECS[role].envVar]?.trim();
  if (fromEnv) return fromEnv;
  return ROLE_SPECS[role].fallback;
}

/** In-memory (non-durable) override — CLI / test. */
export function setRoleModel(role: ModelRole, coord: string): void {
  const c = coord.trim();
  if (!c) throw new Error(`setRoleModel(${role}): coord required`);
  overrides.set(role, c);
}

/** Clear one in-memory override (falls back to file / env / default). */
export function clearRoleModel(role: ModelRole): void {
  overrides.delete(role);
}

/** Clear all in-memory overrides — test hook + TUI "reset to env". */
export function clearRoleModelOverrides(): void {
  overrides.clear();
}

/**
 * Durably set a role's model — writes the `models` section of .omd/config.json. Cross-process:
 * daemon picks it up on next resolve (mtime reload). Preserves other sections / roles.
 */
export function persistRoleModel(role: ModelRole, coord: string, path = configPath()): void {
  const c = coord.trim();
  if (!c) throw new Error(`persistRoleModel(${role}): coord required`);
  mutateConfig((cfg) => {
    if (!cfg.models || typeof cfg.models !== 'object') cfg.models = {};
    cfg.models[role] = c;
  }, path);
}

export interface RoleModelEntry {
  role: ModelRole;
  resolved: string;
  source: RoleModelSource;
}

/** Per-role current resolution + source — feeds the TUI /config·/setup list. */
export function listRoleModels(
  env: Record<string, string | undefined> = process.env,
): RoleModelEntry[] {
  const fm = fileModels();
  return MODEL_ROLES.map((role): RoleModelEntry => {
    const override = overrides.get(role);
    if (override) return { role, resolved: override, source: 'override' };
    const f = fm[role]?.trim();
    if (f) return { role, resolved: f, source: 'file' };
    const e = env[ROLE_SPECS[role].envVar]?.trim();
    if (e) return { role, resolved: e, source: 'env' };
    return { role, resolved: ROLE_SPECS[role].fallback, source: 'default' };
  });
}

// ---------------------------------------------------------------------------
// multimodal leaf pool — config.multimodalPool (坐标列表)
// ---------------------------------------------------------------------------

/** 解析多模态 leaf 候选池 (config.multimodalPool)。无 → []。 */
export function resolveMultimodalPool(path = configPath()): string[] {
  const pool = fileConfig(path).multimodalPool;
  return Array.isArray(pool)
    ? pool.filter((c): c is string => typeof c === 'string' && c.trim().length > 0)
    : [];
}

/** 持久化多模态 leaf 池 (整体替换)。空数组 = 清空池。 */
export function persistMultimodalPool(coords: string[], path = configPath()): void {
  const clean = coords.map((c) => c.trim()).filter(Boolean);
  mutateConfig((cfg) => {
    cfg.multimodalPool = clean;
  }, path);
}

/** 解析多模态**贵层**池 (config.multimodalPoolPremium) — 便宜层分析置信不足/显式深读时升级。无 → []。 */
export function resolveMultimodalPoolPremium(path = configPath()): string[] {
  const pool = (fileConfig(path) as { multimodalPoolPremium?: unknown }).multimodalPoolPremium;
  return Array.isArray(pool)
    ? pool.filter((c): c is string => typeof c === 'string' && c.trim().length > 0)
    : [];
}

/** 持久化多模态贵层池 (整体替换)。空数组 = 清空。 */
export function persistMultimodalPoolPremium(coords: string[], path = configPath()): void {
  const clean = coords.map((c) => c.trim()).filter(Boolean);
  mutateConfig((cfg) => {
    (cfg as { multimodalPoolPremium?: string[] }).multimodalPoolPremium = clean;
  }, path);
}

// custom provider 的单一真源已迁 `~/.pi/agent/models.json` (统一-registry D-1/D-6): 登记走
// models-json.ts 的 upsertProvider / MCP omd_register_provider, callModel 侧注册走
// registerProvidersFromModelsJson。原 config.apis 链 (listCustomApis/persistCustomApi/registerCustomApis)
// 已废 —— models.json 是其超集且额外覆盖 agent-leaf 栈。
