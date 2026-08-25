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

/** 纯处理器: OpenAI body → callModel → OpenAI 响应体 (或错误 {status,error})。 */
export async function handleChatCompletions(
  body: OpenAiChatBody,
  deps: BridgeDeps,
): Promise<{ status: number; json: unknown }> {
  const id = body.model?.trim();
  if (!id) return { status: 400, json: { error: { message: 'model required' } } };
  const coord = deps.mapModel(id);
  if (!coord) return { status: 404, json: { error: { message: `model '${id}' 不在桥映射白名单 (OMD_BRIDGE_MAP)` } } };
  const messages = (body.messages ?? []).filter(
    (m): m is { role: 'system' | 'user' | 'assistant'; content: unknown } =>
      m.role === 'system' || m.role === 'user' || m.role === 'assistant',
  ) as unknown as ModelMessage[];
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

/** 单块 SSE 包装 (stream 兼容捷径)。 */
export function toSingleChunkSse(completion: unknown): string {
  const c = completion as { id: string; model: string; choices: Array<{ message: { content: string } }> };
  const chunk = {
    id: c.id,
    object: 'chat.completion.chunk',
    model: c.model,
    choices: [{ index: 0, delta: { role: 'assistant', content: c.choices[0]?.message.content ?? '' }, finish_reason: 'stop' }],
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
  // 一次性子进程调用 (见 scripts/bench-call.ts 头注): 长驻进程内直调 claude-code 通道对大
  // prompt 9/9 退化为角色扮演, 一次性进程 5/5 干净 —— 机理待查, 先按被证明干净的形状隔离。
  const callViaSubprocess = async (req: ModelRequest): Promise<ModelResponse> => {
    const proc = Bun.spawn(['bun', new URL('./bench-call.ts', import.meta.url).pathname], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'inherit',
    });
    proc.stdin.write(JSON.stringify({ coord: req.model, messages: req.messages, maxTokens: req.maxTokens, temperature: req.temperature, topP: req.topP }));
    proc.stdin.end();
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    const j = JSON.parse(out || '{"ok":false,"error":"empty subprocess output"}') as
      | { ok: true; text: string; usage?: { in: number; out: number } }
      | { ok: false; error: string };
    if (!j.ok) throw new Error(j.error);
    return { text: j.text, usage: j.usage } as ModelResponse;
  };
  const deps: BridgeDeps = { call: callViaSubprocess, mapModel: (id) => map.get(id) };
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
        const body = (await req.json().catch(() => ({}))) as OpenAiChatBody;
        const r = await handleChatCompletions(body, deps);
        // 调试观测位 (env 开): 每笔请求/响应原文落盘 —— 桥是唯一能看见"容器侧模型到底
        // 说了什么"的位置 (任务容器随 trial 回收, 容器内 .omd 现场拿不回来)。
        const logDir = process.env.OMD_BRIDGE_LOG_DIR?.trim();
        if (logDir) {
          const { mkdirSync, writeFileSync } = await import('node:fs');
          try {
            mkdirSync(logDir, { recursive: true });
            writeFileSync(`${logDir}/${Date.now()}-${body.model ?? 'x'}.json`, JSON.stringify({ req: body, status: r.status, res: r.json }, null, 1));
          } catch (e) {
            process.stderr.write(`[bench-bridge] 观测落盘失败 (不影响转发): ${(e as Error).message}\n`);
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
