/**
 * init/headless-config —— 非交互配置突变层 (omd_* MCP 工具 + /omd-setup slash 共用)。
 *
 * wizard.ts 的配置逻辑与 readline 交互耦合 (applyRolePreset 逐个 io.ask 要 key); 本模块提供
 * 同等突变的 headless 版, 供 MCP 子进程 (无 TTY) 与 Claude 对话式 slash 消费:
 *   - key 单独经 setKeyHeadless 落 auth.json(pi 通道)/ .env(native registry), 按坐标解析路由。
 *   - preset 只写角色矩阵 + config.json, 不 prompt key (key 由 setKeyHeadless 单独补)。
 *
 * 全部"写盘 + 活进程注入"双写 (沿 wizard.ts 的 §同步 process.env 模式): 落盘跨重启, 注入令当前
 * MCP 子进程即时生效 —— 角色 env 调用时现读 process.env · config.json 靠 mtime 重读 · native
 * provider 靠 registerProvidersFromEnv/registerCustomApis re-register。故改配置**不必重连 MCP**。
 *
 * 安全: 密钥只落 auth.json (~/.pi, repo 外) 或 .env (gitignored) —— **永不碰 .mcp.json** (git 跟踪)。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import {
  listCustomApis,
  listRoleModels,
  persistCustomApi,
  persistMultimodalPool,
  persistMultimodalPoolPremium,
  persistRoleModel,
  resolveMultimodalPool,
  type ModelRole,
} from '../../model/role-models';
import { getProvider, registerCustomApis, registerProvidersFromEnv } from '../../model/providers';
import { piHasCredential } from '../../model/pi-transport';
import { ROLE_PRESETS, coordProvider } from './role-presets';
import { hudStatusLineCommand, installHudStatusLine } from './hud-statusline';
import { upsertEnv } from './wizard';

/** native registry provider → 其 env key 名 (registerProvidersFromEnv 硬编码消费点)。 */
const NATIVE_ENV_KEY: Record<string, string> = {
  deepseek: 'DEEPSEEK_API_KEY',
  mimo: 'MIMO_API_KEY',
};

/** 坐标格式校验 (provider:model, 排除 URL / 逗号列表) — 与 wizard.COORD_RE 同。 */
export const COORD_RE = /^[a-z0-9._-]+:(?!\/\/)[^\s,]+$/i;

export interface HeadlessDeps {
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** auth.json 路径 (默认 ~/.pi/agent/auth.json)。 */
  authPath?: string;
  /** 写文件接缝 (测试注入)。 */
  writeFile?: (path: string, content: string) => void;
}

function defaultAuthPath(): string {
  return join(homedir(), '.pi', 'agent', 'auth.json');
}

function envFilePath(cwd: string): string {
  return join(cwd, '.env');
}

/** 非破坏性 upsert 一组 env 到 <cwd>/.env (缺文件则建)。 */
function writeEnvUpdates(cwd: string, updates: Record<string, string>, write?: HeadlessDeps['writeFile']): string {
  const path = envFilePath(cwd);
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const next = upsertEnv(existing, updates);
  (write ?? ((p, c) => writeFileSync(p, c, 'utf8')))(path, next);
  return path;
}

/** 写一条 auth.json api_key 条目 (合并, 不动其它 provider)。 */
function writeAuthJsonKey(provider: string, key: string, authPath: string, write?: HeadlessDeps['writeFile']): void {
  let all: Record<string, unknown> = {};
  if (existsSync(authPath)) {
    try {
      const parsed = JSON.parse(readFileSync(authPath, 'utf8')) as Record<string, unknown>;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) all = parsed;
    } catch {
      /* 坏 JSON → 从空起 (不吞: 下方 write 会重写, 但既有条目已丢 — 极罕见, auth.json 由 pi/omd 独占写) */
    }
  }
  all[provider] = { type: 'api_key', key };
  mkdirSync(dirname(authPath), { recursive: true });
  (write ?? ((p, c) => writeFileSync(p, c, 'utf8')))(authPath, `${JSON.stringify(all, null, 2)}\n`);
}

/**
 * provider 是否有可用凭证 —— native (registry 已注册 ∨ env key 在) ∨ pi 通道 (auth.json/env 映射)。
 * piHasCredential 单独对 native provider (如 mimo, 不在 PI_ENV_KEY_MAP) 会漏判, 故此处补 native 维度。
 */
export function hasCredential(provider: string, env: Record<string, string | undefined>): boolean {
  if (getProvider(provider)) return true; // native registry 命中 (注册时 key 在)
  const nativeKey = NATIVE_ENV_KEY[provider];
  if (nativeKey && env[nativeKey]?.trim()) return true;
  const customKeyEnv = listCustomApis().find((a) => a.id === provider)?.keyEnv;
  if (customKeyEnv && env[customKeyEnv]?.trim()) return true;
  return piHasCredential(provider, env);
}

// ---------------------------------------------------------------------------
// setKeyHeadless — 按坐标解析路由 key 落 auth.json(pi) / .env(native) + 活注入。
// ---------------------------------------------------------------------------

export type KeyTarget = 'auto' | 'authjson' | 'env';

export interface SetKeyResult {
  provider: string;
  target: 'authjson' | 'env';
  /** 当前 MCP 子进程是否即时生效 (双写后恒 true)。 */
  immediate: boolean;
  warnings: string[];
}

/**
 * 落一把 provider key 并令当前进程即时可用。路由:
 *   - native (deepseek/mimo/自定 api id): coord 解析走 callModel registry (getProvider 优先于 pi 目录),
 *     key 从 env 读 → 落 .env + 注入 process.env + re-register。
 *   - 其余 pi provider (kimi-coding/minimax-cn/…): coord 走 pi 目录, 认证读 auth.json → 落 api_key 条目
 *     (resolvePiApiKey 现读 → 即时)。
 * target 可显式覆盖 auto 路由。
 */
export function setKeyHeadless(provider: string, key: string, target: KeyTarget = 'auto', deps: HeadlessDeps = {}): SetKeyResult {
  const p = provider.trim();
  const k = key.trim();
  if (!p) throw new Error('setKeyHeadless: provider required');
  if (!k) throw new Error('setKeyHeadless: key required');
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  const authPath = deps.authPath ?? defaultAuthPath();
  const warnings: string[] = [];

  const customKeyEnv = listCustomApis().find((a) => a.id === p)?.keyEnv;
  const nativeKeyEnv = NATIVE_ENV_KEY[p] ?? customKeyEnv;
  const resolved: 'authjson' | 'env' = target === 'auto' ? (nativeKeyEnv ? 'env' : 'authjson') : target;

  if (resolved === 'env') {
    const keyEnv = nativeKeyEnv ?? `${p.toUpperCase()}_API_KEY`;
    writeEnvUpdates(cwd, { [keyEnv]: k }, deps.writeFile);
    (env as Record<string, string>)[keyEnv] = k;
    registerProvidersFromEnv(env); // mimo/deepseek 重注册
    if (customKeyEnv) registerCustomApis(listCustomApis(), env); // 自定 api 重注册
    if (p === 'mimo' && !env.MIMO_BASE_URL) {
      warnings.push('MIMO_BASE_URL 未设 — mimo provider 注册会跳过; 先经 preset 或手动设 base/model。');
    }
    // native env 覆盖同 provider 的旧 auth.json 条目 (coord 走 registry) — 提示避免困惑。
    if (existsSync(authPath)) {
      try {
        const auth = JSON.parse(readFileSync(authPath, 'utf8')) as Record<string, { key?: string }>;
        if (auth[p]?.key && auth[p]!.key !== k) {
          warnings.push(`auth.json 有 ${p} 旧 key — 已被 .env 的 ${keyEnv} 覆盖 (coord 走 native registry)。`);
        }
      } catch {
        /* ignore */
      }
    }
    return { provider: p, target: 'env', immediate: true, warnings };
  }

  writeAuthJsonKey(p, k, authPath, deps.writeFile);
  return { provider: p, target: 'authjson', immediate: true, warnings };
}

// ---------------------------------------------------------------------------
// applyPresetHeadless — 写角色矩阵 (.env) + config (config.json), 不 prompt key。
// ---------------------------------------------------------------------------

export interface ApplyPresetResult {
  presetId: string;
  wroteEnv: string[];
  configRoles: { role: string; coord: string }[];
  multimodalPool: string[];
  customApis: string[];
  /** 无凭证的 provider (headless 不 prompt; 由 setKeyHeadless 单独补)。 */
  missingKeys: { provider: string; where: string }[];
}

export function applyPresetHeadless(presetId: string, deps: HeadlessDeps = {}): ApplyPresetResult {
  const preset = ROLE_PRESETS.find((pr) => pr.id === presetId);
  if (!preset) {
    throw new Error(`unknown preset '${presetId}' (可选: ${ROLE_PRESETS.map((pr) => pr.id).join(', ')})`);
  }
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();

  // ① 角色矩阵 env → .env + 活注入。
  const updates = { ...preset.env };
  writeEnvUpdates(cwd, updates, deps.writeFile);
  for (const [key, val] of Object.entries(updates)) (env as Record<string, string>)[key] = val;

  // ② 自定 API 端点 → config.json (key 后补) + 注册 (key 在 env 则生效)。
  for (const api of preset.customApis ?? []) {
    persistCustomApi({ id: api.id, baseUrl: api.baseUrl, keyEnv: api.keyEnv });
  }

  // ③ 多模态池 → config.json。
  if (preset.multimodalPool?.length) persistMultimodalPool(preset.multimodalPool);
  if (preset.multimodalPoolPremium?.length) persistMultimodalPoolPremium(preset.multimodalPoolPremium);

  // ④ config 角色 (conductor/leaf/verifier/dream) → config.json (mtime 重读即时)。
  for (const cr of preset.configRoles ?? []) persistRoleModel(cr.role, cr.coord);

  // ⑤ native provider 重注册 (新 env 生效) + 自定 api 重注册。
  registerProvidersFromEnv(env);
  if (preset.customApis?.length) registerCustomApis(listCustomApis(), env);

  // ⑥ 缺凭证的 provider 汇总 (供调用方提示补 key)。
  const providers = new Set<string>();
  for (const kp of preset.keyPrompts ?? []) if (kp.provider) providers.add(kp.provider);
  for (const cr of preset.configRoles ?? []) providers.add(coordProvider(cr.coord));
  const missingKeys = [...providers]
    .filter((prov) => !hasCredential(prov, env))
    .map((prov) => ({ provider: prov, where: NATIVE_ENV_KEY[prov] ? `.env:${NATIVE_ENV_KEY[prov]}` : 'auth.json' }));

  return {
    presetId,
    wroteEnv: Object.keys(updates),
    configRoles: (preset.configRoles ?? []).map((c) => ({ role: c.role, coord: c.coord })),
    multimodalPool: preset.multimodalPool ?? [],
    customApis: (preset.customApis ?? []).map((a) => a.id),
    missingKeys,
  };
}

// ---------------------------------------------------------------------------
// setRoleHeadless — 单角色覆盖 → config.json (mtime 重读即时)。
// ---------------------------------------------------------------------------

/** MCP 可调 config 角色 (canonical 5 去 plan — 审议座舱由 Opus 顶替)。 */
export const TUNABLE_CONFIG_ROLES: readonly ModelRole[] = ['conductor', 'leaf', 'verifier', 'dream'];

export function setRoleHeadless(role: string, coord: string): { role: string; coord: string } {
  const r = role.trim() as ModelRole;
  const c = coord.trim();
  if (!TUNABLE_CONFIG_ROLES.includes(r)) {
    throw new Error(`role '${role}' 不可调 (可选: ${TUNABLE_CONFIG_ROLES.join(', ')}; plan 已由 Opus 顶替)`);
  }
  if (!COORD_RE.test(c)) throw new Error(`coord '${coord}' 格式非法 (期望 provider:model)`);
  persistRoleModel(r, c);
  return { role: r, coord: c };
}

// ---------------------------------------------------------------------------
// configSnapshot — 当前角色→模型 + 每 provider 凭证状态 (config_status 数据源)。
// ---------------------------------------------------------------------------

/** 引擎 env 子角色 (Nick 分类 → 实际消费的 OMD_* 变量)。 */
const SNAPSHOT_ENV_ROLES: readonly { label: string; env: string }[] = [
  { label: 'conductor(iter)', env: 'OMD_ITER_CONDUCTOR_MODEL' },
  { label: 'fleet/leaf(iter)', env: 'OMD_ITER_LEAF_MODEL' },
  { label: 'judge', env: 'OMD_JUDGE_MODEL' },
  { label: 'synth(reduce)', env: 'OMD_REDUCE_MODEL' },
  { label: 'synth(reason)', env: 'OMD_REASON_MODEL' },
];

export interface ConfigSnapshot {
  roles: { role: string; resolved: string; source: string; provider: string; hasCredential: boolean }[];
  envRoles: { label: string; coord: string; provider: string; hasCredential: boolean }[];
  multimodalPool: string[];
  customApis: { id: string; baseUrl: string }[];
  warnings: string[];
}

export function configSnapshot(deps: HeadlessDeps = {}): ConfigSnapshot {
  const env = deps.env ?? process.env;
  const warnings: string[] = [];

  // canonical config 角色 (去 plan)。
  const roles = listRoleModels(env)
    .filter((e) => e.role !== 'plan')
    .map((e) => {
      const provider = coordProvider(e.resolved);
      const cred = hasCredential(provider, env);
      if (!cred) warnings.push(`角色 ${e.role} → ${e.resolved} 但 ${provider} 无凭证 (call 时会抛)。`);
      return { role: e.role, resolved: e.resolved, source: e.source, provider, hasCredential: cred };
    });

  // 引擎 env 子角色 (仅报已设的)。
  const envRoles = SNAPSHOT_ENV_ROLES.map((r) => {
    const coord = env[r.env]?.trim() ?? '';
    if (!coord) return null;
    const provider = coordProvider(coord);
    const cred = hasCredential(provider, env);
    if (!cred) warnings.push(`${r.label} (${r.env}) → ${coord} 但 ${provider} 无凭证。`);
    return { label: r.label, coord, provider, hasCredential: cred };
  }).filter((x): x is NonNullable<typeof x> => x !== null);

  return {
    roles,
    envRoles,
    multimodalPool: resolveMultimodalPool(),
    customApis: listCustomApis().map((a) => ({ id: a.id, baseUrl: a.baseUrl })),
    warnings,
  };
}

// ---------------------------------------------------------------------------
// toggleHud — 装/卸 omd-hud statusLine (本 repo .claude/settings.local.json)。
// ---------------------------------------------------------------------------

export interface ToggleHudResult {
  on: boolean;
  status: 'installed' | 'already' | 'removed' | 'not-present' | 'failed';
  path: string;
  reason?: string;
}

export function toggleHud(cwd: string, on: boolean, deps: HeadlessDeps = {}): ToggleHudResult {
  const path = join(cwd, '.claude', 'settings.local.json');
  if (on) {
    const r = installHudStatusLine(cwd);
    return {
      on: true,
      status: r.status === 'installed' ? 'installed' : r.status === 'already' ? 'already' : 'failed',
      path: r.path,
      ...(r.reason ? { reason: r.reason } : {}),
    };
  }
  // off: 仅当 statusLine 是本 repo 的 omd-hud 时移除, 不动其它。
  if (!existsSync(path)) return { on: false, status: 'not-present', path };
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return { on: false, status: 'failed', path, reason: 'settings.local.json 非法 JSON — 拒绝改动' };
  }
  const cur = obj.statusLine as { command?: string } | undefined;
  if (!cur || cur.command !== hudStatusLineCommand(cwd)) return { on: false, status: 'not-present', path };
  delete obj.statusLine;
  (deps.writeFile ?? ((p, c) => writeFileSync(p, c, 'utf8')))(path, `${JSON.stringify(obj, null, 2)}\n`);
  return { on: false, status: 'removed', path };
}
