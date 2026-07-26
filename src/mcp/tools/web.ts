/**
 * src/mcp/tools/web —— **web 能力递到图外** (2026-07-26 owner 定位: 任何 SOTA agent 自由组合)。
 *
 * omd 早就有整套 web 层 (retrieve / pool / fetch-racing / quota / source-tier / clean + provider),
 * 但只在 TUI 里挂 —— 外部 agent 够不着。这两个工具把它交出去:
 *
 *   omd_web      搜 + 抓, **零 LLM**。全文落盘, stdout 只回索引 + 已抓 URL 集。
 *   omd_distill  吃**已有原文**多 lens 蒸馏 (expert 忠实 / challenger 挖长尾), 不抓网。
 *
 * 分工承 xihe 三段链 (fusang/scripts/xihe-{web,research,distill}.ts —— 在 Aalto 派活里跑了很久):
 *   web      去网上**抓**原文        零 LLM
 *   research 抓 + fanout 综合判优     出答案
 *   distill  **已有原文** → 蒸洞察    不抓网, 吃你给的料
 * 三段独立可调, 不是一条焊死的管线 —— 这正是"组合模式"在 research 这条线上的具体形态。
 *
 * **原文零丢失 + context 零污染** (同 xihe 红线): 全文永远落盘, stdout 只回索引/蒸馏结果。
 * 调用方按需 Read 那个文件, 而不是把几万字灌进对话。
 *
 * `omd_web` 的返回**带 fetchedUrls** —— 它是 research 第二轮那个确定性探测器的原料:
 * 「被引用过但从没抓取过的 URL」= 引用集 − 这个集合。
 */
import { z } from 'zod';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OmdMcpTool } from '../server';

export interface WebToolDeps {
  /** 注入式检索 (默认真 retrieveWeb + createWebStackFromEnv)。 */
  retrieve: (query: string, opts: Record<string, unknown>) => Promise<{
    queries: string[];
    searchProviders: string[];
    sources: { url: string; title: string; body?: string; tier: string; provider?: string; error?: string }[];
    fullCorpus: string;
    needsBrowserHarness: string[];
  }>;
  /** 注入式蒸馏 (lens → 蒸馏器)。 */
  distill: (
    lens: 'expert' | 'challenger',
    input: { question: string; title: string; url: string; body: string },
  ) => Promise<{ relevance: string; extract: string }>;
  cwd: string;
}

/** 落盘路径: .omd/web/<slug>-<n>.md (与 render 产物同纹理 — 无空格, 便于被路径正则拾取)。 */
function corpusPath(cwd: string, query: string, stamp: string): string {
  const slug = query.replace(/[^A-Za-z0-9一-龥]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'web';
  const dir = join(cwd, '.omd', 'web');
  mkdirSync(dir, { recursive: true });
  return join(dir, `${slug}-${stamp}.md`);
}

export function createWebTools(deps: WebToolDeps): OmdMcpTool[] {
  return [
    {
      name: 'omd_web',
      // D-11: ≤120 字符。
      description: '搜+抓网页, 零 LLM。全文落盘, 只回索引 + 已抓 URL 集。要综合答案用 dag_research。',
      inputSchema: {
        query: z.string().min(1).describe('检索词'),
        k: z.number().int().min(1).max(30).optional().describe('检索取 N 条 (默认 8)'),
        crawl: z.number().int().min(0).max(20).optional().describe('抓前 N 条正文; 0 = 只搜不抓 (默认按信源档位自适应)'),
        mode: z.enum(['rotate', 'aggregate', 'failover']).optional().describe('provider 池模式; aggregate = 全并行去重, 最全最费'),
      },
      handler: (async (args: Record<string, unknown>) => {
        const query = String(args.query ?? '').trim();
        if (!query) return { isError: true, content: [{ type: 'text', text: 'query 不能为空' }] };
        try {
          const r = await deps.retrieve(query, {
            ...(typeof args.k === 'number' ? { k: args.k } : {}),
            ...(typeof args.crawl === 'number' ? { crawl: args.crawl } : {}),
            ...(typeof args.mode === 'string' ? { mode: args.mode } : {}),
          });
          // 已抓 = 真有正文的那些 (不是"搜到了"; 搜到没抓到的进 notFetched)。
          const fetched = r.sources.filter((s) => (s.body ?? '').length > 0);
          const path = corpusPath(deps.cwd, query, String(r.sources.length));
          writeFileSync(path, r.fullCorpus, 'utf8');
          const index = r.sources
            .map((s) => `  [${s.tier}] ${s.body ? '✓' : '·'} ${s.title || '(无标题)'} — ${s.url}${s.error ? ` (${s.error})` : ''}`)
            .join('\n');
          return {
            content: [
              {
                type: 'text',
                text:
                  `queries: ${r.queries.join(' | ')}\n` +
                  `providers: ${r.searchProviders.join(', ') || '(无)'}\n` +
                  `命中 ${r.sources.length} 条, 抓到正文 ${fetched.length} 条\n${index}\n\n` +
                  `全文语料 (零丢失, 按需 Read): ${path}\n` +
                  `fetchedUrls: ${JSON.stringify(fetched.map((s) => s.url))}\n` +
                  (r.needsBrowserHarness.length
                    ? `needsBrowserHarness (全 provider 抓不动, 要登录态/浏览器接管): ${r.needsBrowserHarness.join(', ')}\n`
                    : ''),
              },
            ],
          };
        } catch (e) {
          return { isError: true, content: [{ type: 'text', text: `检索失败: ${(e as Error).message}` }] };
        }
      }) as OmdMcpTool['handler'],
    },
    {
      name: 'omd_distill',
      description: '吃已有原文蒸馏洞察, 不抓网。expert=忠实抽机制, challenger=高温挖长尾 (未言明前提/冲突/迁移)。',
      inputSchema: {
        text: z.string().min(1).describe('原文 (从 omd_web 落盘的语料里读一段贴进来)'),
        question: z.string().optional().describe('关注点 —— 决定蒸馏往哪个方向收敛'),
        lens: z.enum(['expert', 'challenger', 'both']).optional().describe('镜头; 默认 both (对偶才有增益)'),
        url: z.string().optional().describe('溯源 URL (进 prompt, 让蒸馏保留可引用锚)'),
        title: z.string().optional(),
      },
      handler: (async (args: Record<string, unknown>) => {
        const body = String(args.text ?? '');
        if (!body.trim()) return { isError: true, content: [{ type: 'text', text: 'text 不能为空' }] };
        const input = {
          question: String(args.question ?? ''),
          title: String(args.title ?? '(未给)'),
          url: String(args.url ?? '(未给)'),
          body,
        };
        const lens = (args.lens as string) ?? 'both';
        const want: ('expert' | 'challenger')[] =
          lens === 'both' ? ['expert', 'challenger'] : [lens as 'expert' | 'challenger'];
        const out: string[] = [];
        for (const l of want) {
          try {
            const r = await deps.distill(l, input);
            out.push(`===== ${l} =====\n${r.relevance}\n\n${r.extract}`);
          } catch (e) {
            // 蒸馏是增益不是链路: 一个 lens 挂了照样回另一个, 但**留痕**不静默吞。
            out.push(`===== ${l} (失败) =====\n${(e as Error).message}`);
          }
        }
        return { content: [{ type: 'text', text: out.join('\n\n') }] };
      }) as OmdMcpTool['handler'],
    },
  ];
}
