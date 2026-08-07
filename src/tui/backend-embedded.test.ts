/**
 * L2 判据:进程内嵌后端(TUI SDD §3.1,切片 S10)。
 *
 * `runTurn` 走注入 —— 真轮子要真模型、要网、要钱。这一层证明的只有**接线形状**:
 * 座位每轮现解 / 事件转得对 / abort 掐得准 / 错误原样上抛。
 * 引擎行为本身由 `harness/chat/agent.test.ts` 与 L4 冒烟各管一段。
 */
import type { AgentEvent } from '@earendil-works/pi-agent-core';
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatStore } from '../harness/chat/store';
import type { ChatTurnOpts, ChatTurnResult } from '../harness/chat/agent';
import type { OmdTuiEvent } from './backend';
import { createEmbeddedBackend } from './backend-embedded';

const fresh = () => mkdtempSync(join(tmpdir(), 'omd-tui-embedded-'));

/** 假轮子:记下它收到的 opts,可选地在跑之前发几个 pi 事件。 */
function fakeTurn(opts: { events?: AgentEvent[]; onCall?: (o: ChatTurnOpts) => void; throws?: Error } = {}) {
  return (async (o: ChatTurnOpts): Promise<ChatTurnResult> => {
    opts.onCall?.(o);
    for (const e of opts.events ?? []) o.onEvent?.(e);
    if (opts.throws) throw opts.throws;
    return { session: { messages: [1, 2] } as never, reply: '答', newMessages: [], compactions: 0 };
  }) as never;
}

function make(over: Partial<Parameters<typeof createEmbeddedBackend>[0]> = {}) {
  const cwd = fresh();
  const events: OmdTuiEvent[] = [];
  const backend = createEmbeddedBackend({
    cwd,
    store: new ChatStore(cwd),
    tools: [],
    resolveModel: () => 'deepseek:deepseek-v4-flash',
    runTurn: fakeTurn(),
    ...over,
  });
  backend.onEvent = (e) => events.push(e);
  return { backend, events, cwd };
}

const delta = (text: string): AgentEvent =>
  ({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: text } }) as unknown as AgentEvent;

describe('座位', () => {
  test('★ 座位每轮现解 —— 换了座位, 下一句就换 (不是起跑时算死的)', async () => {
    let seat = 'a:1';
    const seen: string[] = [];
    const { backend } = make({ resolveModel: () => seat, runTurn: fakeTurn({ onCall: (o) => seen.push(o.model) }) });
    await backend.sendChat({ sessionId: 's', prompt: 'x' });
    seat = 'b:2';
    await backend.sendChat({ sessionId: 's', prompt: 'y' });
    expect(seen).toEqual(['a:1', 'b:2']);
  });

  test('★ connection.url 跟着座位变 —— 算死的话切完座 footer 还显示旧座', () => {
    let seat = 'a:1';
    const { backend } = make({ resolveModel: () => seat });
    expect(backend.connection.url).toBe('embedded://a:1');
    seat = 'b:2';
    expect(backend.connection.url).toBe('embedded://b:2');
  });

  test('★ 不是 stub —— url 里不许再出现 stub:// (S10 之后那个文件已删)', () => {
    expect(make().backend.connection.url).not.toContain('stub://');
  });
});

describe('事件转换', () => {
  test('text_delta → chat/delta, seq 单调递增', async () => {
    const { backend, events } = make({ runTurn: fakeTurn({ events: [delta('前'), delta('后')] }) });
    await backend.sendChat({ sessionId: 's', prompt: 'x' });
    const chat = events.filter((e) => e.event === 'chat');
    expect(chat.map((e) => (e.payload as { text: string }).text)).toEqual(['前', '后']);
    expect(events.map((e) => e.seq)).toEqual([...events.map((_, i) => i + 1)]);
  });

  test('工具事件带上名字与成败', async () => {
    const evs = [
      { type: 'tool_execution_start', toolName: 'run' },
      { type: 'tool_execution_end', toolName: 'run', isError: true },
    ] as unknown as AgentEvent[];
    const { backend, events } = make({ runTurn: fakeTurn({ events: evs }) });
    await backend.sendChat({ sessionId: 's', prompt: 'x' });
    expect(events.filter((e) => e.event === 'tool').map((e) => e.payload)).toEqual([
      { phase: 'start', name: 'run' },
      { phase: 'end', name: 'run', ok: false },
    ]);
  });

  test('★ 转不过来的事件**不发** —— 不硬塞成 chat (词表钉死 5 种)', async () => {
    const evs = [{ type: 'agent_start' }, { type: 'turn_end' }] as unknown as AgentEvent[];
    const { backend, events } = make({ runTurn: fakeTurn({ events: evs }) });
    await backend.sendChat({ sessionId: 's', prompt: 'x' });
    expect(events.filter((e) => e.event === 'chat')).toHaveLength(0);
  });

  test('一轮结束发一个 session 事件(UI 拿它收尾流式)', async () => {
    const { backend, events } = make();
    await backend.sendChat({ sessionId: 's', prompt: 'x' });
    expect(events.at(-1)?.event).toBe('session');
  });

  test('★ onEvent 回调抛错不打断这一轮', async () => {
    const { backend } = make({ runTurn: fakeTurn({ events: [delta('a')] }) });
    backend.onEvent = () => {
      throw new Error('UI 炸了');
    };
    expect((await backend.sendChat({ sessionId: 's', prompt: 'x' })).ok).toBe(true);
  });
});

describe('失败与中断', () => {
  test('★ 轮子抛错**原样上抛** —— 在后端吞掉就变成"发了但没反应"', async () => {
    const { backend } = make({ runTurn: fakeTurn({ throws: new Error('provider 429') }) });
    expect(backend.sendChat({ sessionId: 's', prompt: 'x' })).rejects.toThrow('provider 429');
  });

  test('抛错之后在飞表要清干净(否则这条会话再也 abort 不掉)', async () => {
    const { backend } = make({ runTurn: fakeTurn({ throws: new Error('boom') }) });
    await backend.sendChat({ sessionId: 's', prompt: 'x' }).catch(() => {});
    expect(await backend.abortChat({ sessionId: 's' })).toEqual({ ok: true, aborted: false });
  });

  test('★ 没有在飞的轮 → aborted:false, 但不是错误(ok:true)', async () => {
    expect(await make().backend.abortChat({ sessionId: 'nope' })).toEqual({ ok: true, aborted: false });
  });

  test('★ abort 只掐点名的那条会话', async () => {
    const seen = new Map<string, AbortSignal>();
    const { backend } = make({
      runTurn: (async (o: ChatTurnOpts) => {
        seen.set(o.sessionId, o.signal as AbortSignal);
        await new Promise((r) => setTimeout(r, 30));
        return { session: { messages: [] } as never, reply: '', newMessages: [], compactions: 0 };
      }) as never,
    });
    const a = backend.sendChat({ sessionId: 'A', prompt: 'x' });
    const b = backend.sendChat({ sessionId: 'B', prompt: 'y' });
    await new Promise((r) => setTimeout(r, 5));
    expect(await backend.abortChat({ sessionId: 'A' })).toEqual({ ok: true, aborted: true });
    expect(seen.get('A')?.aborted).toBe(true);
    expect(seen.get('B')?.aborted).toBe(false);
    await Promise.all([a, b]);
  });

  test('stop() 掐掉所有在飞的轮', async () => {
    const seen: AbortSignal[] = [];
    const { backend } = make({
      runTurn: (async (o: ChatTurnOpts) => {
        seen.push(o.signal as AbortSignal);
        await new Promise((r) => setTimeout(r, 30));
        return { session: { messages: [] } as never, reply: '', newMessages: [], compactions: 0 };
      }) as never,
    });
    const p = backend.sendChat({ sessionId: 'A', prompt: 'x' });
    await new Promise((r) => setTimeout(r, 5));
    await backend.stop();
    expect(seen[0]?.aborted).toBe(true);
    await p;
  });
});

describe('会话读侧', () => {
  test('没有的会话 → 空历史, 不抛', async () => {
    expect(await make().backend.loadHistory({ sessionId: 'never-created' })).toEqual([]);
  });

  test('★ 非法会话 id **响亮抛** —— ChatStore 的路径白名单穿过这一层没有被吞掉', async () => {
    // 初版这条用了一个中文 id 当"不存在", 结果撞上白名单当场红 —— 那不是 bug,
    // 是 `ChatStore` 防路径穿越的闸。把它钉住: 这一层不许把它降级成"返回空历史"。
    expect(make().backend.loadHistory({ sessionId: '../逃逸' })).rejects.toThrow('非法会话 id');
  });

  test('listSessions 读的是真 ChatStore', async () => {
    const cwd = fresh();
    const store = new ChatStore(cwd);
    const s = store.create('s1', '标题');
    s.messages = [{ role: 'user', content: 'hi', timestamp: 1 } as never];
    store.save(s);
    const backend = createEmbeddedBackend({
      cwd, store, tools: [], resolveModel: () => 'a:1', runTurn: fakeTurn(),
    });
    expect((await backend.listSessions()).map((m) => m.id)).toEqual(['s1']);
  });
});

describe('★ S14: run 能力靠字段在不在探测, 不靠标志位', () => {
  const runsTool = (text: string, isError = false) => ({
    name: 'dag_runs',
    handler: () => ({ content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) }),
  });
  const resumeTool = (text: string, isError = false) => ({
    name: 'dag_resume',
    handler: (a: { runId: string }) => ({
      content: [{ type: 'text', text: `${text}${a?.runId ? ` (${a.runId})` : ''}` }],
      ...(isError ? { isError: true } : {}),
    }),
  });

  test('★ 没给 mcpTools → 两个方法**不存在**(UI 那边键就不出现, 不是点了没反应)', () => {
    const { backend } = make();
    expect(backend.listRuns).toBeUndefined();
    expect(backend.resumeRun).toBeUndefined();
  });

  test('★ 只给了 dag_runs → 只有 listRuns 存在(逐个探测, 不是一个总开关)', () => {
    const { backend } = make({ mcpTools: [runsTool('r1 done')] as never });
    expect(typeof backend.listRuns).toBe('function');
    expect(backend.resumeRun).toBeUndefined();
  });

  test('listRuns 把工具的文本原样带出来', async () => {
    const { backend } = make({ mcpTools: [runsTool('r1  failed  2026  把活干了')] as never });
    expect(await backend.listRuns?.()).toBe('r1  failed  2026  把活干了');
  });

  test('resumeRun 把 runId 传下去', async () => {
    const { backend } = make({ mcpTools: [resumeTool('resuming')] as never });
    expect(await backend.resumeRun?.({ runId: 'abc' })).toEqual({ ok: true, text: 'resuming (abc)' });
  });

  test('★ 工具说 isError → ok:false 且**原因原样带出**(吞掉就问不出为什么续不了)', async () => {
    const { backend } = make({ mcpTools: [resumeTool('no checkpoint for run abc', true)] as never });
    const r = await backend.resumeRun?.({ runId: 'abc' });
    expect(r?.ok).toBe(false);
    expect(r?.text).toContain('no checkpoint');
  });
});
