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
import { logger } from '../logger';
import type { ChatStore } from '../harness/chat/store';
import type { AnyOmdTool } from '../harness/agent-tools';
import { type ChatTurnOpts, runChatTurn } from '../harness/chat/agent';
import type { OmdBackend, OmdTuiEvent, TuiSessionMeta } from './backend';
import type { ContextFile } from './context';

export interface EmbeddedBackendDeps {
  cwd: string;
  store: ChatStore;
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
  /** conductor 的上下文装配(S4)。屏上显示的与模型吃到的必须是同一份数组。 */
  contextFiles?: ContextFile[];
  /**
   * omd 自记忆(S16,A8)。给了就每轮召回一次注在消息末尾(advisory)。
   * 省略 = 不注入 —— 与"注入了但一条都没召回到"**不是一回事**。
   */
  memory?: import('../harness/memory/store').OmdMemory;
  /** 测试接缝:替换真轮子。生产不传。 */
  runTurn?: typeof runChatTurn;
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
    if (e.type === 'tool_execution_start') {
      emit('tool', { phase: 'start', name: (e as { toolName?: string }).toolName ?? '?' });
      return;
    }
    if (e.type === 'tool_execution_end') {
      emit('tool', {
        phase: 'end',
        name: (e as { toolName?: string }).toolName ?? '?',
        ok: !(e as { isError?: boolean }).isError,
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
          ...(deps.contextFiles ? { contextFiles: deps.contextFiles } : {}),
        };
        const r = await runTurn(turn);
        // pressure / usage 一起发 —— UI 靠它画"离满还有多远、这一轮花了多少"。
        emit('session', {
          sessionId,
          messageCount: r.session.messages.length,
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
      return deps.store.load(sessionId)?.messages ?? [];
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
      return deps.store.list().map((m) => ({
        id: m.id,
        title: m.title,
        updatedAt: Date.parse(m.updatedAt) || 0,
      }));
    },
  };
}
