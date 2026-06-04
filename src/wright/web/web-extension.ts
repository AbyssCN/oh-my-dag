/**
 * src/wright/web/web-extension —— 把 web 栈接进 TUI (commit 079137e 的库 → 可调工具)。
 *
 * web_search(query, mode?) → WebSearchPool (failover/rotate 摊额度/aggregate 聚合)。
 * web_fetch(url, clean?)   → fetchProviders 顺序兜底 (firecrawl→jina); clean=true 走 trafilatura 提纯裸 HTML。
 * `/web` 命令 → 看/调 provider (mode/default/toggle)。
 * 注: 大输出由 MCP 轴 B 的 tool_result hook 自动转沙箱 (web_fetch 抓到大页面 → 只指针进 context)。
 */
import { Type, type Static } from 'typebox';
import {
  defineTool,
  type ExtensionContext,
  type ExtensionFactory,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { CleaningFetchProvider } from './clean';
import type { FetchProvider, FetchResult } from './types';
import type { PoolMode, WebSearchPool } from './pool';
import type { Cleaner } from './clean';
import { logger } from '../../logger';

/** = WebStack (在 index.ts 定义); 这里独立声明避免 index↔ 本文件循环。 */
interface WebStackLike {
  searchPool: WebSearchPool;
  fetchProviders: FetchProvider[];
  cleaner: Cleaner;
}

const SEARCH = Type.Object({
  query: Type.String({ description: '搜索词。' }),
  k: Type.Optional(Type.Number({ description: '结果数, 默认 5。' })),
  mode: Type.Optional(
    Type.Union([Type.Literal('failover'), Type.Literal('rotate'), Type.Literal('aggregate')], {
      description: 'failover(默认挂了换下一个) / rotate(多 key 摊额度) / aggregate(全发去重合并)。省略用池默认。',
    }),
  ),
});
const FETCH = Type.Object({
  url: Type.String({ description: '要抓的 URL。' }),
  clean: Type.Optional(Type.Boolean({ description: 'true = 裸抓 HTML 再走 trafilatura 提纯正文 (默认 false: 用 provider 自带 markdown)。' })),
});
type SearchParams = Static<typeof SEARCH>;
type FetchParams = Static<typeof FETCH>;

function textResult(text: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: 'text' as const, text }], details };
}

/** fetch provider 顺序兜底: 首个成功即返; 全失败抛聚合错误。 */
export async function fetchWithFallback(
  providers: FetchProvider[],
  url: string,
  opts: { raw?: boolean; signal?: AbortSignal } = {},
): Promise<{ result: FetchResult; provider: string }> {
  const errors: string[] = [];
  for (const p of providers) {
    try {
      return { result: await p.fetch(url, opts), provider: p.name };
    } catch (e) {
      errors.push(`${p.name}: ${(e as Error).message}`);
    }
  }
  throw new Error(`all fetch providers failed: ${errors.join(' | ')}`);
}

export function createWebExtension(opts: { stack: WebStackLike }): ExtensionFactory {
  const { searchPool, fetchProviders, cleaner } = opts.stack;

  return (pi) => {
    pi.registerTool(
      defineTool({
        name: 'web_search',
        label: 'Web search',
        description: '搜网页 (多 provider: 轮换额度/聚合)。返回 title+url+snippet。',
        promptSnippet: 'web_search(query, mode?) — 搜网页。',
        parameters: SEARCH,
        executionMode: 'parallel',
        async execute(_id: string, p: SearchParams, _signal, _onUpdate, ctx: ExtensionContext) {
          try {
            const r = await searchPool.search(p.query, p.k ?? 5, { mode: p.mode as PoolMode | undefined });
            if (r.results.length === 0) return textResult('无结果。', { hits: 0 });
            const lines = r.results.map((x) => `- ${x.title}\n  ${x.url}\n  ${x.snippet}`).join('\n');
            return textResult(lines, { hits: r.results.length, providers: r.providers, mode: r.mode });
          } catch (e) {
            ctx?.ui?.notify?.(`web_search 失败: ${(e as Error).message}`, 'error');
            return textResult(`error: ${(e as Error).message}`, { ok: false });
          }
        },
      }) as unknown as ToolDefinition,
    );

    pi.registerTool(
      defineTool({
        name: 'web_fetch',
        label: 'Web fetch',
        description: '抓一个 URL 的正文 (markdown)。多 provider 兜底; clean=true 走 trafilatura 提纯。',
        promptSnippet: 'web_fetch(url, clean?) — 抓网页正文。',
        parameters: FETCH,
        executionMode: 'sequential',
        async execute(_id: string, p: FetchParams, signal?: AbortSignal) {
          const provs = p.clean
            ? fetchProviders.map((fp) => new CleaningFetchProvider(fp, cleaner))
            : fetchProviders;
          try {
            const { result, provider } = await fetchWithFallback(provs, p.url, { signal });
            const head = result.title ? `# ${result.title}\n\n` : '';
            return textResult(`${head}${result.text}`, { provider, url: result.url });
          } catch (e) {
            return textResult(`error: ${(e as Error).message}`, { ok: false });
          }
        },
      }) as unknown as ToolDefinition,
    );

    pi.registerCommand('web', {
      description: 'web 搜索管理: /web list · mode <failover|rotate|aggregate> · default <name> · toggle <name>',
      handler: async (args: string, ctx) => {
        const [sub, val] = args.trim().split(/\s+/);
        try {
          if (sub === 'list') {
            const s = searchPool.status();
            ctx.ui.notify(
              `search providers:\n${s.map((x) => `  ${x.name} [${x.enabled ? 'on' : 'off'}] used=${x.used}${x.limit ? '/' + x.limit : ''}`).join('\n')}\nfetch: ${fetchProviders.map((f) => f.name).join(', ')}`,
              'info',
            );
          } else if (sub === 'mode') {
            searchPool.setMode(val as PoolMode);
            ctx.ui.notify(`search mode → ${val}`, 'info');
          } else if (sub === 'default') {
            searchPool.setDefault(val!);
            ctx.ui.notify(`默认 provider → ${val}`, 'info');
          } else if (sub === 'toggle') {
            const cur = searchPool.status().find((x) => x.name === val);
            searchPool.toggle(val!, !(cur?.enabled ?? true));
            ctx.ui.notify(`${val} → ${cur?.enabled ? 'off' : 'on'}`, 'info');
          } else {
            ctx.ui.notify('子命令: list | mode | default | toggle', 'warning');
          }
        } catch (e) {
          ctx.ui.notify(`/web ${sub} 失败: ${(e as Error).message}`, 'error');
          logger.warn({ sub, err: (e as Error).message }, '[wright/web] command failed');
        }
      },
    });
  };
}
