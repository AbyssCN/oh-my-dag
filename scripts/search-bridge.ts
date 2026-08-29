#!/usr/bin/env bun
/**
 * scripts/search-bridge —— 宿主侧检索桥(2026-08-29)。
 *
 * ## 为什么存在
 *
 * 2026-08-29 code80 批实测:80 个 trial 里 `无 search provider` 出现 **160 行**
 * (每 trial 恒 2 条:`executor:'research'` 节点不挂 + `omd_web` 不挂)。也就是说
 * **omd 的整个调研面在评测容器里一次都没通过电**。要拿研究类 bench 验引擎,这是第一块砖。
 *
 * 不能直接把 key 塞进容器 —— 那正是模型桥当初存在的理由:容器跑的是被测模型生成的代码,
 * 凭证一旦入内即暴露。所以照同一个形状再造一座:**密钥留在宿主,容器只拿一个 token。**
 *
 * ## 为什么长成 SearXNG 的样子
 *
 * `src/harness/web/providers/searxng.ts` 发的是 `GET {base}/search?q=…&format=json`,
 * 收的是 `{results:[{title,url,content}]}` —— **且它不发任何鉴权头**(逐字读过)。
 * 所以桥按这个形状实现,容器侧只需 `SEARXNG_URL=http://<宿主>:<port>/s/<token>`,
 * **引擎一行都不用改**。token 走路径段是被 provider 的形状逼出来的,不是图省事。
 *
 * ## 边界
 *
 * · **只代理检索,不代理抓取。** 实测容器有外网出口(`https://example.com` → 200),
 *   抓取那半靠既有的 Jina/PlainFetch 直连就行 —— 桥只补真正缺的那一格(要钱的 key)。
 * · **不吞失败。** 上游炸了返 502 + 原文,**不返空 results** ——
 *   「搜到 0 条」与「搜挂了」是两件事,压成一个空数组事后就再也分不开(仓规坑 ①)。
 * · **fail-closed**:没有 `OMD_SEARCH_BRIDGE_TOKEN` 不启动。
 * · **不另造一套检索栈**:内部直接用 `createWebStackFromEnv`,与 `omd_web` / `dag_research`
 *   走的是同一个池、同一份配额账本(单源纪律)。
 */
import { createWebStackFromEnv, type WebStack } from '../src/harness/web/index';

/** 池返回的那一份(只取桥用得上的三格,不复制整个类型)。 */
export interface PoolReply {
  results: Array<{ title: string; url: string; snippet: string }>;
  providers: string[];
  /** 路上挂掉的 provider 原文。缺席 = 没人抛。 */
  errors?: string[];
}

export interface SearchBridgeDeps {
  /** 真正去搜的那一下。注入点 = 测试替身。 */
  search: (query: string, maxResults: number) => Promise<PoolReply>;
  token: string;
}

export interface BridgeReply {
  status: number;
  json: unknown;
}

/**
 * 路由 + 鉴权 + 形状转换。纯函数半(不碰网络、不读 env),给测试直接调。
 *
 * 路径约定:`/s/<token>/search`。token 不匹配 → 401,且**不提示哪里错**
 * (说"token 错了"等于告诉扫描器路径对了)。
 */
export async function handleSearch(url: URL, deps: SearchBridgeDeps): Promise<BridgeReply> {
  const m = /^\/s\/([^/]+)\/search$/.exec(url.pathname);
  if (!m) return { status: 404, json: { error: 'not found' } };
  if (m[1] !== deps.token) return { status: 401, json: { error: 'unauthorized' } };
  const q = url.searchParams.get('q')?.trim() ?? '';
  if (!q) return { status: 400, json: { error: 'q required' } };
  const nRaw = Number(url.searchParams.get('maxResults') ?? url.searchParams.get('n') ?? 10);
  const maxResults = Number.isFinite(nRaw) && nRaw > 0 ? Math.min(Math.trunc(nRaw), 50) : 10;
  try {
    const r = await deps.search(q, maxResults);
    // ⚠ 空结果 + 有 provider 抛错 = **搜挂了**, 不是"没搜到"。这一支返 502:
    // 让它以 200 + 空数组回去, 容器侧会把"检索层坏了"读成"这个词没有结果", 而调研节点
    // 会照着"网上查不到"继续往下写 —— 那是本仓最怕的静默失效形状。
    if (r.results.length === 0 && (r.errors?.length ?? 0) > 0) {
      return { status: 502, json: { error: `search upstream: ${r.errors!.join(' | ')}` } };
    }
    // SearXNG 形状: snippet 那一列它叫 content。多带一个 `omd` 字段(SearXNG 客户端忽略未知键)
    // 把"谁服务的 / 谁挂了"带回去 —— 留了证据才看得见 (仓规坑 ②)。
    return {
      status: 200,
      json: {
        query: q,
        results: r.results.map((x) => ({ title: x.title, url: x.url, content: x.snippet })),
        omd: { providers: r.providers, ...(r.errors?.length ? { errors: r.errors } : {}) },
      },
    };
  } catch (e) {
    // ⚠ 不返 `{results:[]}`。空结果与失败必须分得开 —— 前者是"这个词没搜到",
    // 后者是"检索根本没跑成", 而它们对调用方的下一步完全不同。
    return { status: 502, json: { error: `search upstream: ${(e as Error).message}` } };
  }
}

if (import.meta.main) {
  const token = process.env.OMD_SEARCH_BRIDGE_TOKEN?.trim();
  if (!token) {
    process.stderr.write('search-bridge: OMD_SEARCH_BRIDGE_TOKEN 缺失 —— 无鉴权不启动 (fail-closed)\n');
    process.exit(1);
  }
  const stack: WebStack = createWebStackFromEnv(process.env);
  const status = stack.searchPool.status?.() ?? [];
  const usable = Array.isArray(status) ? status.filter((s: { enabled?: boolean }) => s.enabled !== false).length : 0;
  if (usable === 0) {
    // 宿主自己都没 provider 时启动 = 造一座通向空气的桥, 容器会拿到一串 502 却以为是自己的问题。
    process.stderr.write('search-bridge: 宿主没有任何可用 search provider (设 TAVILY_API_KEY / ANYSEARCH_API_KEY / SEARXNG_URL) —— 不启动\n');
    process.exit(1);
  }
  const port = Number(process.env.OMD_SEARCH_BRIDGE_PORT ?? 4520);
  const deps: SearchBridgeDeps = {
    token,
    search: async (q, n) => {
      const r = await stack.searchPool.search(q, n);
      return { results: r.results, providers: r.providers, ...(r.errors?.length ? { errors: r.errors } : {}) };
    },
  };
  Bun.serve({
    port,
    hostname: '0.0.0.0', // 容器网段可达; token 即边界 (同模型桥)
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/healthz') return Response.json({ ok: true, providers: usable });
      const r = await handleSearch(url, deps);
      return Response.json(r.json, { status: r.status });
    },
  });
  process.stderr.write(`[search-bridge] 0.0.0.0:${port} · ${usable} 个 provider · token 已启用\n`);
  process.stderr.write(`[search-bridge] 容器侧设: SEARXNG_URL=http://<宿主网关>:${port}/s/<token>\n`);
}
