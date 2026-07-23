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

/* ─── HTML 兜底剥离 (确定性, 零 LLM, 零第三方依赖) ────────────────────
 *
 * 场景: cleaner 是 PassthroughCleaner (trafilatura bin 缺失降级) 或清洗器漏网时,
 *   provider 的裸 HTML 会原样灌进语料 (实证: jina+passthrough 把 docs.github.com 整页
 *   HTML 连 nav/script 塞进 groundTruth, run 29936271221)。这里在**统一落地点**
 *   (CleaningFetchProvider.fetch, 所有 provider 清洗路径都过) 补一道保守剥离:
 *   判为整页 HTML → 剥标签取正文; 剥后过短 → 抛错标失败 (fail-loud, 不喂壳渣)。
 * 保守自写 (不引 trafilatura/cheerio): 只做正则级块剥离 + 实体解码 + 空白折叠,
 *   宁欠清洗 (漏几个 inline 标签) 不误伤 (吞正文)。真清洗仍由 trafilatura 主路径负责,
 *   这只是 passthrough 漏斗的止血闸。 */

/** 命名/数值 HTML 实体最小解码 (保守集, 覆盖正文高频; &amp; 最后解防二次解码)。 */
function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&(?:#39|apos);/gi, "'")
    .replace(/&#(\d+);/g, (_, d: string) => safeFromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => safeFromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/gi, '&');
}

function safeFromCodePoint(cp: number): string {
  if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return '';
  try {
    return String.fromCodePoint(cp);
  } catch {
    return '';
  }
}

/**
 * 内容判定为「整页原始 HTML」: <html/<head/<body 骨架标签 = 铁证; 否则看标签字符密度
 * (标签占全文 >30% → HTML 壳)。正常 markdown/正文里零星 <br>/<a> 不会触发 (密度低)。
 */
export function looksLikeRawHtml(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (/<html[\s>]/i.test(t) || /<head[\s>]/i.test(t) || /<body[\s>]/i.test(t)) return true;
  const tags = t.match(/<[a-z!/][^>]*>/gi);
  if (!tags) return false;
  const tagChars = tags.reduce((n, tag) => n + tag.length, 0);
  return tagChars / t.length > 0.3;
}

/**
 * 保守剥离 HTML → 纯正文。title 保留 (置顶为 `# 标题`); script/style/nav/header/footer 等
 * chrome 块连内容丢弃; 块级标签转换行留段落边界; 其余标签剥掉; 实体解码; 空白折叠。
 */
export function stripHtmlToText(html: string): string {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeEntities(titleMatch[1]!).replace(/\s+/g, ' ').trim() : '';

  let s = html;
  // chrome / 脚本 / 样式块: 连内容整块丢弃 (不能只剥标签, 否则 script 里的 JS/JSON 文本会残留成正文)
  s = s.replace(
    /<(script|style|nav|header|footer|noscript|svg|template|iframe|form|aside|head)\b[^>]*>[\s\S]*?<\/\1>/gi,
    ' ',
  );
  s = s.replace(/<!--[\s\S]*?-->/g, ' '); // 注释
  // 块级边界 → 换行 (保留段落结构)
  s = s.replace(/<\/(p|div|section|article|li|ul|ol|h[1-6]|tr|table|blockquote|pre)>/gi, '\n');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<[^>]+>/g, ' '); // 剥剩余所有标签
  s = decodeEntities(s);
  // 空白折叠: 行内多空格→单空格, 每行 trim, 多空行→单空行
  s = s
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return title ? `# ${title}\n\n${s}` : s;
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
  /** 剥离后正文短于此 → 判壳渣, 抛错标失败。默认 200, 对齐 retrieveWeb 的 minChars
   *  (语料层「太短=空」的既有边界; 低于此的整页 HTML 剥完只剩 nav/script 壳, 无正文)。 */
  private readonly minCleanChars: number;
  constructor(
    private readonly base: FetchProvider,
    private readonly cleaner: Cleaner,
    opts: { minCleanChars?: number } = {},
  ) {
    this.name = `${base.name}+${cleaner.name}`;
    this.minCleanChars = opts.minCleanChars ?? 200;
  }
  async fetch(url: string, opts: { raw?: boolean; signal?: AbortSignal } = {}): Promise<FetchResult> {
    const raw = await this.base.fetch(url, { raw: true, signal: opts.signal });
    if (opts.raw) return raw; // 调用方显式要原始 HTML → 不清洗
    const { text } = await this.cleaner.clean(raw.text, { signal: opts.signal });
    // HTML 兜底: cleaner (尤其 passthrough) 漏网的整页 HTML → 确定性剥标签取正文。
    // 正常 markdown/text 不触发 (looksLikeRawHtml 密度判定为假) → 零丢失不破。
    if (looksLikeRawHtml(text)) {
      const stripped = stripHtmlToText(text);
      if (stripped.trim().length < this.minCleanChars) {
        // 剥后只剩壳渣 → fail-loud, 不把 nav/script 残渣喂进语料
        // (与 fetchRacing「全 provider 空/失败」同款语义: 抛错 → 该 url 进 needsBrowserHarness)
        throw new Error(
          `${this.name}: HTML 剥离后正文过短 (${stripped.trim().length}<${this.minCleanChars}), 疑似整页壳无正文`,
        );
      }
      return { ...raw, text: stripped, contentType: 'text/markdown' };
    }
    return { ...raw, text, contentType: 'text/markdown' };
  }
}
