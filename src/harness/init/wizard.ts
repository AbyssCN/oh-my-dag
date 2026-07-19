/**
 * init/wizard —— omd 首次配置向导 (配 key + 选 model + 探针校验 + 健检)。
 *
 * 触发 (tui.ts 接线): ① `omd init` 显式 ② 缺 runtime 配置时首次启动自动进 (替代旧 fail-fast 崩)。
 * pre-main 交互 (pi TUI 还没起) → IO 抽象成 WizardIO (默认 readline, 测试注入脚本化 IO)。
 *
 * 纯件可测: detectRuntimeConfig / providerDefaults / upsertEnv / probeProvider (注入 fetch)。
 * 编排 runInitWizard 串起来 + 写 .env (非破坏性 upsert, 保留其余行/注释)。
 *
 * env 命名: 源码 OMD_ 前缀 (sync scrub → OMD_); provider key (DEEPSEEK_ / MIMO_ 前缀) 第三方名不 scrub。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import {
  getOAuthProviders,
  type OAuthCredentials,
  type OAuthLoginCallbacks,
} from '@earendil-works/pi-ai/oauth';
import { getProviders as piGetProviders, getEnvApiKey as piGetEnvApiKey } from '@earendil-works/pi-ai';
import { registerKimiCodingOAuth } from '../../model/kimi-oauth';
import { bold, dim, fg } from '../branding/palette';
import {
  persistCustomApi,
  persistMultimodalPool,
  persistMultimodalPoolPremium,
  persistRoleModel,
  type ApiDef,
  type ModelRole,
} from '../../model/role-models';
import { ROLE_PRESETS, ROLE_ENV_ALLOWLIST, coordProvider, type RolePreset } from './role-presets';
import { globalEnvPath } from '../../env-alias';

/** 一线支持的后端 (= registerProvidersFromEnv 认识的)。 */
export interface ProviderDef {
  id: string;
  label: string;
  /** API key 的 env 变量名。 */
  keyEnv: string;
  /** base URL env 变量名 + 默认值。 */
  baseEnv: string;
  defaultBase: string;
  /** model env 变量名 + 候选 (第一个为默认)。 */
  modelEnv: string;
  models: string[];
}

export const PROVIDERS: readonly ProviderDef[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek (v4-pro / v4-flash · OpenAI 兼容)',
    keyEnv: 'DEEPSEEK_API_KEY',
    baseEnv: 'DEEPSEEK_BASE_URL',
    defaultBase: 'https://api.deepseek.com',
    modelEnv: 'DEEPSEEK_MODEL',
    models: ['deepseek-v4-pro', 'deepseek-v4-flash'],
  },
  {
    id: 'mimo',
    label: 'MiMo (v2.5-pro · reasoning + 多模态 · 区域锁 key)',
    keyEnv: 'MIMO_API_KEY',
    baseEnv: 'MIMO_BASE_URL',
    defaultBase: 'https://api.mimo.xiaomi.com/v1',
    modelEnv: 'MIMO_MODEL',
    models: ['mimo-v2.5-pro'],
  },
];

export function providerById(id: string | undefined): ProviderDef | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

export interface RuntimeConfigStatus {
  ok: boolean;
  provider?: string;
  model?: string;
  /** 缺的 env 变量名 (引导用)。 */
  missing: string[];
}

/**
 * 判 runtime 配置是否齐 (决定是否要进 wizard)。
 * 齐 = OMD_RUNTIME_PROVIDER + OMD_RUNTIME_MODEL + 该 provider 的 API key。
 */
export function detectRuntimeConfig(env: Record<string, string | undefined> = process.env): RuntimeConfigStatus {
  const provider = env.OMD_RUNTIME_PROVIDER;
  const model = env.OMD_RUNTIME_MODEL;
  const missing: string[] = [];
  if (!provider) missing.push('OMD_RUNTIME_PROVIDER');
  if (!model) missing.push('OMD_RUNTIME_MODEL');
  const def = providerById(provider);
  if (def && !env[def.keyEnv]) missing.push(def.keyEnv);
  // provider 设了但不认识 → 视为已配 (高级用户自定; 不强拦)。
  return { ok: missing.length === 0, provider, model, missing };
}

/**
 * 非破坏性 upsert: 把 updates 的 key 写进 .env 内容 (存在则替换该行, 否则追加), 其余行原样保留。
 */
export function upsertEnv(content: string, updates: Record<string, string>): string {
  const lines = content.length ? content.split('\n') : [];
  const remaining = { ...updates };
  const out = lines.map((line) => {
    const m = /^(\s*)([A-Z0-9_]+)\s*=/.exec(line);
    if (m && m[2] && m[2] in remaining) {
      const key = m[2];
      const val = remaining[key];
      delete remaining[key];
      return `${key}=${val}`;
    }
    return line;
  });
  const appended = Object.entries(remaining).map(([k, v]) => `${k}=${v}`);
  if (appended.length) {
    if (out.length && out[out.length - 1]?.trim() !== '') out.push('');
    out.push('# --- omd init 写入 ---', ...appended);
  }
  return `${out.join('\n').replace(/\n+$/, '')}\n`;
}

export interface ProbeResult {
  ok: boolean;
  detail: string;
}

/** 探针: GET {base}/models 校验 key 可达 (OpenAI 兼容)。注入 fetch 便于测试。 */
export async function probeProvider(
  base: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 12_000,
): Promise<ProbeResult> {
  const url = `${base.replace(/\/$/, '')}/models`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: ctl.signal,
    });
    if (res.ok) return { ok: true, detail: `HTTP ${res.status}` };
    if (res.status === 401 || res.status === 403) return { ok: false, detail: `鉴权失败 (HTTP ${res.status}) — key 错或区域锁` };
    return { ok: false, detail: `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, detail: (e as Error).name === 'AbortError' ? '超时' : (e as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

// ── pi OAuth (统一模型层, 2026-07-19): auth.json 检测 + 可选内联登录 ────────────────
//
// grounding (pi-ai 0.77.0 oauth.d.ts 实测): 内置 OAuthProviderInterface 只有 anthropic /
// github-copilot / openai-codex, 三者的 login(callbacks) 均可编程调用 (onAuth/onDeviceCode/
// onPrompt/onSelect 回调) → 可内联跑。kimi-coding **无**内置登录件 (pi 侧 extension 注册) →
// 只能指引去 pi CLI 里 /login 后重跑 omd init。已登录检测 = 读 ~/.pi/agent/auth.json。

/** pi auth.json 默认路径。 */
export function defaultPiAuthPath(): string {
  return join(homedir(), '.pi', 'agent', 'auth.json');
}

/** provider 总览步的注入面 (测试换假目录/假 env)。 */
export interface ProviderOverviewDeps {
  getProviders?: () => string[];
  getEnvApiKey?: (provider: string) => string | undefined;
}

/**
 * ⓪ pi 目录 provider 总览 (向导开场, 纯展示零交互): 列出 pi-ai 目录全部 provider (~32 家) +
 * 就绪标记 — ✓oauth (auth.json 有凭证) / ✓key (对应 env key 已设)。让用户一眼看到"pi 认识哪些家、
 * 我已经能用哪些家", 而不是只看到 omd 一线支持的两家。目录不可用 fail-open 跳过。
 */
export function runProviderOverviewStep(
  io: WizardIO,
  piReady: string[],
  deps: ProviderOverviewDeps = {},
): void {
  let provs: string[] = [];
  try {
    provs = (deps.getProviders ?? (piGetProviders as () => string[]))();
  } catch {
    return; // 目录不可用不砖向导
  }
  if (!provs.length) return;
  const keyOf = deps.getEnvApiKey ?? piGetEnvApiKey;
  const ready: string[] = [];
  const rest: string[] = [];
  for (const p of provs) {
    if (piReady.includes(p)) {
      ready.push(`${p} ✓oauth`);
      continue;
    }
    let k: string | undefined;
    try {
      k = keyOf(p);
    } catch {
      k = undefined;
    }
    if (k) ready.push(`${p} ✓key`);
    else rest.push(p);
  }
  io.note(
    [
      bold(fg('gold', `pi 目录 provider (${provs.length} 家)`)),
      ready.length ? `  ${fg('success', '已就绪:')} ${fg('rice', ready.join(' · '))}` : '',
      `  ${dim(fg('riceMuted', `可配: ${rest.join(' ')}`))}`,
      `  ${dim(fg('riceMuted', '任一家配好 env key 或 pi OAuth 后, 即可用 provider:model 坐标挂到任何角色'))}`,
    ]
      .filter(Boolean)
      .join('\n'),
  );
}

/**
 * 检测 auth.json 里已就绪的 provider (api_key 有 key, 或 oauth 有 access)。
 * 缺文件/坏 JSON → [] (检测永不砖 wizard)。纯函数可测 (注入路径)。
 */
export function listPiAuthReady(authPath = defaultPiAuthPath()): string[] {
  try {
    if (!existsSync(authPath)) return [];
    const all = JSON.parse(readFileSync(authPath, 'utf8')) as Record<
      string,
      { type?: unknown; key?: unknown; access?: unknown } | undefined
    >;
    return Object.entries(all)
      .filter(([, v]) =>
        (typeof v?.key === 'string' && v.key.trim()) ||
        (typeof v?.access === 'string' && v.access.trim()),
      )
      .map(([k]) => k);
  } catch {
    return [];
  }
}

/** 内联可跑的 pi OAuth 登录件 (pi-ai OAuthProviderInterface 子集)。 */
export interface PiOAuthLoginProvider {
  id: string;
  name: string;
  login: (callbacks: OAuthLoginCallbacks) => Promise<OAuthCredentials>;
}

/** pi OAuth 步骤的注入面 (测试换假 auth.json / 假登录件)。 */
export interface PiAuthDeps {
  authPath?: string;
  /** 内联登录件列表。默认 = pi-ai oauth getOAuthProviders() (懒 require)。 */
  oauthProviders?: () => PiOAuthLoginProvider[];
  /** 登录成功后把凭证写回 auth.json。默认 = 读-改-写 authPath。 */
  saveCredential?: (provider: string, creds: OAuthCredentials) => void;
}

function realOAuthProviders(): PiOAuthLoginProvider[] {
  registerKimiCodingOAuth(); // 防加载顺序: 未经 model/index 也保证 kimi-coding 登录件在场
  return getOAuthProviders().map((p) => ({
    id: p.id,
    name: p.name,
    login: (cb) => p.login(cb),
  }));
}

function saveCredentialToAuthJson(authPath: string, provider: string, creds: OAuthCredentials): void {
  const all = existsSync(authPath)
    ? (JSON.parse(readFileSync(authPath, 'utf8')) as Record<string, unknown>)
    : {};
  all[provider] = { type: 'oauth', ...creds };
  mkdirSync(dirname(authPath), { recursive: true });
  writeFileSync(authPath, `${JSON.stringify(all, null, 2)}\n`, 'utf8');
}

/**
 * pi OAuth 登录步 (runInitWizard ① — 先登录后配置): ① auth.json 已就绪清单 (纯展示)
 * ② confirm (默认否 — 既有脚本化测试队列不受扰) → select 登录件 → 内联跑 device/browser flow
 *    (URL/代码经 io.note, 输入经 io.ask/io.select) → 凭证写回 auth.json。
 * ③ kimi-coding 等无内置登录件的 → 打印精确指引 (pi CLI /login → 重跑 omd init)。
 * 返回**就绪 provider 清单** (含本次新登录的) — 下游 preset 用它免 key, 角色微调用它出坐标提示。
 * 导出便于测试直驱。永不抛 (登录失败 note 后继续 wizard)。
 */
export async function runPiOAuthStep(io: WizardIO, piAuth: PiAuthDeps = {}): Promise<string[]> {
  const authPath = piAuth.authPath ?? defaultPiAuthPath();
  const ready = listPiAuthReady(authPath);
  if (ready.length) {
    io.note(
      `${fg('success', '✓')} pi OAuth 已就绪: ${fg('rice', ready.join(', '))} ${dim(fg('riceMuted', `(来自 ${authPath} — 可直接用作 provider:model 坐标, 如 kimi-coding:k3)`))}`,
    );
  }
  const wantLogin = await io.confirm('跑 pi OAuth 登录? (Claude Pro/Max · GitHub Copilot · ChatGPT Codex; 可跳过)', false);
  if (!wantLogin) return ready;

  const providers = (piAuth.oauthProviders ?? realOAuthProviders)();
  // 已就绪的 provider 不进登录菜单 (再登一遍无意义); 全就绪 → 直接返回。
  // kimi-coding 正常已在注册表 (kimi-oauth.ts) — 手动兜底项仅在缺席且未就绪时出现。
  const loginOptions = [
    ...providers.filter((p) => !ready.includes(p.id)).map((p) => ({ id: p.id, label: p.name })),
    ...(ready.includes('kimi-coding') || providers.some((p) => p.id === 'kimi-coding')
      ? []
      : [{ id: 'kimi-coding', label: 'Kimi For Coding (device flow 经 omd 内置 pi)' }]),
  ];
  if (!loginOptions.length) {
    io.note(`${fg('success', '✓')} 全部 OAuth provider 已就绪, 无需登录`);
    return ready;
  }
  const choice = await io.select('选 OAuth provider', loginOptions);
  if (!choice) return ready;
  const provider = providers.find((p) => p.id === choice);
  if (!provider) {
    // 无 pi-ai 内置登录件 (kimi-coding 及未知)。omd 自带 pi runtime — 不需要任何外部 CLI:
    io.note(
      [
        fg('warning', `${choice} 的登录件在 pi 扩展层 (非 pi-ai 内置 OAuth), 向导内联跑不了 — 但 omd 就是 pi runtime:`),
        `  ${fg('rice', '启动 omd 后输 /login')}   ${dim(fg('riceMuted', `# 选 ${choice}, 完成 device flow`))}`,
        `  ${dim(fg('riceMuted', `凭证落 ${authPath}, 之后任何时候重跑 omd init 即显示 ✓ 就绪`))}`,
      ].join('\n'),
    );
    return ready;
  }
  try {
    const callbacks: OAuthLoginCallbacks = {
      onAuth: (info) =>
        io.note(`打开浏览器授权: ${fg('rice', info.url)}${info.instructions ? `\n${dim(fg('riceMuted', info.instructions))}` : ''}`),
      onDeviceCode: (info) =>
        io.note(`打开 ${fg('rice', info.verificationUri)} 输入代码 ${bold(fg('gold', info.userCode))} (轮询等待授权…)`),
      onPrompt: (prompt) => io.ask(prompt.message),
      onManualCodeInput: () => io.ask('粘贴回调 code'),
      onSelect: (prompt) => io.select(prompt.message, prompt.options),
      onProgress: (m) => io.note(dim(fg('riceMuted', m))),
    };
    const creds = await provider.login(callbacks);
    (piAuth.saveCredential ?? ((pid, c) => saveCredentialToAuthJson(authPath, pid, c)))(provider.id, creds);
    io.note(`${fg('success', '✓')} ${provider.name} 登录成功 — 凭证已写 ${authPath}`);
  } catch (e) {
    io.note(`${fg('error', '✗')} ${provider.name} 登录失败: ${(e as Error).message} ${dim(fg('riceMuted', '(可稍后在 pi CLI 里 /login)'))}`);
  }
  // 重读: 本次登录成功的 provider 一并计入就绪清单。
  return listPiAuthReady(authPath);
}

/** wizard 的 IO 抽象 (默认 readline; 测试注入脚本化)。 */
export interface WizardIO {
  /** 单选: 返回选中项 id (或 undefined = 取消)。 */
  select(label: string, options: Array<{ id: string; label: string }>): Promise<string | undefined>;
  /** 自由输入 (secret=true 不回显)。空 → 返回 defaultValue。 */
  ask(question: string, opts?: { defaultValue?: string; secret?: boolean }): Promise<string>;
  confirm(question: string, defaultValue?: boolean): Promise<boolean>;
  note(message: string): void;
}

/** preset 落 config.json 的写入口 (注入便于测试; 默认 role-models 真实现)。 */
export interface PresetPersistDeps {
  persistCustomApi: (def: ApiDef) => void;
  persistMultimodalPool: (coords: string[]) => void;
  persistMultimodalPoolPremium: (coords: string[]) => void;
  persistRoleModel: (role: ModelRole, coord: string) => void;
}

export interface InitWizardDeps {
  io: WizardIO;
  env?: Record<string, string | undefined>;
  cwd?: string;
  /** 写 .env (注入便于测试; 默认 Bun.write)。 */
  writeEnv?: (path: string, content: string) => Promise<void> | void;
  fetchImpl?: typeof fetch;
  /** preset 的 config.json 写入口 (注入便于测试)。 */
  persist?: PresetPersistDeps;
  /** pi OAuth 步骤注入面 (测试换假 auth.json / 假登录件)。 */
  piAuth?: PiAuthDeps;
  /** provider 总览步注入面 (测试换假目录)。 */
  providerCatalog?: ProviderOverviewDeps;
}

export interface InitWizardResult {
  /** 写入的 env 更新 (含 secret, 仅返回 key 列表给日志, 不返回值)。 */
  writtenKeys: string[];
  provider: string;
  model: string;
  probe: ProbeResult | null;
  envPath: string;
}

const REAL_PERSIST: PresetPersistDeps = {
  persistCustomApi: (def) => persistCustomApi(def),
  persistMultimodalPool: (coords) => persistMultimodalPool(coords),
  persistMultimodalPoolPremium: (coords) => persistMultimodalPoolPremium(coords),
  persistRoleModel: (role, coord) => persistRoleModel(role, coord),
};

/**
 * 应用一个角色矩阵 preset (纯泛化消费, 模型字符串只在 role-presets.ts):
 * ① env 合并进 updates ② 缺 key 提示粘贴 (回车跳过) ③ persistCustomApi 注册自定端点
 * ④ persistMultimodalPool / persistMultimodalPoolPremium 写多模态双层池 (对应 key 跳过则不写)
 * ⑤ persistRoleModel 写 config 角色
 * ⑥ io.note 汇总表。导出便于测试直驱。
 */
export async function applyRolePreset(
  preset: RolePreset,
  updates: Record<string, string>,
  io: WizardIO,
  env: Record<string, string | undefined>,
  persist: PresetPersistDeps = REAL_PERSIST,
  piReady: string[] = [],
): Promise<void> {
  Object.assign(updates, preset.env);

  // 缺的 key 逐个提示 (已在 env 或本次 updates 里的跳过)。跳过 → 该 provider 的 pool/config 角色不写。
  const missingProviders = new Set<string>();
  // pi OAuth 依赖的 provider (如 kimi-coding): 就绪判定走 auth.json, 免 key。
  // 未登录 → 指引 (omd 即 pi runtime, TUI 里 /login 即可, 不需要外部 CLI) + 同 key 跳过语义剔除坐标。
  for (const p of preset.oauthProviders ?? []) {
    if (piReady.includes(p)) {
      io.note(`${fg('success', '✓')} ${p} 经 pi OAuth 已就绪 — 免 key`);
    } else {
      io.note(
        fg('warning', `${p} 未登录 — omd 内置 pi runtime: 启动 omd 后输 /login 选 ${p} 完成 device flow, 再跑 omd init 即就绪。本次先剔除其坐标。`),
      );
      missingProviders.add(p);
    }
  }
  for (const kp of preset.keyPrompts ?? []) {
    // pi OAuth 已就绪的 provider 免 key (统一模型层: 认证走 pi auth.json, 不走 env key)。
    if (kp.provider && piReady.includes(kp.provider)) {
      io.note(`${fg('success', '✓')} ${kp.provider} 经 pi OAuth 已就绪 — 免 key`);
      continue;
    }
    if (env[kp.env]?.trim() || updates[kp.env]?.trim()) continue;
    const v = await io.ask(`${kp.label} — ${kp.env} (回车跳过)`, { secret: true });
    if (v.trim()) updates[kp.env] = v.trim();
    else if (kp.provider) missingProviders.add(kp.provider);
  }

  // 自定 OpenAI 兼容端点 → config.json apis 段 (key 可后补, 端点元数据先落)。
  for (const api of preset.customApis ?? []) {
    persist.persistCustomApi({ id: api.id, baseUrl: api.baseUrl, keyEnv: api.keyEnv });
  }

  // 多模态池 (便宜层 + 贵层): 对应 provider key 跳过的坐标剔除; 全空则不写。
  let writtenPool: string[] = [];
  if (preset.multimodalPool?.length) {
    writtenPool = preset.multimodalPool.filter((c) => !missingProviders.has(coordProvider(c)));
    if (writtenPool.length) persist.persistMultimodalPool(writtenPool);
    else io.note(dim(fg('riceMuted', '多模态池未写 (对应 key 跳过, 可稍后 /config 补)')));
  }
  let writtenPremium: string[] = [];
  if (preset.multimodalPoolPremium?.length) {
    writtenPremium = preset.multimodalPoolPremium.filter((c) => !missingProviders.has(coordProvider(c)));
    if (writtenPremium.length) persist.persistMultimodalPoolPremium(writtenPremium);
    else io.note(dim(fg('riceMuted', '多模态贵层池未写 (对应 key 跳过, 可稍后 /config 补)')));
  }

  // config.json 角色写入 (如 verifier 跨家族) — provider key 跳过的同样不写。
  const writtenRoles: Array<{ role: string; coord: string }> = [];
  for (const cr of preset.configRoles ?? []) {
    if (missingProviders.has(coordProvider(cr.coord))) continue;
    persist.persistRoleModel(cr.role, cr.coord);
    writtenRoles.push({ role: cr.role, coord: cr.coord });
  }

  // 汇总表: 本次写入的角色矩阵。
  const rows: Array<[string, string]> = ROLE_ENV_ALLOWLIST.filter((k) => k in updates).map((k) => [
    k,
    updates[k]!,
  ]);
  for (const r of writtenRoles) rows.push([`config:${r.role}`, r.coord]);
  if (writtenPool.length) rows.push(['config:multimodalPool', writtenPool.join(', ')]);
  if (writtenPremium.length) rows.push(['config:multimodalPoolPremium', writtenPremium.join(', ')]);
  for (const api of preset.customApis ?? []) {
    rows.push([`config:api:${api.id}`, `${api.baseUrl} (key: ${api.keyEnv})`]);
  }
  const width = Math.max(...rows.map(([k]) => k.length));
  io.note(
    [
      bold(fg('gold', `角色矩阵 · ${preset.label}`)),
      ...rows.map(([k, v]) => `  ${fg('rice', k.padEnd(width))}  ${dim(fg('riceMuted', v))}`),
    ].join('\n'),
  );
}

/** 'provider:model' 坐标格式 (排除 URL 与逗号列表)。 */
export const COORD_RE = /^[a-z0-9._-]+:(?!\/\/)[^\s,]+$/i;

/**
 * 逐角色微调面 = **真实的节点角色 env 面** (ROLE_ENV_ALLOWLIST 有消费方的子集) + 2 个 config 角色。
 * 注意不含 config:plan / config:conductor —— 二者当前无消费方 (plan 工具箱跑在对话里 = runtime 模型;
 * /execute 分解器默认 = runtime, 覆盖点是 OMD_ITER_CONDUCTOR_MODEL env, 见 resolveConductorDefault)。
 */
export const TUNABLE_ENV_ROLES: readonly { env: string; label: string }[] = [
  { env: 'OMD_ITER_CONDUCTOR_MODEL', label: 'DAG 分解器 (/execute·/iterate; 默认=runtime 模型)' },
  { env: 'OMD_ITER_LEAF_MODEL', label: 'DAG inproc 叶子 (单发生成/判断)' },
  { env: 'OMD_ITER_AGENT_MODEL', label: 'DAG agent 叶子 (带工具改文件)' },
  { env: 'OMD_CONDUCTOR_ESCALATION_MODEL', label: '升级分解器 (校验失败才买的强模型)' },
  { env: 'OMD_CG_CONDUCTOR_MODEL', label: '检索图分解器 (/cg·/audit)' },
  { env: 'OMD_CG_LEAF_MODEL', label: '检索图叶子' },
  { env: 'OMD_CG_AGENT_MODEL', label: '检索图 agent 叶子' },
  { env: 'OMD_LENS_MODEL', label: '研究镜头 (dag-research 扇出)' },
  { env: 'OMD_REDUCE_MODEL', label: '研究归并 (镜头内 V→1 合成)' },
  { env: 'OMD_JUDGE_MODEL', label: '研究评判 (K-judge)' },
  { env: 'OMD_REASON_MODEL', label: '研究推理 (终稿)' },
  { env: 'OMD_REVIEW_SPEC_MODEL', label: '审查 Spec 轴 (dag-review 双轴)' },
  { env: 'OMD_LEAF_OVERFLOW_MODEL', label: '叶子溢出兜底 (超长上下文)' },
];
export const TUNABLE_CONFIG_ROLES: readonly { role: ModelRole; label: string }[] = [
  { role: 'verifier', label: '跨模型校验 skeptic (建议 ≠ 主力家族)' },
  { role: 'dream', label: '记忆整理 (dream/skill-miner, 便宜档即可)' },
];

/**
 * 逐角色微调步 (④): 配了多 provider/网关 (opencode-go 一把 key 多家族 · pi OAuth 多后端) 时,
 * 各节点角色可挂不同模型。select 循环 (选角色 → 填坐标 → 重复, '完成'退出) — 不逐项轰炸。
 * env 角色写 updates (随 env 落盘); config 角色走 persistRoleModel。坐标格式校验 (COORD_RE),
 * 'kimi-k3' 这类缺 provider 前缀的输入被拒并提示。导出便于测试直驱。
 */
export async function runRoleTuneStep(
  io: WizardIO,
  updates: Record<string, string>,
  persist: PresetPersistDeps = REAL_PERSIST,
  piReady: string[] = [],
): Promise<void> {
  if (!(await io.confirm('逐角色微调模型? (各节点角色可挂不同模型; 可跳过)', false))) return;
  // 坐标提示: 本次配置里出现过的 provider:model + pi OAuth 就绪 provider。
  const coords = [...new Set(Object.values(updates).filter((v) => COORD_RE.test(v)))];
  const hints = [...coords, ...piReady.map((p) => `${p}:<model>`)];
  if (hints.length) io.note(dim(fg('riceMuted', `可用坐标: ${hints.join(' · ')}`)));
  for (;;) {
    const options = [
      ...TUNABLE_ENV_ROLES.map((r) => ({
        id: r.env,
        label: `${r.label}${updates[r.env] ? ` = ${updates[r.env]}` : ''}`,
      })),
      ...TUNABLE_CONFIG_ROLES.map((r) => ({ id: `config:${r.role}`, label: `${r.label} — config:${r.role}` })),
      { id: 'done', label: '完成' },
    ];
    const pick = await io.select('改哪个角色?', options);
    if (!pick || pick === 'done') return;
    const v = (await io.ask('provider:model 坐标 (如 kimi-coding:k3, 回车取消)')).trim();
    if (!v) continue;
    if (!COORD_RE.test(v)) {
      io.note(fg('error', `坐标格式应为 provider:model (输入的 "${v}" 缺 provider 前缀, 如 kimi-coding:k3)`));
      continue;
    }
    if (pick.startsWith('config:')) persist.persistRoleModel(pick.slice('config:'.length) as ModelRole, v);
    else updates[pick] = v;
  }
}

/**
 * 跑首次配置向导 (2026-07-19 重排, preset-first):
 *   ① pi OAuth 先行 (就绪检测 + 可选内联登录 — 就绪 provider 后续免 key)
 *   ② 选档: 三档 preset 一键配全套角色矩阵, 或极简单 provider (旧四问)
 *   ③ web 搜索可选 → ④ 逐角色微调 (多 provider 时各角色挂不同模型)
 *   → 写 env (项目有 .env 则写项目, 否则写全局 ~/.omd/env — 任何目录起 omd 都可用) → 健检。
 * 返回结果供 tui.ts 决定下一步 (写完即可继续 boot, env 已就绪)。
 */
export async function runInitWizard(deps: InitWizardDeps): Promise<InitWizardResult | null> {
  const { io } = deps;
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  const writeEnv = deps.writeEnv ?? ((p, c) => Bun.write(p, c).then(() => undefined));
  // 写入点: 项目已有 .env → 项目级; 否则全局 (修"全局命令无全局配置"的按目录碎片化)。
  const localEnvPath = `${cwd}/.env`;
  const envPath = existsSync(localEnvPath) ? localEnvPath : globalEnvPath();
  const persist = deps.persist ?? REAL_PERSIST;

  io.note(`${bold(fg('cinnabar', '◉ omd 初始化向导'))}  ${dim(fg('riceMuted', '目录总览 · 登录/检测 · 选档 · 角色微调 · 校验'))}`);

  // ⓪ pi 目录 provider 总览: 全部 ~32 家 + 就绪标记 (✓oauth/✓key), 开场即知可用面。
  runProviderOverviewStep(io, listPiAuthReady(deps.piAuth?.authPath ?? defaultPiAuthPath()), deps.providerCatalog ?? {});

  // ① pi OAuth: 就绪 provider 免 key, 后续 preset/微调直接可用其坐标。
  const piReady = await runPiOAuthStep(io, deps.piAuth ?? {});

  // ② 选档 (preset-first): 三档 = 完整方案 (角色矩阵+多模态池+跨家族 verifier), 极简 = 单 provider。
  const planChoice = await io.select('配置方案', [
    ...ROLE_PRESETS.map((p) => ({ id: p.id, label: p.label })),
    { id: 'single', label: '极简 — 只配一个 provider (角色走出厂默认, 可稍后 omd init 升档)' },
  ]);
  if (!planChoice) {
    io.note(fg('warning', '已取消 — 可手动 cp .env.example .env 后填 key'));
    return null;
  }

  const updates: Record<string, string> = {};
  let probe: ProbeResult | null = null;
  const preset = ROLE_PRESETS.find((p) => p.id === planChoice);
  if (preset) {
    await applyRolePreset(preset, updates, io, env, persist, piReady);
  } else {
    // 极简: provider → key → base → model (旧四问) + 探针。
    const providerId = await io.select(
      '选 LLM 后端 provider',
      PROVIDERS.map((p) => ({ id: p.id, label: p.label })),
    );
    const def = providerById(providerId);
    if (!def) {
      io.note(fg('warning', '已取消 — 可手动 cp .env.example .env 后填 key'));
      return null;
    }
    const key = await io.ask(`粘 ${def.label} 的 API key`, { secret: true });
    if (!key.trim()) {
      io.note(fg('error', '未输入 key — 取消'));
      return null;
    }
    const base = (await io.ask(`base URL`, { defaultValue: def.defaultBase })).trim() || def.defaultBase;
    const model =
      (await io.select(
        '选默认 model',
        def.models.map((m) => ({ id: m, label: m })),
      )) ?? def.models[0]!;
    Object.assign(updates, {
      OMD_RUNTIME_PROVIDER: def.id,
      OMD_RUNTIME_MODEL: model,
      [def.keyEnv]: key.trim(),
      [def.baseEnv]: base,
      [def.modelEnv]: model,
    });
    io.note(dim(fg('riceMuted', `探针校验 ${def.id} 可达…`)));
    probe = await probeProvider(base, key.trim(), deps.fetchImpl ?? fetch);
    io.note(
      probe.ok
        ? `${fg('success', '✓')} ${def.id} 可达 (${probe.detail})`
        : `${fg('error', '✗')} ${def.id} 不可达: ${probe.detail} ${dim(fg('riceMuted', '(key 照写, 可稍后改)'))}`,
    );
  }

  // ③ web 搜索 (可选)
  if (await io.confirm('配置 web 搜索? (Tavily / Anysearch, 可跳过)', false)) {
    const tavily = await io.ask('TAVILY_API_KEY (回车跳过)', { secret: true });
    if (tavily.trim()) updates.TAVILY_API_KEY = tavily.trim();
    const anysearch = await io.ask('ANYSEARCH_API_KEY (回车跳过)', { secret: true });
    if (anysearch.trim()) updates.ANYSEARCH_API_KEY = anysearch.trim();
  }

  // ④ 逐角色微调 (多 provider/网关时各角色挂不同模型; 默认跳过)。
  await runRoleTuneStep(io, updates, persist, piReady);

  // 写 env (非破坏性 upsert)
  const existing = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
  await writeEnv(envPath, upsertEnv(existing, updates));
  // 同步进 process.env, 使本次 boot 立即可用 (不必重启)。
  for (const [k, v] of Object.entries(updates)) (env as Record<string, string>)[k] = v;

  // 健检总结 (runtime 坐标来自本次写入或既有 env)。
  const rtProvider = updates.OMD_RUNTIME_PROVIDER ?? env.OMD_RUNTIME_PROVIDER ?? '';
  const rtModel = updates.OMD_RUNTIME_MODEL ?? env.OMD_RUNTIME_MODEL ?? '';
  io.note(
    `${bold(fg('gold', '已就绪'))}  ${fg('rice', `${rtProvider}:${rtModel}`)} → ${envPath}  ${dim(fg('riceMuted', 'shift+tab 进 pathfinder · /cg 检索 · /audit 审计'))}`,
  );

  return {
    writtenKeys: Object.keys(updates),
    provider: rtProvider,
    model: rtModel,
    probe,
    envPath,
  };
}
