/**
 * src/harness/chat/claude-sdk-turn —— conductor chat 的 Claude Agent SDK 通道(订阅座位)。
 *
 * 与 `agent.ts` 的 `runChatTurn` **同契约**(ChatTurnOpts → ChatTurnResult),按座位坐标分派:
 * provider === 'claude-code' 走这里(分派点在 runChatTurn 顶部,四个调用方免费继承)。
 * 决策记录:docs/plan/NOTES.md 2026-08-10「Claude 订阅经 Agent SDK 上三座位」;
 * 可行性探针:scripts/claude-sdk-probe.ts(S0 五信号全绿,2026-08-10 实测)。
 *
 * 与 pi 通道的三处刻意差异(不是缺口,是委托):
 *   ① **上下文压缩不做**:SDK 自带 context 管理;`compactions` 恒 0 的语义是
 *      「委托给 SDK」,不是「没压」——消费者按 compactionRatio 判"开没开"的那条纪律
 *      在本通道不适用(见 ChatTurnResult.compactions 注)。
 *   ② **会话双轨**:omd session-store 存投影(展示/审计真相),SDK 侧自持 transcript
 *      供 resume 续接;两者的桥是 `.omd/chat/claude-sdk-sessions.json`(omd sessionId →
 *      SDK session_id,每轮 resume 会 fork 出新 id,**每轮成功后重写**)。
 *   ③ **账本**:座位坐标(claude-code:*)**刻意不进 cost-ledger 价表** → unpriced=true。
 *      订阅额度不是 $0 也不是 API 名义价(SDK 报的 total_cost_usd 是名义价,不入账);
 *      unpriced 旗就是本仓「NULL ≠ 0」的现行表示。token 照记,逐条 assistant emit
 *      不汇总(calls 语义与 pi 通道一致)。
 *
 * 失败语义与 pi 通道同一条:result.subtype !== 'success' 或流中断 → **一个字节不写**,
 * 响亮上抛(半轮不入库);sidecar 映射也只在成功后写。
 */
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { AgentEvent, AgentMessage } from '@earendil-works/pi-agent-core';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { assistantText, loadProjectContext } from '../agent-leaf';
import type { AnyOmdTool } from '../agent-tools';
import { buildConductorChatSystemPrompt } from '../harness-prompts';
import { parseModelRef } from '../fleet';
import { logger } from '../../logger';
import { emitModelUsage } from '../../model/accounting';
import type { ModelUsage } from '../../model/types';
import { analyzeContextPressure } from './usage';
import type { ChatTurnOpts, ChatTurnResult } from './agent';

/** 订阅通道的座位 provider(坐标形如 `claude-code:claude-fable-5`)。 */
export const CLAUDE_SDK_PROVIDER = 'claude-code';

/** MCP server 在 SDK 侧的注册名 → 工具名前缀 `mcp__omd__<name>`。 */
const MCP_SERVER_NAME = 'omd';

/** 测试接缝:与 `query` 同形的最小面(真 SDK 要真订阅 + claude CLI)。 */
export type SdkQueryFn = (props: { prompt: string; options: Options }) => AsyncIterable<SDKMessage>;

// ── 工具桥:OmdTool(TypeBox=JSON Schema)→ 进程内 MCP server ────────────────────
/**
 * 低层 handler 直喂 JSON Schema —— 不经 SDK 的 zod `tool()`,零 schema 翻译
 * (探针实测可行:ListTools/CallTool 走 McpServer.server 的 setRequestHandler)。
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

// ── SDK 消息 → pi 形状(session-store 投影用同一套消费者) ──────────────────────
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

/** assistant:content 块逐类映射(text/thinking/tool_use),usage 收窄成 turnUsages 认的形状。 */
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
    // turnUsages 只读 input/output/cacheRead;cacheWrite 一并带上供人读账。
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

// ── SDK 会话映射 sidecar(omd sessionId → SDK session_id) ────────────────────────
function sdkMapPath(cwd: string): string {
  return join(cwd, '.omd', 'chat', 'claude-sdk-sessions.json');
}

function readSdkSessionId(cwd: string, sessionId: string): string | undefined {
  try {
    const map = JSON.parse(readFileSync(sdkMapPath(cwd), 'utf8')) as Record<string, string>;
    return map[sessionId];
  } catch {
    return undefined; // 文件不存在 = 首轮,正常路径;损坏走下面 write 时整文件重建
  }
}

function writeSdkSessionId(cwd: string, sessionId: string, sdkSessionId: string): void {
  // fail-open 但不吞证据:写失败只降级续接(下轮 SDK 侧起新会话),必须留痕。
  try {
    const p = sdkMapPath(cwd);
    let map: Record<string, string> = {};
    try {
      map = JSON.parse(readFileSync(p, 'utf8')) as Record<string, string>;
    } catch {
      /* 首次或损坏 → 重建;旧映射丢失的后果同写失败,由下一行日志兜证据 */
    }
    map[sessionId] = sdkSessionId;
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, `${JSON.stringify(map, null, 2)}\n`);
  } catch (err) {
    logger.warn({ sessionId, sdkSessionId, err: (err as Error).message }, '[claude-sdk] 会话映射写失败 → 下轮 SDK 侧将起新会话');
  }
}

// ── 主体 ─────────────────────────────────────────────────────────────────────────
export async function runChatTurnSdk(opts: ChatTurnOpts): Promise<ChatTurnResult> {
  const { modelId } = parseModelRef(opts.model);
  const tools = opts.tools ?? [];
  const existing = await opts.store.open(opts.sessionId);
  const priorCount = existing ? (await existing.messages()).length : 0;

  let systemPrompt = buildConductorChatSystemPrompt({
    cwd: opts.cwd,
    tools,
    contextFiles: opts.contextFiles ?? loadProjectContext(opts.cwd),
  });
  if (opts.systemPromptHook) {
    try {
      systemPrompt = await opts.systemPromptHook(systemPrompt);
    } catch (err) {
      logger.warn({ err: (err as Error).message }, '[claude-sdk] systemPrompt 钩子抛了 → 用原串');
    }
  }

  const bridge = buildOmdSdkMcpBridge(tools, { onEvent: opts.onEvent ?? (() => {}) });
  const abort = new AbortController();
  opts.signal?.addEventListener('abort', () => abort.abort(), { once: true });
  const resume = readSdkSessionId(opts.cwd, opts.sessionId);

  const options: Options = {
    model: modelId,
    cwd: opts.cwd,
    systemPrompt,
    // 内置工具全清:conductor 的工具面就是闸(agent-tools.ts 搬家时的同一条纪律),
    // 手上只有显式桥过去的 omd 工具。
    tools: [],
    mcpServers: { [MCP_SERVER_NAME]: { type: 'sdk', name: MCP_SERVER_NAME, instance: bridge.instance } },
    allowedTools: bridge.allowedTools,
    abortController: abort,
    ...(resume ? { resume } : {}),
  };

  opts.onEvent?.({ type: 'agent_start' });
  const q = (opts.sdkQueryFn ?? (query as unknown as SdkQueryFn))({ prompt: opts.prompt, options });

  const toolNameById = new Map<string, string>();
  const generated: AgentMessage[] = [];
  const usages: ModelUsage[] = [];
  let result: SdkResult | undefined;

  for await (const msg of q) {
    if (msg.type === 'assistant') {
      const mapped = mapAssistant(msg, opts.model, toolNameById);
      generated.push(mapped);
      // 逐条 emit 不汇总:每条 assistant 是一次独立 API 调用,calls 语义与 pi 通道一致。
      const u = mapSdkUsage(msg.message.usage as SdkApiUsage | undefined);
      if (u.in > 0 || u.out > 0) {
        usages.push(u);
        try {
          emitModelUsage(u, opts.model, 'chat');
        } catch (err) {
          logger.warn({ err: (err as Error).message, model: opts.model }, '[claude-sdk] 用量入账失败 (已吞, 不影响这一轮)');
        }
      }
      opts.onEvent?.({ type: 'message_end', message: mapped });
    } else if (msg.type === 'user') {
      generated.push(...mapToolResults(msg, toolNameById));
    } else if (msg.type === 'result') {
      result = msg;
    }
    // system/stream_event 等其余消息型不进投影。
  }

  if (!result) throw new Error('[claude-sdk] 流结束但没收到 result 消息 (CLI 中断?)');
  if (result.subtype !== 'success') {
    const detail = 'result' in result && typeof (result as { result?: unknown }).result === 'string' ? (result as { result: string }).result : '';
    throw new Error(`[claude-sdk] provider 错误: ${result.subtype}${detail ? ` — ${detail}` : ''}`);
  }

  // ── 成功之后才落任何东西(半轮不入库,与 pi 通道同纪律) ────────────────────────
  const userMsg = { role: 'user', content: opts.prompt, timestamp: Date.now() } as AgentMessage;
  const newMessages: AgentMessage[] = [userMsg, ...generated];
  const titleSource = opts.prompt.replace(/\s+/g, ' ').trim();
  const session = existing ?? (await opts.store.create(opts.sessionId, titleSource.length > 60 ? `${titleSource.slice(0, 60)}…` : titleSource));
  for (const m of newMessages) await session.append(m);
  writeSdkSessionId(opts.cwd, opts.sessionId, result.session_id);
  opts.onEvent?.({ type: 'agent_end', messages: newMessages });

  const after = priorCount + newMessages.length;
  const windowTokens =
    Object.values((result.modelUsage ?? {}) as Record<string, { contextWindow?: number }>)[0]?.contextWindow ?? 1_000_000;
  const total: ModelUsage = usages.reduce<ModelUsage>(
    (acc, u) => ({ in: acc.in + u.in, out: acc.out + u.out, cacheHit: (acc.cacheHit ?? 0) + (u.cacheHit ?? 0) }),
    { in: 0, out: 0, cacheHit: 0 },
  );
  return {
    sessionId: opts.sessionId,
    messageCount: after,
    reply: generated.map(assistantText).join(''),
    newMessages,
    usage: total,
    pressure: analyzeContextPressure({ systemPrompt, messages: await session.messages(), windowTokens }),
    compactions: 0, // 委托给 SDK 的通道恒 0 —— 语义是「SDK 自管」,不是「没压」(见文件头注 ①)
  };
}
