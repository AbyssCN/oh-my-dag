/**
 * callModel — provider-agnostic single-shot inference (mimo-leaf contract piece 1).
 *
 * One request → one response (INV-1). No tool loop, no multi-turn: an agentic
 * leaf goes through executor='agent' (omd own-loop), not here. When a
 * `responseSchema` is given the reply is JSON-parsed + Zod-validated and only a
 * validated object is returned; transport, parse and validation failures share a
 * single bounded retry budget (INV-3), validation/parse failures re-prompt with
 * the concrete error, transport failures back off exponentially.
 */
import type {
  ModelMessage,
  ModelRequest,
  ModelResponse,
  ModelUsage,
  ProviderConfig,
} from './types';
import { getProvider } from './providers';
import { emitModelUsage } from './accounting';
import { resolvePiModel, piRequest, type PiModel } from './pi-transport';
import { reportProviderFailure } from './provider-health';

export type {
  ContentPart,
  ModelMessage,
  ModelRequest,
  ModelResponse,
  ModelUsage,
  ProviderApi,
  ProviderConfig,
  Role,
} from './types';
export {
  registerProvider,
  getProvider,
  listProviders,
  clearProviders,
  registerProvidersFromEnv,
  registerProvidersFromModelsJson,
} from './providers';

export type ModelErrorKind = 'config' | 'transport' | 'http' | 'parse' | 'validation' | 'truncation';

/** Typed error so a node's on_failure / a caller can branch on the failure mode. */
export class ModelError extends Error {
  readonly kind: ModelErrorKind;
  /** 1-based attempt count when thrown; set at throw time so callers can budget on it (INV-3). */
  attempts: number;
  readonly status?: number;
  constructor(
    kind: ModelErrorKind,
    message: string,
    opts?: { attempts?: number; status?: number; cause?: unknown },
  ) {
    super(message, opts?.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'ModelError';
    this.kind = kind;
    this.attempts = opts?.attempts ?? 0;
    this.status = opts?.status;
  }
}

interface RawResult {
  text: string;
  usage: ModelUsage;
  raw: unknown;
  /** Normalised finish reason (see ModelResponse.finishReason). */
  finishReason?: string;
}

/** Map provider-specific finish/stop reasons onto a small shared vocab. */
function normalizeFinish(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  switch (raw) {
    case 'length':
    case 'max_tokens':
      return 'length';
    case 'stop':
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'tool_calls':
    case 'tool_use':
      return 'tool_call';
    case 'content_filter':
      return 'content_filter';
    default:
      return raw;
  }
}

/**
 * 解析目标的判别联合 (统一模型层, 2026-07-19):
 *   own = 自有 registry 命中 (自定网关 / env 注册 provider) — 走本文件 openai/anthropic 直连 (零回归);
 *   pi  = registry 未注册但 pi-ai 目录认识 — 走 pi-transport (协议/env key 映射全交 pi)。
 */
type ResolvedTarget =
  | { kind: 'own'; cfg: ProviderConfig; modelId: string; resolved: string }
  | { kind: 'pi'; piModel: PiModel; resolved: string };

function resolveModel(req: ModelRequest): ResolvedTarget {
  const raw = req.model;
  if (!raw) {
    throw new ModelError('config', 'callModel: req.model required (format "provider:modelId")');
  }
  const sep = raw.indexOf(':');
  const providerName = sep === -1 ? raw : raw.slice(0, sep);
  const cfg = getProvider(providerName);
  if (cfg) {
    const modelId = sep === -1 ? cfg.defaultModel ?? '' : raw.slice(sep + 1);
    if (!modelId) {
      throw new ModelError(
        'config',
        `callModel: no model id in '${raw}' and provider '${providerName}' has no defaultModel`,
      );
    }
    return { kind: 'own', cfg, modelId, resolved: `${providerName}:${modelId}` };
  }
  // ② pi-ai 目录后备 (新默认): registry 不认识 → 探 pi 目录 (纯目录查询无网络)。
  // 裸 provider 坐标 (无 ':model') 不走 pi — pi 路必须显式 model id, 保持旧错误语义。
  const modelId = sep === -1 ? '' : raw.slice(sep + 1);
  if (modelId) {
    const piModel = resolvePiModel(providerName, modelId);
    if (piModel) return { kind: 'pi', piModel, resolved: `${providerName}:${modelId}` };
  }
  // ③ 都不认 → 既有清晰错误 (文案保持不变, 附 pi 提示)。
  throw new ModelError('config', `callModel: provider '${providerName}' not registered`);
}

/**
 * 纯解析校验: 坐标能否解析成可调模型 (有 model id 或裸 provider 有 defaultModel)。
 * 解析规则单一真理源 = resolveModel — **两路都查**: 自有 registry 优先, miss 再探 pi-ai 目录
 * (getModel/getModels 纯查表)。不能解析 → 抛 ModelError('config')。无网络副作用。
 * 用途: wiring 层 (如 resolveVerification) fail-fast —— 把"DAG 跑完才崩"提到"DAG 跑前崩"。
 * `label` 进错误信息, 点名是哪个角色坐标坏 (如 'verifier')。
 */
export function assertModelResolvable(coord: string, label = 'model'): void {
  try {
    resolveModel({ messages: [], model: coord });
  } catch (err) {
    const msg = err instanceof ModelError ? err.message : String(err);
    throw new ModelError('config', `${label} 坐标无法解析: ${msg}`);
  }
}

async function postJson(
  cfg: ProviderConfig,
  path: string,
  body: unknown,
  signal?: AbortSignal,
  extraHeaders?: Record<string, string>,
): Promise<unknown> {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...(cfg.headers ?? {}) };
  if (cfg.api === 'openai-compatible') headers.authorization = `Bearer ${cfg.apiKey}`;
  Object.assign(headers, extraHeaders ?? {});

  let res: Response;
  try {
    res = await fetch(`${cfg.baseUrl}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    throw new ModelError('transport', `fetch failed: ${(e as Error)?.message ?? String(e)}`, { cause: e });
  }
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new ModelError('http', `HTTP ${res.status}: ${errText.slice(0, 300)}`, { status: res.status });
  }
  return res.json();
}

/**
 * provider → 该 provider 真正接受的 `reasoning_effort` 字面量 (由弱到强)。
 * **实测事实, 不是推测** —— 发错值不是降级而是 HTTP 400/500, 整个节点白挂:
 *   - mimo / mimo-platform: 2026-07-25 实测 `Input should be 'low', 'medium' or 'high'`;
 *     'max' 与 'minimal' 均 400 (与 .env 里"ultraspeed 在 max 上 500"的旧记录同源)。
 *   - deepseek: 'high' / 'max' (R6 验 api-docs.deepseek.com)。
 * 未列的 provider 走 UNKNOWN_EFFORTS: 只发 'high' —— 保守到底, 宁可不省也不发坏参数。
 * 新增一行前请**先真打一次 API**, 别照抄别家文档。
 */
const PROVIDER_EFFORTS: Record<string, readonly string[]> = {
  mimo: ['low', 'medium', 'high'],
  'mimo-platform': ['low', 'medium', 'high'],
  deepseek: ['high', 'max'],
};
const UNKNOWN_EFFORTS: readonly string[] = ['high'];

/** 内部档 → provider 字面量的候选序 (由该档出发, 先找同义, 再向下退)。 */
const EFFORT_LADDER: Record<string, readonly string[]> = {
  off: [],
  low: ['low', 'minimal'],
  medium: ['medium', 'low'],
  high: ['high', 'medium'],
  // xhigh 想要"最强": 有 max 用 max, 没有就**降到 high** (owner 2026-07-25: xhigh 不是每个模型都有)。
  xhigh: ['max', 'high'],
};

/**
 * 内部 thinkingLevel → 该 provider 可接受的 reasoning_effort 字面量; 取不到 → undefined (不发该字段)。
 * 'off' 恒不发 —— OpenAI 兼容端点没有统一的关思考开关 (mimo 实测 enable_thinking/thinking 三种写法
 * 全被忽略, 输出 token 与不发时同量级), 与其发一个假装有效的字段, 不如诚实地什么都不发。
 */
export function reasoningEffortFor(provider: string, level: string | undefined): string | undefined {
  if (!level) return undefined;
  const supported = PROVIDER_EFFORTS[provider] ?? UNKNOWN_EFFORTS;
  for (const cand of EFFORT_LADDER[level] ?? []) {
    if (supported.includes(cand)) return cand;
  }
  return undefined;
}

async function openaiRequest(
  cfg: ProviderConfig,
  modelId: string,
  messages: ModelMessage[],
  req: ModelRequest,
  provider: string,
): Promise<RawResult> {
  const body: Record<string, unknown> = {
    model: modelId,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
  };
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.topP !== undefined) body.top_p = req.topP;
  const effort = reasoningEffortFor(provider, req.thinkingLevel);
  if (effort) body.reasoning_effort = effort;
  if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;
  if (req.responseSchema) body.response_format = { type: 'json_object' };

  const json = (await postJson(cfg, '/chat/completions', body, req.signal)) as {
    choices?: { message?: { content?: string }; finish_reason?: string }[];
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      input_tokens?: number;
      output_tokens?: number;
      // 命中 cache 的 input token, 两种 openai-兼容风格:
      //   DeepSeek = prompt_cache_hit_tokens (顶层) · MiMo/OpenAI = prompt_tokens_details.cached_tokens
      prompt_cache_hit_tokens?: number;
      prompt_tokens_details?: { cached_tokens?: number };
    };
  };
  const text = json?.choices?.[0]?.message?.content ?? '';
  const u = json?.usage;
  const cacheHit = u?.prompt_cache_hit_tokens ?? u?.prompt_tokens_details?.cached_tokens;
  return {
    text,
    // Tolerate a gateway that normalises usage to Anthropic naming (INV-4: usage must land).
    usage: {
      in: u?.prompt_tokens ?? u?.input_tokens ?? 0,
      out: u?.completion_tokens ?? u?.output_tokens ?? 0,
      ...(cacheHit !== undefined ? { cacheHit } : {}),
    },
    raw: json,
    finishReason: normalizeFinish(json?.choices?.[0]?.finish_reason),
  };
}

async function anthropicRequest(
  cfg: ProviderConfig,
  modelId: string,
  messages: ModelMessage[],
  req: ModelRequest,
): Promise<RawResult> {
  // anthropic-messages splits the system prompt out of the turn list.
  // System prompts are text-only; coerce defensively now that content may be multimodal parts.
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => (typeof m.content === 'string' ? m.content : ''))
    .join('\n\n');
  const turns = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role, content: m.content }));
  const body: Record<string, unknown> = {
    model: modelId,
    max_tokens: req.maxTokens ?? cfg.maxTokens ?? 4096,
    messages: turns,
  };
  if (system) body.system = system;
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.topP !== undefined) body.top_p = req.topP;

  const json = (await postJson(cfg, '/messages', body, req.signal, {
    'x-api-key': cfg.apiKey,
    'anthropic-version': '2023-06-01',
  })) as {
    content?: { type?: string; text?: string }[];
    stop_reason?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      prompt_tokens?: number;
      completion_tokens?: number;
      // Anthropic prompt-cache: 读命中 input token (V2-ECON 账本)。
      cache_read_input_tokens?: number;
    };
  };
  const text = Array.isArray(json?.content)
    ? json.content.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('')
    : '';
  const u = json?.usage;
  return {
    text,
    usage: {
      in: u?.input_tokens ?? u?.prompt_tokens ?? 0,
      out: u?.output_tokens ?? u?.completion_tokens ?? 0,
      ...(u?.cache_read_input_tokens !== undefined ? { cacheHit: u.cache_read_input_tokens } : {}),
    },
    raw: json,
    finishReason: normalizeFinish(json?.stop_reason),
  };
}

function doRequest(
  target: ResolvedTarget,
  messages: ModelMessage[],
  req: ModelRequest,
): Promise<RawResult> {
  if (target.kind === 'pi') {
    // pi-transport 的 PiCallResult 与 RawResult 结构同形 (text/usage/raw/finishReason)。
    return piRequest(target.piModel, messages, req);
  }
  const provider = target.resolved.split(':')[0] ?? '';
  return target.cfg.api === 'anthropic-messages'
    ? anthropicRequest(target.cfg, target.modelId, messages, req)
    : openaiRequest(target.cfg, target.modelId, messages, req, provider);
}

/** Strip a ```json … ``` fence if the model wrapped its JSON in one. */
function stripFences(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return (fenced?.[1] ?? text).trim();
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new ModelError('transport', 'callModel: aborted during backoff'));
  }
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(t);
      reject(new ModelError('transport', 'callModel: aborted during backoff'));
    };
    // Drop the listener on a normal wake so a long-lived signal never leaks listeners.
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * 该错误是否 = provider 运行时故障 (值得熔断该 provider): fetch 失败 (非 abort) 或 HTTP 429/5xx。
 * abort = 调用方意图停止 (非后端故障) → 不熔断。config/parse/validation/truncation = 请求/内容问题,
 * 换 provider 也不解决 → 不熔断 (熔断只针对「这个后端此刻不健康」)。
 */
function isProviderFault(err: ModelError): boolean {
  if (err.kind === 'transport') return !String(err.message).includes('abort');
  if (err.kind === 'http') return err.status === 429 || (err.status ?? 0) >= 500;
  return false;
}

export async function callModel(req: ModelRequest): Promise<ModelResponse> {
  if (!req.messages || req.messages.length === 0) {
    throw new ModelError('config', 'callModel: messages required');
  }
  const target = resolveModel(req);
  const resolved = target.resolved;
  const maxRetries = req.maxRetries ?? 2;
  const baseDelay = req.retryDelayMs ?? 250;

  // `messages` may grow with corrective turns on parse/validation failure; the
  // original request is preserved so each correction restates it from scratch.
  let messages = req.messages;
  let lastErr: ModelError | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // A caller-cancelled request fails fast and is never retried — the signal is
    // intent to stop, not a transient fault (P1-B).
    if (req.signal?.aborted) {
      const aborted = new ModelError('transport', 'callModel: aborted');
      aborted.attempts = attempt;
      throw aborted;
    }
    let result: RawResult;
    try {
      result = await doRequest(target, messages, req);
    } catch (e) {
      if (req.signal?.aborted) {
        const aborted = new ModelError('transport', 'callModel: aborted', { cause: e });
        aborted.attempts = attempt + 1;
        throw aborted;
      }
      lastErr = e instanceof ModelError ? e : new ModelError('transport', String(e), { cause: e });
      lastErr.attempts = attempt + 1; // accurate budget on exhaustion (P1-C / INV-3)
      // 运行时熔断: provider-fault (429/5xx/网络) → 冷却该 provider, 后续 role 解析顺延兜底
      // (provider-health)。本次 in-flight 重试仍打原 target — 冷却只改**未来**的角色路由。
      if (isProviderFault(lastErr)) reportProviderFailure(target.resolved);
      if (attempt < maxRetries) {
        await sleep(baseDelay * 2 ** attempt, req.signal);
        continue;
      }
      break;
    }

    // Silent-truncation guard: a reasoning model can spend the whole token budget on
    // reasoning and return finish_reason 'length' with EMPTY content. That is a failure, not
    // a success — the old code returned "" as if it were a real answer. Surface it as a
    // retryable `truncation` error: truncation length is partly stochastic (reasoning size
    // varies per sample), so a bounded retry often clears it; on exhaustion the caller gets a
    // clear signal to raise maxTokens. A 'length' finish with NON-empty content is a real (if
    // cut) answer and is returned untouched — only `finishReason` flags it.
    if (result.finishReason === 'length' && !result.text.trim()) {
      emitModelUsage(result.usage, resolved); // reasoning still spent tokens (INV-4: usage lands)
      lastErr = new ModelError(
        'truncation',
        'output truncated at max_tokens with empty content (reasoning consumed the budget) — raise maxTokens',
        { attempts: attempt + 1 },
      );
      if (attempt < maxRetries) {
        await sleep(baseDelay * 2 ** attempt, req.signal);
        continue;
      }
      break;
    }

    if (!req.responseSchema) {
      emitModelUsage(result.usage, resolved); // V2-ECON: 通知 ledger (不持久, 守 INV-4)
      return { text: result.text, usage: result.usage, raw: result.raw, model: resolved, attempts: attempt + 1, finishReason: result.finishReason };
    }

    // Structured output: parse → validate → only ever return validated data (INV-3).
    let obj: unknown;
    try {
      obj = JSON.parse(stripFences(result.text));
    } catch (e) {
      lastErr = new ModelError('parse', `invalid JSON: ${(e as Error).message}`, { attempts: attempt + 1 });
      messages = [
        ...req.messages,
        {
          role: 'user',
          content: `Your previous reply was not valid JSON (${(e as Error).message}). Reply with ONLY a JSON object — no prose, no code fences.`,
        },
      ];
      if (attempt < maxRetries) continue;
      break;
    }

    const parsed = req.responseSchema.safeParse(obj);
    if (parsed.success) {
      emitModelUsage(result.usage, resolved); // V2-ECON: 通知 ledger (不持久, 守 INV-4)
      return {
        text: result.text,
        parsed: parsed.data,
        usage: result.usage,
        raw: result.raw,
        model: resolved,
        attempts: attempt + 1,
        finishReason: result.finishReason,
      };
    }

    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    lastErr = new ModelError('validation', `schema validation failed: ${issues}`, { attempts: attempt + 1 });
    messages = [
      ...req.messages,
      { role: 'assistant', content: result.text },
      {
        role: 'user',
        content: `Your JSON failed schema validation (${issues}). Return a corrected JSON object that matches the schema — nothing else.`,
      },
    ];
    if (attempt < maxRetries) continue;
    break;
  }

  throw (
    lastErr ?? new ModelError('transport', 'callModel: retries exhausted with no captured error')
  );
}
