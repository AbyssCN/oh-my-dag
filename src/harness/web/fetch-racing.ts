/**
 * src/harness/web/fetch-racing —— 单 URL 并发竞速抓取。
 *
 * §3.1 A — 先并发 race 档 (Promise.any, 赢即 abort 其余),
 * 全败/全 short → 串行 tail 档 (= 原 fetchWithFallback 语义)。
 * 不退化 minChars 质量闸, 不浪费付费 provider。
 *
 * WFC-INV-1 (minChars 保真), WFC-INV-2 (race 无成本泄漏), WFC-INV-3 (赢即止血)。
 */
import type { FetchProvider, FetchResult } from './types';

/* ─── helpers ─────────────────────────────────────── */

/** 正文过短错误 — race 档内 "软失败" 信号 (不抛到外界)。 */
class ShortError extends Error {
  override readonly name = 'ShortError';
  constructor(readonly provider: string, readonly got: number, readonly min: number) {
    super(`${provider}: too-short (${got}<${min})`);
  }
}

/** 合并外部 signal + 内部 controller: 任一 abort 即全链同步。 */
function mergeSignals(external: AbortSignal | undefined): {
  signal: AbortSignal;
  done(): void;
} {
  const ctrl = new AbortController();
  const onAbort = () => { ctrl.abort(); };
  external?.addEventListener('abort', onAbort, { once: true });
  return {
    signal: ctrl.signal,
    done() {
      ctrl.signal.aborted || ctrl.abort(); // 确保 cleanup
      external?.removeEventListener('abort', onAbort);
    },
  };
}

/** 并联 race 档: 拼一个 per-provider promise, minChars 闸 = reject(ShortError)。 */
async function raceOne(
  provider: FetchProvider,
  url: string,
  opts: { raw?: boolean; minChars: number; signal: AbortSignal },
): Promise<{ result: FetchResult; provider: string }> {
  const result = await provider.fetch(url, { raw: opts.raw, signal: opts.signal });
  const len = result.text.trim().length;
  if (len < opts.minChars) throw new ShortError(provider.name, len, opts.minChars);
  return { result, provider: provider.name };
}

/* ─── public API ──────────────────────────────────── */

/** provider 档位: race=免费可并发 / tail=付费或慢串行。 */
export type FetchTier = 'race' | 'tail';

/** 默认分档 (按名): 自托管/keyless 引擎=race; 付费或慢引擎=tail。 */
export function defaultTier(name: string): FetchTier {
  // 装饰器会给 name 叠后缀 (CleaningFetchProvider '+trafilatura' 等);
  // 必须取 base name (首个 ~ 或 + 之前) 判档 — 否则精确匹配被后缀打偏 → 全塌 tail, 竞速静默失效。
  const base = name.split(/[~+]/)[0];
  return base === 'crawl4ai' || base === 'jina' ? 'race' : 'tail';
}

/**
 * 单 URL 竞速抓取。
 *
 * 1. providers 按 tierOf 分 race/tail 档。
 * 2. race: 全发, Promise.any 取第一个达标 (>=minChars)。赢家确定后 abort 其余 in-flight。
 * 3. tail: 严格串行 (= 现 fetchWithFallback), minChars 软失败降级。
 * 4. 全失败 → throw, 错误含各 provider 原因。
 *
 * @throws 全 provider 失败/全 short → Error (含全部原因, 不退化诊断)。
 */
export async function fetchRacing(
  providers: FetchProvider[],
  url: string,
  opts: {
    raw?: boolean;
    signal?: AbortSignal;
    /** 正文最短字符数, 短于此视作空 (默认 0 = 不闸)。 */
    minChars?: number;
    /** provider → tier 映射 (默认 defaultTier)。 */
    tierOf?: (name: string) => FetchTier;
  } = {},
): Promise<{ result: FetchResult; provider: string }> {
  const min = opts.minChars ?? 0;
  const tierOf = opts.tierOf ?? defaultTier;

  const race: FetchProvider[] = [];
  const tail: FetchProvider[] = [];
  for (const p of providers) {
    (tierOf(p.name) === 'race' ? race : tail).push(p);
  }

  // 合并外部 + 内部 abort (赢家 abort 用)
  const merged = mergeSignals(opts.signal);
  const errors: string[] = [];

  try {
    // ── race 档 ──
    if (race.length > 0) {
      const promises = race.map((p) =>
        raceOne(p, url, { raw: opts.raw, minChars: min, signal: merged.signal })
          .catch((e: Error) => {
            errors.push(e.message);
            return Promise.reject(e); // 保持 reject, Promise.any 等 AggregateError
          }),
      );

      try {
        const winner = await Promise.any(promises);
        return winner; // 有达标 → 返回 (finally 会 abort 其余)
      } catch {
        // AggregateError = 全 race 失败; 已收集 errors, 继续 tail
        // ShortError 没到外抛, 所以 errors 已含 short/真实失败
      }
    }

    // ── tail 档 (串行) ──
    for (const p of tail) {
      try {
        const result = await p.fetch(url, { raw: opts.raw, signal: merged.signal });
        const len = result.text.trim().length;
        if (len < min) {
          errors.push(`${p.name}: too-short (${len}<${min})`);
          continue;
        }
        return { result, provider: p.name };
      } catch (e) {
        errors.push(`${p.name}: ${(e as Error).message}`);
      }
    }
  } finally {
    merged.done(); // abort 未结束的 race, 清理 signal 监听
  }

  // ── 全失败 ──
  throw new Error(`all fetch providers failed/empty: ${errors.join(' | ')}`);
}
