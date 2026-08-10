/**
 * src/model/role-models.ts — the role→model resolver + unified config center (D60 · omd config seam).
 *
 * callModel 的 provider registry 已是 config-driven (provider:modelId 经注册解析);
 * 这一层补"哪个座位用哪个 model"的绑定 + 多模态池。**全库唯一的模型解析权威**
 * ({@link resolveSeatModel}, P0 2026-07-28 INV-MODEL-1) —— 座位 = 14 个 DAG 节点 + continuity/review
 * 两个后台角色, 一条链:
 *
 *   explicit (调用方显式)
 *     → in-memory override (CLI/test, 非持久)
 *       → config.models[seat] (持久 + 跨进程, TUI /config·/setup·omd_set_role 写它)
 *         → env: OMD_<SEAT>_MODEL, 其后历史别名 OMD_ITER_* / OMD_CG_*
 *           → config.autoAssigned[seat] (omd models auto 按渠道经济学落盘)
 *             → **单一可配** config.defaultModel / OMD_DEFAULT_MODEL / OMD_RUNTIME_*
 *               → 抛 SeatUnresolvedError (INV-MODEL-5: 无出厂坐标, 计划期响亮失败)
 *
 * config.json schema v2 (向后兼容 v1):
 *   { version, models: {seat→coord}, defaultModel, multimodalPool: [coord…], pools, autoAssigned }
 * multimodalPool = 多模态 leaf 的候选池 (从 provider 池里挑有多模态能力的, 如 mimo/gemini/kimi 多选)。
 *
 * 文件路径经 {@link configPath} 确定性发现 (INV-MODEL-4: 向上找 .omd/config.json → repo 根,
 * OMD_CONFIG_PATH 显式覆盖), 不再是 cwd-相对 —— server 与脚本从不同目录起也读同一份。
 * 下次 resolve 时 mtime 重读即捡到改动, 不重启 (INV-MODEL-3)。
 * INV: 永不返硬编码 URL — 只返 'provider' / 'provider:modelId' 坐标, callModel 经注册 provider 解析。
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
// worktree → 主仓的识别与留痕库锚点同源 (src/harness/repo-root), 两处各算一份必漂。
import { mainRepoRootOfWorktree } from '../harness/repo-root';
import { logger } from '../logger';

/**
 * Daemon roles that drive callModel. (plan 审议座舱角色已随 plan-extension 撤除, 2026-07-25 owner 裁决。)
 * continuity = session 交接 checkpoint 蒸馏 (opt-in, 便宜档);刻意不进 MODEL_ROLES —— 它是后台
 * 可选角色, 走 env/config/默认解析即可, 不进默认 config UI / 起跑坐席告警面 (避免未用该功能者被噪音)。
 *
 * **角色 = 座位的子集** (INV-MODEL-1, P0 2026-07-28): 角色路与节点路自此是同一个 resolver
 * ({@link resolveSeatModel}) 的两个门面, 不再是两条会跑出不同答案的链。
 */
export type ModelRole = 'conductor' | 'leaf' | 'verifier' | 'continuity' | 'review';

/** UX 顺序 (config 列表 / onboard 页展示): 执行 → 校验。 */
export const MODEL_ROLES: readonly ModelRole[] = ['conductor', 'leaf', 'verifier'];

export type RoleModelSource = SeatModelSource;

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
const overrides = new Map<OmdSeat, string>();

// ---------------------------------------------------------------------------
// file layer — .omd/config.json (cwd-relative; OMD_CONFIG_PATH override).
// ---------------------------------------------------------------------------
const DEFAULT_CONFIG_REL = '.omd/config.json';

/** 路径发现缓存 (只缓存**路径**不缓存内容; 内容仍走 fileCache 的 mtime 判定)。 */
let configPathCache: { cwd: string; env: string | undefined; path: string } | null = null;

/**
 * **确定性 config 路径** (INV-MODEL-4)。此前是裸 `.omd/config.json` cwd-相对 —— MCP server 从
 * 一个目录起、dag-* 脚本从另一个目录起, 两边读的是**两份不同的 config**, 于是"我明明改了配置"。
 *
 * 解析序 (从 cwd 逐级向上, **走到 repo 边界为止**):
 *   1. `OMD_CONFIG_PATH` (显式即权威, 相对路径对 cwd 解析成绝对);
 *   2. 路上第一个**已存在的** `.omd/config.json` (worktree 里跑 = 用 worktree 自己的);
 *   3. 撞到 repo 根 (`.git`) 就停 → `<root>/.omd/config.json` (还没 init 的仓; init/models auto 写这里);
 *   4. 压根不在仓里 → 一直走到文件系统根, 都没有则 `<cwd>/.omd/config.json`。
 *
 * **在仓内不越过仓边界**是刻意的: 否则一份游离的 `~/.omd/config.json` 会静默劫持每个还没 init
 * 的项目 —— 那种"配置从哪来的"最难查。
 *
 * 返回**绝对路径**, 故 cwd 之后再变也不会读串。cwd/env 变了会重新发现 (键在缓存里)。
 */
export function configPath(): string {
  const cwd = process.cwd();
  const envPath = process.env.OMD_CONFIG_PATH;
  if (configPathCache && configPathCache.cwd === cwd && configPathCache.env === envPath) {
    return configPathCache.path;
  }
  const path = discoverConfigPath(cwd, envPath);
  configPathCache = { cwd, env: envPath, path };
  return path;
}

function discoverConfigPath(cwd: string, envPath: string | undefined): string {
  if (envPath?.trim()) {
    const p = envPath.trim();
    return isAbsolute(p) ? p : resolve(cwd, p);
  }
  const fsRoot = parse(cwd).root;
  let dir = cwd;
  for (;;) {
    if (existsSync(join(dir, DEFAULT_CONFIG_REL))) return join(dir, DEFAULT_CONFIG_REL);
    // repo 边界: 仓里没 config 就用仓根的位置, **不再往上找别人的**
    if (existsSync(join(dir, '.git'))) {
      // ⚠ **linked worktree 的 `.git` 是一个文件, 不是目录** (2026-08-05 实测补的这一格)。
      //   `existsSync` 对文件也返 true, 于是发现就停在 worktree 根 —— 而 `.omd/` 是 gitignored,
      //   worktree 里按定义没有它。实测: `configPath()` 指向一个不存在的文件 → 座位全部
      //   `SeatUnresolvedError`, **omd 在任何 linked worktree 下开跑即死**
      //   (后台 agent / `--worktree` / Claude Code 的 worktree 全中)。
      //   linked worktree **是同一个仓**, 所以回主仓取 config 恰恰是"不越过仓边界"的本义。
      const main = mainRepoRootOfWorktree(join(dir, '.git'));
      if (main && main !== dir) return join(main, DEFAULT_CONFIG_REL);
      return join(dir, DEFAULT_CONFIG_REL);
    }
    if (dir === fsRoot) break;
    dir = dirname(dir);
  }
  return join(cwd, DEFAULT_CONFIG_REL);
}

interface ConfigFile {
  version?: number;
  /** role → 'provider:modelId' coordinate. Absent role = fall to env / default. */
  models?: Record<string, string>;
  /**
   * **全库唯一的"没配时用谁"** (INV-MODEL-2, P0 2026-07-28)。此前 14 个节点 + 6 个角色各带一条
   * 硬编码 deepseek 兜底, 换栈时漏改一条就是跑到一半 402;现在收成这一个可配键。
   * 仍然**没有出厂值** (owner 锁「不 bake 任何模型」) —— 这里也空 = 座位未配 = 计划期响亮失败。
   */
  defaultModel?: string;
  /** 多模态 leaf 候选池 (坐标列表)。 */
  multimodalPool?: string[];
  /**
   * stamp pass 的**显式档位池** (2026-07-26)。缺省 → 从座位坐标推导 (老行为)。
   * 为什么要它: 座位推导下 mid = uniq(leaf/agent/overflow)、cheap = uniq(lens/expand/distill),
   * 而 auto-assign 把这六个座位全归 worker 类给同一个坐标 → **mid 与 cheap 恒等**, tier:'cheap'
   * 是空转, sibling 跨家族分散也没有对象可散。池是「档位里有哪些模型」, 座位是「哪个角色用哪个模型」——
   * 两件事, 分开配。
   */
  pools?: Partial<Record<string, string[]>>;
  /** auto-assign 落盘的 node → coord (D-17 一次性填, 可读可改)。resolveRoleModelConfigured 的 auto 层读它。 */
  autoAssigned?: Record<string, string>;
  /**
   * S-T: auto-assign 落盘的 node → 推理档 (与 autoAssigned 同键)。**独立一段而非把 autoAssigned
   * 的值改成对象**: 后者要每个读者都做归一化, 且毁掉「手改 config 时一行一个坐标」的可读性;
   * 独立段是纯增量 —— 老 config 没有这段 = 座位档缺席 = 执行期回落原有默认 (向后兼容)。
   */
  autoAssignedThinking?: Record<string, string>;
  /**
   * 座位 advisor 坐标 (seat → 'provider:modelId', NOTES 2026-08-10)。纯增量段: 老 config
   * 缺席 = 无 advisor (**不自动选** —— transcript 会外发, 显式配置才生效)。分派看**座位**通道:
   * claude-code 座走官方 server tool, pi 座走内部升档 tool。
   */
  advisors?: Record<string, string>;
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

/** Drop the mtime + 路径发现缓存 — test hook + after an out-of-band file write / chdir。 */
export function resetConfigCache(): void {
  fileCache = null;
  configPathCache = null;
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

/**
 * Resolve a role's model coordinate (座位 resolver 的角色门面)。
 * Priority: override → file → env → auto → defaultModel。
 * @throws {SeatUnresolvedError} 座位一层都没配 (INV-MODEL-5 响亮失败)。非致命场景用
 *   {@link tryResolveSeatModel} 拿 undefined。
 */
export function resolveRoleModel(
  role: ModelRole,
  env: Record<string, string | undefined> = process.env,
): string {
  return resolveSeatModel(role, { env }).model;
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
  /** 解析到的坐标; **未配座位 = ''** (展示面不抛, 由 UI 显示"未配")。 */
  resolved: string;
  source: RoleModelSource;
}

/** Per-role current resolution + source — feeds the TUI /config·/setup list. */
export function listRoleModels(
  env: Record<string, string | undefined> = process.env,
): RoleModelEntry[] {
  return MODEL_ROLES.map((role): RoleModelEntry => {
    const r = tryResolveSeatModel(role, { env });
    return { role, resolved: r?.model ?? '', source: r?.source ?? 'default' };
  });
}

// ---------------------------------------------------------------------------
// node-level resolution (D-5 classification, 14 nodes)
// ---------------------------------------------------------------------------
/**
 * ⚠ **座位的真源已搬到 `seats.ts`** (2026-08-01) —— 分档 / 消费点 / effort / 采样 / 建议模型
 * 全在那一张表里。这里只保留**派生视图**, 别在这里写第二份。
 */
export type { NodeTier, OmdSeat } from './seats';
export { ALL_SEAT_IDS as ALL_SEATS, SEAT_TIER as NODE_TIER, seatSpec, seatSampling } from './seats';
import type { OmdSeat } from './seats';
import { seatSpec as seatSpecOf } from './seats';

/** 兼容旧命名: 引擎节点座位 = 全部座位 (continuity/review 也是座位, 见 seats.ts)。 */
export type OmdNode = OmdSeat;

/**
 * 座位的 **env 别名** —— 历史上并行跑着的那几套解析器 (OMD_ITER_* 的 /iterate·/execute·MCP 引擎座、
 * OMD_CG_* 的 /cg·/audit 座) 在此收编成同一条链的 env 层别名 (INV-MODEL-1)。
 *
 * **别名落在 config.models 之下** 是刻意的: 此前 `resolveEngineModels` 把 OMD_ITER_* 排在 config
 * 之上, 于是"改了 config.json 却还是老模型"——同一个 conductor 座在两条链上解出两个答案。统一后
 * 优先序只有一条: override → config.models → env(正名 → 别名) → autoAssigned → defaultModel。
 */
const SEAT_ENV_ALIASES: Partial<Record<OmdSeat, readonly string[]>> = {
  conductor: ['OMD_ITER_CONDUCTOR_MODEL', 'OMD_CG_CONDUCTOR_MODEL'],
  leaf: ['OMD_ITER_LEAF_MODEL', 'OMD_CG_LEAF_MODEL'],
  agent: ['OMD_ITER_AGENT_MODEL', 'OMD_CG_AGENT_MODEL'],
  // 2026-07-28 空旋钮全仓扫: `escalation` 座此前是**纯装饰** —— auto-assign 给它派模型、起跑自检查
  // 它的凭证, 而引擎读的是 OMD_CONDUCTOR_ESCALATION_MODEL, 谁都没解析过这个座。config 说 X 引擎用
  // env 的 Y, 正是 INV-MODEL-1 要杀的形态, 在这一个座位上活了下来 (P0 收口时漏的)。
  // 收法与其它座位一致: 老 env 名降为本座别名, config.models 压过它。
  escalation: ['OMD_CONDUCTOR_ESCALATION_MODEL'],
  // `review-spec` 同上, 只是它的正名 env key 恰好就是历史名 (seatEnvKey → OMD_REVIEW_SPEC_MODEL),
  // 无需别名 —— 缺的只是消费方去解析它 (见 harness/review/run.ts)。
};

/** 座位正名 env key: OMD_<SEAT>_MODEL (连字符/点 → 下划线, 对齐既有 OMD_REVIEW_SPEC_MODEL 约定)。 */
export function seatEnvKey(seat: OmdSeat): string {
  return `OMD_${seat.toUpperCase().replace(/[.-]/g, '_')}_MODEL`;
}

export type SeatModelSource = 'explicit' | 'override' | 'file' | 'env' | 'auto' | 'default';

export interface SeatModelResult {
  /** Resolved model coordinate ('provider' or 'provider:modelId'). */
  model: string;
  /** 解析层。'default' = 单一可配 defaultModel 兜底 (座位本身未配)。 */
  source: SeatModelSource;
  /** 命中的具体来源标识 (env key / 'config.models' / 'config.autoAssigned' / 'config.defaultModel')。 */
  via: string;
}

/** 向后兼容别名 (老调用方签名不变)。 */
export type NodeModelResult = SeatModelResult;

/**
 * 座位一层都没配 —— 计划期响亮失败 (INV-MODEL-5)。
 * 此前这里是静默落 deepseek: 没 DeepSeek 余额的部署会一路跑到 leaf 调用才 402, 报错还不指名是哪个座。
 */
export class SeatUnresolvedError extends Error {
  constructor(readonly seat: OmdSeat) {
    super(
      `[omd/model] 座位 '${seat}' 未配模型 —— 无 config.models['${seat}'] / ${seatEnvKey(seat)} / ` +
        `config.autoAssigned['${seat}'] / config.defaultModel。` +
        `修: 跑 \`omd models auto\` (按渠道自动分配) 或 \`omd_set_role ${seat} <provider:model>\`, ` +
        `或设 config.defaultModel 兜住全部座位。`,
    );
    this.name = 'SeatUnresolvedError';
  }
}

export interface SeatResolveOpts {
  /** Caller-provided override (highest priority)。 */
  explicit?: string;
  /** auto-assign map 注入 (测试传 {} 走纯链, 不读真 config)。 */
  autoAssignMap?: Record<string, string>;
  /** .omd/config.json 的 models 段 (测试注入 hermetic; 默认读 fileModels(configPath()))。 */
  modelsMap?: Record<string, string>;
  env?: Record<string, string | undefined>;
  /** config.json 路径 (测试注入; 默认 configPath())。models / auto / defaultModel 段读它。 */
  configPath?: string;
  /** 末级兜底注入 (测试; 默认读 config.defaultModel → OMD_DEFAULT_MODEL → OMD_RUNTIME_*)。 */
  defaultModel?: string;
}

/**
 * **单一可配兜底** (INV-MODEL-2): config.defaultModel → env OMD_DEFAULT_MODEL →
 * runtime 坐标 OMD_RUNTIME_PROVIDER:OMD_RUNTIME_MODEL (TUI init wizard 写的那对)。
 * 三处皆空 → undefined = 无出厂硬编码 (owner 锁「不 bake 任何模型」)。
 */
export function resolveDefaultModel(
  opts: { env?: Record<string, string | undefined>; configPath?: string } = {},
): string | undefined {
  const env = opts.env ?? process.env;
  const fromFile = fileConfig(opts.configPath ?? configPath()).defaultModel?.trim();
  if (fromFile) return fromFile;
  const fromEnv = env.OMD_DEFAULT_MODEL?.trim();
  if (fromEnv) return fromEnv;
  const provider = env.OMD_RUNTIME_PROVIDER?.trim();
  const model = env.OMD_RUNTIME_MODEL?.trim();
  return provider && model ? `${provider}:${model}` : undefined;
}

/** 持久化单一兜底坐标到 .omd/config.json defaultModel 段。 */
export function persistDefaultModel(coord: string, path = configPath()): void {
  const c = coord.trim();
  if (!c) throw new Error('persistDefaultModel: coord required');
  mutateConfig((cfg) => {
    cfg.defaultModel = c;
  }, path);
}

/**
 * **唯一的模型解析权威** (INV-MODEL-1)。全部座位 —— DAG 节点 stamp / stampPools / research 的
 * lens·reason·expand·distill / agent-leaf / 后台角色 —— 都经这一条链, 读同一个 config。
 *
 * 优先序: explicit → in-memory override → config.models → env (正名 → 别名) → config.autoAssigned
 *        → 单一可配 defaultModel。
 *
 * 一层都没命中 → undefined (调用方决定是响亮失败还是跳过该功能)。要"解不到就抛"用
 * {@link resolveSeatModel}。
 */
export function tryResolveSeatModel(
  seat: OmdSeat,
  opts: SeatResolveOpts = {},
): SeatModelResult | undefined {
  const { explicit, autoAssignMap, modelsMap, env = process.env, configPath: cfgPath } = opts;
  // 1. explicit argument (caller knows best)
  if (explicit?.trim()) return { model: explicit.trim(), source: 'explicit', via: 'explicit' };
  // 2. in-memory override (CLI / test, 非持久)
  const override = overrides.get(seat as ModelRole);
  if (override?.trim()) return { model: override.trim(), source: 'override', via: 'override' };
  // 3. .omd/config.json `models` 段 —— 单一手配面。压过 env 与 auto-assign 提案。
  const fromModels = (modelsMap ?? fileModels(cfgPath))[seat]?.trim();
  if (fromModels) return { model: fromModels, source: 'file', via: 'config.models' };
  // 4. env: 正名 OMD_<SEAT>_MODEL, 其后历史别名 (OMD_ITER_* / OMD_CG_*)
  for (const key of [seatEnvKey(seat), ...(SEAT_ENV_ALIASES[seat] ?? [])]) {
    const v = env[key]?.trim();
    if (v) return { model: v, source: 'env', via: key };
  }
  // 5. auto-assign (D-19): `omd models auto` 按渠道经济学落盘的 node→coord
  const fromAuto = (autoAssignMap ?? fileAutoAssigned(cfgPath))[seat]?.trim();
  if (fromAuto) return { model: fromAuto, source: 'auto', via: 'config.autoAssigned' };
  // 6. 单一可配兜底 (INV-MODEL-2: 全库仅此一处"没配时用谁", 且无出厂值)
  const fallback = opts.defaultModel?.trim() || resolveDefaultModel({ env, ...(cfgPath ? { configPath: cfgPath } : {}) });
  if (fallback) return { model: fallback, source: 'default', via: 'config.defaultModel' };
  return undefined;
}

/**
 * 座位模型解析, 解不到即抛 (INV-MODEL-5 计划期响亮失败)。
 * @throws {SeatUnresolvedError}
 */
export function resolveSeatModel(seat: OmdSeat, opts: SeatResolveOpts = {}): SeatModelResult {
  const r = tryResolveSeatModel(seat, opts);
  if (!r) throw new SeatUnresolvedError(seat);
  return r;
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
 * 节点门面 (老名字, 老签名) —— 实现即 {@link resolveSeatModel}。
 * @throws {SeatUnresolvedError} 座位一层都没配 (INV-MODEL-5)。
 */
export function resolveRoleModelConfigured(
  node: OmdSeat,
  opts: SeatResolveOpts = {},
): NodeModelResult {
  return resolveSeatModel(node, opts);
}
// seat advisor — config.advisors (seat → 坐标, NOTES 2026-08-10)
// ---------------------------------------------------------------------------

/**
 * 解析座位的 advisor 坐标。层级同座位模型的精神: env > config > seats.ts 声明默认;
 * 全缺 = undefined = 该座位无 advisor(**没有出厂值** —— 不自动选,transcript 会外发)。
 * 消费点: mcp/tools/chat (conductor) · mcp/assemble (agent leaf 装配)。
 */
export function resolveSeatAdvisor(
  seat: string,
  opts: { env?: NodeJS.ProcessEnv; path?: string } = {},
): string | undefined {
  const env = opts.env ?? process.env;
  const fromEnv = env[`OMD_${seat.toUpperCase()}_ADVISOR`];
  if (fromEnv?.trim()) return fromEnv.trim();
  const fromConfig = fileConfig(opts.path ?? configPath()).advisors?.[seat];
  if (typeof fromConfig === 'string' && fromConfig.trim()) return fromConfig.trim();
  return seatSpecOf(seat)?.advisor;
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
export const POOL_TIERS = [
  'strong',
  'mid',
  'cheap',
  'multimodal',
  'multimodalStrong',
  // ── 2026-08-05: 原本**硬写在源码里**的那几个池搬进来 ──────────────────────────
  // 为什么搬: 它们是**选择**不是事实表(价表/能力表/评分那类才该留在代码里),而改一个选择
  // 却要改代码+跑测试+提交。今天一天里 owner 连续三次撞到同一堵墙:研究判优池里躺着一个
  // 429 的死座位、溢出兜底在拿 mimo 跑文本活 —— 全靠 grep 才翻出来。
  //
  // ⚠ 它们**沿用 pools 这条轴的既有语义**(见 checkPools 的注):不经过座位链,
  //   `OMD_POOL_*` 压过 config,坏值丢弃 fail-open。少造一套机制就少一处会漂。
  /** 研究判优池(judge panel,K 维度逐个轮不同族)。 */
  'judge',
  /** 跨家族发散池(lens gen + synth framing)。 */
  'lens',
  // auto-assign 的**溢出兜底**(专属桶烧穿后落哪几个坐标)。按 NodeClass 分。
  // 兜底恰恰是没人盯着的那条路 —— 主桶烧穿时才生效,配错会静默发生。
  'fallbackDecomposer',
  'fallbackJudgeSynth',
  'fallbackWorker',
  'fallbackVerify',
] as const;
export type PoolTier = (typeof POOL_TIERS)[number];

/** 档位正名 env key: `OMD_POOL_<TIER>` (驼峰 → 下划线大写)。逗号分隔多个坐标。 */
export function poolEnvKey(tier: PoolTier): string {
  return `OMD_POOL_${tier.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase()}`;
}

/**
 * 与 {@link resolveConfiguredPools} 同一次解析,但**带上来源层**(2026-08-05)。
 *
 * 为什么要它:`resolveConfiguredPools` 只回"配了什么",回不出"这个值是谁给的"。
 * 而 owner 今天连撞三次的正是后者 —— 一个坐标到底来自 env、config、还是硬写在某个源码文件里,
 * 只能靠 grep 全仓才答得上来。读数板要能一眼答,这一层就得先答得上来。
 */
export function describeConfiguredPools(
  path = configPath(),
  env: Record<string, string | undefined> = process.env,
): Partial<Record<PoolTier, { coords: string[]; source: 'env' | 'config' }>> {
  const raw = fileConfig(path).pools;
  const fromFile = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out: Partial<Record<PoolTier, { coords: string[]; source: 'env' | 'config' }>> = {};
  for (const tier of POOL_TIERS) {
    const fromEnv = cleanCoordList(env[poolEnvKey(tier)]);
    if (fromEnv) {
      out[tier] = { coords: fromEnv, source: 'env' };
      continue;
    }
    const fromCfg = cleanCoordList(fromFile[tier]);
    if (fromCfg) out[tier] = { coords: fromCfg, source: 'config' };
  }
  return out;
}

/** 坐标列表清洗 (逗号串或数组 → 去重的坐标数组; 无有效项 → undefined)。坏值丢弃 fail-open。 */
function cleanCoordList(xs: unknown): string[] | undefined {
  const arr = typeof xs === 'string' ? xs.split(',') : xs;
  if (!Array.isArray(arr)) return undefined;
  const out = [
    ...new Set(
      arr
        .filter((x): x is string => typeof x === 'string')
        .map((x) => x.trim())
        .filter((x) => x.includes(':')),
    ),
  ];
  return out.length ? out : undefined;
}

export function resolveConfiguredPools(
  path = configPath(),
  env: Record<string, string | undefined> = process.env,
): Partial<Record<PoolTier, string[]>> {
  const raw = fileConfig(path).pools;
  const fromFile = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  // ⚠ 清洗器与 describeConfiguredPools **共用同一个** (cleanCoordList): 两份清洗规则早晚各漂各的,
  //   而"读数板说配了、执行期说没配"是这条链上最难查的一种。
  const clean = cleanCoordList;
  const out: Partial<Record<PoolTier, string[]>> = {};
  for (const tier of POOL_TIERS) {
    // env **压过** config.pools —— 与座位那条 env 别名的方向相反, 是刻意的:
    // 座位的 env 是**历史别名** (OMD_ITER_* 等), 当年它们压过 config 造成"改了 config 还是老模型",
    // 所以 P0 把它们降到 config 之下。这里的 OMD_POOL_* 是**新造的临时覆盖口**, 没有历史包袱,
    // 语义就该是"这次进程按我说的来" —— 否则配置文件永远配着, 临时覆盖就永远不生效, 等于白加。
    const picked = clean(env[poolEnvKey(tier)]) ?? clean(fromFile[tier]);
    if (picked) out[tier] = picked;
  }
  return out;
}
