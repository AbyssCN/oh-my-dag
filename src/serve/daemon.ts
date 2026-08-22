/**
 * src/serve/daemon —— `omd serve` 的 HTTP 面(Bun.serve,127.0.0.1 单用户)。
 *
 * 三个面,三种耦合方式,刻意不同:
 *   · **读侧** = read-api 纯磁盘契约(零进程内状态 → 谁起的 run 都看得见,daemon 重启无损)。
 *   · **命令侧** = POST /api/tools/:name → 装配层 MCP 工具桥(与 Claude Code 的 MCP 面
 *     同一批 handler —— 一个控制面,两个传输;这里不复制任何业务逻辑)。
 *   · **chat 侧** = runChatTurn(conductor 蒸馏 prompt + 持久会话)经 SSE 流式外露;
 *     工具面 = chat-tools(同一批 handler 的白名单薄包装)。
 *
 * createDaemonFetch 与端口绑定分离 —— fetch handler 可测(不占端口),startDaemon 才 Bun.serve。
 * 安全边界:默认只绑 127.0.0.1(这是 owner 自己的控制台,不是多租户服务);id/slug 全部过
 * read-api 的白名单闸;命令面 POST-only。
 */
import type { AgentEvent } from '@earendil-works/pi-agent-core';
import { logger } from '../logger';
import { boardHtml } from './board-page';
import type { OmdMcpTool } from '../mcp/server';
import type { PlanLedger } from '../harness/plan/plan-ledger';
import type { AnyOmdTool } from '../harness/agent-tools';
import type { OmdSessionStore } from '../harness/chat/session-store';
import { runChatTurn, type ChatTurnOpts } from '../harness/chat/agent';
import {
  listPathMaps,
  listRuns,
  readHudState,
  readReadout,
  readAttention,
  readSeats,
  readSkills,
  readMcpServers,
  readPlaybooks,
  readRunBoard,
  readProfiles,
  readNodeOutput,
  readPathMap,
  readRun,
} from './read-api';

export interface DaemonDeps {
  cwd: string;
  /** assembleOmdMcpTools() 产物 — 命令面 + chat 工具面共用。 */
  tools: readonly OmdMcpTool[];
  chatStore: OmdSessionStore;
  ledger: PlanLedger;
  /** conductor 座位坐标 — **每请求现解**(INV-MODEL-3: omd_set_role 改完下一句话就生效)。 */
  resolveChatModel: () => string;
  chatTools: AnyOmdTool[];
  /** 前端构建产物目录(缺席 → 内置占位页)。 */
  staticDir?: string;
  /** 测试接缝: 透传 runChatTurn 的 loopFn。 */
  chatLoopFn?: ChatTurnOpts['loopFn'];
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}
function notFound(what: string): Response {
  return json({ error: `not found: ${what}` }, 404);
}
function badRequest(msg: string): Response {
  return json({ error: msg }, 400);
}

/** SSE 帧编码(event + JSON data)。 */
function sseFrame(event: string, data: unknown): Uint8Array {
  return new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export function createDaemonFetch(deps: DaemonDeps): (req: Request) => Promise<Response> {
  const { cwd } = deps;

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const parts = url.pathname.split('/').filter(Boolean); // ['api','runs',...]
    try {
      if (parts[0] === 'api') return await api(req, url, parts.slice(1));
      // /board 必须在 staticPage 之前: 那条路径会被 SPA history 回落吃掉 (返 index.html)。
      // 只认 GET —— 这一页是只读投影, 别的方法一律落到 404 而不是被静默当成页面请求。
      if (url.pathname === '/board') {
        // 非 GET 显式 404, 而**不是**落到 staticPage 的兜底页 —— 那条路径对任何方法都返 200,
        // 于是一次误发的写请求会拿到一个成功状态码, 读上去像"写进去了"。
        if (req.method !== 'GET') return notFound(url.pathname);
        return new Response(boardHtml(), { headers: { 'content-type': 'text/html; charset=utf-8' } });
      }
      return staticPage(deps, url.pathname);
    } catch (err) {
      // 边界闸 (非法 id/slug) 抛的是 Error → 400; 其余 500 带真因 (localhost 单用户, 不藏栈)。
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.startsWith('非法') || msg.includes('非法')) return badRequest(msg);
      logger.warn({ err: msg, path: url.pathname }, '[serve] 请求处理失败');
      return json({ error: msg }, 500);
    }
  };

  async function api(req: Request, url: URL, p: string[]): Promise<Response> {
    // ── 健康 ──
    if (p[0] === 'health') return json({ ok: true, cwd, now: new Date().toISOString() });

    // ── 读侧: runs ──
    if (p[0] === 'runs' && req.method === 'GET') {
      if (p.length === 1) return json(listRuns(cwd));
      const runId = p[1]!;
      if (p.length === 2) {
        const run = readRun(cwd, runId);
        return run ? json(run) : notFound(`run ${runId}`);
      }
      if (p.length === 4 && p[2] === 'nodes') {
        const kind = url.searchParams.get('kind') === 'fanin' ? 'fanin' : 'out';
        const text = readNodeOutput(cwd, runId, p[3]!, kind);
        return text === null
          ? notFound(`${kind}-${p[3]}`)
          : new Response(text, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
      }
    }

    // ── 读侧: hud / 地图 ──
    if (p[0] === 'hud' && req.method === 'GET') return json(readHudState(cwd));
    // 读数板 + 跨图注意力: 首页那五问的数据源。
    if (p[0] === 'readout' && req.method === 'GET') return json(readReadout(cwd));
    if (p[0] === 'attention' && req.method === 'GET') return json(readAttention(cwd));
    if (p[0] === 'seats' && req.method === 'GET') return json(readSeats(cwd));
    // Skills / MCP / 并发协调 / Profiles: 只读清单端点 (S10, D-20)。
    if (p[0] === 'skills' && req.method === 'GET') return json(readSkills(cwd));
    if (p[0] === 'mcp' && req.method === 'GET') return json(readMcpServers(cwd));
    if (p[0] === 'playbooks' && req.method === 'GET') return json(readPlaybooks(cwd));
    if (p[0] === 'run-board' && req.method === 'GET') return json(readRunBoard(cwd));
    if (p[0] === 'profiles' && req.method === 'GET') return json(readProfiles(cwd));
    if (p[0] === 'maps' && req.method === 'GET') {
      if (p.length === 1) return json(listPathMaps(cwd));
      const map = readPathMap(cwd, p[1]!);
      return map ? json(map) : notFound(`map ${p[1]}`);
    }

    // ── 读侧: plan 图库 ──
    if (p[0] === 'plans') {
      if (req.method === 'GET' && p.length === 1) return json(deps.ledger.families());
      if (req.method === 'GET' && p.length === 2) return json(deps.ledger.plans(p[1]!));
      if (p[1] === 'version' && p.length >= 3) {
        const planJson = deps.ledger.planJson(p[2]!);
        if (planJson === null) return notFound(`plan ${p[2]}`);
        if (req.method === 'GET') return new Response(planJson, { headers: JSON_HEADERS });
        // POST /api/plans/version/:planId/rerun — 复跑走装配层 dag_run_plan (同一控制面)。
        if (req.method === 'POST' && p[3] === 'rerun') {
          const body = (await req.json().catch(() => ({}))) as { task?: string; leafModel?: string };
          return bridge('dag_run_plan', {
            plan: planJson,
            ...(body.task ? { task: body.task } : {}),
            ...(body.leafModel ? { leafModel: body.leafModel } : {}),
          });
        }
      }
    }

    // ── 命令面: 装配层工具桥 (POST-only) ──
    if (p[0] === 'tools') {
      if (req.method === 'GET' && p.length === 1) {
        return json(deps.tools.map((t) => ({ name: t.name, description: t.description })));
      }
      if (req.method === 'POST' && p.length === 2) {
        const args = ((await req.json().catch(() => null)) ?? {}) as Record<string, unknown>;
        return bridge(p[1]!, args);
      }
    }

    // ── chat ──
    if (p[0] === 'chat') {
      if (req.method === 'GET' && p.length === 1) return json(await deps.chatStore.list());
      if (req.method === 'GET' && p.length === 2) {
        const s = await deps.chatStore.open(p[1]!);
        if (!s) return notFound(`chat ${p[1]}`);
        // 详情 = 列表里的那条元信息 + 投影出来的消息。**不再回整个存储单元** ——
        // 新层的持久单元是条目树, 把它原样倒给前端等于让 UI 依赖一个它读不懂的形状。
        const meta = (await deps.chatStore.list()).find((m) => m.id === s.id);
        return json({ ...(meta ?? { id: s.id, title: '' }), messages: await s.messages() });
      }
      if (req.method === 'DELETE' && p.length === 2) {
        await deps.chatStore.delete(p[1]!);
        return json({ ok: true });
      }
      if (req.method === 'POST' && p.length === 3 && p[2] === 'messages') {
        const body = (await req.json().catch(() => null)) as { message?: string } | null;
        if (!body?.message?.trim()) return badRequest('body.message required');
        return chatSse(p[1]!, body.message);
      }
    }

    return notFound(url.pathname);
  }

  /** 命令桥: MCP 工具直调, MCP 形状 {content,isError} 原样回 (HTTP 200; isError 是业务信号非传输错)。 */
  async function bridge(name: string, args: Record<string, unknown>): Promise<Response> {
    const tool = deps.tools.find((t) => t.name === name);
    if (!tool) return notFound(`tool ${name}`);
    try {
      const res = await (tool.handler as (a: unknown, extra: unknown) => unknown)(args, {});
      return json(res);
    } catch (err) {
      // zod/McpError 参数错 → 400 带真因
      return badRequest(err instanceof Error ? err.message : String(err));
    }
  }

  /** chat 轮 → SSE: delta(正文流) / tool(工具起止) / result(终帧) / error。 */
  function chatSse(sessionId: string, message: string): Response {
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (event: string, data: unknown) => {
          try {
            controller.enqueue(sseFrame(event, data));
          } catch {
            /* 客户端断开 → enqueue 抛; 轮子继续跑完落盘, 这里静默 (对话不因刷新丢) */
          }
        };
        const onEvent = (e: AgentEvent): void => {
          if (e.type === 'message_update' && e.assistantMessageEvent.type === 'text_delta') {
            send('delta', { text: e.assistantMessageEvent.delta });
          } else if (e.type === 'tool_execution_start') {
            send('tool', { phase: 'start', name: (e as { toolName?: string }).toolName ?? '?' });
          } else if (e.type === 'tool_execution_end') {
            send('tool', {
              phase: 'end',
              name: (e as { toolName?: string }).toolName ?? '?',
              ok: !(e as { isError?: boolean }).isError,
            });
          }
        };
        try {
          const r = await runChatTurn({
            store: deps.chatStore,
            sessionId,
            prompt: message,
            model: deps.resolveChatModel(),
            cwd,
            tools: deps.chatTools,
            onEvent,
            ...(deps.chatLoopFn ? { loopFn: deps.chatLoopFn } : {}),
          });
          send('result', { sessionId, reply: r.reply, messageCount: r.messageCount });
        } catch (err) {
          send('error', { message: err instanceof Error ? err.message : String(err) });
        } finally {
          try {
            controller.close();
          } catch {
            /* 已随客户端断开而关 */
          }
        }
      },
    });
    return new Response(stream, {
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      },
    });
  }
}

/** 静态托管: staticDir 有货则给, SPA 回落 index.html; 没建前端时给占位页 (读 API 仍全量可用)。 */
function staticPage(deps: DaemonDeps, pathname: string): Response {
  if (deps.staticDir) {
    const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
    // 路径穿越闸: 归一化后必须仍在 staticDir 下
    if (!rel.includes('..')) {
      const file = Bun.file(`${deps.staticDir}/${rel}`);
      if (file.size > 0) return new Response(file);
      const index = Bun.file(`${deps.staticDir}/index.html`);
      if (index.size > 0) return new Response(index); // SPA history-route 回落
    }
  }
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>omd serve</title>
<body style="font-family:system-ui;max-width:640px;margin:4rem auto;line-height:1.6">
<h1>omd serve</h1>
<p>引擎 API 已就绪(<code>/api/health</code> · <code>/api/runs</code> · <code>/api/maps</code> ·
<code>/api/plans</code> · <code>/api/chat</code>)。</p>
<p>web 前端尚未构建:在 <code>web/</code> 下 <code>bun install && bun run build</code> 后重启。</p>`,
    { headers: { 'content-type': 'text/html; charset=utf-8' } },
  );
}

/** 端口绑定入口 (cli 用)。返回 Bun server 句柄 (测试可 stop)。 */
export function startDaemon(deps: DaemonDeps, opts: { port?: number; hostname?: string } = {}): ReturnType<typeof Bun.serve> {
  const fetchFn = createDaemonFetch(deps);
  const server = Bun.serve({
    port: opts.port ?? 4517,
    hostname: opts.hostname ?? '127.0.0.1',
    fetch: fetchFn,
    idleTimeout: 0, // SSE 长连接不许被闲置计时器掐掉
  });
  logger.warn(`[omd serve] http://${server.hostname}:${server.port} (cwd=${deps.cwd})`);
  return server;
}
