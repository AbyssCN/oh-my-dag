/**
 * Provider registry (INV-2). Process-global map; entries are registered either
 * explicitly via {@link registerProvider} or from env via
 * {@link registerProvidersFromEnv}. callModel resolves `provider:modelId`
 * against this map, so a new backend never touches call sites.
 */
import type { ProviderConfig } from './types';
import { MAX_TOKENS_DEFAULT } from './role-models';
import { readCustomProviders } from './models-json';

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
  // (旧 pi-auth-bridge 已删, 2026-07-19 统一模型层): kimi-coding 等 pi OAuth provider 不再桥进本
  // registry — callModel 的 pi-ai 目录后备通道 (pi-transport) 原生解析 + 认证 (auth.json / env 映射)。
  return registered;
}

/**
 * 注册 `~/.pi/agent/models.json` 的完整自定 provider 进 callModel registry (统一-registry D-2/C-2)。
 * 与 {@link registerProvidersFromEnv} 同级; boot 时于其**后**调 (bootstrap.ts / tui.ts) → models.json
 * 是单一真源, 同名覆盖 env。幂等 (registry 按 name upsert)。builtin-override 条目 (deepseek 等) 由
 * readCustomProviders 已滤掉 (INV-5); 无凭证条目已滤掉 (INV-4)。
 * defaultModel 兜底 = 首个 model id (裸 coord 解析用)。maxTokens = 条目内模型 maxTokens 最大值, 无则
 * MAX_TOKENS_DEFAULT (治 index.ts:239 的 `?? 4096` 太低吃 reasoning 预算)。返回注册的 provider id。
 */
export function registerProvidersFromModelsJson(
  env: Record<string, string | undefined> = process.env,
): string[] {
  const registered: string[] = [];
  for (const entry of readCustomProviders(env)) {
    const maxTokens =
      entry.models.reduce((mx, m) => Math.max(mx, m.maxTokens ?? 0), 0) || MAX_TOKENS_DEFAULT;
    registerProvider(entry.id, {
      baseUrl: entry.baseUrl,
      apiKey: entry.apiKey,
      api: entry.api === 'anthropic-messages' ? 'anthropic-messages' : 'openai-compatible',
      ...(entry.models[0]?.id ? { defaultModel: entry.models[0].id } : {}),
      maxTokens,
    });
    registered.push(entry.id);
  }
  return registered;
}
