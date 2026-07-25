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
import { logger } from '../logger';

/**
 * Daemon roles that drive callModel. (plan 审议座舱角色已随 plan-extension 撤除, 2026-07-25 owner 裁决。)
 * continuity = session 交接 checkpoint 蒸馏 (opt-in, 便宜档);刻意不进 MODEL_ROLES —— 它是后台
 * 可选角色, 走 env/config/默认解析即可, 不进默认 config UI / 起跑坐席告警面 (避免未用该功能者被噪音)。
 */
export type ModelRole = 'conductor' | 'leaf' | 'verifier' | 'dream' | 'continuity' | 'review';

/** UX 顺序 (config 列表 / onboard 页展示): 执行 → 校验 → 做梦。 */
export const MODEL_ROLES: readonly ModelRole[] = ['conductor', 'leaf', 'verifier', 'dream'];

interface RoleSpec {
  /** per-role env override (在 file 之下、出厂默认之上)。 */
  envVar: string;
  /** 出厂默认坐标 ('provider' 或 'provider:modelId')。 */
  fallback: string;
}

const ROLE_SPECS: Record<ModelRole, RoleSpec> = {
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
  // Review find 层 = 对抗审查读码找 bug;review 自成体系, verify 用 OMD_REVIEW_VERIFY_MODEL 覆盖/回落 find
  // (不碰引擎 verifier 角色, 避免渗透)。opt-in 不进 UI; fallback 裸 provider (→ defaultModel),
  // 无凭证经 roleModelWithFallback 顺延 — 不假设用户 key。
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
  /**
   * stamp pass 的**显式档位池** (2026-07-26)。缺省 → 从座位坐标推导 (老行为)。
   * 为什么要它: 座位推导下 mid = uniq(leaf/agent/overflow)、cheap = uniq(lens/expand/distill),
   * 而 auto-assign 把这六个座位全归 worker 类给同一个坐标 → **mid 与 cheap 恒等**, tier:'cheap'
   * 是空转, sibling 跨家族分散也没有对象可散。池是「档位里有哪些模型」, 座位是「哪个角色用哪个模型」——
   * 两件事, 分开配。
   */
  pools?: { strong?: string[]; mid?: string[]; cheap?: string[]; multimodal?: string[]; multimodalStrong?: string[] };
  /** auto-assign 落盘的 node → coord (D-17 一次性填, 可读可改)。resolveRoleModelConfigured 的 auto 层读它。 */
  autoAssigned?: Record<string, string>;
  /**
   * S-T: auto-assign 落盘的 node → 推理档 (与 autoAssigned 同键)。**独立一段而非把 autoAssigned
   * 的值改成对象**: 后者要每个读者都做归一化, 且毁掉「手改 config 时一行一个坐标」的可读性;
   * 独立段是纯增量 —— 老 config 没有这段 = 座位档缺席 = 执行期回落原有默认 (向后兼容)。
   */
  autoAssignedThinking?: Record<string, string>;
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
// node-level resolution (D-5 classification, 14 nodes)
// ---------------------------------------------------------------------------
/** D-5 node tier classification. Each omd daemon node maps to one tier. */
export type NodeTier = 'decomposer' | 'judge_synth' | 'worker' | 'verify' | 'dream';
/** All 14 omd daemon nodes (D-2). */
export type OmdNode =
  | 'conductor' | 'escalation'
  | 'judge' | 'reason' | 'reduce'
  | 'leaf' | 'agent' | 'lens' | 'expand' | 'distill' | 'overflow'
  | 'verifier' | 'review-spec'
  | 'dream';
/**
 * D-5 node→tier mapping. Groups nodes by function for tier-based model selection.
 * decomposer: conductor + escalation (分解/升级)
 * judge_synth: judge + reason + reduce (判断/综合/缩约)
 * worker: leaf/agent/lens/expand/distill/overflow (执行)
 * verify: verifier + review-spec (跨模型校验, ≠ 主力族)
 * dream: dream (独立 consolidation)
 */
export const NODE_TIER: Record<OmdNode, NodeTier> = {
  conductor: 'decomposer',
  escalation: 'decomposer',
  judge: 'judge_synth',
  reason: 'judge_synth',
  reduce: 'judge_synth',
  leaf: 'worker',
  agent: 'worker',
  lens: 'worker',
  expand: 'worker',
  distill: 'worker',
  overflow: 'worker',
  verifier: 'verify',
  'review-spec': 'verify',
  dream: 'dream',
};
/**
 * Per-node hardcoded default coordinates (provider:modelId).
 * These are the canonical fallback when no env/auto-assign/config-file override exists.
 * INV-4 / G-2: regression test snapshots these — change = deliberate, not accidental.
 * Values aligned with actual production usage in harness/research/*.ts and harness/tui.ts.
 */
export const NODE_DEFAULT_COORD: Record<OmdNode, string> = {
  // decomposer — conductor/escalation use deepseek-v4-pro (research-quality default).
  conductor: 'deepseek:deepseek-v4-pro',
  escalation: 'deepseek:deepseek-v4-pro',
  // judge_synth — judge/reason use deepseek-v4-pro; reduce uses cheaper flash (D-14).
  judge: 'deepseek:deepseek-v4-pro',
  reason: 'deepseek:deepseek-v4-pro',
  reduce: 'deepseek:deepseek-v4-flash',
  // worker — leaf/agent/lens use flash-tier; remaining workers same tier.
  leaf: 'deepseek:deepseek-v4-flash',
  agent: 'deepseek:deepseek-v4-flash',
  lens: 'deepseek:deepseek-v4-flash',
  expand: 'deepseek:deepseek-v4-flash',
  distill: 'deepseek:deepseek-v4-flash',
  overflow: 'deepseek:deepseek-v4-flash',
  // verify — cross-model ≠ main (INV-3).
  verifier: 'deepseek',
  'review-spec': 'deepseek',
  // dream
  dream: 'deepseek',
};
export interface NodeModelResult {
  /** Resolved model coordinate ('provider' or 'provider:modelId'). */
  model: string;
  /** How the model was resolved. 'default' = hardcoded fallback (unconfigured). */
  source: 'explicit' | 'env' | 'auto' | 'default';
}

/** 读 .omd/config.json 的 autoAssigned 段 (node→coord)。无/坏 → {} (mtime-cached, 静默)。 */
function fileAutoAssigned(path = configPath()): Record<string, string> {
  const a = fileConfig(path).autoAssigned;
  return a && typeof a === 'object' && !Array.isArray(a) ? a : {};
}

/**
 * 落盘 auto-assign 结果 (node→coord) 到 .omd/config.json autoAssigned 段 (D-17 一次性填, 可读可改)。
 * 整段替换 (保留 models/multimodalPool 等其它段)。跨进程: daemon 下次 resolve 时 mtime 重读即捡到。
 * thinking 给了则同时整段替换 autoAssignedThinking (S-T 座位档随座位成对下发)。
 */
export function persistAutoAssigned(
  map: Record<string, string>,
  path = configPath(),
  thinking?: Record<string, ThinkingLevel>,
): void {
  mutateConfig((cfg) => {
    cfg.autoAssigned = { ...map };
    if (thinking) cfg.autoAssignedThinking = { ...thinking };
  }, path);
}

/** 推理档词表 (与 GenerateFn/callModel 的 thinkingLevel 同词表 — 单一词汇)。 */
export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high' | 'xhigh';
const THINKING_LEVELS: readonly ThinkingLevel[] = ['off', 'low', 'medium', 'high', 'xhigh'];
/** 档位强弱序 (取 max 用): off < low < medium < high < xhigh。 */
const thinkingRank = (t: ThinkingLevel): number => THINKING_LEVELS.indexOf(t);

/** 读 .omd/config.json 的 autoAssignedThinking 段 (node→档)。无/坏值 → 丢弃该条 (fail-open)。 */
function fileAutoAssignedThinking(path = configPath()): Record<string, ThinkingLevel> {
  const raw = fileConfig(path).autoAssignedThinking;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, ThinkingLevel> = {};
  for (const [node, v] of Object.entries(raw)) {
    if (typeof v === 'string' && (THINKING_LEVELS as readonly string[]).includes(v)) out[node] = v as ThinkingLevel;
  }
  return out;
}

/**
 * S-T: 模型坐标 → 座位推理档。座位档按 node 名落盘, 而执行期只认坐标 (stamp pass 把座位坐标
 * 铺到 plan 节点上), 故按坐标反查。
 *
 * **多座位共用一个坐标时取最高档** (如 worker 与 verify 都落在同一模型上): 宁可多花推理 token,
 * 也不把 verify/judge 座静默降档 —— 降档的代价是错答案通过, 比 token 贵。碰撞会 log 供修分配表。
 *
 * @returns 该坐标的座位档; 无座位落在此坐标 (或老 config 无该段) → undefined (调用方回落原默认)。
 */
export function resolveSeatThinking(
  coord: string,
  opts: { configPath?: string; autoAssignMap?: Record<string, string>; thinkingMap?: Record<string, ThinkingLevel> } = {},
): ThinkingLevel | undefined {
  const coords = opts.autoAssignMap ?? fileAutoAssigned(opts.configPath);
  const thinking = opts.thinkingMap ?? fileAutoAssignedThinking(opts.configPath);
  let best: ThinkingLevel | undefined;
  let winner: string | undefined;
  const collided: string[] = [];
  for (const [node, c] of Object.entries(coords)) {
    if (c !== coord) continue;
    const t = thinking[node];
    if (!t) continue;
    if (best === undefined) {
      best = t;
      winner = node;
    } else if (t !== best) {
      collided.push(node);
      if (thinkingRank(t) > thinkingRank(best)) {
        best = t;
        winner = node;
      }
    }
  }
  if (collided.length > 0) {
    logger.warn(
      { coord, winner, level: best, collided },
      '[omd/role-models] 多座位共用坐标且档位不一致 → 取最高档 (改 auto-assign 分配表可消除)',
    );
  }
  return best;
}
/**
 * Resolve a node's model with full configuration chain.
 * Priority: explicit-arg ?? OMD_<NODE>_MODEL env ?? auto-assign coord ?? hardcoded default.
 *
 * @param node - D-2 node name (e.g. 'conductor', 'leaf', 'review-spec').
 * @param opts.explicit - Caller-provided override (highest priority).
 * @param opts.autoAssignMap - Optional node→coord map from auto-assign (D-19).
 * @param opts.env - Environment to read from (default: process.env).
 */
export function resolveRoleModelConfigured(
  node: OmdNode,
  opts: {
    explicit?: string;
    autoAssignMap?: Record<string, string>;
    env?: Record<string, string | undefined>;
    /** config.json 路径 (测试注入; 默认 configPath())。auto 层读 autoAssigned 段用。 */
    configPath?: string;
  } = {},
): NodeModelResult {
  const { explicit, autoAssignMap, env = process.env, configPath: cfgPath } = opts;
  // 1. explicit argument (caller knows best)
  if (explicit?.trim()) {
    return { model: explicit.trim(), source: 'explicit' };
  }
  // 2. per-node env: OMD_<NODE_UPPER>_MODEL (hyphens + dots → underscore, 对齐既有
  //    ROLE_ENV_ALLOWLIST 约定 OMD_REVIEW_SPEC_MODEL; 若只转 dots 会成 OMD_REVIEW-SPEC_MODEL 不匹配)
  const envKey = `OMD_${node.toUpperCase().replace(/[.-]/g, '_')}_MODEL`;
  const fromEnv = env[envKey]?.trim();
  if (fromEnv) {
    return { model: fromEnv, source: 'env' };
  }
  // 3. auto-assign (D-19): 显式 param 优先; 未传 param 则读 .omd/config.json 的 autoAssigned 段
  //    (D-17 一次性落盘, runAutoAssign 写)。测试传 autoAssignMap:{} 走纯链 (不读真 config, 保 hermetic)。
  const autoMap = autoAssignMap ?? fileAutoAssigned(cfgPath);
  const fromAuto = autoMap[node]?.trim();
  if (fromAuto) {
    return { model: fromAuto, source: 'auto' };
  }
  // 4. hardcoded default (D-5 tier classification)
  return { model: NODE_DEFAULT_COORD[node], source: 'default' };
}
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

/**
 * 读 .omd/config.json 的显式档位池 (`pools` 段)。每档独立 —— 只配了 cheap 就只覆盖 cheap,
 * 其余仍走座位推导 (调用方以 `?? 座位推导` 兜)。坏值/非坐标条目丢弃 (fail-open)。
 */
export function resolveConfiguredPools(
  path = configPath(),
): { strong?: string[]; mid?: string[]; cheap?: string[]; multimodal?: string[]; multimodalStrong?: string[] } {
  const raw = fileConfig(path).pools;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const clean = (xs: unknown): string[] | undefined => {
    if (!Array.isArray(xs)) return undefined;
    const out = [...new Set(xs.filter((x): x is string => typeof x === 'string' && x.includes(':')))];
    return out.length ? out : undefined;
  };
  return {
    ...(clean(raw.strong) ? { strong: clean(raw.strong)! } : {}),
    ...(clean(raw.mid) ? { mid: clean(raw.mid)! } : {}),
    ...(clean(raw.cheap) ? { cheap: clean(raw.cheap)! } : {}),
    ...(clean(raw.multimodal) ? { multimodal: clean(raw.multimodal)! } : {}),
    ...(clean(raw.multimodalStrong) ? { multimodalStrong: clean(raw.multimodalStrong)! } : {}),
  };
}
