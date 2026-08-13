/**
 * src/tui/backend-embedded —— **真后端:进程内直调 `runChatTurn`**(TUI SDD §3.1,切片 S10)。
 *
 * ## 这一片之前所有"能用了"都是假的
 *
 * S2..S9 的 `omd tui` 接的是断链说明卡:能打字、能画、能拒绝,**一次都没发给过任何模型**。
 * 这个文件是那条线接上的地方,也是 A2 / A3 达成的地方。
 *
 * ## 与 daemon 是同一条路,不是第二条
 *
 * `serve/daemon.ts` 的 SSE 与这里调的是**同一个 `runChatTurn`、同一批 `chatTools`**。
 * UI 侧只认 `OmdBackend` 那一个形状(SDD §3.1),所以"进程内嵌"与"远程 daemon"两种装配
 * 共用一套 UI 代码 —— 一旦这里长出业务逻辑,两种装配就会开始各自长分支。
 *
 * ## 工具面是 chat 位的白名单,不是 leaf 的全套
 *
 * `createConductorChatTools` 给的是指挥位工具(run/solve/status/图库/地图/记忆召回),
 * **不给文件工具** —— 改文件走图,不走对话。那是 THE-LOOP 的角色红线,不是这一片的取舍。
 */
import type { AgentEvent, AgentMessage } from '@earendil-works/pi-agent-core';
import { estimateTokens } from '@earendil-works/pi-agent-core';
import { logger } from '../logger';
import type { OmdSessionStore } from '../harness/chat/session-store';
import type { AnyOmdTool } from '../harness/agent-tools';
import { type ChatTurnOpts, runChatTurn } from '../harness/chat/agent';
import { type BranchSummaryCallModel, entryKind, entryPreview, planBranchNavigation } from '../harness/chat/branch-summary';
import { type CompactionCallModel, compactChatMessages } from '../harness/chat/compaction';
import type { OmdBackend, OmdTuiEvent, TuiSessionMeta, TuiTreeEntry } from './backend';

export interface EmbeddedBackendDeps {
  cwd: string;
  store: OmdSessionStore;
  /** chat 位工具白名单(`createConductorChatTools` 的产物)。 */
  tools: AnyOmdTool[];
  /**
   * 装配层的**全套** MCP 工具(S14)。`dag_runs` / `dag_resume` 从这里取。
   *
   * ⚠ 与 `tools` 不是一回事:那是 chat 位的白名单(指挥位,不给文件工具);
   * 这里是 UI **自己**要直调的两个只读/续跑口 —— 不经过模型。
   * 省略 → `listRuns` / `resumeRun` 两个能力**不存在**(UI 那边键就不出现)。
   */
  mcpTools?: readonly { readonly name: string; readonly handler: (args: never, extra: never) => unknown }[];
  /**
   * 座位**每轮现解**(INV-MODEL-3):`/seat` 改完,下一句就换座。
   * 起跑时解一次的写法会让切座位在当前会话里静默无效。
   */
  resolveModel: () => string;
  /**
   * omd 自记忆(S16,A8)。给了就每轮召回一次注在消息末尾(advisory)。
   * 省略 = 不注入 —— 与"注入了但一条都没召回到"**不是一回事**。
   */
  memory?: import('../harness/memory/store').OmdMemory;
  /** 扩展的 `before_agent_start` 钩子(S15a)。省略 = 没装扩展。 */
  systemPromptHook?: (prompt: string) => Promise<string>;
  // ⚠ 这里**没有** `usage` 账本(2026-08-09 删)。chat 轮的账由 `runChatTurn` 在轮内
  // 逐条 `emitModelUsage(u, model, 'chat')` 记,装配层订一次钩子即可(`cli.ts`)——
  // 后端再补记一笔合计就是同一轮记两遍(生产账本上留下过 10 对孪生行)。
  /** 测试接缝:替换真轮子。生产不传。 */
  runTurn?: typeof runChatTurn;
  /** 测试接缝:压缩摘要那一次模型调用。生产不传(真 `callModel`, 账本挂在它出口上)。 */
  compactCallModel?: CompactionCallModel;
  /**
   * 测试接缝:**分支摘要**那一次模型调用(台账 §1.3)。生产不传。
   *
   * ⚠ 与 `compactCallModel` 分开而不是共用一个:两条路花的是两笔钱、判词也不同
   * (压缩失败 = 回落优雅停;分支摘要失败 = **不导航**)。共用一个接缝时,测试里
   * "只想让分支摘要塌"就会连带把压缩也换掉,于是量的不再是那一条。
   */
  branchCallModel?: BranchSummaryCallModel;
}

/**
 * 引擎节点事件 → `OmdTuiEvent`(S11)。
 *
 * ⚠ 这个函数由 **`cli.ts` 装配时挂到 `assembleOmdMcpTools({ onNodeEvent })` 上** ——
 * 它不是 backend 的一个方法,因为工具面是在 backend **之前**装配好的
 * (工具要先存在才能交给 `runChatTurn`)。所以后端出一个"往里灌事件"的口子。
 */
export interface DagEventSink {
  pushDagEvent(runId: string, e: unknown): void;
}

interface McpToolLike {
  readonly name: string;
  readonly handler: (args: never, extra: never) => unknown;
}
interface McpResult {
  content?: { type: string; text?: string }[];
  isError?: boolean;
}

const textOf = (r: McpResult): string =>
  (r.content ?? [])
    .map((c) => c.text ?? '')
    .filter(Boolean)
    .join('\n');

export function createEmbeddedBackend(deps: EmbeddedBackendDeps): OmdBackend & DagEventSink {
  const runTurn = deps.runTurn ?? runChatTurn;
  const mcpTool = (name: string): McpToolLike | undefined => deps.mcpTools?.find((t) => t.name === name);
  const invokeText = async (t: McpToolLike, args: unknown): Promise<string> =>
    textOf((await t.handler(args as never, {} as never)) as McpResult);
  /** 每会话一个 controller —— `abortChat` 要能只掐一条会话,不是掐全部。 */
  const inflight = new Map<string, AbortController>();
  let seq = 0;
  let onEvent: ((e: OmdTuiEvent) => void) | undefined;

  const emit = (event: OmdTuiEvent['event'], payload: unknown): void => {
    seq += 1;
    try {
      onEvent?.({ event, payload, seq });
    } catch (err) {
      // 回调抛错不许打断这一轮 —— 但**不许吞证据**(fail-open 的两半)。
      logger.warn({ err: (err as Error).message, event, seq }, '[omd/tui] onEvent 回调抛错 (已吞, 不打断本轮)');
    }
  };

  /** pi 的事件词表 → `OmdTuiEvent` 的 5 种。转不过来的**不发**,不硬塞成 'chat'。 */
  const mapAgentEvent = (e: AgentEvent): void => {
    if (e.type === 'message_update' && e.assistantMessageEvent.type === 'text_delta') {
      emit('chat', { type: 'delta', text: e.assistantMessageEvent.delta });
      return;
    }
    /**
     * ★ **思维链**(2026-08-13 补)。pi 的 `AssistantMessageEvent` 里一直有
     * `thinking_start` / `thinking_delta` / `thinking_end` 三个成员
     * (实读 `pi-ai/dist/types.d.ts:401-413`),而这里**只映射了 `text_delta`** ——
     * 于是整条思维链被"转不过来的不发"那条注释顺手吞掉了。
     *
     * 它转得过来:`chat` 事件的 payload 多一个 `type`,与 `delta` 并列。
     * owner 2026-08-13 的原话:「思维链也看不到」。那不是模型没想,是这里没发。
     *
     * `thinking_end` 也发:UI 靠它**收掉思考条目**,下一段正文才不会续进思考区
     * (与 `session` 事件收尾 assistant 气泡同一条理由)。
     */
    if (e.type === 'message_update' && e.assistantMessageEvent.type === 'thinking_delta') {
      emit('chat', { type: 'thinking', text: e.assistantMessageEvent.delta });
      return;
    }
    if (e.type === 'message_update' && e.assistantMessageEvent.type === 'thinking_end') {
      emit('chat', { type: 'thinking_end' });
      return;
    }
    // ⚠ `id` 是 pi 的 `toolCallId`, **必须带上**:UI 靠它把 end 对回 start 那一行。
    //   此前对回去靠的是**工具名** —— 同一个工具连调两次时, 第一个 end 会去更新
    //   最后一条同名行, 于是屏上"先跑完的那个"标记落在"后开始的那一行"上。
    // ⚠ `args` 原样透传, 由 UI 去挑那半句 —— 后端不做展示决策(挑哪一格是排版, 不是数据)。
    if (e.type === 'tool_execution_start') {
      const t = e as { toolName?: string; toolCallId?: string; args?: unknown };
      emit('tool', { phase: 'start', name: t.toolName ?? '?', id: t.toolCallId, args: t.args });
      return;
    }
    /**
     * ★ **工具跑着的中途读数**(2026-08-14)。pi 的第 3 种工具事件,omd 此前整个丢掉 ——
     * 而丢掉它不只是少画一行:`bash` 那侧根本没接 `onUpdate`,于是这个事件
     * **结构上永远不会到达**。两处一起补才有用(`agent-tools.ts` 的 `onChunk`)。
     *
     * 只发**进度那一格**不发全文:`partialResult.content` 是到目前为止的整段输出,
     * 一条 `bun test` 能有几万字,逐次全量发等于把输出复制几百份进事件流。
     * UI 要的是"它还在动 + 现在到哪了",所以这里给**行数**与**末行**。
     */
    if (e.type === 'tool_execution_update') {
      const t = e as { toolName?: string; toolCallId?: string; partialResult?: { content?: { text?: string }[] } };
      const text = t.partialResult?.content?.map((c) => c.text ?? '').join('') ?? '';
      const lines = text ? text.split('\n') : [];
      emit('tool', {
        phase: 'update',
        name: t.toolName ?? '?',
        id: t.toolCallId,
        lines: lines.length,
        // 末**非空**行 —— 很多命令输出以换行结尾, 取 at(-1) 会恒得空串(读成"没输出")。
        tail: [...lines].reverse().find((l) => l.trim()) ?? '',
      });
      return;
    }
    if (e.type === 'tool_execution_end') {
      const t = e as { toolName?: string; toolCallId?: string; isError?: boolean; result?: { details?: unknown } };
      /**
       * ★ `details` 透传(2026-08-13,owner 点名「工具结果也进屏」)。
       *
       * 屏上此前只有 `✓ grep foo in src/` —— **搜到了什么看不见**,命中 0 处与 300 处
       * 长得一模一样,而这两件事该做的下一步完全不同。
       *
       * ⚠ 只发 `details` **不发 `result.content`**:后者是给模型看的正文,一次 grep
       * 就可能是几万字,灌进事件流等于把整个工具输出复制一份进 UI。
       * `details` 是各工具的结构化契约(`OmdTool<T>` 的类型参数),小且稳定。
       *
       * ⚠ 不在这里渲染成句子 —— 与上面 `args` 那条同一纪律:后端只传数据,
       * 挑哪几格、怎么措辞是排版,归 UI(`render/tool-result.ts`)。
       */
      emit('tool', {
        phase: 'end',
        name: t.toolName ?? '?',
        id: t.toolCallId,
        ok: !t.isError,
        ...(t.result?.details !== undefined ? { details: t.result.details } : {}),
      });
    }
  };

  return {
    // 座位是可变的(`/seat`),所以这里是 getter 而不是构造时算死的常量 ——
    // 算死的话切完座位 footer 还显示旧座, 一个"看起来没换"的假象。
    get connection() {
      return { url: `embedded://${deps.resolveModel()}` };
    },
    set onEvent(fn: ((e: OmdTuiEvent) => void) | undefined) {
      onEvent = fn;
    },
    get onEvent() {
      return onEvent;
    },
    /** 引擎侧灌进来的节点事件。`runId` 一起带上 —— UI 要能分辨换了一个 run。 */
    pushDagEvent(runId: string, e: unknown) {
      emit('dag', { runId, node: e });
    },
    start() {},
    async stop() {
      for (const c of inflight.values()) c.abort();
      inflight.clear();
    },

    async sendChat({ sessionId, prompt }) {
      const controller = new AbortController();
      inflight.set(sessionId, controller);
      try {
        const turn: ChatTurnOpts = {
          store: deps.store,
          sessionId,
          prompt,
          model: deps.resolveModel(),
          cwd: deps.cwd,
          tools: deps.tools,
          onEvent: mapAgentEvent,
          signal: controller.signal,
          ...(deps.memory ? { memory: deps.memory } : {}),
          ...(deps.systemPromptHook ? { systemPromptHook: deps.systemPromptHook } : {}),
        };
        const r = await runTurn(turn);
        // ⚠ 这一轮的账在 `runTurn` **里面**已经逐条记完了 (agent.ts 的 emitModelUsage) ——
        // 这里不许再记一笔合计 (2026-08-09 双计账的原址)。
        // pressure / usage 一起发 —— UI 靠它画"离满还有多远、这一轮花了多少"。
        emit('session', {
          sessionId,
          messageCount: r.messageCount,
          compactions: r.compactions,
          pressure: r.pressure,
          usage: r.usage,
        });
        return { ok: true };
      } finally {
        // ⚠ finally 不是 catch: 抛出去的错要**原样**上到 UI (那里画成 notice 并记日志),
        // 在这里吞掉就变成"发了但没反应"。这里只负责清理在飞表。
        inflight.delete(sessionId);
      }
    },

    async abortChat({ sessionId }) {
      const c = inflight.get(sessionId);
      if (!c) return { ok: true, aborted: false }; // 没有在飞的不是错误
      c.abort();
      inflight.delete(sessionId);
      return { ok: true, aborted: true };
    },

    async loadHistory({ sessionId }): Promise<AgentMessage[]> {
      // 缺席返回空历史 (还没说过话不是错误); 非法 id 仍**响亮抛** —— 那是路径穿越闸。
      return (await (await deps.store.open(sessionId))?.messages()) ?? [];
    },

    // ── /compact: 手动压缩当前会话 ──────────────────────────────────────────
    // 与 agent.ts 轮前压缩同一条路 (202-231): compactChatMessages (真 model call,
    // 账本挂在 callModel 出口, 不许换掉默认值) → appendCompaction 落条目 →
    // 重读投影算 after。`null` = 无可压缩 (会话不存在 / 切不出点) ——
    // "没压" 不是 "压成空的" (compaction.ts:60 同口径)。
    // 两个读数同口径: 逐条 estimateTokens 相加 (agent.ts:192 pureEstimate 先例)。
    async compact({ sessionId }: { sessionId: string }) {
      const session = await deps.store.open(sessionId);
      if (!session) return null;
      const messages = await session.messages();
      const before = messages.reduce((n, m) => n + estimateTokens(m), 0);
      const compacted = await compactChatMessages({
        messages,
        model: deps.resolveModel(),
        ...(deps.compactCallModel ? { callModelFn: deps.compactCallModel } : {}),
      });
      if (!compacted) return null;
      await session.appendCompaction({
        summary: compacted.summary,
        tokensBefore: before,
        retainedTail: compacted.retainedTail,
      });
      const after = await session.messages();
      return {
        tokensBefore: before,
        tokensAfter: after.reduce((n, m) => n + estimateTokens(m), 0),
        messageCount: after.length,
      };
    },

    // ── S14: run 历史与续跑 ────────────────────────────────────────────────
    // 只在装配层工具真的给了的时候才挂上去 —— **能力探测面靠字段在不在**,
    // 不靠一个 `capabilities` 标志位 (两处声明同一件事必漂)。
    ...(mcpTool('dag_runs')
      ? {
          async listRuns(): Promise<string> {
            return invokeText(mcpTool('dag_runs') as McpToolLike, {});
          },
        }
      : {}),
    ...(mcpTool('dag_resume')
      ? {
          async resumeRun({ runId }: { runId: string }): Promise<{ ok: boolean; text: string }> {
            const res = (await (mcpTool('dag_resume') as McpToolLike).handler({ runId } as never, {} as never)) as McpResult;
            // `isError` 是 MCP 侧的**明确否**(没有 checkpoint / 状态不对), 原样带出去 ——
            // 吞成 ok:false 会让"为什么续不了"这个问题问不出答案。
            return { ok: !res.isError, text: textOf(res) };
          },
        }
      : {}),

    async listSessions(): Promise<TuiSessionMeta[]> {
      return (await deps.store.list()).map((m) => ({
        id: m.id,
        title: m.title,
        updatedAt: Date.parse(m.updatedAt) || 0,
        ...(m.parent ? { parent: m.parent } : {}),
      }));
    },

    // ── §1.3: 会话树与 pi 式分支 ────────────────────────────────────────────
    // 读侧走 `allEntries()` (**整棵树**, 不是当前分支): 分支摘要之后被放弃的那一段仍在
    // 文件里, 而 `entries()` 看不见它们 —— 看不见就选不回去, 那条分支等于丢了。
    async sessionTree({ sessionId }: { sessionId: string }): Promise<{ leafId: string | null; entries: TuiTreeEntry[] }> {
      const session = await deps.store.open(sessionId);
      // 会话不存在 = 还没说过话, 不是错误 (同 loadHistory)。leafId 仍是 null —— 空树。
      if (!session) return { leafId: null, entries: [] };
      const entries = await session.allEntries();
      return {
        leafId: await session.leafId(),
        entries: entries.map((e) => ({
          id: e.id,
          parentId: e.parentId,
          seq: e.seq,
          kind: entryKind(e),
          preview: entryPreview(e),
        })),
      };
    },

    // 写侧两步走: `planBranchNavigation` 只算 (读 + 一次模型调用), `navigateTo` 才写 ——
    // 摘要失败时 lane **一步都不动** (fail-closed): 移了 lane 又没有摘要 = 那条分支被放弃
    // 且没有任何交代, 正是本仓 S-1 那一族。
    async branchTo({ sessionId, entryId }: { sessionId: string; entryId: string }): Promise<{ ok: boolean; text: string; summarized: boolean }> {
      const session = await deps.store.open(sessionId);
      if (!session) return { ok: false, text: `no such session: ${sessionId}`, summarized: false };
      try {
        const plan = await planBranchNavigation({
          session: session.tree,
          targetId: entryId,
          model: deps.resolveModel(),
          ...(deps.branchCallModel ? { callModelFn: deps.branchCallModel } : {}),
        });
        if (!plan.ok) return { ok: false, text: plan.error.message, summarized: false };
        await session.navigateTo(entryId, plan.value.entry ?? undefined);
        const text = plan.value.entry
          ? `branched at ${entryId}; ${plan.value.abandoned} entries of the old branch were summarized into a [branch summary] node (they stay in the same file)`
          : `moved to ${entryId}; nothing was abandoned, so no [branch summary] node was written`;
        return { ok: true, text, summarized: plan.value.entry !== null };
      } catch (err) {
        // 条目不存在 / 写锁被别的进程占着都走这里 —— 原文原样带出去, 别吞成一句 "failed"。
        return { ok: false, text: err instanceof Error ? err.message : String(err), summarized: false };
      }
    },

    // 切片⑦: fork 直调 store (显式动作, 立刻建文件)。错误转成 ok:false + 原因原文 ——
    // "为什么 fork 不了"这个问题必须答得出来 (源没写过盘 / id 冲突是两个不同的答案)。
    async forkSession({ fromId, newId }): Promise<{ ok: boolean; text: string }> {
      try {
        const s = await deps.store.fork(fromId, newId);
        return { ok: true, text: `forked ${s.id} from ${fromId} (${(await s.messages()).length} messages)` };
      } catch (err) {
        return { ok: false, text: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
