/**
 * src/model/role-models.ts — the role→model resolver (D60 · valar config seam).
 *
 * callModel 的 provider registry 已是 config-driven (provider:modelId 经注册解析);
 * 缺的是"哪个 daemon 角色用哪个 model"的绑定。这一层补上 — dream / conductor / leaf
 * 各解析到一个坐标, 4 级优先:
 *
 *   in-memory override (CLI/test, 非持久)
 *     → file (.valar/config.json, 持久 + 跨进程, TUI /config 写它)
 *       → per-role env (VALAR_DREAM_MODEL / …)
 *         → 出厂默认
 *
 * 文件层 = valar 既有落盘约定 (.valar/* cwd-相对, 同 memory.db / session-crystals.db),
 * 经 VALAR_CONFIG_PATH 覆盖路径。daemon (bun start) 与 TUI (bun run valar) 同从 repo root
 * 跑, 共享同一 .valar/config.json; daemon 下次 resolve 时 mtime 重读即捡到 TUI 的改动, 不重启。
 *
 * 本轮只 WIRE dream (LiveDreamModel 读 resolveRoleModel('dream'));conductor/leaf 在此声明
 * 以便 TUI 枚举, 调用点本轮不改。INV: 永不返硬编码 URL — 只返 'provider' / 'provider:modelId'
 * 坐标, callModel 再经注册 provider 解析 (model/types INV-2);未注册 provider 由 callModel 抛。
 */
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Daemon roles that drive callModel. (valar coding-agent 的脑子走 pi /model + models.json, 不在此。) */
export type ModelRole = 'dream' | 'conductor' | 'leaf';

export const MODEL_ROLES: readonly ModelRole[] = ['dream', 'conductor', 'leaf'];

interface RoleSpec {
  /** per-role env override (在 file 之下、出厂默认之上)。 */
  envVar: string;
  /** 出厂默认坐标 ('provider' 或 'provider:modelId')。 */
  fallback: string;
}

const ROLE_SPECS: Record<ModelRole, RoleSpec> = {
  // Dream consolidation = 抽取推理。默认 'deepseek' → provider default → DEEPSEEK_MODEL (v4-pro)。
  dream: { envVar: 'VALAR_DREAM_MODEL', fallback: 'deepseek' },
  // Conductor 分解。默认镜像现有 VALAR_CONDUCTOR_FALLBACK_MODEL 行为 (本轮不重接 conductor)。
  conductor: { envVar: 'VALAR_CONDUCTOR_MODEL', fallback: 'mimo' },
  // Leaf 执行 = 单发廉价档。
  leaf: { envVar: 'VALAR_LEAF_MODEL', fallback: 'mimo' },
};

export type RoleModelSource = 'override' | 'file' | 'env' | 'default';

// ---------------------------------------------------------------------------
// in-memory override (highest, non-durable: CLI / test). Use persistRoleModel
// for durable cross-process config.
// ---------------------------------------------------------------------------
const overrides = new Map<ModelRole, string>();

// ---------------------------------------------------------------------------
// file layer — .valar/config.json (cwd-relative; VALAR_CONFIG_PATH override).
// ---------------------------------------------------------------------------
const DEFAULT_CONFIG_PATH = '.valar/config.json';

/** Resolved config-file path: VALAR_CONFIG_PATH or .valar/config.json (cwd-relative). */
export function configPath(): string {
  return process.env.VALAR_CONFIG_PATH ?? DEFAULT_CONFIG_PATH;
}

interface ConfigFile {
  version?: number;
  /** role → 'provider:modelId' coordinate. Absent role = fall to env / default. */
  models?: Record<string, string>;
}

let fileCache: { path: string; mtimeMs: number; models: Record<string, string> } | null = null;

/** Read the `models` section, mtime-cached. Missing / unreadable / malformed → {} (silent,
 *  like user-profile's null — a broken config never throws into a resolve). */
function fileModels(path = configPath()): Record<string, string> {
  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    fileCache = null;
    return {};
  }
  if (fileCache && fileCache.path === path && fileCache.mtimeMs === mtimeMs) {
    return fileCache.models;
  }
  let models: Record<string, string> = {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as ConfigFile;
    if (parsed.models && typeof parsed.models === 'object') {
      models = parsed.models as Record<string, string>;
    }
  } catch {
    models = {};
  }
  fileCache = { path, mtimeMs, models };
  return models;
}

/** Drop the mtime cache — test hook + after an out-of-band file write. */
export function resetConfigCache(): void {
  fileCache = null;
}

// ---------------------------------------------------------------------------
// resolution + mutation
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

/** In-memory (non-durable) override — CLI / test. For durable cross-process, use persistRoleModel. */
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
 * Durably set a role's model — writes the `models` section of .valar/config.json. Cross-process:
 * the daemon picks it up on its next resolve (mtime reload, no restart). This is what TUI `/config`
 * calls. Preserves any other sections / roles already in the file.
 */
export function persistRoleModel(role: ModelRole, coord: string, path = configPath()): void {
  const c = coord.trim();
  if (!c) throw new Error(`persistRoleModel(${role}): coord required`);
  let cfg: ConfigFile = { version: 1, models: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as ConfigFile;
    if (parsed && typeof parsed === 'object') cfg = parsed;
  } catch {
    // new / unreadable file — start fresh, do not clobber silently-on-parse beyond this role.
  }
  if (!cfg.models || typeof cfg.models !== 'object') cfg.models = {};
  if (cfg.version === undefined) cfg.version = 1;
  cfg.models[role] = c;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(cfg, null, 2)}\n`);
  fileCache = null; // invalidate so THIS process sees the write immediately
}

export interface RoleModelEntry {
  role: ModelRole;
  resolved: string;
  source: RoleModelSource;
}

/** Per-role current resolution + source — feeds the TUI /config list. */
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
