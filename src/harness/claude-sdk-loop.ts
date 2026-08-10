/**
 * src/harness/claude-sdk-loop —— Claude 订阅通道的共享 SDK 循环核(chat 与 agent-leaf 共用)。
 *
 * 独立成文件是为了断环:chat 模块 import agent-leaf 的工具函数,agent-leaf 又要用本循环核 ——
 * 核若长在 chat 里就是 leaf ↔ chat 互引。本文件只依赖类型面与 model 层,零环。
 * 通道总注(差异/纪律/决策指针)见 src/harness/chat/claude-sdk-turn.ts 文件头。
 */
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { AgentEvent, AgentMessage } from '@earendil-works/pi-agent-core';
import { randomUUID } from 'node:crypto';
import type { AnyOmdTool } from './agent-tools';
import { logger } from '../logger';
import { emitModelUsage } from '../model/accounting';
import { CLAUDE_SDK_PROVIDER } from '../model/claude-sdk-complete';
import type { ModelUsage } from '../model/types';

/**
 * claude-code 座位的 advisor 坐标 → 官方路的裸 model id。
 * 一期纪律(NOTES):claude-code 座只走官方 advisor,advisor 坐标必须同为 claude-code:*;
 * 异族坐标 → warn + 不挂(不静默:配了没生效必须留痕)。
 */
export function officialAdvisorModelId(advisorCoord: string | undefined, seatCoord: string): string | undefined {
  if (!advisorCoord) return undefined;
  const prefix = `${CLAUDE_SDK_PROVIDER}:`;
  if (advisorCoord.startsWith(prefix)) return advisorCoord.slice(prefix.length);
  logger.warn(
    { seat: seatCoord, advisor: advisorCoord },
    '[claude-sdk] claude-code 座位的 advisor 必须是 claude-code:* 坐标 (官方配对表) —— 本次不挂 advisor',
  );
  return undefined;
}

/** MCP server 在 SDK 侧的注册名 → 工具名前缀 `mcp__omd__<name>`。 */
const MCP_SERVER_NAME = 'omd';

/** 测试接缝:与 `query` 同形的最小面(真 SDK 要真订阅 + claude CLI)。 */
export type SdkQueryFn = (props: { prompt: string; options: Options }) => AsyncIterable<SDKMessage>;

// ── 工具桥:OmdTool(TypeBox=JSON Schema)→ 进程内 MCP server ────────────────────
/**
 * 低层 handler 直喂 JSON Schema —— 不经 SDK 的 zod `tool()`,零 schema 翻译
 * (探针实测可行:ListTools/CallTool 走 McpServer.server 的 setRequestHandler)。
 * tool_execution_start/end 事件与 pi 循环同形 —— agent-leaf 的 filesTouched/writeEffects/
 * shellRuns/drift 采集全挂在这两个事件上,桥发得对,那套机械原样工作。
 */
export function buildOmdSdkMcpBridge(
  tools: AnyOmdTool[],
  hooks?: { onEvent?: (e: AgentEvent) => void },
): { instance: McpServer; allowedTools: string[] } {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const instance = new McpServer({ name: MCP_SERVER_NAME, version: '0' }, { capabilities: { tools: {} } });
  instance.server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description ?? '',
      inputSchema: t.parameters as unknown as { type: 'object'; [k: string]: unknown },
    })),
  }));
  instance.server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const tool = byName.get(req.params.name);
    if (!tool) {
      // 反向自检口径:未知工具必须红(bridge 测试当场证伪一次)。
      return { content: [{ type: 'text' as const, text: `[TOOL ERROR] unknown tool '${req.params.name}'` }], isError: true };
    }
    const callId = `sdk-${randomUUID().slice(0, 8)}`;
    const args = tool.prepareArguments ? tool.prepareArguments(req.params.arguments ?? {}) : (req.params.arguments ?? {});
    hooks?.onEvent?.({ type: 'tool_execution_start', toolCallId: callId, toolName: tool.name, args });
    try {
      const r = await tool.execute(callId, args as never, extra?.signal);
      hooks?.onEvent?.({ type: 'tool_execution_end', toolCallId: callId, toolName: tool.name, result: r, isError: false });
      return {
        content: r.content.map((c) =>
          c.type === 'text'
            ? { type: 'text' as const, text: c.text }
            : { type: 'image' as const, data: (c as { data: string }).data, mimeType: (c as { mimeType: string }).mimeType },
        ),
      };
    } catch (err) {
      // 工具失败按 chat-tools 的 `[TOOL ERROR]` 惯例回给模型(fail-open 不吞证据)。
      const msg = (err as Error).message;
      logger.warn({ tool: tool.name, err: msg }, '[claude-sdk] 工具执行抛错 → isError 回给模型');
      hooks?.onEvent?.({ type: 'tool_execution_end', toolCallId: callId, toolName: tool.name, result: msg, isError: true });
      return { content: [{ type: 'text' as const, text: `[TOOL ERROR] ${msg}` }], isError: true };
    }
  });
  return { instance, allowedTools: tools.map((t) => `mcp__${MCP_SERVER_NAME}__${t.name}`) };
}

// ── SDK 消息 → pi 形状(session-store / leaf 后处理用同一套消费者) ────────────────
type SdkAssistant = Extract<SDKMessage, { type: 'assistant' }>;
type SdkUser = Extract<SDKMessage, { type: 'user' }>;
type SdkResult = Extract<SDKMessage, { type: 'result' }>;

interface SdkApiUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/** in = 全部 prompt 侧 token(直读 + 缓存读 + 缓存写),cacheHit ⊆ in —— 对齐 mapSessionUsage 口径。 */
function mapSdkUsage(u: SdkApiUsage | undefined): ModelUsage {
  if (!u) return { in: 0, out: 0 };
  const cacheHit = u.cache_read_input_tokens ?? 0;
  return {
    in: (u.input_tokens ?? 0) + cacheHit + (u.cache_creation_input_tokens ?? 0),
    out: u.output_tokens ?? 0,
    cacheHit,
  };
}

function mapStopReason(s: string | null | undefined): string {
  if (s === 'tool_use') return 'toolUse';
  if (s === 'max_tokens') return 'length';
  return 'stop';
}

/** assistant:content 块逐类映射(text/thinking/tool_use),usage 收窄成 turnUsages / leaf 累账认的形状。 */
function mapAssistant(m: SdkAssistant, modelCoord: string, toolNameById: Map<string, string>): AgentMessage {
  const blocks: unknown[] = [];
  for (const b of m.message.content as unknown as Array<Record<string, unknown>>) {
    if (b.type === 'text') blocks.push({ type: 'text', text: b.text });
    else if (b.type === 'thinking') blocks.push({ type: 'thinking', thinking: b.thinking });
    else if (b.type === 'tool_use') {
      toolNameById.set(b.id as string, b.name as string);
      blocks.push({ type: 'toolCall', id: b.id, name: b.name, arguments: b.input ?? {} });
    }
    // redacted_thinking 等其余块不进投影(展示/审计无内容可用,SDK 侧 transcript 自持)。
  }
  const u = m.message.usage as SdkApiUsage | undefined;
  return {
    role: 'assistant',
    content: blocks,
    api: 'anthropic-messages',
    provider: CLAUDE_SDK_PROVIDER,
    model: modelCoord,
    // turnUsages 只读 input/output/cacheRead;leaf 累账另读 cacheWrite(并进 input 全价,诚实近似)。
    usage: u
      ? { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0 }
      : undefined,
    stopReason: mapStopReason(m.message.stop_reason as string | null),
    timestamp: Date.now(),
  } as unknown as AgentMessage;
}

/** user 消息里只认 tool_result 块(SDK 把工具结果作为 user 轮回放);纯文本 user 是我们自己的 prompt,不重复入库。 */
function mapToolResults(m: SdkUser, toolNameById: Map<string, string>): AgentMessage[] {
  const content = m.message.content;
  if (!Array.isArray(content)) return [];
  const out: AgentMessage[] = [];
  for (const b of content as unknown as Array<Record<string, unknown>>) {
    if (b.type !== 'tool_result') continue;
    const raw = b.content;
    const text =
      typeof raw === 'string'
        ? raw
        : Array.isArray(raw)
          ? (raw as Array<{ type?: string; text?: string }>).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('')
          : '';
    out.push({
      role: 'toolResult',
      toolCallId: b.tool_use_id,
      toolName: toolNameById.get(b.tool_use_id as string) ?? '(unknown)',
      content: [{ type: 'text', text }],
      isError: b.is_error === true,
      timestamp: Date.now(),
    } as unknown as AgentMessage);
  }
  return out;
}

// ── 共享循环核(chat 与 agent-leaf 的公共部分) ─────────────────────────────────────
export interface SdkLoopOpts {
  prompt: string;
  systemPrompt: string;
  tools: AnyOmdTool[];
  /** 裸 model id(SDK 认的),如 claude-sonnet-5。 */
  modelId: string;
  /** 座位坐标(投影消息的 model 字段 + 日志归因),如 claude-code:claude-sonnet-5。 */
  modelCoord: string;
  effort?: NonNullable<Options['effort']>;
  /**
   * 官方 server-side advisor 的模型 id(裸 id 如 claude-opus-5,非坐标)。经 SDK
   * `settings.advisorModel` 下发;配对合法性由 CLI/API 校验(不合法 = 不挂 + 通知,不炸)。
   */
  advisorModel?: string;
  resume?: string;
  cwd: string;
  onEvent?: (e: AgentEvent) => void;
  /**
   * 每收到一条 SDK 流消息叫一次(含 stream_event 增量)—— leaf 看门狗的进展信号。
   * 不开 includePartialMessages 时长思考轮没有增量,3 分钟 idle 看门狗会把「在想」判成
   * 「挂死」(与 2026-08-01 换看门狗判据时修的同一族错),所以 leaf 必须两个都开。
   */
  onActivity?: () => void;
  includePartialMessages?: boolean;
  signal?: AbortSignal;
  sdkQueryFn?: SdkQueryFn;
  /** abort 时不抛、返已累积消息(leaf 优雅停语义);chat 不开 = 无 result 必抛。 */
  tolerateAbort?: boolean;
  /**
   * 账本归因(owner 验收 P1,2026-08-10):给了就在循环核里 emit —— **成败都记**,
   * 失败路的 token 也真烧了订阅额度,不 emit 就是账外。origin 由调用方定(chat/engine)。
   * 不给 = 不 emit(测试/特殊调用方自理)。
   */
  ledger?: { model: string; origin: 'chat' | 'engine' };
}

export interface SdkLoopOut {
  /** 本轮生成(assistant + toolResult,pi 形状,不含调用方自己的 user prompt)。 */
  generated: AgentMessage[];
  /**
   * 账行(逐模型)。真源 = result.modelUsage(SDK 文档:`usage` 是 main-loop-only,
   * **modelUsage 才是记账字段** —— 验收实测 per-assistant usage 会分块重复 + out 严重低估)。
   * result 缺席(流断/abort)→ 按 API message id 去重的累积值兜底,归因座位坐标。
   * advisor / 子代理的 token 在 modelUsage 里是独立条目 → 独立账行,归因免费。
   */
  ledgerRows: { model: string; usage: ModelUsage }[];
  /** ledgerRows 合计(chat 的 ChatTurnResult.usage / leaf 的 AgentLeafResult.usage 用它)。 */
  totalUsage: ModelUsage;
  /** success 时必有;tolerateAbort 且中途 abort 时缺席。 */
  result?: SdkResult;
  aborted: boolean;
}

export async function runSdkAgentLoop(o: SdkLoopOpts): Promise<SdkLoopOut> {
  const bridge = buildOmdSdkMcpBridge(o.tools, { onEvent: o.onEvent ?? (() => {}) });
  const abort = new AbortController();
  o.signal?.addEventListener('abort', () => abort.abort(), { once: true });

  const options: Options = {
    model: o.modelId,
    cwd: o.cwd,
    systemPrompt: o.systemPrompt,
    // 内置工具全清:座位的工具面就是闸(agent-tools.ts 搬家时的同一条纪律)。
    tools: [],
    mcpServers: { [MCP_SERVER_NAME]: { type: 'sdk', name: MCP_SERVER_NAME, instance: bridge.instance } },
    allowedTools: bridge.allowedTools,
    abortController: abort,
    ...(o.effort ? { effort: o.effort } : {}),
    ...(o.resume ? { resume: o.resume } : {}),
    ...(o.includePartialMessages ? { includePartialMessages: true } : {}),
    ...(o.advisorModel ? { settings: { advisorModel: o.advisorModel } as Options['settings'] } : {}),
  };

  o.onEvent?.({ type: 'agent_start' });
  const q = (o.sdkQueryFn ?? (query as unknown as SdkQueryFn))({ prompt: o.prompt, options });

  const toolNameById = new Map<string, string>();
  const generated: AgentMessage[] = [];
  // per-API-message 去重累积 (兜底账): SDK 把同一次 API 调用按 content 块拆成多条 assistant
  // 消息, 每条带同一份 usage —— 逐条 emit 就是三胞胎账行 (验收实测)。同 id 后到覆盖先到。
  const usageById = new Map<string, ModelUsage>();
  let anon = 0;
  let result: SdkResult | undefined;
  let threw: unknown = null;

  try {
    for await (const msg of q) {
      o.onActivity?.();
      if (msg.type === 'assistant') {
        const mapped = mapAssistant(msg, o.modelCoord, toolNameById);
        generated.push(mapped);
        const u = mapSdkUsage(msg.message.usage as SdkApiUsage | undefined);
        if (u.in > 0 || u.out > 0) usageById.set((msg.message as { id?: string }).id ?? `anon-${anon++}`, u);
        o.onEvent?.({ type: 'message_end', message: mapped });
      } else if (msg.type === 'user') {
        generated.push(...mapToolResults(msg, toolNameById));
      } else if (msg.type === 'result') {
        result = msg;
      }
      // system / stream_event 等其余消息型不进投影(stream_event 只喂 onActivity)。
    }
  } catch (err) {
    threw = err; // 先记账再决定抛不抛 —— 失败路的 token 也真烧了 (P1)。
  }

  const aborted = o.signal?.aborted === true;
  // ── 账行:真源 result.modelUsage(错误 result 也带),缺席才用去重累积兜底 ────────
  const mu = result
    ? (result as { modelUsage?: Record<string, { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number }> }).modelUsage
    : undefined;
  const ledgerRows = (
    mu && Object.keys(mu).length > 0
      ? Object.entries(mu).map(([k, v]) => ({
          model: `${CLAUDE_SDK_PROVIDER}:${k}`,
          usage: {
            in: (v.inputTokens ?? 0) + (v.cacheReadInputTokens ?? 0) + (v.cacheCreationInputTokens ?? 0),
            out: v.outputTokens ?? 0,
            cacheHit: v.cacheReadInputTokens ?? 0,
          },
        }))
      : [...usageById.values()].map((usage) => ({ model: o.modelCoord, usage }))
  ).filter((r) => r.usage.in > 0 || r.usage.out > 0); // 全零不记 (calls 灌水, 同 turnUsages 口径)
  if (o.ledger) {
    for (const row of ledgerRows) {
      try {
        emitModelUsage(row.usage, row.model, o.ledger.origin);
      } catch (err) {
        logger.warn({ err: (err as Error).message, model: row.model }, '[claude-sdk] 用量入账失败 (已吞, 不影响本轮)');
      }
    }
  }
  const totalUsage = ledgerRows.reduce<ModelUsage>(
    (acc, r) => ({ in: acc.in + r.usage.in, out: acc.out + r.usage.out, cacheHit: (acc.cacheHit ?? 0) + (r.usage.cacheHit ?? 0) }),
    { in: 0, out: 0, cacheHit: 0 },
  );

  // ── 失败语义(账已记完才抛) ─────────────────────────────────────────────────────
  if (threw !== null) {
    if (!(o.tolerateAbort && aborted)) throw threw;
    logger.warn({ model: o.modelCoord, err: (threw as Error).message }, '[claude-sdk] abort 中断 → 返已累积消息 (优雅停)');
  }
  if (!result && !(o.tolerateAbort && aborted) && threw === null) {
    throw new Error('[claude-sdk] 流结束但没收到 result 消息 (CLI 中断?)');
  }
  if (result && result.subtype !== 'success' && !(o.tolerateAbort && aborted)) {
    const detail = 'result' in result && typeof (result as { result?: unknown }).result === 'string' ? (result as { result: string }).result : '';
    throw new Error(`[claude-sdk] provider 错误: ${result.subtype}${detail ? ` — ${detail}` : ''}`);
  }
  o.onEvent?.({ type: 'agent_end', messages: generated });
  return { generated, ledgerRows, totalUsage, ...(result ? { result } : {}), aborted };
}

