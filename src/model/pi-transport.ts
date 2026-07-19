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
import {
  completeSimple as piCompleteSimple,
  getEnvApiKey as piGetEnvApiKey,
  getModel as piGetModel,
  getModels as piGetModels,
  type Api,
  type AssistantMessage,
  type Context,
  type Message,
  type Model,
  type SimpleStreamOptions,
  type ThinkingLevel,
  type Usage,
} from '@earendil-works/pi-ai';
import {
  getOAuthApiKey as piGetOAuthApiKey,
  getOAuthProvider as piGetOAuthProvider,
  type OAuthCredentials,
} from '@earendil-works/pi-ai/oauth';
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

/** 真实现 (静态 import: pi-ai 是 ESM-only export map, Bun require 解析不到 import 条件)。 */
function realDeps(): PiTransportDeps {
  return {
    getModel: piGetModel as unknown as PiTransportDeps['getModel'],
    getModels: piGetModels as unknown as PiTransportDeps['getModels'],
    completeSimple: piCompleteSimple,
    getEnvApiKey: piGetEnvApiKey,
    getOAuthProvider: piGetOAuthProvider,
    getOAuthApiKey: piGetOAuthApiKey,
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
  return {
    text,
    usage: piUsageToModelUsage(msg.usage),
    raw: msg,
    finishReason: piFinishReason(msg.stopReason),
  };
}
