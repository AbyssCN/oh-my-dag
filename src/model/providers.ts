/**
 * Provider registry (INV-2). Process-global map; entries are registered either
 * explicitly via {@link registerProvider} or from env via
 * {@link registerProvidersFromEnv}. callModel resolves `provider:modelId`
 * against this map, so a new backend never touches call sites.
 */
import type { ProviderConfig } from './types';

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
      defaultModel: env.MIMO_MODEL,
    });
    registered.push('mimo');
  }
  if (env.DEEPSEEK_BASE_URL && env.DEEPSEEK_API_KEY) {
    registerProvider('deepseek', {
      baseUrl: env.DEEPSEEK_BASE_URL,
      apiKey: env.DEEPSEEK_API_KEY,
      api: 'openai-compatible',
      defaultModel: env.DEEPSEEK_MODEL,
    });
    registered.push('deepseek');
  }
  return registered;
}
