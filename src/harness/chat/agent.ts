/**
 * src/harness/chat/agent —— conductor chat 的一轮执行(runAgentLoop + 持久 messages)。
 *
 * 与 agent-leaf 同一条裸循环路(pi-agent-core SDK 直调,禁 CLI 包——见 no-cli-dep.test.ts),
 * 差异只有三点,全部长在这里:
 *   ① **持久会话**:leaf 每次现构造空 messages 弃置;chat 从 session-store 载入历史(投影),
 *      跑完把本轮新增**逐条 append** 进磁盘。
 *      runAgentLoop 的语义(实读 dist/agent-loop.js):不改传入 context.messages(内部拷贝),
 *      返回值 = prompts + 本轮生成 → 持久化即 append(...returned)。
 *   ② **conductor 档 system prompt**(harness-prompts 蒸馏核,冻结前缀在前)。
 *   ③ **事件外露**:emit 原样转给 onEvent(daemon 拿去接 SSE)。
 *
 * 失败语义:轮子抛错 → **一个字节都不写**,响亮上抛(半轮对话入库 = 重试时 user 消息重复;
 * 前端本来留着输入框内容,丢的只是这一轮)。provider 错误同 agent-leaf 的 C-5b 纪律:
 * stopReason==='error' 的轮不算成功,连同 errorMessage 上抛真因。
 */
import {
  runAgentLoop,
  convertToLlm,
  estimateContextTokens,
  estimateTokens,
  type AgentContext,
  type AgentEvent,
  type AgentLoopConfig,
  type AgentMessage,
} from '@earendil-works/pi-agent-core';
// 0.84 起 `runAgentLoop` 第 6 参 streamFn **必填** (同 agent-leaf 头注)。0.80 的内部默认就是它。
import { streamSimple } from '@earendil-works/pi-ai/compat';
import { uuidv7 } from '@earendil-works/pi-ai';
import { assistantText } from '../agent-leaf';
import { logger } from '../../logger';
import { buildSessionStartContext } from '../session/resume';
import { maybeCheckpointOmdSession } from '../session/omd-checkpoint';
import { emitModelUsage } from '../../model/accounting';
import type { ModelUsage } from '../../model/types';
import { type CompactionCallModel, compactChatMessages } from './compaction';
import { clearCompactionJournal, journalPathFor, writeCompactionJournal } from './compaction-journal';
import { type ContextPressure, analyzeContextPressure, sumUsage, turnUsages } from './usage';
import { join } from 'node:path';
import { createMemoryTransform } from './memory-inject';
import type { AnyOmdTool } from '../agent-tools';
import { buildConductorChatSystemPrompt } from '../harness-prompts';
import { parseModelRef } from '../fleet';
import { resolvePiApiKey, resolvePiModel } from '../../model/pi-transport';
import type { ThinkingLevel } from '../../model/role-models';
import type { OmdSessionStore } from './session-store';
import { CLAUDE_SDK_PROVIDER, runChatTurnSdk } from './claude-sdk-turn';
import { createAdvisorTool, createTranscriptRecorder } from '../advisor-tool';

export interface ChatTurnOpts {
  store: OmdSessionStore;
  sessionId: string;
  /** 用户本轮输入。 */
  prompt: string;
  /** 座位坐标 'provider:model-id'(座位解析在调用方——daemon 解 conductor 座,这里只认坐标)。 */
  model: string;
  cwd: string;
  tools?: AnyOmdTool[];
  /** 默认 'high'(conductor 座的默认档;chat 是判断位不是量产位)。 */
  thinkingLevel?: ThinkingLevel;
  /**
   * advisor 坐标(resolveSeatAdvisor('conductor') 的产物,省略 = 无)。按通道分派:
   * claude-code 座 → 官方 server tool(settings.advisorModel);pi 座 → 内部升档 tool
   * (advisor-tool.ts 注入本轮工具面,transcript 含既往会话)。
   */
  advisor?: string;
  /** pi AgentEvent 原样外露(daemon → SSE)。 */
  onEvent?: (e: AgentEvent) => void;
  signal?: AbortSignal;
  /**
   * 在飞插话(steering,工具间隙注入)/ 轮尾追加(follow-up,本该停时续跑)两队列的
   * 取数钩子 —— pi loop 契约:**不许抛、无货返 []**(types.d.ts:202/214)。
   * ⚠ 只在 pi loop 路生效;claude-sdk 路(`runChatTurnSdk`)不吃这两个钩子,
   *   队列残留由调用方轮后排空兜底(TUI 的 drainQueued 那条)。
   */
  getSteeringMessages?: () => Promise<AgentMessage[]>;
  getFollowUpMessages?: () => Promise<AgentMessage[]>;
  /**
   * W5 片1: 本轮附带的图片(pi `ImageContent` 形)。座位模型不吃图 → provider 错误
   * 按 C-5b 响亮上抛,**不做**静默丢图(I3)—— 丢图是"说了一句没说过的话"的镜像。
   */
  promptImages?: { type: 'image'; data: string; mimeType: string }[];
  /**
   * 测试接缝:替换真循环(真循环要真模型)。生产不传。
   */
  loopFn?: typeof runAgentLoop;
  /**
   * 上下文预算占比(S9)。超过 `contextWindow × 这个比例`就压缩。默认 0.85,与 leaf 同。
   * 传 `0` 关掉压缩 —— **关掉不是省钱,是撞窗口时整轮硬失败**。
   */
  contextBudgetRatio?: number;
  /** 压缩时尾部保留的 token 预算。默认 20k,与 leaf 同。 */
  compactionKeepRecentTokens?: number;
  /**
   * 测试接缝:摘要那一次模型调用。省略 → 真 `callModel`(账本挂在它出口上)。生产不传。
   */
  compactionCallModel?: CompactionCallModel;
  /**
   * 记忆自动注入(S16,A8)。给了就在**每次请求前**召回一次并把结果注在消息末尾。
   *
   * ⚠ **advisory**:失败静默 no-op 不阻断这一轮;走 `transformContext` 只改这一次请求,
   * 不写回会话(召回内容不该落进 ChatStore 当成用户说过的话)。省略 = 不注入。
   */
  memory?: import('../memory/store').OmdMemory;
  /**
   * system prompt 钩子(S15a:扩展的 `before_agent_start` 落点)。
   *
   * ⚠ **只能追加**的校验不在这里 —— 在 `tui/ext/host.ts` 的父侧。这里只认"给我一个串"。
   * 校验放在调用方是刻意的:这条 opts 将来可能有别的消费者,而那条纪律是**扩展**专属的。
   */
  systemPromptHook?: (prompt: string) => Promise<string>;
  /**
   * 测试接缝:claude-code 通道的 SDK query 替身(真 SDK 要真订阅 + claude CLI)。生产不传。
   * 类型写结构面不 import claude-sdk-turn —— 那边 import 本文件的 ChatTurnOpts,引用回去就是环。
   */
  sdkQueryFn?: (props: {
    prompt: string;
    options: import('@anthropic-ai/claude-agent-sdk').Options;
  }) => AsyncIterable<import('@anthropic-ai/claude-agent-sdk').SDKMessage>;
}

export interface ChatTurnResult {
  sessionId: string;
  /**
   * 这一轮结束时会话里有多少条消息(投影口径)。
   *
   * ⚠ 换存储层之前这里给的是整个 `ChatSession`,而两个消费者都只取 `.messages.length`。
   * 新层的消息是**投影**不是持久单元,再把整份数组带出来就等于鼓励调用方拿它当真相。
   */
  messageCount: number;
  /** 本轮 assistant 正文(thinking/toolCall 块不算)。 */
  reply: string;
  /** 本轮新增消息(含 user prompt 本身)。 */
  newMessages: AgentMessage[];
  /**
   * 本轮总用量。**逐条进账本、这里给合计** —— UI 显示要一个数,账本要每一次调用。
   *
   * ⚠ 全零 = provider 一次用量都没报,**不是"没花钱"**(fake loop 的测试就是这种)。
   */
  usage: ModelUsage;
  /** 这一轮结束时的上下文压力(给 UI 显示"离满还有多远")。 */
  pressure: ContextPressure;
  /**
   * 本轮压缩了几次(轮前 + 轮内合计)。
   *
   * ⚠ `0` 与"没开压缩"是两件事,后者看 `compactionRatio === 0` —— 别把两种情形
   * 都读成"这轮没压"(本仓 `NULL ≠ 0 ≠ 不适用`)。
   */
  compactions: number;
}

/** 首条消息 → 会话标题(列表页显示用,截断即可)。 */
function titleOf(prompt: string): string {
  const oneLine = prompt.replace(/\s+/g, ' ').trim();
  return oneLine.length > 60 ? `${oneLine.slice(0, 60)}…` : oneLine;
}

export async function runChatTurn(opts: ChatTurnOpts): Promise<ChatTurnResult> {
  const { provider, modelId } = parseModelRef(opts.model);
  // 订阅通道分派(NOTES 2026-08-10):claude-code:* 走 Agent SDK loop,契约同面。
  // 分派放在 pi 解析**之前** —— claude-code 不在 pi 目录,晚一行就是解析报错。
  if (provider === CLAUDE_SDK_PROVIDER) return runChatTurnSdk(opts);
  const piModel = resolvePiModel(provider, modelId);
  if (!piModel) {
    throw new Error(`[chat-agent] 坐标 '${opts.model}' 解析不出模型 (provider '${provider}' 两栈都查不到)`);
  }

  /**
   * ★ **会话文件到这一步为止都还没建**。
   *
   * `open()` 缺席返回 `null`,而 `create()` 在新层里是**立刻建文件**的(老 `ChatStore.create`
   * 只在内存里造一个对象)。所以建会话推到轮子跑完之后 —— 这一条同时保住两条老纪律:
   * ① **空会话不写进磁盘**(起了 TUI 没说话 → `/session list` 里不该冒出一条空的);
   * ② **半轮不入库**(循环抛错 / provider 报错 → 盘上什么都不该有,重试时不该看见半条)。
   */
  const existing = await opts.store.open(opts.sessionId);
  let messages = existing ? await existing.messages() : [];
  let tools = opts.tools ?? [];

  // 内部升档 advisor(pi 座,NOTES 2026-08-10):无参 advisor 工具进本轮工具面,
  // prompt 面随 buildConductorChatSystemPrompt 的工具列举自动到位。recorder 挂 onEvent 链,
  // seed 既往会话 —— advisor 该看到这轮之前聊了什么。
  const advisorRecorder = opts.advisor ? createTranscriptRecorder() : null;
  if (opts.advisor && advisorRecorder) {
    tools = [
      ...tools,
      createAdvisorTool({ advisor: opts.advisor, seatCoord: opts.model, transcript: () => advisorRecorder.serialize() }),
    ];
  }

  // ── 上下文压缩 (S9) ────────────────────────────────────────────────────────
  // 两处都要, 管的不是同一件事:
  //  ① **轮前** —— 管**跨轮**增长。prepareNextTurn 只改这一次 run 内的上下文, 而下一轮
  //     从 ChatStore 重新载入时省下的 token 全回来了。真正让持久会话瘦下来的是这一条。
  //  ② **prepareNextTurn** —— 管**单轮内**工具循环的爆炸式增长 (一轮几十次工具调用)。
  const budgetRatio = opts.contextBudgetRatio ?? 0.85;
  const keepRecentTokens = opts.compactionKeepRecentTokens ?? 20_000;
  const window = piModel.contextWindow;
  const wantCompaction = budgetRatio > 0 && window > 0;
  let compactions = 0;
  /**
   * 压缩当轮, provider 自报的用量这个锚是**失效**的 (agent-leaf 2026-08-01 实测):
   * 压缩删的是最后一条 assistant **前面**的消息, 而那条 assistant 自报的 usage 仍是压缩前的大数
   * → 压完再问"还超不超"永远答"超" —— 压缩照跑照付钱, 然后照样停。锚只失效一轮。
   */
  let usageAnchorStale = false;
  const pureEstimate = (msgs: AgentMessage[]): number => msgs.reduce((n, m) => n + estimateTokens(m), 0);
  const overBudget = (msgs: AgentMessage[]): boolean => {
    const tokens = usageAnchorStale ? pureEstimate(msgs) : estimateContextTokens(msgs).tokens;
    usageAnchorStale = false;
    return tokens >= window * budgetRatio;
  };

  if (wantCompaction && existing && overBudget(messages)) {
    const before = pureEstimate(messages);
    // H4 事务日志 (#185):start → summary → replace → end 四步入 sidecar, 中途崩溃能分辨停在哪一步。
    // 全程 fail-open —— 日志写失败只 warn, 不拦压缩。路径 = 会话 JSONL 的 sidecar。
    const journal = journalPathFor(existing.path);
    writeCompactionJournal(journal, { step: 'start', sessionId: opts.sessionId, tokensBefore: before, at: Date.now() });
    const compacted = await compactChatMessages({
      messages,
      model: opts.model,
      keepRecentTokens,
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.compactionCallModel ? { callModelFn: opts.compactionCallModel } : {}),
    });
    if (compacted) {
      compactions++;
      const beforeCount = messages.length;
      // 立刻**写进会话**: 不写的话下一轮载入的还是老的那一堆, 这次压缩等于白花钱。
      // 落成一条 `compaction` 条目 (append-only), 投影自己会把它之前的东西截掉 ——
      // 这就是 SDD 里"改完数组再全量 save 整块消失"的那一步。
      // H4:entry id 写前一步领好(写进 replace 日志), 与落条的是同一份 —— 恢复时拿它反查 store。
      const entryId = uuidv7();
      writeCompactionJournal(journal, {
        step: 'summary',
        sessionId: opts.sessionId,
        tokensBefore: before,
        summary: compacted.summary,
        retainedTailLength: compacted.retainedTail.length,
        at: Date.now(),
      });
      writeCompactionJournal(journal, {
        step: 'replace',
        sessionId: opts.sessionId,
        summary: compacted.summary,
        retainedTailLength: compacted.retainedTail.length,
        entryId,
        at: Date.now(),
      });
      await existing.appendCompaction({ summary: compacted.summary, tokensBefore: before, retainedTail: compacted.retainedTail, id: entryId });
      clearCompactionJournal(journal); // 干净收尾:删 sidecar (end 不落盘)。
      // ⚠ **重新取投影**, 不用 `compacted.messages`: 存进去的是条目, 而这一轮要发给模型的
      //   必须与下一轮载入时看到的**是同一份**。两处各拼一次就是 S-1 那一族 (都"有内容", 只是不同)。
      messages = await existing.messages();
      logger.info(
        {
          sessionId: opts.sessionId,
          window,
          tokens: `${before}→${pureEstimate(messages)}`,
          msgs: `${beforeCount}→${messages.length}`,
        },
        '[chat-agent] 轮前上下文压缩 —— 已写进会话',
      );
    } else {
      clearCompactionJournal(journal); // 压不动 = 干净结束, 不留半截日志。
      // 压不动不是致命错: 这一轮照跑, 撞窗口由 provider 报。但**不许静默** ——
      // "压缩开着却一次没压成"与"没开压缩"读数上长得一样, 分不开就查不出。
      logger.warn({ sessionId: opts.sessionId, window }, '[chat-agent] 超预算但压不动 (消息太少或切不出点)');
    }
  }

  let systemPrompt = buildConductorChatSystemPrompt({
    cwd: opts.cwd,
    tools,
  });

  // ── 交接读回 (#211) ────────────────────────────────────────────────────────
  // 只在**这条会话的第一轮**注:`existing === null` = 会话文件还没建。往后每轮都注就是
  // 每轮重放一遍上一段,而且会把它自己写进新 checkpoint 里滚雪球。
  // 读的是 markdown 真源不是 facts 镜像(理由见 resume.ts 头注);全程 fail-open,读不到就不注。
  if (existing === null) {
    // 与 Claude Code 那条 hook **同一个函数**: persona 画像 + 上一段交接, 两块各自独立。
    // #211 首版只注了交接 —— 于是 omd 自己比 Claude 那条少一角, 而 omd 才是要建的 harness。
    const opening = buildSessionStartContext({ cwd: opts.cwd });
    if (opening) {
      systemPrompt = `${systemPrompt}\n\n${opening}`;
      logger.info({ sessionId: opts.sessionId, chars: opening.length }, '[session-continuity] 开场上下文已注入');
    }
  }
  if (opts.systemPromptHook) {
    // fail-open: 钩子挂了不该让这一句发不出去; 但不吞证据。
    try {
      systemPrompt = await opts.systemPromptHook(systemPrompt);
    } catch (err) {
      logger.warn({ err: (err as Error).message }, '[chat-agent] systemPrompt 钩子抛了 → 用原串');
    }
  }
  const context: AgentContext = { systemPrompt, messages, tools };
  const thinking = opts.thinkingLevel ?? 'high';
  const config: AgentLoopConfig = {
    model: piModel,
    convertToLlm,
    ...(thinking !== 'off' ? { reasoning: thinking } : {}),
    // 凭证每轮现取(同 agent-leaf: OAuth token 会在长会话中途过期)。
    getApiKey: (p: string) => resolvePiApiKey(p),
    // 两队列钩子直通 (在飞插话 / 轮尾追加)。契约(不许抛)由提供方保证 —— 这里不再包一层,
    // 包了反而把"提供方违约"藏成静默空轮。
    ...(opts.getSteeringMessages ? { getSteeringMessages: opts.getSteeringMessages } : {}),
    ...(opts.getFollowUpMessages ? { getFollowUpMessages: opts.getFollowUpMessages } : {}),
    // 记忆注入走甲类钩子 `transformContext` (S16): 只改这一次请求看到的消息, 不写回 context。
    // C-9: 召回打点路径显式拼 cwd (不吃进程 cwd), INJECTED 从此有盘上痕迹。
    ...(opts.memory
      ? { transformContext: createMemoryTransform({ memory: opts.memory, eventsPath: join(opts.cwd, '.omd', 'recall-events.jsonl') }) }
      : {}),
    // ② 单轮内压缩。顺序是**先压再判停**: 循环先调 prepareNextTurn 换上下文, 再拿换好的
    //    问 shouldStopAfterTurn。于是压成功 → 下一句判据自然在线下, 不停;
    //    压不动 → 下一句接住优雅停。不需要额外的"压过了没"标志位, 也就没有它漂掉的可能。
    ...(wantCompaction
      ? {
          prepareNextTurn: async ({ context: ctx }) => {
            if (!overBudget(ctx.messages)) return undefined;
            const compacted = await compactChatMessages({
              messages: ctx.messages,
              model: opts.model,
              keepRecentTokens,
              ...(opts.signal ? { signal: opts.signal } : {}),
              ...(opts.compactionCallModel ? { callModelFn: opts.compactionCallModel } : {}),
            });
            if (!compacted) return undefined; // 压不动 → 交给 shouldStopAfterTurn 优雅停
            usageAnchorStale = true;
            compactions++;
            logger.info(
              { sessionId: opts.sessionId, msgs: `${ctx.messages.length}→${compacted.messages.length}` },
              '[chat-agent] 轮内上下文压缩 —— 接着跑, 不是交卷',
            );
            // ⚠ 轮**内**这一次不落条目: 它压的是这一次 run 里的工具循环, 而 `returned`
            //   仍是从原始 prompts 起算的完整新增 —— 落一条 compaction 会把还没写进会话的
            //   东西当成"已经在会话里"截掉。跨轮那一半由上面的轮前压缩负责。
            // ⚠ 只换 messages。`systemPrompt` 原样带过去 —— 它是冻结前缀, 动一个字
            // 就是 conductor 侧 prompt-cache 全失效, 而压缩本来是为了省钱。
            return { context: { ...ctx, messages: compacted.messages } };
          },
          shouldStopAfterTurn: ({ context: ctx }) => overBudget(ctx.messages),
        }
      : {}),
  };

  advisorRecorder?.seed(messages);
  const loop = opts.loopFn ?? runAgentLoop;
  const returned = await loop(
    // W5 片1: 有图时 content 变 parts (文本逐字保留 + 图, I2 附件是加不是换); 无图零改动。
    [
      {
        role: 'user',
        content:
          opts.promptImages && opts.promptImages.length > 0
            ? [{ type: 'text', text: opts.prompt }, ...opts.promptImages]
            : opts.prompt,
        timestamp: Date.now(),
      },
    ],
    context,
    config,
    (e) => {
      advisorRecorder?.note(e);
      opts.onEvent?.(e);
    },
    opts.signal,
    streamSimple,
  );

  // provider 错误响亮上抛 (C-5b 同纪律): error 轮不算成功, 不落盘。
  const errored = returned.find(
    (m) => (m as { stopReason?: string }).stopReason === 'error',
  ) as { errorMessage?: string } | undefined;
  if (errored) {
    throw new Error(`[chat-agent] provider 错误: ${errored.errorMessage ?? '(无 errorMessage)'}`);
  }

  // ── 用量进账本 (2026-08-07) ─────────────────────────────────────────────────
  // ⚠ 逐条 emit 不汇总: `returned` 里每条 assistant 都是**一次独立的 provider 调用**,
  // 汇总成一笔会让账本的 `calls` 少算 —— 而 `calls` 是"这一轮打了几次模型"的唯一读数。
  // fail-open: 记账不下沉主流程 (ECON-3), 但不吞证据。
  const usages = turnUsages(returned);
  for (const u of usages) {
    try {
      emitModelUsage(u, opts.model, 'chat');
    } catch (err) {
      logger.warn({ err: (err as Error).message, model: opts.model }, '[chat-agent] 用量入账失败 (已吞, 不影响这一轮)');
    }
  }

  // 会话文件在这一刻才建 (见上方 `existing` 那条注): 到这里这一轮已经成了。
  const session = existing ?? (await opts.store.create(opts.sessionId, titleOf(opts.prompt)));
  // 逐条追加 —— `returned` 含本轮 user prompt 本身 (pi 的返回值 = prompts + 本轮生成)。
  // 串行 await: 同一个 `Session` 实例的写本来就落进 pi 的 enqueue 单链, 抢跑没有意义。
  for (const m of returned) await session.append(m);
  const after = [...messages, ...returned];
  const reply = returned.map(assistantText).join('');
  const pressure = analyzeContextPressure({
    systemPrompt: context.systemPrompt,
    messages: after,
    windowTokens: window,
  });
  // ── 交接写入 (#211) ────────────────────────────────────────────────────────
  // omd 自己的存档出口。**不 await**:蒸馏要打一次模型(秒级),这一轮的回答不等它。
  // 触发口径与 Claude Code 那条共用 `bucket.ts`;`maybeCheckpointOmdSession` 自身全 fail-open。
  void maybeCheckpointOmdSession({
    sessionId: opts.sessionId,
    cwd: opts.cwd,
    entries: () => session.entries(),
    // omd 侧引擎自己握着这个数(CC 那头只能从 transcript 事后推)。
    ctxTokens: pressure.usedTokens,
    compacted: compactions > 0,
  });

  return {
    sessionId: opts.sessionId,
    messageCount: after.length,
    reply,
    newMessages: returned,
    compactions,
    usage: sumUsage(usages),
    pressure,
  };
}
