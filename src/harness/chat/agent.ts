/**
 * src/harness/chat/agent —— conductor chat 的一轮执行(runAgentLoop + 持久 messages)。
 *
 * 与 agent-leaf 同一条裸循环路(pi-agent-core SDK 直调,禁 CLI 包——见 no-cli-dep.test.ts),
 * 差异只有三点,全部长在这里:
 *   ① **持久会话**:leaf 每次现构造空 messages 弃置;chat 从 ChatStore 载入历史,跑完追加落盘。
 *      runAgentLoop 的语义(实读 dist/agent-loop.js):不改传入 context.messages(内部拷贝),
 *      返回值 = prompts + 本轮生成 → 持久化即 push(...returned)。
 *   ② **conductor 档 system prompt**(harness-prompts 蒸馏核,冻结前缀在前)。
 *   ③ **事件外露**:emit 原样转给 onEvent(daemon 拿去接 SSE)。
 *
 * 失败语义:轮子抛错 → **不落盘**,响亮上抛(半轮对话入库 = 重试时 user 消息重复;
 * 前端本来留着输入框内容,丢的只是这一轮)。provider 错误同 agent-leaf 的 C-5b 纪律:
 * stopReason==='error' 的轮不算成功,连同 errorMessage 上抛真因。
 */
import {
  runAgentLoop,
  convertToLlm,
  type AgentContext,
  type AgentEvent,
  type AgentLoopConfig,
  type AgentMessage,
} from '@earendil-works/pi-agent-core';
import { assistantText, loadProjectContext } from '../agent-leaf';
import type { AnyOmdTool } from '../agent-tools';
import { buildConductorChatSystemPrompt } from '../harness-prompts';
import { parseModelRef } from '../fleet';
import { resolvePiApiKey, resolvePiModel } from '../../model/pi-transport';
import type { ThinkingLevel } from '../../model/role-models';
import { ChatStore, type ChatSession } from './store';

export interface ChatTurnOpts {
  store: ChatStore;
  sessionId: string;
  /** 用户本轮输入。 */
  prompt: string;
  /** 座位坐标 'provider:model-id'(座位解析在调用方——daemon 解 conductor 座,这里只认坐标)。 */
  model: string;
  cwd: string;
  tools?: AnyOmdTool[];
  /** 省略 → loadProjectContext(cwd)(与 leaf 同一条向上走的加载路)。 */
  contextFiles?: readonly { path: string; content: string }[];
  /** 默认 'high'(conductor 座的默认档;chat 是判断位不是量产位)。 */
  thinkingLevel?: ThinkingLevel;
  /** pi AgentEvent 原样外露(daemon → SSE)。 */
  onEvent?: (e: AgentEvent) => void;
  signal?: AbortSignal;
  /**
   * 测试接缝:替换真循环(真循环要真模型)。生产不传。
   */
  loopFn?: typeof runAgentLoop;
}

export interface ChatTurnResult {
  session: ChatSession;
  /** 本轮 assistant 正文(thinking/toolCall 块不算)。 */
  reply: string;
  /** 本轮新增消息(含 user prompt 本身)。 */
  newMessages: AgentMessage[];
}

/** 首条消息 → 会话标题(列表页显示用,截断即可)。 */
function titleOf(prompt: string): string {
  const oneLine = prompt.replace(/\s+/g, ' ').trim();
  return oneLine.length > 60 ? `${oneLine.slice(0, 60)}…` : oneLine;
}

export async function runChatTurn(opts: ChatTurnOpts): Promise<ChatTurnResult> {
  const { provider, modelId } = parseModelRef(opts.model);
  const piModel = resolvePiModel(provider, modelId);
  if (!piModel) {
    throw new Error(`[chat-agent] 坐标 '${opts.model}' 解析不出模型 (provider '${provider}' 两栈都查不到)`);
  }

  const session = opts.store.load(opts.sessionId) ?? opts.store.create(opts.sessionId, titleOf(opts.prompt));
  const tools = opts.tools ?? [];
  const context: AgentContext = {
    systemPrompt: buildConductorChatSystemPrompt({
      cwd: opts.cwd,
      tools,
      contextFiles: opts.contextFiles ?? loadProjectContext(opts.cwd),
    }),
    messages: session.messages,
    tools,
  };
  const thinking = opts.thinkingLevel ?? 'high';
  const config: AgentLoopConfig = {
    model: piModel,
    convertToLlm,
    ...(thinking !== 'off' ? { reasoning: thinking } : {}),
    // 凭证每轮现取(同 agent-leaf: OAuth token 会在长会话中途过期)。
    getApiKey: (p: string) => resolvePiApiKey(p),
  };

  const loop = opts.loopFn ?? runAgentLoop;
  const returned = await loop(
    [{ role: 'user', content: opts.prompt, timestamp: Date.now() }],
    context,
    config,
    (e) => opts.onEvent?.(e),
    opts.signal,
  );

  // provider 错误响亮上抛 (C-5b 同纪律): error 轮不算成功, 不落盘。
  const errored = returned.find(
    (m) => (m as { stopReason?: string }).stopReason === 'error',
  ) as { errorMessage?: string } | undefined;
  if (errored) {
    throw new Error(`[chat-agent] provider 错误: ${errored.errorMessage ?? '(无 errorMessage)'}`);
  }

  session.messages.push(...returned);
  opts.store.save(session);
  const reply = returned.map(assistantText).join('');
  return { session, reply, newMessages: returned };
}
