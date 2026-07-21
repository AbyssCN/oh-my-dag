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
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

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
