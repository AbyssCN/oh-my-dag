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

/** Daemon roles that drive callModel. plan = 审议座舱模型 (omd 对话脑子仍走 pi /model)。 */
export type ModelRole = 'plan' | 'conductor' | 'leaf' | 'verifier' | 'dream';

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
};

export type RoleModelSource = 'override' | 'file' | 'env' | 'default';

/** 用户自定 OpenAI-兼容 API (config.apis)。boot 时注册进 callModel registry。 */
export interface ApiDef {
  /** provider 名 (坐标前半, 如 'gemini' / 'kimi')。 */
  id: string;
  /** OpenAI-兼容 base URL。 */
  baseUrl: string;
  /** 读 key 的 env 变量名 (如 'GEMINI_API_KEY')。省略 = id 大写 + _API_KEY。 */
  keyEnv?: string;
  /** 默认模型 id (坐标省略 model 半时用)。 */
  defaultModel?: string;
  /** 是否有多模态能力 (供 onboard 页过滤多模态池候选)。 */
  multimodal?: boolean;
}

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
  /** 用户自定 OpenAI-兼容 API 端点。 */
  apis?: ApiDef[];
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

// ---------------------------------------------------------------------------
// custom APIs — config.apis (用户随意添加, boot 注册进 callModel registry)
// ---------------------------------------------------------------------------

/** 列用户自定 API。无 → []。 */
export function listCustomApis(path = configPath()): ApiDef[] {
  const apis = fileConfig(path).apis;
  if (!Array.isArray(apis)) return [];
  return apis.filter(
    (a): a is ApiDef =>
      !!a && typeof a === 'object' && typeof a.id === 'string' && typeof a.baseUrl === 'string',
  );
}

/** 增/改一个 API (按 id upsert)。 */
export function persistCustomApi(def: ApiDef, path = configPath()): void {
  const id = def.id.trim();
  if (!id) throw new Error('persistCustomApi: id required');
  if (!def.baseUrl.trim()) throw new Error('persistCustomApi: baseUrl required');
  mutateConfig((cfg) => {
    const apis = Array.isArray(cfg.apis) ? cfg.apis : [];
    const next = apis.filter((a) => a && a.id !== id);
    next.push({ ...def, id, baseUrl: def.baseUrl.trim() });
    cfg.apis = next;
  }, path);
}

/** 删一个 API (按 id)。 */
export function removeCustomApi(id: string, path = configPath()): void {
  mutateConfig((cfg) => {
    if (Array.isArray(cfg.apis)) cfg.apis = cfg.apis.filter((a) => a && a.id !== id);
  }, path);
}
