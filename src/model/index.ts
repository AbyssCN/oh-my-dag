/**
 * callModel — provider-agnostic single-shot inference (mimo-leaf contract piece 1).
 *
 * One request → one response (INV-1). No tool loop, no multi-turn: an agentic
 * leaf goes through executor='agent' (wright own-loop), not here. When a
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
  registerCustomApis,
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

function resolveModel(req: ModelRequest): { cfg: ProviderConfig; modelId: string; resolved: string } {
  const raw = req.model;
  if (!raw) {
    throw new ModelError('config', 'callModel: req.model required (format "provider:modelId")');
  }
  const sep = raw.indexOf(':');
  const providerName = sep === -1 ? raw : raw.slice(0, sep);
  const cfg = getProvider(providerName);
  if (!cfg) {
    throw new ModelError('config', `callModel: provider '${providerName}' not registered`);
  }
  const modelId = sep === -1 ? cfg.defaultModel ?? '' : raw.slice(sep + 1);
  if (!modelId) {
    throw new ModelError(
      'config',
      `callModel: no model id in '${raw}' and provider '${providerName}' has no defaultModel`,
    );
  }
  return { cfg, modelId, resolved: `${providerName}:${modelId}` };
}

/**
 * 纯解析校验: 坐标能否解析成可调模型 (有 model id 或裸 provider 有 defaultModel)。
 * 解析规则单一真理源 = resolveModel。不能解析 → 抛 ModelError('config')。无网络副作用。
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

async function openaiRequest(
  cfg: ProviderConfig,
  modelId: string,
  messages: ModelMessage[],
  req: ModelRequest,
): Promise<RawResult> {
  const body: Record<string, unknown> = {
    model: modelId,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
  };
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.topP !== undefined) body.top_p = req.topP;
  // thinkingLevel → deepseek reasoning_effort (R6 验: api-docs.deepseek.com, high/max; 默认 high)。
  // 只映 high/xhigh (其余 = 不发, 用模型默认), 避免对不支持的 provider 发坏参数。
  const effort = req.thinkingLevel === 'high' ? 'high' : req.thinkingLevel === 'xhigh' ? 'max' : undefined;
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
  cfg: ProviderConfig,
  modelId: string,
  messages: ModelMessage[],
  req: ModelRequest,
): Promise<RawResult> {
  return cfg.api === 'anthropic-messages'
    ? anthropicRequest(cfg, modelId, messages, req)
    : openaiRequest(cfg, modelId, messages, req);
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

export async function callModel(req: ModelRequest): Promise<ModelResponse> {
  if (!req.messages || req.messages.length === 0) {
    throw new ModelError('config', 'callModel: messages required');
  }
  const { cfg, modelId, resolved } = resolveModel(req);
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
      result = await doRequest(cfg, modelId, messages, req);
    } catch (e) {
      if (req.signal?.aborted) {
        const aborted = new ModelError('transport', 'callModel: aborted', { cause: e });
        aborted.attempts = attempt + 1;
        throw aborted;
      }
      lastErr = e instanceof ModelError ? e : new ModelError('transport', String(e), { cause: e });
      lastErr.attempts = attempt + 1; // accurate budget on exhaustion (P1-C / INV-3)
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
