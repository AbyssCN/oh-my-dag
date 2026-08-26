#!/usr/bin/env bun
/**
 * scripts/bench-bridge —— 宿主侧 OpenAI 兼容桥 (E1c, 2026-08-26)。
 *
 * 场景: bench 容器里的 omd 需要 Opus (claude-code 订阅) 与 GPT (openai-codex 订阅) 座位,
 * 而订阅 OAuth 凭证**不进容器** (容器跑模型生成的代码, 凭证一旦入内即暴露给被测任务)。
 * 本桥跑在宿主, 容器经 `http://<宿主网关>:<port>/v1` 调用; 真正的通道路由走引擎既有
 * `callModel` (src/model/index.ts:363) —— 零第二套模型语义。
 *
 * 安全: 启动**必须**给 OMD_BRIDGE_TOKEN (fail-closed, 缺 token 拒启动);
 * 每请求校验 `Authorization: Bearer <token>`。绑定 0.0.0.0 只为容器网段可达,
 * token 即边界。桥只暴露补全面, 不暴露任何引擎控制面。
 *
 * 模型名映射: 容器侧用**裸 id** (bench provider 的 model 名不能再含冒号),
 * 桥按 OMD_BRIDGE_MAP 映射到真 coord, 形如:
 *   OMD_BRIDGE_MAP='claude-opus-5=claude-code:claude-opus-5,MiniMax-M3=minimax-cn:MiniMax-M3,gpt-5.6-sol=openai-codex:gpt-5.6-sol'
 * 未映射的模型名 → 404 (不猜, 不透传任意 coord —— 桥的暴露面 = 映射表的白名单)。
 *
 * stream 兼容: `stream:true` 时以单块 SSE 返回完整内容 + [DONE] (兼容捷径;
 * pi 的 openai 客户端两种都吃, 真流式待实测需要再做)。
 */
import type { ModelMessage, ModelRequest, ModelResponse } from '../src/model/types';

export interface BridgeDeps {
  call: (req: ModelRequest) => Promise<ModelResponse>;
  /** 裸 model id → 真 coord;undefined = 不在白名单。 */
  mapModel: (id: string) => string | undefined;
}

export function parseBridgeMap(spec: string | undefined): Map<string, string> {
  const m = new Map<string, string>();
  for (const pair of (spec ?? '').split(',')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    m.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
  return m;
}

interface OpenAiChatBody {
  model?: string;
  messages?: Array<{ role: string; content: unknown }>;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  stream?: boolean;
}

/**
 * minimax 透传道 (2026-08-26, 批 6 终局根因修): callModel 是**纯文本单发**, 桥的 translate 模式
 * 静默丢 `tools` 字段 → 容器内 agent 环的工具调用面整条蒸发 (MiniMax 只能文本假装调工具,
 * 零真实写入)。工具座必须走**字节级透传**: body 原样 (model 换真 id) 直达 minimax 原生
 * OpenAI-形状端点, `tools`/`tool_calls` 原生往返。文本座 (Opus/GPT, 单发结构化输出) 留 translate。
 */
export interface PassthroughRoute {
  url: string;
  apiKey: string;
  modelId: string;
}

export async function handlePassthrough(
  body: OpenAiChatBody & Record<string, unknown>,
  route: PassthroughRoute,
): Promise<{ status: number; json: unknown }> {
  const upstreamBody = { ...body, model: route.modelId, stream: false };
  let res: Response;
  try {
    res = await fetch(route.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${route.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(upstreamBody),
    });
  } catch (e) {
    return { status: 502, json: { error: { message: `bridge passthrough: ${(e as Error).message}` } } };
  }
  const json = await res.json().catch(() => ({ error: { message: 'passthrough: 上游响应不是 JSON' } }));
  return { status: res.status, json };
}

/** 纯处理器: OpenAI body → callModel → OpenAI 响应体 (或错误 {status,error})。 */
export async function handleChatCompletions(
  body: OpenAiChatBody,
  deps: BridgeDeps,
): Promise<{ status: number; json: unknown }> {
  const id = body.model?.trim();
  if (!id) return { status: 400, json: { error: { message: 'model required' } } };
  const coord = deps.mapModel(id);
  if (!coord) return { status: 404, json: { error: { message: `model '${id}' 不在桥映射白名单 (OMD_BRIDGE_MAP)` } } };
  // ⚠ role 归一 (2026-08-26 终局根因, n=26): pi 的 openai 客户端把 system 以 OpenAI 新式
  // `developer` role 发出; 初版 filter 只认三 role, 把 24K 的 conductor 系统面**整条静默丢弃**,
  // 模型在真空里退回 CC 默认行为 + 用户全局 harness 填充 → 18/18 角色扮演, 而绕开 filter 的
  // 直调 8/8 干净 (serialize 把未知 role 当普通段拼入, 指令仍在)。静默 filter = 自家「fail-open
  // 吞证据」禁条的教科书违例; 现 developer→system 归一, 其余未知 role 保留并打警告。
  const messages = (body.messages ?? [])
    .map((m) => (m.role === 'developer' ? { ...m, role: 'system' } : m))
    .filter((m) => {
      const ok = m.role === 'system' || m.role === 'user' || m.role === 'assistant';
      if (!ok) process.stderr.write(`[bench-bridge] 未知 role '${String(m.role)}' 的消息被弃 (内容前 60: ${JSON.stringify(String(m.content).slice(0, 60))})\n`);
      return ok;
    }) as unknown as ModelMessage[];
  if (messages.length === 0) return { status: 400, json: { error: { message: 'messages required' } } };
  let res: ModelResponse;
  try {
    res = await deps.call({
      messages,
      model: coord,
      ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
      ...(body.top_p !== undefined ? { topP: body.top_p } : {}),
      ...(body.max_tokens ?? body.max_completion_tokens
        ? { maxTokens: (body.max_tokens ?? body.max_completion_tokens)! }
        : {}),
    });
  } catch (e) {
    // 上游通道错误原文透传 (吞异常不许吞证据); 502 让客户端知道是桥后侧挂了。
    return { status: 502, json: { error: { message: `bridge upstream: ${(e as Error).message}` } } };
  }
  return {
    status: 200,
    json: {
      id: `omdbridge-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: id,
      choices: [
        { index: 0, message: { role: 'assistant', content: res.text ?? '' }, finish_reason: 'stop' },
      ],
      usage: {
        prompt_tokens: res.usage?.in ?? 0,
        completion_tokens: res.usage?.out ?? 0,
        total_tokens: (res.usage?.in ?? 0) + (res.usage?.out ?? 0),
      },
    },
  };
}

/** 单块 SSE 包装 (stream 兼容捷径)。tool_calls 原样进 delta —— 丢了 = agent 环工具面蒸发。 */
export function toSingleChunkSse(completion: unknown): string {
  const c = completion as {
    id?: string; model?: string;
    choices?: Array<{ message?: { content?: string | null; tool_calls?: unknown }; finish_reason?: string }>;
  };
  const msg = c.choices?.[0]?.message ?? {};
  const chunk = {
    id: c.id ?? `omdbridge-${Date.now()}`,
    object: 'chat.completion.chunk',
    model: c.model ?? '',
    choices: [{
      index: 0,
      delta: {
        role: 'assistant',
        content: msg.content ?? '',
        ...(msg.tool_calls ? { tool_calls: msg.tool_calls } : {}),
      },
      finish_reason: c.choices?.[0]?.finish_reason ?? 'stop',
    }],
  };
  return `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`;
}

export function checkAuth(header: string | null, token: string): boolean {
  return header === `Bearer ${token}`;
}

if (import.meta.main) {
  const token = process.env.OMD_BRIDGE_TOKEN?.trim();
  if (!token) {
    process.stderr.write('bench-bridge: OMD_BRIDGE_TOKEN 缺失 —— 无鉴权不启动 (fail-closed)\n');
    process.exit(1);
  }
  const map = parseBridgeMap(process.env.OMD_BRIDGE_MAP);
  if (map.size === 0) {
    process.stderr.write('bench-bridge: OMD_BRIDGE_MAP 空 —— 白名单为空的桥没有意义\n');
    process.exit(1);
  }
  const port = Number(process.env.OMD_BRIDGE_PORT ?? 4519);
  // 独立部署雷 (见 src/model/claude-sdk-complete.ts 头注): 脱离会话链的 CLI 会加载用户全局
  // CLAUDE.md 并压过 systemPrompt。桥自备只含凭证的隔离配置目录, 传给全部子调用。
  if (!process.env.CLAUDE_CONFIG_DIR) {
    const { mkdirSync, copyFileSync, existsSync } = await import('node:fs');
    const iso = `${process.env.HOME}/.omd/bridge-claude-home`;
    mkdirSync(iso, { recursive: true });
    const cred = `${process.env.HOME}/.claude/.credentials.json`;
    if (existsSync(cred)) copyFileSync(cred, `${iso}/.credentials.json`);
    process.env.CLAUDE_CONFIG_DIR = iso;
    process.stderr.write(`[bench-bridge] CLAUDE_CONFIG_DIR → ${iso} (隔离, 防用户全局 harness 注入)\n`);
  }
  // 一次性子进程 + 文件传参 + **有界并发 worker 池** (2026-08-26 二改):
  // 初版顶层**串行**队列是「异步上下文退化」疑点下的排除法产物; 该疑点后被终局根因
  // (filter 静默丢 developer role, 所有形状共用同一坏 filter, 形状实验整组被污染) 取代。
  // 串行队列在 8 容器并发下是独木桥: 队列深度 × 单发分钟级延迟 = E2 首批观测的 30 分钟
  // 尾延迟, spec 段超时 7/10 的直接机理。单发形状 (一次性子进程 + 文件传参) 一字不动,
  // 只把「一次一个」改成「至多 N 个同时」; 每发写一行延迟证据 (排队 ms + 执行 ms)。
  type Job = { req: ModelRequest; resolve: (r: ModelResponse) => void; reject: (e: Error) => void; enqueuedAt: number };
  const queue: Job[] = [];
  // 唤醒队列而非单槽: N 个 worker 同时空闲时各挂一个 resolver, 单槽会互相覆写,
  // 被覆写的 worker 永远醒不来 (并发池的经典饿死形态)。入队唤一个, 醒来抢不到活再睡。
  const sleepers: Array<() => void> = [];
  const callViaQueue = (req: ModelRequest): Promise<ModelResponse> =>
    new Promise((resolve, reject) => {
      queue.push({ req, resolve, reject, enqueuedAt: Date.now() });
      sleepers.shift()?.();
    });
  const concurrency = Math.max(1, Number(process.env.OMD_BRIDGE_CONCURRENCY ?? 4) || 4);
  const runWorker = async (workerId: number): Promise<void> => {
    const { writeFileSync, rmSync } = await import('node:fs');
    for (;;) {
      const job = queue.shift();
      if (!job) {
        await new Promise<void>((r) => sleepers.push(r));
        continue;
      }
      const startedAt = Date.now();
      try {
        const tmp = `/tmp/bench-call-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
        writeFileSync(tmp, JSON.stringify({ coord: job.req.model, messages: job.req.messages, maxTokens: job.req.maxTokens, temperature: job.req.temperature, topP: job.req.topP }));
        const proc = Bun.spawn(['bun', new URL('./bench-call.ts', import.meta.url).pathname, tmp], { stdout: 'pipe', stderr: 'inherit' });
        const out = await new Response(proc.stdout).text();
        await proc.exited;
        rmSync(tmp, { force: true });
        const j = JSON.parse(out || '{"ok":false,"error":"empty subprocess output"}') as
          | { ok: true; text: string; usage?: { in: number; out: number } }
          | { ok: false; error: string };
        if (!j.ok) throw new Error(j.error);
        job.resolve({ text: j.text, usage: j.usage } as ModelResponse);
      } catch (e) {
        job.reject(e as Error);
      } finally {
        // 延迟证据行 (E2 首批量不到单发延迟的补尺): 排队多久 + 跑多久 + 当下队列深度。
        process.stderr.write(
          `[bench-bridge] w${workerId} ${job.req.model} queued=${startedAt - job.enqueuedAt}ms exec=${Date.now() - startedAt}ms depth=${queue.length}\n`,
        );
      }
    }
  };
  for (let w = 0; w < concurrency; w++) void runWorker(w);
  const deps: BridgeDeps = { call: callViaQueue, mapModel: (id) => map.get(id) };
  // 透传道凭证 (启动期一次解析, env → auth.json 同引擎链)。缺 = 透传不可用, 响亮打一行,
  // minimax 路由退回 translate (工具面蒸发, 但不静默 —— 这一行就是证据)。
  const { minimaxApiKey } = await import('../src/model/minimax-native');
  const { resolvePiApiKey } = await import('../src/model/pi-transport');
  const passthroughKey = minimaxApiKey() ?? (await resolvePiApiKey('minimax-cn'));
  if (!passthroughKey) {
    process.stderr.write('[bench-bridge] ⚠ minimax 凭证缺失 → 透传道不可用, minimax 路由退回 translate (agent 工具面将蒸发)\n');
  }
  Bun.serve({
    port,
    hostname: '0.0.0.0',
    idleTimeout: 240,
    async fetch(req) {
      const url = new URL(req.url);
      if (!checkAuth(req.headers.get('authorization'), token)) {
        return Response.json({ error: { message: 'unauthorized' } }, { status: 401 });
      }
      if (req.method === 'GET' && url.pathname === '/v1/models') {
        return Response.json({ object: 'list', data: [...map.keys()].map((id) => ({ id, object: 'model' })) });
      }
      if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
        const body = (await req.json().catch(() => ({}))) as OpenAiChatBody & Record<string, unknown>;
        // 工具座路由: minimax 坐标走字节级透传 (tools/tool_calls 原生往返); 其余走 translate。
        const coordForRoute = body.model ? map.get(body.model.trim()) : undefined;
        const r = coordForRoute?.startsWith('minimax-cn:') && passthroughKey
          ? await handlePassthrough(body, {
              url: `${(process.env.MINIMAX_BASE_URL?.replace(/\/$/, '') ?? 'https://api.minimaxi.com/v1')}/text/chatcompletion_v2`,
              apiKey: passthroughKey,
              modelId: coordForRoute.slice('minimax-cn:'.length),
            })
          : await handleChatCompletions(body, deps);
        // 调试观测位 (env 开): 每笔请求/响应原文写入磁盘 —— 桥是唯一能看见"容器侧模型到底
        // 说了什么"的位置 (任务容器随 trial 回收, 容器内 .omd 现场拿不回来)。
        const logDir = process.env.OMD_BRIDGE_LOG_DIR?.trim();
        if (logDir) {
          const { mkdirSync, writeFileSync } = await import('node:fs');
          try {
            mkdirSync(logDir, { recursive: true });
            writeFileSync(`${logDir}/${Date.now()}-${body.model ?? 'x'}.json`, JSON.stringify({ req: body, status: r.status, res: r.json }, null, 1));
          } catch (e) {
            process.stderr.write(`[bench-bridge] 观测写入磁盘失败 (不影响转发): ${(e as Error).message}\n`);
          }
        }
        if (r.status === 200 && body.stream) {
          return new Response(toSingleChunkSse(r.json), {
            headers: { 'content-type': 'text/event-stream' },
          });
        }
        return Response.json(r.json as Record<string, unknown>, { status: r.status });
      }
      return Response.json({ error: { message: 'not found' } }, { status: 404 });
    },
  });
  process.stderr.write(`[bench-bridge] 0.0.0.0:${port} · ${map.size} 模型白名单 · token 已启用\n`);
}
