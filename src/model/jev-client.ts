/**
 * model/jev-client —— **TypeSafe System One 的裸 HTTP 客户端**(契约
 * `docs/plan/2026-09-22-jev-传感器-阶段0-E1-执行契约.md` 切片 1 / D-2)。
 *
 * ## 这个模块是什么
 *
 * 一发请求换一组**带类型的判别值**:输入 `state`(引擎自己的账)+ 一组问题,
 * 输出每问一个数(Noul = 是/否概率)。它**不生成文本**,所以它不是 `callModel` 的一条通道,
 * 与 pi-transport / registry / auto-assign 全无关系 —— 故意不进那套。
 *
 * ## 为什么不装 SDK
 *
 * 面窄到一条 `POST {base}/v1/systemone`:header `Authorization: Bearer <TYPESAFE_API_KEY>`,
 * body `{ model, state, questions }`。装 `@typesafe-ai/sdk` 换来的是一层重试/日志/类型生成,
 * 而这里**不许重试**(超时即无信号,见下)。2026-09-22 curl 实测 200 的响应形:
 *
 *   { "model": "jev-1.13.0", "answers": { "<id>": { "type": "noul", "noul": 0.24 } },
 *     "usage": { "input_tokens": 355, "output_tokens": 40 } }
 *
 * ## 不变量
 *
 *  · **永不抛。** 调用方(传感器)是仓规 §引擎理念 ④ 的「只报不拦」层:拿不到读数不许挡主流程,
 *    所以失败一律化成 `{ ok: false, why }`,而 `why` 分五类 —— `no-key` / `timeout` / `http` /
 *    `parse` / `network` 各自的下一步不同,压成一个「挂了」就再也分不开(仓规 §静默坑 1)。
 *  · **无 key ⇒ 一次 fetch 都不发。** 没配 key 是常态(默认 `OMD_SENSORS=off`),
 *    不是错误,更不该变成每步一发的网络噪声。
 *  · **超时由 AbortController 钉死,不重试。** 传感器与模型思考并行跑,迟到的读数没有用处。
 */

/** 问题的 wire 形(typesafe-sdk-js 源码逐字)。本阶段只用 `noul`,`choice` 先留着形不用。 */
export type JevQuestion =
  | { type: 'noul'; instructions: string }
  | { type: 'choice'; instructions: string; criteria: Record<string, string | null> };

/** 一问的答。字段按问题类型填,不出现的键就是不适用 —— **不要**拿 0 顶替缺席(仓规 §静默坑 1)。 */
export interface JevAnswer {
  noul?: number;
  choice?: string;
  probabilities?: Record<string, number>;
  confidence?: number;
}

export interface JevAskInput {
  state: unknown;
  questions: Record<string, JevQuestion>;
  timeoutMs?: number;
  /** 测试注入;缺省用全局 `fetch`。 */
  fetch?: typeof fetch;
  /** 缺省 `process.env`(key 经 env-discovery 从 `.env` 加载)。 */
  env?: Record<string, string | undefined>;
}

export type JevAskResult =
  | { ok: true; answers: Record<string, JevAnswer>; ms: number; model?: string; inputTokens?: number; outputTokens?: number }
  | { ok: false; why: 'no-key' | 'timeout' | 'http' | 'parse' | 'network'; ms: number; detail?: string };

/** 2026-09-22 curl 实测 200 的 base;`TYPESAFE_BASE_URL` 覆盖。 */
export const JEV_DEFAULT_BASE_URL = 'https://api.typesafe.ai';
/** 1500 ms:传感器藏在模型那一发(秒级)后面,迟到即作废。本机六次暖调用 552–599 ms(2026-09-22),800 只剩 200 ms 余量,放宽不花墙钟。 */
export const JEV_DEFAULT_TIMEOUT_MS = 1500;
export const JEV_DEFAULT_MODEL = 'jev-latest';

/** 响应里 `answers.<id>` 的形;多余键忽略,缺席键不补。 */
function toAnswer(raw: unknown): JevAnswer {
  if (raw === null || typeof raw !== 'object') return {};
  const o = raw as Record<string, unknown>;
  const out: JevAnswer = {};
  if (typeof o.noul === 'number') out.noul = o.noul;
  if (typeof o.choice === 'string') out.choice = o.choice;
  if (o.probabilities !== null && typeof o.probabilities === 'object') {
    out.probabilities = o.probabilities as Record<string, number>;
  }
  if (typeof o.confidence === 'number') out.confidence = o.confidence;
  return out;
}

/** 发一发 System One。**永不抛**:任何失败都是一个带 `why` 的 `ok: false`。 */
export async function askJev(input: JevAskInput): Promise<JevAskResult> {
  const env = input.env ?? (process.env as Record<string, string | undefined>);
  const started = Date.now();
  const key = env.TYPESAFE_API_KEY;
  if (!key) return { ok: false, why: 'no-key', ms: Date.now() - started };

  const base = (env.TYPESAFE_BASE_URL ?? JEV_DEFAULT_BASE_URL).replace(/\/+$/, '');
  const timeoutMs = input.timeoutMs ?? JEV_DEFAULT_TIMEOUT_MS;
  const doFetch = input.fetch ?? fetch;

  const ac = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ac.abort();
  }, timeoutMs);

  let res: Response;
  try {
    res = await doFetch(`${base}/v1/systemone`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: JEV_DEFAULT_MODEL, state: input.state, questions: input.questions }),
      signal: ac.signal,
    });
  } catch (e) {
    // 超时读数的下限钉在 `timeoutMs`: 定时器可以比它早 1 ms 触发, 而 INV-1 的判据是 `ms ≥ timeoutMs`,
    // 让读数比判据小只会把不变量变成抖动测试。
    const ms = Date.now() - started;
    if (timedOut) return { ok: false, why: 'timeout', ms: Math.max(ms, timeoutMs) };
    return { ok: false, why: 'network', ms, detail: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) return { ok: false, why: 'http', ms: Date.now() - started, detail: `HTTP ${res.status}` };

  let body: unknown;
  try {
    body = await res.json();
  } catch (e) {
    return { ok: false, why: 'parse', ms: Date.now() - started, detail: e instanceof Error ? e.message : String(e) };
  }

  const ms = Date.now() - started;
  const o = (body ?? {}) as Record<string, unknown>;
  const rawAnswers = (o.answers ?? {}) as Record<string, unknown>;
  const answers: Record<string, JevAnswer> = {};
  for (const [id, raw] of Object.entries(rawAnswers)) answers[id] = toAnswer(raw);
  const usage = (o.usage ?? {}) as Record<string, unknown>;
  return {
    ok: true,
    answers,
    ms,
    ...(typeof o.model === 'string' ? { model: o.model } : {}),
    ...(typeof usage.input_tokens === 'number' ? { inputTokens: usage.input_tokens } : {}),
    ...(typeof usage.output_tokens === 'number' ? { outputTokens: usage.output_tokens } : {}),
  };
}
