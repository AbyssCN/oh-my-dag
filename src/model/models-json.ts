/**
 * models-json —— 读 pi 原生模型配置 `~/.pi/agent/models.json` 的自定 provider 条目 (统一-registry D-1/C-1)。
 *
 * models.json 是 pi ModelRuntime 认自定 provider 的**正门** (agent-leaf 原生读它; pi 扩展 registerProvider
 * 对 agent-leaf 架构性无效, 见 docs/plan/2026-07-21-unified-model-registry.md ## 机制证伪)。本模块让
 * callModel 栈也读同一份 → 两栈单一真源 (INV-1/INV-2)。
 *
 * 只带出**完整自定条目** (baseUrl+apiKey+api 齐全者, 如 zhipu / mimo-platform / minimax-cn);
 * builtin-override 条目 (只 models 无 baseUrl, 如 deepseek / opencode-go) 跳过 —— 那些是 pi-native,
 * callModel 走 env + pi-transport (INV-5)。`$ENV` key 引用 (如 "$ZHIPU_API_KEY") 从 env 解析,
 * 缺 key → 跳过该 provider (INV-4 fail-open)。文件缺 / 坏 → [] (静默, 永不抛)。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** 一个完整自定 provider 条目 (baseUrl+apiKey+api 齐全, apiKey 已从 $ENV 解析成真值)。 */
export interface ModelsJsonEntry {
  id: string;
  baseUrl: string;
  apiKey: string;
  /** models.json 原始 api 名 (如 'openai-completions')。 */
  api: string;
  models: { id: string; maxTokens?: number; contextWindow?: number }[];
}

/** models.json 路径: `~/.pi/agent/models.json` (PI_AGENT_DIR 覆盖 agent 目录, 与 pi 一致; 同 pi-transport auth.json 约定)。 */
export function modelsJsonPath(env: Record<string, string | undefined> = process.env): string {
  const dir = env.PI_AGENT_DIR?.trim() || join(homedir(), '.pi', 'agent');
  return join(dir, 'models.json');
}

/** `$ENV` 引用解析: "$FOO" → env.FOO; 非 `$` 前缀原样 (字面 key)。空 → undefined。 */
function resolveKey(raw: string, env: Record<string, string | undefined>): string | undefined {
  const v = raw.trim();
  if (!v) return undefined;
  if (v.startsWith('$')) return env[v.slice(1)]?.trim() || undefined;
  return v;
}

interface RawProvider {
  baseUrl?: unknown;
  apiKey?: unknown;
  api?: unknown;
  models?: unknown;
}

function cleanModels(raw: unknown): ModelsJsonEntry['models'] {
  if (!Array.isArray(raw)) return [];
  const out: ModelsJsonEntry['models'] = [];
  for (const m of raw) {
    if (!m || typeof m !== 'object') continue;
    const id = (m as { id?: unknown }).id;
    if (typeof id !== 'string' || !id) continue;
    const maxTokens = (m as { maxTokens?: unknown }).maxTokens;
    const contextWindow = (m as { contextWindow?: unknown }).contextWindow;
    out.push({
      id,
      ...(typeof maxTokens === 'number' ? { maxTokens } : {}),
      ...(typeof contextWindow === 'number' ? { contextWindow } : {}),
    });
  }
  return out;
}

/**
 * 读 models.json 的完整自定 provider 条目。
 * 过滤: baseUrl+apiKey+api 齐全 (跳过 builtin-override, INV-5) + `$ENV` key 能解析 (跳过无凭证, INV-4)。
 */
export function readCustomProviders(
  env: Record<string, string | undefined> = process.env,
  path = modelsJsonPath(env),
): ModelsJsonEntry[] {
  let providers: Record<string, RawProvider>;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
      providers?: Record<string, RawProvider>;
    };
    providers =
      parsed?.providers && typeof parsed.providers === 'object' && !Array.isArray(parsed.providers)
        ? parsed.providers
        : {};
  } catch {
    return [];
  }
  const out: ModelsJsonEntry[] = [];
  for (const [id, p] of Object.entries(providers)) {
    if (!p || typeof p !== 'object') continue;
    // 完整自定条目才收 (builtin-override 只有 models, 无 baseUrl/apiKey/api) — INV-5。
    if (typeof p.baseUrl !== 'string' || typeof p.api !== 'string' || typeof p.apiKey !== 'string') {
      continue;
    }
    const apiKey = resolveKey(p.apiKey, env);
    if (!apiKey) continue; // 无凭证跳过 (INV-4 fail-open)
    out.push({ id, baseUrl: p.baseUrl, apiKey, api: p.api, models: cleanModels(p.models) });
  }
  return out;
}

/** 一个自定 provider 的展示态 (config_status 用): key 未解析前的原貌 + 凭证是否就绪。 */
export interface CustomProviderStatus {
  id: string;
  baseUrl: string;
  /** apiKey 的 `$ENV` 引用名 (如 'ZHIPU_API_KEY'); 字面 key → null。 */
  keyEnv: string | null;
  /** 凭证是否就绪 (env 里有该 key, 或字面 key 非空)。false = 登记了但没 key。 */
  hasKey: boolean;
  models: ModelsJsonEntry['models'];
}

/**
 * 列 models.json 的完整自定 provider (baseUrl+apiKey+api 齐全者), **不按凭证过滤** —— 供 config_status
 * 展示 (含无凭证条目, 标 ✗)。与 readCustomProviders (registers 用, 已滤无凭证) 区别: 这是**展示态**。
 */
export function listCustomProviderStatus(
  env: Record<string, string | undefined> = process.env,
  path = modelsJsonPath(env),
): CustomProviderStatus[] {
  const root = readRaw(path);
  const p = root.providers;
  if (!p || typeof p !== 'object' || Array.isArray(p)) return [];
  const out: CustomProviderStatus[] = [];
  for (const [id, raw] of Object.entries(p as Record<string, RawProvider>)) {
    if (!raw || typeof raw !== 'object') continue;
    if (typeof raw.baseUrl !== 'string' || typeof raw.api !== 'string' || typeof raw.apiKey !== 'string') {
      continue; // builtin-override (无 baseUrl) 不展示为自定 provider (INV-5)
    }
    const rawKey = raw.apiKey.trim();
    const keyEnv = rawKey.startsWith('$') ? rawKey.slice(1) : null;
    const hasKey = !!resolveKey(raw.apiKey, env);
    out.push({ id, baseUrl: raw.baseUrl, keyEnv, hasKey, models: cleanModels(raw.models) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// upsert (MCP 面写盘, 统一-registry D-3/C-4): omd_register_provider / omd_set_model 经此**merge**
// 写 `~/.pi/agent/models.json`。铁律 (GWT-6): 只动本次提供的字段, 保留既有条目的 compat/headers 等
// 未提供字段 —— **不整体替换**。apiKey 落 `$<keyEnv>` 引用 (不落明文 key)。models 按 id merge (保留
// 既有 model 的其它字段 + 本次未提及的 model)。所有读写走 RAW (不解析 $ENV、不 filter), 保真源结构。
// ---------------------------------------------------------------------------

/** 顶层 RAW 结构 (未知字段全保留)。缺文件/坏 JSON → {} (调用方从空起, upsert 会补 providers)。 */
function readRaw(path: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function writeRaw(path: string, obj: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(obj, null, 2)}\n`);
}

/** 取顶层 providers 段 (非对象 → 空对象)。返回引用, 直接改后写回。 */
function providersOf(root: Record<string, unknown>): Record<string, Record<string, unknown>> {
  const p = root.providers;
  if (p && typeof p === 'object' && !Array.isArray(p)) {
    return p as Record<string, Record<string, unknown>>;
  }
  const fresh: Record<string, Record<string, unknown>> = {};
  root.providers = fresh;
  return fresh;
}

/** 一个 model patch (只带出显式提供的数值字段, 避免 undefined 覆写既有值)。 */
export interface ModelPatch {
  id: string;
  maxTokens?: number;
  contextWindow?: number;
}

function modelPatchFields(m: ModelPatch): Record<string, unknown> {
  return {
    id: m.id,
    ...(typeof m.maxTokens === 'number' ? { maxTokens: m.maxTokens } : {}),
    ...(typeof m.contextWindow === 'number' ? { contextWindow: m.contextWindow } : {}),
  };
}

/** merge 一批 model patch 进既有 models 数组 (按 id upsert, 保留既有未提及字段/条目)。 */
function mergeModels(existing: unknown, incoming: ModelPatch[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = Array.isArray(existing)
    ? existing.filter((m): m is Record<string, unknown> => !!m && typeof m === 'object').map((m) => ({ ...m }))
    : [];
  for (const inc of incoming) {
    if (!inc.id) continue;
    const patch = modelPatchFields(inc);
    const i = out.findIndex((m) => m.id === inc.id);
    if (i >= 0) out[i] = { ...out[i], ...patch };
    else out.push(patch);
  }
  return out;
}

export interface UpsertProviderInput {
  /** provider id (坐标前半, models.json 键)。 */
  id: string;
  /** OpenAI/Anthropic-兼容 base URL。 */
  baseUrl: string;
  /** 读 key 的 env 变量名 (落盘为 `$<keyEnv>` 引用, 不落明文)。 */
  keyEnv: string;
  /** pi api 名。省略 = 保留既有条目的 api, 全新条目默认 'openai-completions'。 */
  api?: string;
  /** 本次登记/更新的 model 条目 (按 id merge)。 */
  models?: ModelPatch[];
}

/**
 * merge upsert 一个自定 provider 进 models.json 的 providers 段 (C-4)。
 * 保留既有条目的 compat/headers 等未提供字段 (GWT-6 不 clobber); apiKey 落 `$<keyEnv>`。
 * @returns created=true 表新建条目, false 表更新既有。
 */
export function upsertProvider(
  input: UpsertProviderInput,
  path = modelsJsonPath(),
): { created: boolean } {
  const id = input.id.trim();
  if (!id) throw new Error('upsertProvider: id required');
  if (!input.baseUrl.trim()) throw new Error('upsertProvider: baseUrl required');
  if (!input.keyEnv.trim()) throw new Error('upsertProvider: keyEnv required');
  const root = readRaw(path);
  const providers = providersOf(root);
  const existing =
    providers[id] && typeof providers[id] === 'object' && !Array.isArray(providers[id])
      ? providers[id]
      : undefined;
  const created = existing === undefined;
  const base = existing ?? {};
  providers[id] = {
    ...base, // 保留 compat/headers 等未提供字段 (GWT-6)
    baseUrl: input.baseUrl.trim().replace(/\/+$/, ''),
    apiKey: `$${input.keyEnv.trim()}`,
    api: input.api?.trim() || (typeof base.api === 'string' ? base.api : 'openai-completions'),
    models: mergeModels(base.models, input.models ?? []),
  };
  writeRaw(path, root);
  return { created };
}

/**
 * upsert 一个 model 条目 (C-4): 坐标 `provider:model` → 改对应 provider 的 model per-model 属性。
 * provider 必须先存在 (经 upsertProvider / 手写 models.json); 不存在 → providerFound=false (调用方提示先登记)。
 * @returns providerFound / created (该 model 是否新建)。
 */
export function upsertModel(
  coord: string,
  patch: { maxTokens?: number; contextWindow?: number },
  path = modelsJsonPath(),
): { provider: string; model: string; providerFound: boolean; created: boolean } {
  const sep = coord.indexOf(':');
  if (sep < 0) throw new Error(`upsertModel: coord '${coord}' 需 provider:model 格式`);
  const provider = coord.slice(0, sep).trim();
  const model = coord.slice(sep + 1).trim();
  if (!provider || !model) throw new Error(`upsertModel: coord '${coord}' 需 provider:model 格式`);
  const root = readRaw(path);
  const providers = providersOf(root);
  const p = providers[provider];
  if (!p || typeof p !== 'object' || Array.isArray(p)) {
    return { provider, model, providerFound: false, created: false };
  }
  const before = Array.isArray(p.models) ? (p.models as unknown[]).length : 0;
  const merged = mergeModels(p.models, [{ id: model, ...patch }]);
  p.models = merged;
  const created = merged.length > before;
  writeRaw(path, root);
  return { provider, model, providerFound: true, created };
}
