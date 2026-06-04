/**
 * plan/web-retriever —— **可插拔 Web 检索接缝** (the owner 指令: 后续换专用爬取+元检索工具替默认)。
 *
 * D 子系统 (知识摄取) 的网络获取走此接口。P1 即留接口 + 默认实现 (crawl/crawl4ai → markdown);
 * 将来换成专用「带爬取和元检索的网络检索工具」(crawl4ai + SearXNG 合成) 时只换 createXxxRetriever,
 * 上层 (/ref / 自动 URL 摄取) 不动。占位默认 = crawl bin; 不直接用 curl/WebSearch (the owner 锁)。
 */

/** 一次抓取结果。 */
export interface FetchedRef {
  url: string;
  title?: string;
  /** 抓到的 markdown 正文 (失败为空)。 */
  markdown: string;
  ok: boolean;
  error?: string;
}

/** Web 检索器接口 —— 上层只依赖这个, 实现可换。 */
export interface WebRetriever {
  fetch(url: string): Promise<FetchedRef>;
}

/** exec 抽象 (pi.exec 或测试桩)。 */
export type ExecFn = (
  cmd: string,
  args: string[],
  opts?: { timeout?: number; cwd?: string },
) => Promise<{ stdout: string; stderr: string; code: number }>;

export interface DefaultRetrieverOpts {
  /** 单次抓取超时 ms。默认 30000。 */
  timeoutMs?: number;
  /** markdown 截断上限 (防 ledger / context 膨胀)。默认 12000 字。 */
  maxChars?: number;
}

/** 从 markdown 抽标题 (首个 # heading, 否则 url)。 */
function extractTitle(md: string, url: string): string {
  const h = md.match(/^#\s+(.+)$/m);
  return h?.[1]?.trim() ?? url;
}

/**
 * 默认 WebRetriever: `crawl <url>` (crawl4ai → markdown) 经注入的 exec。
 * **占位实现** —— 后续 the owner 的专用爬取+元检索工具替换此函数即可, 接口不变。
 */
export function createDefaultWebRetriever(exec: ExecFn, opts: DefaultRetrieverOpts = {}): WebRetriever {
  const timeout = opts.timeoutMs ?? 30_000;
  const maxChars = opts.maxChars ?? 12_000;
  return {
    async fetch(url: string): Promise<FetchedRef> {
      try {
        const r = await exec('crawl', [url], { timeout });
        if (r.code !== 0) {
          return { url, markdown: '', ok: false, error: (r.stderr || `exit ${r.code}`).slice(0, 200) };
        }
        let md = r.stdout.trim();
        if (!md) return { url, markdown: '', ok: false, error: '空响应' };
        const title = extractTitle(md, url);
        if (md.length > maxChars) md = `${md.slice(0, maxChars)}\n…(截断, 原 ${md.length} 字)`;
        return { url, title, markdown: md, ok: true };
      } catch (e) {
        return { url, markdown: '', ok: false, error: (e as Error).message };
      }
    },
  };
}
