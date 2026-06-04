/**
 * Provider registry (INV-2). Process-global map; entries are registered either
 * explicitly via {@link registerProvider} or from env via
 * {@link registerProvidersFromEnv}. callModel resolves `provider:modelId`
 * against this map, so a new backend never touches call sites.
 */
import type { ProviderConfig } from './types';
import type { ApiDef } from './role-models';

const registry = new Map<string, ProviderConfig>();

export function registerProvider(name: string, cfg: ProviderConfig): void {
  if (!name) throw new Error('registerProvider: name required');
  if (!cfg.baseUrl) throw new Error(`registerProvider(${name}): baseUrl required`);
  if (!cfg.apiKey) throw new Error(`registerProvider(${name}): apiKey required`);
  // Normalise the base so callModel can join paths without double slashes.
  registry.set(name, { ...cfg, baseUrl: cfg.baseUrl.replace(/\/+$/, '') });
}

export function getProvider(name: string): ProviderConfig | undefined {
  return registry.get(name);
}

export function listProviders(): string[] {
  return [...registry.keys()];
}

/** Reset the registry — test hook (INV-2 stays config-only, so this is safe). */
export function clearProviders(): void {
  registry.clear();
}

/**
 * Register 'mimo' from MIMO_BASE_URL / MIMO_API_KEY / MIMO_MODEL when both the
 * base and key are present (契约 §7 env). Idempotent; returns the names added.
 * The one outward dependency (MIMO_API_KEY) lands here, nowhere else.
 */
export function registerProvidersFromEnv(
  env: Record<string, string | undefined> = process.env,
): string[] {
  const registered: string[] = [];
  if (env.MIMO_BASE_URL && env.MIMO_API_KEY) {
    registerProvider('mimo', {
      baseUrl: env.MIMO_BASE_URL,
      apiKey: env.MIMO_API_KEY,
      api: 'openai-compatible',
      // defaultModel 兜底: 裸 provider 坐标 (如 role fallback 'mimo') 靠它解析。env 未设 → 用稳健默认,
      // 避免 "provider 'mimo' has no defaultModel" 崩 boot (非 bake runtime 模型, 仅 bare-coord 兜底)。
      defaultModel: env.MIMO_MODEL ?? 'mimo-v2.5-pro',
    });
    registered.push('mimo');
  }
  if (env.DEEPSEEK_BASE_URL && env.DEEPSEEK_API_KEY) {
    registerProvider('deepseek', {
      baseUrl: env.DEEPSEEK_BASE_URL,
      apiKey: env.DEEPSEEK_API_KEY,
      api: 'openai-compatible',
      // defaultModel 兜底 (同 mimo): 裸 'deepseek' 坐标 (verifier role fallback) 靠它解析, 不崩 boot。
      defaultModel: env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash',
    });
    registered.push('deepseek');
  }
  return registered;
}

/**
 * 注册用户自定 API (config.apis) 进 callModel registry — "随意添加 API"。在 registerProvidersFromEnv
 * 之上叠加: 每个 api 的 key 从其 keyEnv (省略 = ID 大写 + _API_KEY) 读, 无 key 的静默跳过 (onboard 页提示)。
 * 同名覆盖 (config api 优先于内置, 让用户能改 base/key)。返回成功注册的 provider id。
 */
export function registerCustomApis(
  apis: ApiDef[],
  env: Record<string, string | undefined> = process.env,
): string[] {
  const registered: string[] = [];
  for (const a of apis) {
    if (!a.id || !a.baseUrl) continue;
    const keyEnv = a.keyEnv ?? `${a.id.toUpperCase()}_API_KEY`;
    const apiKey = env[keyEnv];
    if (!apiKey) continue; // 未配 key → 跳过 (registerProvider 要求 apiKey; onboard 页提示补)
    registerProvider(a.id, {
      baseUrl: a.baseUrl,
      apiKey,
      api: 'openai-compatible',
      defaultModel: a.defaultModel,
    });
    registered.push(a.id);
  }
  return registered;
}
