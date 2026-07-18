/**
 * src/harness/web/clean —— 正文清洗层 (HTML → 干净 markdown 正文, 去 nav/footer/登录 chrome)。
 *
 * 默认实现 = trafilatura (benchmark 第一, Python 2.0.0), 经 spawn 走 CLI (stdin HTML → --markdown)。
 * Python 依赖 → 高级档 (需 `uv tool install trafilatura`); bin 缺失时 resolveCleaner 降级 PassthroughCleaner。
 *
 * 跟 fetch provider 解耦: Firecrawl/Jina 服务端已清洗 (markdown), 但裸 HTML 源 (raw 模式)
 * 仍带 boilerplate (实证: Firecrawl 爬 Medium 前 500 字全是 Sign-in/Open-in-app) → 再过一道 trafilatura 提纯。
 *
 * runner 注入 → 纯逻辑可测不打 Python (CI 无 trafilatura 时单测仍跑)。
 */
import type { FetchProvider, FetchResult } from './types';

export interface CleanResult {
  text: string;
}

export interface Cleaner {
  readonly name: string;
  clean(html: string, opts?: { signal?: AbortSignal }): Promise<CleanResult>;
}

/** html → 清洗后文本。默认 spawn trafilatura; 测试注入 fake。 */
export type CleanRunner = (html: string, signal?: AbortSignal) => Promise<string>;

export class TrafilaturaCleaner implements Cleaner {
  readonly name = 'trafilatura';
  private readonly runner: CleanRunner;
  constructor(opts: { bin?: string; runner?: CleanRunner } = {}) {
    this.runner = opts.runner ?? defaultTrafilaturaRunner(opts.bin ?? 'trafilatura');
  }
  async clean(html: string, opts: { signal?: AbortSignal } = {}): Promise<CleanResult> {
    if (!html.trim()) return { text: '' };
    const text = await this.runner(html, opts.signal);
    return { text: text.trim() };
  }
}

/** 无清洗器时的兜底 (原样返回, 不破坏管道)。 */
export class PassthroughCleaner implements Cleaner {
  readonly name = 'passthrough';
  async clean(html: string): Promise<CleanResult> {
    return { text: html };
  }
}

/** spawn `trafilatura --markdown`, stdin 喂 HTML, stdout 取 markdown。 */
function defaultTrafilaturaRunner(bin: string): CleanRunner {
  return async (html, signal) => {
    const proc = Bun.spawn([bin, '--markdown'], {
      stdin: new TextEncoder().encode(html),
      stdout: 'pipe',
      stderr: 'pipe',
      signal,
    });
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code !== 0) {
      const err = await new Response(proc.stderr).text();
      throw new Error(`trafilatura exited ${code}: ${err.slice(0, 200)}`);
    }
    return out;
  };
}

/** trafilatura bin 在 → TrafilaturaCleaner; 否则 PassthroughCleaner (分发友好降级)。 */
export function resolveCleaner(opts: { bin?: string } = {}): Cleaner {
  const bin = opts.bin ?? 'trafilatura';
  return Bun.which(bin) ? new TrafilaturaCleaner({ bin }) : new PassthroughCleaner();
}

/**
 * 把任意 FetchProvider 包成"裸抓 → 清洗"管道:
 * base.fetch(raw:true) 取 HTML → cleaner 提纯。caller 显式要 raw 时跳过清洗。
 * 这就是 "Firecrawl/scrapling 裸抓 + trafilatura 清洗" 的组合壳。
 */
export class CleaningFetchProvider implements FetchProvider {
  readonly name: string;
  constructor(
    private readonly base: FetchProvider,
    private readonly cleaner: Cleaner,
  ) {
    this.name = `${base.name}+${cleaner.name}`;
  }
  async fetch(url: string, opts: { raw?: boolean; signal?: AbortSignal } = {}): Promise<FetchResult> {
    const raw = await this.base.fetch(url, { raw: true, signal: opts.signal });
    if (opts.raw) return raw; // 调用方显式要原始 HTML → 不清洗
    const { text } = await this.cleaner.clean(raw.text, { signal: opts.signal });
    return { ...raw, text, contentType: 'text/markdown' };
  }
}
