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
import { existsSync, readFileSync } from 'node:fs';
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
): Promise<void> {
  Object.assign(updates, preset.env);

  // 缺的 key 逐个提示 (已在 env 或本次 updates 里的跳过)。跳过 → 该 provider 的 pool/config 角色不写。
  const missingProviders = new Set<string>();
  for (const kp of preset.keyPrompts ?? []) {
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

/**
 * 跑首次配置向导: 选 provider → 配 key/base/model → (可选) web key → 写 .env → 探针校验 → 健检总结。
 * 返回结果供 tui.ts 决定下一步 (写完即可继续 boot, env 已就绪)。
 */
export async function runInitWizard(deps: InitWizardDeps): Promise<InitWizardResult | null> {
  const { io } = deps;
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  const writeEnv = deps.writeEnv ?? ((p, c) => Bun.write(p, c).then(() => undefined));
  const envPath = `${cwd}/.env`;

  io.note(`${bold(fg('cinnabar', '◉ omd 初始化向导'))}  ${dim(fg('riceMuted', '配后端 · 选 model · 校验可达'))}`);

  // ① provider
  const providerId = await io.select(
    '选 LLM 后端 provider',
    PROVIDERS.map((p) => ({ id: p.id, label: p.label })),
  );
  const def = providerById(providerId);
  if (!def) {
    io.note(fg('warning', '已取消 — 可手动 cp .env.example .env 后填 key'));
    return null;
  }

  // ② API key (必填)
  const key = await io.ask(`粘 ${def.label} 的 API key`, { secret: true });
  if (!key.trim()) {
    io.note(fg('error', '未输入 key — 取消'));
    return null;
  }

  // ③ base URL (默认值可回车跳过)
  const base = (await io.ask(`base URL`, { defaultValue: def.defaultBase })).trim() || def.defaultBase;

  // ④ model
  const model =
    (await io.select(
      '选默认 model',
      def.models.map((m) => ({ id: m, label: m })),
    )) ?? def.models[0]!;

  const updates: Record<string, string> = {
    OMD_RUNTIME_PROVIDER: def.id,
    OMD_RUNTIME_MODEL: model,
    [def.keyEnv]: key.trim(),
    [def.baseEnv]: base,
    [def.modelEnv]: model,
  };

  // ⑤ web 搜索 (可选)
  if (await io.confirm('配置 web 搜索? (Tavily / Anysearch, 可跳过)', false)) {
    const tavily = await io.ask('TAVILY_API_KEY (回车跳过)', { secret: true });
    if (tavily.trim()) updates.TAVILY_API_KEY = tavily.trim();
    const anysearch = await io.ask('ANYSEARCH_API_KEY (回车跳过)', { secret: true });
    if (anysearch.trim()) updates.ANYSEARCH_API_KEY = anysearch.trim();
  }

  // ⑥ 角色模型矩阵: preset 一键配全套, 或手动两问 (旧行为), 或跳过。
  const presetChoice = await io.select('角色模型矩阵 (conductor/leaf/plan/…)', [
    ...ROLE_PRESETS.map((p) => ({ id: p.id, label: p.label })),
    { id: 'manual', label: '手动逐项 / 跳过' },
  ]);
  const preset = ROLE_PRESETS.find((p) => p.id === presetChoice);
  if (preset) {
    await applyRolePreset(preset, updates, io, env, deps.persist ?? REAL_PERSIST);
  } else if (presetChoice === 'manual') {
    // 旧两问行为: 逐项覆盖 (回车跳过 = 走统一 runtime model)。
    const conductor = await io.ask('OMD_CG_CONDUCTOR_MODEL (provider:model, 回车跳过)');
    if (conductor.trim()) updates.OMD_CG_CONDUCTOR_MODEL = conductor.trim();
    const plan = await io.ask('OMD_PLAN_MODEL (provider:model, 回车跳过)');
    if (plan.trim()) updates.OMD_PLAN_MODEL = plan.trim();
  }

  // 写 .env (非破坏性 upsert)
  const existing = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
  await writeEnv(envPath, upsertEnv(existing, updates));
  // 同步进 process.env, 使本次 boot 立即可用 (不必重启)。
  for (const [k, v] of Object.entries(updates)) (env as Record<string, string>)[k] = v;

  // ⑦ 探针校验
  io.note(dim(fg('riceMuted', `探针校验 ${def.id} 可达…`)));
  const probe = await probeProvider(base, key.trim(), deps.fetchImpl ?? fetch);
  io.note(
    probe.ok
      ? `${fg('success', '✓')} ${def.id} 可达 (${probe.detail})`
      : `${fg('error', '✗')} ${def.id} 不可达: ${probe.detail} ${dim(fg('riceMuted', '(key 已写入 .env, 可稍后改)'))}`,
  );

  // 健检总结
  io.note(`${bold(fg('gold', '已就绪'))}  ${fg('rice', `${def.id}:${model}`)} → .env  ${dim(fg('riceMuted', 'shift+tab 进 plan · /cg 检索 · /audit 审计'))}`);

  return {
    writtenKeys: Object.keys(updates),
    provider: def.id,
    model,
    probe,
    envPath,
  };
}
