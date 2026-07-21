/**
 * pi-transport — callModel 的 pi-ai 目录后备通道 (统一模型层, 2026-07-19)。
 *
 * 解析序 (owner 锁定设计): ① 自有 registry (自定 OpenAI 兼容网关 / env 注册的 mimo·deepseek)
 * ② provider 不在 registry 但 pi-ai 目录认识 → 本通道经 pi `completeSimple()` 调用 —— 协议
 * (anthropic-messages / openai-completions / …) 与 env key 映射全交给 pi; ③ 都不认 → config 错。
 *
 * 认证事实 (pi-ai 0.77.0 实测 grounding):
 *   - `complete()/completeSimple()` 只认 `options.apiKey ?? getEnvApiKey(provider)`, **不**自动读
 *     ~/.pi/agent/auth.json —— auth.json 的读取/刷新在 pi-coding-agent 的 AuthStorage 层。
 *   - pi-ai oauth 内置 provider 只有 anthropic / github-copilot / openai-codex。kimi-coding **无**
 *     内置 OAuthProviderInterface (pi 侧经 extension 动态注册) → 过期刷新对它不可行, 与旧
 *     pi-auth-bridge 同语义: 直接用 access 快照, 过期则 401 响亮报错 (绝不静默)。
 *   - 目录滞后事实: auth.json 里用户实跑的 model id (如 kimi-coding:k3) 可能不在 pi 目录; pi 自己的
 *     model-resolver `buildFallbackModel` 用同 provider 目录条目克隆换 id —— 此处同策略。
 *
 * 测试注入: setPiTransportDepsForTest() 换 getModel/getModels/completeSimple/env/auth 路径。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type {
  Api,
  AssistantMessage,
  Context,
  Message,
  Model,
  SimpleStreamOptions,
  ThinkingLevel,
  Usage,
} from '@earendil-works/pi-ai';
// 0.80: 目录读/completeSimple 挪进 /compat (deprecated shim, 行为等价; 深迁移 Models API 另行);
// oauth 子路径变纯类型入口, 全局 OAuth 注册表已删 — kimi-coding 刷新走本仓 kimi-oauth 登录件。
import {
  completeSimple as piCompleteSimple,
  getModel as piGetModel,
  getModels as piGetModels,
} from '@earendil-works/pi-ai/compat';
import type { OAuthCredentials } from '@earendil-works/pi-ai/oauth';
import { createKimiCodingOAuthProvider } from './kimi-oauth';
import type { ContentPart, ModelMessage, ModelRequest, ModelUsage } from './types';
import { ModelError } from './index';
import { logger } from '../logger';

export type PiModel = Model<Api>;

/** piRequest 的归一结果 — 与 index.ts 内部 RawResult 结构一致 (text/usage/raw/finishReason)。 */
export interface PiCallResult {
  text: string;
  usage: ModelUsage;
  raw: unknown;
  finishReason?: string;
}

// ── 依赖注入 (测试换假件; 默认 = 真 pi-ai 面) ─────────────────────────────────────

export interface PiTransportDeps {
  getModel: (provider: string, modelId: string) => PiModel | undefined;
  getModels: (provider: string) => PiModel[];
  completeSimple: (
    model: PiModel,
    context: Context,
    options?: SimpleStreamOptions,
  ) => Promise<AssistantMessage>;
  getEnvApiKey: (provider: string) => string | undefined;
  /** OAuth 刷新件 (pi-ai/oauth)。内置只有 anthropic/copilot/codex; 其余 (kimi-coding) → undefined。 */
  getOAuthProvider: (id: string) => { getApiKey: (c: OAuthCredentials) => string } | undefined;
  getOAuthApiKey: (
    id: string,
    creds: Record<string, OAuthCredentials>,
  ) => Promise<{ newCredentials: OAuthCredentials; apiKey: string } | null>;
  authPath: string;
  now: () => number;
}

/**
 * provider → env key 映射 (对齐 pi-ai 0.80 env-api-keys.js 的表; 0.80 不再从入口导出该函数,
 * 表本身是稳定公开事实)。未知 provider → undefined (与 pi 同语义)。
 */
const PI_ENV_KEY_MAP: Record<string, string> = {
  openai: 'OPENAI_API_KEY', 'azure-openai-responses': 'AZURE_OPENAI_API_KEY', deepseek: 'DEEPSEEK_API_KEY',
  google: 'GEMINI_API_KEY', 'google-vertex': 'GOOGLE_CLOUD_API_KEY', groq: 'GROQ_API_KEY',
  cerebras: 'CEREBRAS_API_KEY', xai: 'XAI_API_KEY', openrouter: 'OPENROUTER_API_KEY',
  'vercel-ai-gateway': 'AI_GATEWAY_API_KEY', zai: 'ZAI_API_KEY', mistral: 'MISTRAL_API_KEY',
  minimax: 'MINIMAX_API_KEY', 'minimax-cn': 'MINIMAX_CN_API_KEY', moonshotai: 'MOONSHOT_API_KEY',
  'moonshotai-cn': 'MOONSHOT_API_KEY', huggingface: 'HF_TOKEN', fireworks: 'FIREWORKS_API_KEY',
  together: 'TOGETHER_API_KEY', opencode: 'OPENCODE_API_KEY', 'opencode-go': 'OPENCODE_API_KEY',
  'kimi-coding': 'KIMI_API_KEY', 'cloudflare-workers-ai': 'CLOUDFLARE_API_KEY',
  'cloudflare-ai-gateway': 'CLOUDFLARE_API_KEY', xiaomi: 'XIAOMI_API_KEY',
  'xiaomi-token-plan-cn': 'XIAOMI_TOKEN_PLAN_CN_API_KEY', 'xiaomi-token-plan-ams': 'XIAOMI_TOKEN_PLAN_AMS_API_KEY',
  'xiaomi-token-plan-sgp': 'XIAOMI_TOKEN_PLAN_SGP_API_KEY',
};

/** env key 解析 (anthropic 双名/copilot 特例 + 上表)。导出供 wizard provider 总览复用。 */
export function piEnvApiKey(provider: string, env: Record<string, string | undefined> = process.env): string | undefined {
  const names =
    provider === 'anthropic' ? ['ANTHROPIC_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']
    : provider === 'github-copilot' ? ['COPILOT_GITHUB_TOKEN']
    : PI_ENV_KEY_MAP[provider] ? [PI_ENV_KEY_MAP[provider]!] : [];
  for (const n of names) {
    const v = env[n]?.trim();
    if (v) return v;
  }
  return undefined;
}

/** 真实现 (静态 import: pi-ai 是 ESM-only export map, Bun require 解析不到 import 条件)。 */
function realDeps(): PiTransportDeps {
  // kimi-coding 刷新件 = 本仓 kimi-oauth (0.80 无全局 OAuth 注册表; 其余 oauth provider 无刷新件,
  // 走过期快照 + 响亮警告的旧语义)。
  const kimi = createKimiCodingOAuthProvider();
  return {
    getModel: piGetModel as unknown as PiTransportDeps['getModel'],
    getModels: piGetModels as unknown as PiTransportDeps['getModels'],
    completeSimple: piCompleteSimple,
    getEnvApiKey: (p) => piEnvApiKey(p),
    getOAuthProvider: (id) => (id === kimi.id ? { getApiKey: (c) => kimi.getApiKey(c) } : undefined),
    getOAuthApiKey: async (id, creds) => {
      if (id !== kimi.id || !creds[id]) return null;
      const next = await kimi.refreshToken(creds[id]!);
      return { newCredentials: next, apiKey: kimi.getApiKey(next) };
    },
    authPath: join(homedir(), '.pi', 'agent', 'auth.json'),
    now: () => Date.now(),
  };
}

let depsOverride: Partial<PiTransportDeps> | null = null;
let realCache: PiTransportDeps | null = null;

function deps(): PiTransportDeps {
  const base = (realCache ??= realDeps());
  return depsOverride ? { ...base, ...depsOverride } : base;
}

/** 测试钩子: 注入假 pi 面 (可部分覆盖, 缺键回落真实现)。不带参 = 还原。 */
export function setPiTransportDepsForTest(overrides?: Partial<PiTransportDeps>): void {
  depsOverride = overrides ?? null;
}

// ── 目录解析 ───────────────────────────────────────────────────────────────────

/**
 * pi 目录探针: 精确命中 → 目录 Model; miss 但 provider 在目录 → 克隆同 provider 首条换 id
 * (= pi model-resolver buildFallbackModel 语义, 兜目录滞后, 如 kimi-coding:k3)。
 * provider 目录不认识 → undefined (调用方回落 config 错)。纯目录查询, 无网络。
 */
export function resolvePiModel(provider: string, modelId: string): PiModel | undefined {
  if (!provider || !modelId) return undefined;
  const d = deps();
  const exact = d.getModel(provider, modelId);
  if (exact) return exact;
  const siblings = d.getModels(provider);
  const base = siblings[0];
  if (!base) return undefined;
  return { ...base, id: modelId, name: modelId };
}

// ── 认证 (auth.json → env; 优先序与 pi AuthStorage 一致) ──────────────────────────

interface AuthEntry {
  type?: unknown;
  key?: unknown;
  access?: unknown;
  refresh?: unknown;
  expires?: unknown;
}

/** 读 auth.json 单条; 缺文件/坏 JSON/缺条目 → null (永不抛)。 */
function readAuthEntry(provider: string, authPath: string): AuthEntry | null {
  try {
    if (!existsSync(authPath)) return null;
    const all = JSON.parse(readFileSync(authPath, 'utf8')) as Record<string, AuthEntry | undefined>;
    return all[provider] ?? null;
  } catch {
    return null;
  }
}

/** 刷新成功后把新凭证写回 auth.json (读-改-写; 单 omd 进程, 不做 pi 的 proper-lockfile)。 */
function persistRefreshedCredentials(
  provider: string,
  creds: OAuthCredentials,
  authPath: string,
): void {
  try {
    const all = existsSync(authPath)
      ? (JSON.parse(readFileSync(authPath, 'utf8')) as Record<string, unknown>)
      : {};
    all[provider] = { type: 'oauth', ...creds };
    writeFileSync(authPath, `${JSON.stringify(all, null, 2)}\n`, 'utf8');
  } catch (e) {
    logger.warn({ provider, err: (e as Error).message }, '[omd/pi] 刷新凭证写回 auth.json 失败 (本次调用仍用新 token)');
  }
}

/**
 * pi 通道 API key 解析 (优先序 = pi AuthStorage: auth.json api_key → auth.json oauth → env):
 *   - oauth 未过期: 有 OAuthProviderInterface → getApiKey(creds); 无 (kimi-coding) → 直接 access。
 *   - oauth 已过期: 有刷新件 → getOAuthApiKey 刷新 + 写回; 无 → 警告后仍用 access (旧 bridge 语义,
 *     请求会 401 响亮失败, 用户跑一次 pi 触发刷新即可)。
 * 全 miss → undefined (调用方抛 config 错)。
 */
export async function resolvePiApiKey(provider: string): Promise<string | undefined> {
  const d = deps();
  const entry = readAuthEntry(provider, d.authPath);
  if (entry) {
    if (entry.type === 'api_key' && typeof entry.key === 'string' && entry.key.trim()) {
      return entry.key;
    }
    if (typeof entry.access === 'string' && entry.access.trim()) {
      const creds: OAuthCredentials = {
        access: entry.access,
        refresh: typeof entry.refresh === 'string' ? entry.refresh : '',
        expires: typeof entry.expires === 'number' ? entry.expires : 0,
      };
      const expired = creds.expires !== 0 && creds.expires <= d.now();
      const oauthProvider = d.getOAuthProvider(provider);
      if (!expired) {
        return oauthProvider ? oauthProvider.getApiKey(creds) : creds.access;
      }
      if (oauthProvider) {
        try {
          const refreshed = await d.getOAuthApiKey(provider, { [provider]: creds });
          if (refreshed) {
            persistRefreshedCredentials(provider, refreshed.newCredentials, d.authPath);
            return refreshed.apiKey;
          }
        } catch (e) {
          logger.warn({ provider, err: (e as Error).message }, '[omd/pi] OAuth 刷新失败 — 回落过期 access (请求将 401)');
        }
      } else {
        logger.warn(
          `[omd/pi] ${provider} token 已过期且 pi-ai 无内置刷新件 — 跑一次 pi/kimi 命令触发刷新 (请求将 401 响亮失败)`,
        );
      }
      return creds.access;
    }
  }
  return d.getEnvApiKey(provider);
}

/**
 * provider 是否有**可用凭证** —— 同步、无副作用 (不触发 OAuth 刷新/写回), 供角色兜底链 + 起跑坐席
 * 检查廉价判定 (issue #6)。与 resolvePiApiKey 同优先序但只探"在不在", 不解析实际 key:
 *   auth.json api_key 条目 ∨ auth.json oauth access (kimi-coding 等 OAuth) ∨ env key 映射。
 * assertModelResolvable 是 **key-blind** (pi 目录认识 deepseek 全坐标即便无 key) → 判"能否真调用"
 * 必须走凭证维度, 否则无 DEEPSEEK_API_KEY 时 judge/review 的 deepseek 坐标"看似可解析"实则 call 时抛无凭证。
 */
export function piHasCredential(
  provider: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const entry = readAuthEntry(provider, deps().authPath);
  if (entry) {
    if (entry.type === 'api_key' && typeof entry.key === 'string' && entry.key.trim()) return true;
    if (typeof entry.access === 'string' && entry.access.trim()) return true;
  }
  return !!piEnvApiKey(provider, env);
}

// ── 请求/响应适配 ──────────────────────────────────────────────────────────────

const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** data:<mime>;base64,... → pi ImageContent。http(s) URL pi 不收裸链接 → config 错 (响亮不静默)。 */
function toPiImage(url: string): { type: 'image'; data: string; mimeType: string } {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (!m || !m[1] || m[2] === undefined) {
    throw new ModelError(
      'config',
      'pi 通道多模态只收 data:<mime>;base64 URI (pi ImageContent 无 URL 形态) — http(s) 图链请走自有 registry 的 openai-compatible provider',
    );
  }
  return { type: 'image', data: m[2], mimeType: m[1] };
}

function toPiUserContent(content: string | ContentPart[]): Message & { role: 'user' } {
  if (typeof content === 'string') {
    return { role: 'user', content, timestamp: Date.now() };
  }
  return {
    role: 'user',
    content: content.map((p) =>
      p.type === 'text' ? { type: 'text' as const, text: p.text } : toPiImage(p.image_url.url),
    ),
    timestamp: Date.now(),
  };
}

/**
 * ModelMessage[] → pi Context。system 抽出拼 systemPrompt (pi 单独收); assistant 合成最小
 * AssistantMessage (callModel 纠错重试轮的 assistant 回填; usage 置零 — 历史轮不重复计量)。
 */
export function toPiContext(messages: ModelMessage[], model: PiModel): Context {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => (typeof m.content === 'string' ? m.content : ''))
    .filter(Boolean)
    .join('\n\n');
  const turns: Message[] = messages
    .filter((m) => m.role !== 'system')
    .map((m) => {
      if (m.role === 'assistant') {
        const text = typeof m.content === 'string'
          ? m.content
          : m.content.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('');
        const assistant: AssistantMessage = {
          role: 'assistant',
          content: [{ type: 'text', text }],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: { ...ZERO_USAGE, cost: { ...ZERO_USAGE.cost } },
          stopReason: 'stop',
          timestamp: Date.now(),
        };
        return assistant;
      }
      return toPiUserContent(m.content);
    });
  return system ? { systemPrompt: system, messages: turns } : { messages: turns };
}

/**
 * pi Usage → 本仓 ModelUsage。语义对齐 (types.ts: `in` = 总 prompt token 含命中段, cacheHit ⊆ in):
 * pi 的 input **不含** cacheRead/cacheWrite (anthropic input_tokens / openai prompt-cached 均已扣,
 * providers/*.js 实测) → in = input + cacheRead + cacheWrite 才是总 prompt。cacheWrite 本仓价表无
 * 写价字段, 并入 in 按全价计 (诚实近似, 不虚构字段)。out = output 直取。
 */
export function piUsageToModelUsage(u: Usage): ModelUsage {
  return {
    in: u.input + u.cacheRead + u.cacheWrite,
    out: u.output,
    ...(u.cacheRead > 0 ? { cacheHit: u.cacheRead } : {}),
  };
}

/** pi StopReason → callModel 归一 finish 词表 (normalizeFinish 同表)。error/aborted 在上游转抛。 */
function piFinishReason(stop: AssistantMessage['stopReason']): string {
  switch (stop) {
    case 'length':
      return 'length';
    case 'toolUse':
      return 'tool_call';
    default:
      return 'stop';
  }
}

/** errorMessage 里嗅 HTTP 状态码 (pi 只给 message 串, 无结构化 status — 尽力而为, 嗅不到算 transport)。 */
function classifyPiError(message: string): ModelError {
  const m = /\b([45]\d\d)\b/.exec(message);
  if (m && m[1]) {
    return new ModelError('http', `pi: ${message.slice(0, 300)}`, { status: Number(m[1]) });
  }
  return new ModelError('transport', `pi: ${message.slice(0, 300)}`);
}

/**
 * pi 通道单发: ModelRequest → completeSimple → PiCallResult。
 * thinkingLevel 直映 pi reasoning ('off'/省略 = 不发; 仅 model.reasoning=true 才发 — 目录事实防坏参);
 * topP pi SimpleStreamOptions 不支持 → 不发 (诚实丢弃, 不伪造)。
 * stopReason 'error'/'aborted' → ModelError (http 嗅状态码 / transport), 供 callModel 统一重试预算。
 */
export async function piRequest(
  model: PiModel,
  messages: ModelMessage[],
  req: ModelRequest,
): Promise<PiCallResult> {
  const d = deps();
  const apiKey = await resolvePiApiKey(model.provider);
  if (!apiKey) {
    throw new ModelError(
      'config',
      `pi 通道: provider '${model.provider}' 无凭证 — 设对应 env key 或先在 pi 里登录 (~/.pi/agent/auth.json)`,
    );
  }
  const context = toPiContext(messages, model);
  const reasoning: ThinkingLevel | undefined =
    model.reasoning && req.thinkingLevel && req.thinkingLevel !== 'off'
      ? req.thinkingLevel
      : undefined;
  let msg: AssistantMessage;
  try {
    msg = await d.completeSimple(model, context, {
      apiKey,
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.maxTokens !== undefined ? { maxTokens: req.maxTokens } : {}),
      ...(req.signal ? { signal: req.signal } : {}),
      ...(reasoning ? { reasoning } : {}),
    });
  } catch (e) {
    if (e instanceof ModelError) throw e;
    throw new ModelError('transport', `pi: ${(e as Error)?.message ?? String(e)}`, { cause: e });
  }
  // pi 的 complete() 对 API 错误**不抛** — resolve 出 stopReason 'error'/'aborted' 的部分消息
  // (event-stream.js: error 事件也 extractResult)。此处转回 ModelError 走 callModel 重试预算。
  if (msg.stopReason === 'aborted') {
    throw new ModelError('transport', `pi: aborted${msg.errorMessage ? `: ${msg.errorMessage}` : ''}`);
  }
  if (msg.stopReason === 'error') {
    throw classifyPiError(msg.errorMessage ?? 'unknown provider error');
  }
  const text = msg.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('');
  const finishReason = piFinishReason(msg.stopReason);
  // 空-content guard (INV-3 / C-5, 镜像 index.ts:363): reasoning 模型可把整个 token 预算烧在推理上,
  // 返 finish 'length' + 空 content。此前静默返 {text:''} → agent 节点 empty-done, 看着像成功。
  // 转 retryable `truncation` (截断长度部分随机, 有界重试常能过; 耗尽则调用方得"抬 maxTokens"的明确信号)。
  // 'length' + 非空 = 真 (虽被切) 答案, 原样返, 仅 finishReason 标记。
  if (finishReason === 'length' && !text.trim()) {
    throw new ModelError(
      'truncation',
      'pi: output truncated at max_tokens with empty content (reasoning consumed the budget) — raise maxTokens',
    );
  }
  return {
    text,
    usage: piUsageToModelUsage(msg.usage),
    raw: msg,
    finishReason,
  };
}
