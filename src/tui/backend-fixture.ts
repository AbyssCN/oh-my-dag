/**
 * src/tui/backend-fixture —— **L3 专用的假后端**(TUI SDD §9 第三层,切片 S10)。
 *
 * ## 它取代了 `backend-stub.ts`,但**不是同一件事**
 *
 * `backend-stub` 是断链说明卡:引擎还没接通时的**生产**默认值,零假数据。
 * S10 接通之后它该死 —— 留着当 fallback 会让"引擎挂了"静默退化成"看起来在用"。
 *
 * 这个文件相反:它**只在 `OMD_TUI_BACKEND=fixture` 时被装**,存在的唯一理由是
 * SDD §9 那条「L3 = fixture backend + 真 PTY」—— PTY lane 要证明 UI 循环、渲染、
 * 按键、流式装配是通的,而**不能**因此去打真模型(要钱、要网、读数还不稳定)。
 *
 * ## 它凭什么不算"假数据"
 *
 * 因为它**自报家门**:`connection.url === 'fixture://l3-test'`,而那串字符会画在 footer 上。
 * 判据不是"有没有编内容",是"读的人会不会误以为这是真的"。生产路径上它装不进来
 * (env 没设就走 embedded),PTY 上它写在屏幕正中间。
 */
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { OmdBackend, OmdTuiEvent, TuiSessionMeta } from './backend';

/** footer 上会显示这一串。PTY 断言它 —— 生产里出现即说明装错了后端。 */
export const FIXTURE_URL = 'fixture://l3-test';

/** 固定回复分两片发 —— 流式装配的判据要的就是"分批到达仍恰好出现一次"。 */
export const FIXTURE_CHUNKS = ['已收到。', '这是 fixture 后端, 没有发给任何模型。'] as const;

export function createFixtureBackend(): OmdBackend {
  let seq = 0;
  let onEvent: ((e: OmdTuiEvent) => void) | undefined;
  const sessions = new Map<string, AgentMessage[]>();

  const emit = (event: OmdTuiEvent['event'], payload: unknown): void => {
    seq += 1;
    onEvent?.({ event, payload, seq });
  };

  return {
    connection: { url: FIXTURE_URL },
    set onEvent(fn: ((e: OmdTuiEvent) => void) | undefined) {
      onEvent = fn;
    },
    get onEvent() {
      return onEvent;
    },
    start() {},
    stop() {},
    async sendChat({ sessionId, prompt }) {
      const msgs = sessions.get(sessionId) ?? [];
      msgs.push({ role: 'user', content: prompt, timestamp: Date.now() } as AgentMessage);
      // 工具事件也发一对: PTY 要能验"工具在跑"这条线也接得上。
      emit('tool', { phase: 'start', name: 'fixture_tool' });
      emit('tool', { phase: 'end', name: 'fixture_tool', ok: true });
      for (const text of FIXTURE_CHUNKS) emit('chat', { type: 'delta', text });
      emit('session', { sessionId, messageCount: msgs.length + 1 });
      sessions.set(sessionId, msgs);
      return { ok: true };
    },
    async abortChat() {
      return { ok: true, aborted: false };
    },
    async loadHistory({ sessionId }): Promise<AgentMessage[]> {
      return sessions.get(sessionId) ?? [];
    },
    async listSessions(): Promise<TuiSessionMeta[]> {
      return [...sessions.keys()].map((id) => ({ id, title: id, updatedAt: 0 }));
    },
  };
}
