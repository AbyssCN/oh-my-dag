/**
 * callModel types — provider-agnostic single-shot model adapter.
 *
 * Contract: docs/plan/mimo-leaf-execution-contract.md (候选 D65) §3.
 *  - INV-1 single request/response only (no tool loop, no multi-turn).
 *  - INV-2 provider registered, not hard-coded (mimo / DeepSeek / vLLM by config).
 *  - INV-3 structured reply is JSON-parsed + Zod-validated with bounded retry;
 *          only a validated object is ever returned.
 *  - INV-4 token usage is returned to the caller, never persisted here (the
 *          caller records it into its session/event — no telemetry table).
 */
import type { ZodTypeAny } from 'zod';

/** Wire shape of a provider's chat API. */
export type ProviderApi = 'openai-compatible' | 'anthropic-messages';

/**
 * Provider registry entry (INV-2). Adding a provider is config, not code:
 * a new backend registers by env and callModel call sites are unchanged.
 * `baseUrl/apiKey/api` are the contract's named shape; the rest are optional
 * additive refinements (falsifiable — drop if they earn nothing).
 */
export interface ProviderConfig {
  baseUrl: string;
  apiKey: string;
  api: ProviderApi;
  /** Used when a ModelRequest omits the `:model` half (e.g. model = 'mimo'). */
  defaultModel?: string;
  /** anthropic-messages requires max_tokens; default 4096. */
  maxTokens?: number;
  /** Extra headers merged into every request (e.g. self-hosted gateway auth). */
  headers?: Record<string, string>;
}

export type Role = 'system' | 'user' | 'assistant';

/**
 * Multimodal content part (mimo-leaf contract, multimodal leg).
 * openai-compatible providers (MiMo v2.5, DeepSeek-VL, OpenAI) accept an array
 * of parts as message content. image_url.url may be an http(s) URL or a
 * `data:<mime>;base64,...` URI.
 */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface ModelMessage {
  role: Role;
  /** string (text-only, the common case) or multimodal parts. */
  content: string | ContentPart[];
}

export interface ModelRequest {
  messages: ModelMessage[];
  /** 'provider:modelId', e.g. 'mimo:deepseek-v4-flash'. Omit → provider default. */
  model?: string;
  temperature?: number;
  /** nucleus sampling 截断 (0-1)。低=只留最自信 token, 高=含长尾。与 persona conditioning 配合操控分布。 */
  topP?: number;
  /**
   * 推理深度 (reasoning effort)。high/xhigh → deepseek `reasoning_effort: high/max` (OpenAI-compat 路径)。
   * 省略/medium 及以下 = 不显式发 (deepseek 默认 high)。用于 conductor(分解)/leaf(执行) 的档位控制。
   */
  thinkingLevel?: 'off' | 'low' | 'medium' | 'high' | 'xhigh';
  /** anthropic max_tokens / openai max_completion_tokens cap. */
  maxTokens?: number;
  /** When present, the reply is JSON-parsed + validated; only validated `parsed` is returned (INV-3). */
  responseSchema?: ZodTypeAny;
  /** Bounded retry budget across transport + validation failures. Default 2 → ≤3 attempts (INV-3). */
  maxRetries?: number;
  /** Base backoff ms (exponential per attempt). Default 250. Tests pass 0. */
  retryDelayMs?: number;
  signal?: AbortSignal;
}

export interface ModelUsage {
  in: number;
  out: number;
  /**
   * 命中 prompt-cache 的 input token 数 (V2-ECON 账本基础)。`in` 仍是总 prompt token (含命中部分);
   * cacheHit ⊆ in, 命中段按 ~10% 价计。provider 不报则 undefined (DeepSeek=prompt_cache_hit_tokens /
   * Anthropic=cache_read_input_tokens)。**OUTPUT 永远全价, 不在此**。
   */
  cacheHit?: number;
}

export interface ModelResponse {
  /** Raw assistant text (last attempt). */
  text: string;
  /** Validated object — present iff `responseSchema` was given and passed (INV-3). */
  parsed?: unknown;
  usage: ModelUsage;
  /** Provider's raw JSON response (last attempt). */
  raw: unknown;
  /** Resolved 'provider:modelId'. */
  model: string;
  /** 1-based attempt count that produced this response. */
  attempts: number;
  /**
   * Normalised provider finish reason: 'stop' | 'length' | 'tool_call' | 'content_filter'
   * | <provider-raw>. Lets a caller detect a truncated answer ('length') instead of mistaking
   * a cut-off reply for a complete one. A 'length' finish with EMPTY content never reaches here
   * — callModel treats that as a retryable `truncation` error (raise maxTokens). Undefined if the
   * provider did not report one.
   */
  finishReason?: string;
}
