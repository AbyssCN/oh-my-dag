/**
 * L2 判据:进程内嵌后端(TUI SDD §3.1,切片 S10)。
 *
 * `runTurn` 走注入 —— 真轮子要真模型、要网、要钱。这一层证明的只有**接线形状**:
 * 座位每轮现解 / 事件转得对 / abort 掐得准 / 错误原样上抛。
 * 引擎行为本身由 `harness/chat/agent.test.ts` 与 L4 冒烟各管一段。
 */
import type { AgentEvent, AgentMessage } from '@earendil-works/pi-agent-core';
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOmdSessionStore } from '../harness/chat/session-store';
import { runChatTurn, type ChatTurnOpts, type ChatTurnResult } from '../harness/chat/agent';
import { observeModelUsage } from '../model/accounting';
import type { OmdTuiEvent } from './backend';
import { createEmbeddedBackend } from './backend-embedded';
import { createTuiUsageLedger, type UsageRecord } from './usage/ledger';

const fresh = () => mkdtempSync(join(tmpdir(), 'omd-tui-embedded-'));

/** 假轮子:记下它收到的 opts,可选地在跑之前发几个 pi 事件。 */
function fakeTurn(opts: { events?: AgentEvent[]; onCall?: (o: ChatTurnOpts) => void; throws?: Error } = {}) {
  return (async (o: ChatTurnOpts): Promise<ChatTurnResult> => {
    opts.onCall?.(o);
    for (const e of opts.events ?? []) o.onEvent?.(e);
    if (opts.throws) throw opts.throws;
    return { sessionId: o.sessionId, messageCount: 2, reply: '答', newMessages: [], compactions: 0, usage: { in: 0, out: 0 }, pressure: { systemTokens: 0, harnessTokens: 0, historyTokens: 0, usedTokens: 0, windowTokens: 0, ratio: null } };
  }) as never;
}

function make(over: Partial<Parameters<typeof createEmbeddedBackend>[0]> = {}) {
  const cwd = fresh();
  const events: OmdTuiEvent[] = [];
  const backend = createEmbeddedBackend({
    cwd,
    store: createOmdSessionStore(cwd),
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

  /**
   * ★ 思维链(2026-08-13)。owner 原话「思维链也看不到」—— 根因就在这里:
   * 这个映射表**只有 `text_delta`**,pi 的 `thinking_*` 三兄弟一条都没转。
   *
   * 反向自检(实跑):把 `mapAgentEvent` 里 `thinking_delta` 那个分支删掉 → 第 1 条当场红。
   */
  test('★ thinking_delta → chat/thinking(此前整条思维链被丢掉)', async () => {
    const think = (t: string) =>
      ({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: t } }) as unknown as AgentEvent;
    const end = { type: 'message_update', assistantMessageEvent: { type: 'thinking_end' } } as unknown as AgentEvent;
    const { backend, events } = make({ runTurn: fakeTurn({ events: [think('想'), think('完了'), end, delta('答')] }) });
    await backend.sendChat({ sessionId: 's', prompt: 'x' });
    expect(events.filter((e) => e.event === 'chat').map((e) => e.payload)).toEqual([
      { type: 'thinking', text: '想' },
      { type: 'thinking', text: '完了' },
      { type: 'thinking_end' },
      { type: 'delta', text: '答' },
    ]);
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

  /**
   * ★ `details` 透传(2026-08-13,owner 点名「工具结果也进屏」)。
   *
   * 两条判据是一对:**要传 `details`**、**不要传 `content`**。后者是给模型看的正文,
   * 一次 grep 可能几万字 —— 灌进事件流等于把整个工具输出复制一份进 UI。
   *
   * 反向自检(实跑):把 `mapAgentEvent` 里 `t.result?.details` 那一段删掉 → 第 1 条当场红。
   */
  test('★ tool_execution_end 透传 details(而不是整个 result)', async () => {
    const evs = [
      {
        type: 'tool_execution_end',
        toolName: 'grep',
        toolCallId: 'c1',
        isError: false,
        result: { content: [{ type: 'text', text: '几万字的正文' }], details: { matches: 8, files: 3 } },
      },
    ] as unknown as AgentEvent[];
    const { backend, events } = make({ runTurn: fakeTurn({ events: evs }) });
    await backend.sendChat({ sessionId: 's', prompt: 'x' });
    const payload = events.find((e) => e.event === 'tool')?.payload as Record<string, unknown>;
    expect(payload.details).toEqual({ matches: 8, files: 3 });
    expect(JSON.stringify(payload)).not.toContain('几万字的正文');
  });

  /**
   * ★ 中途读数(2026-08-14)。两条判据是一对:**要发进度**、**不要发全文** ——
   * `partialResult.content` 是到目前为止的整段输出,逐次全量发等于把输出复制几百份进事件流。
   */
  test('★ tool_execution_update → phase:update, 只发行数与末行', async () => {
    const evs = [
      {
        type: 'tool_execution_update',
        toolName: 'bash',
        toolCallId: 'u1',
        partialResult: { content: [{ type: 'text', text: 'line-1\nline-2\nline-3\n' }] },
      },
    ] as unknown as AgentEvent[];
    const { backend, events } = make({ runTurn: fakeTurn({ events: evs }) });
    await backend.sendChat({ sessionId: 's', prompt: 'x' });
    const payload = events.find((e) => e.event === 'tool')?.payload as Record<string, unknown>;
    // 4 行 = 三行正文 + 末尾换行切出来的空串(行数是"到哪了"的读数, 不做美化)。
    expect(payload).toEqual({ phase: 'update', name: 'bash', id: 'u1', lines: 4, tail: 'line-3' });
    expect(JSON.stringify(payload)).not.toContain('line-1');
  });

  test('★ 末行取最后一个**非空**行 —— 输出以换行结尾时 at(-1) 恒是空串', async () => {
    const evs = [
      { type: 'tool_execution_update', toolName: 'bash', toolCallId: 'u2', partialResult: { content: [{ type: 'text', text: 'done\n\n\n' }] } },
    ] as unknown as AgentEvent[];
    const { backend, events } = make({ runTurn: fakeTurn({ events: evs }) });
    await backend.sendChat({ sessionId: 's', prompt: 'x' });
    expect((events.find((e) => e.event === 'tool')?.payload as { tail: string }).tail).toBe('done');
  });

  test('没有 details 的工具:键**不出现**(与 details 是 undefined 分得开)', async () => {
    const evs = [{ type: 'tool_execution_end', toolName: 'x', toolCallId: 'c2', isError: false, result: {} }] as unknown as AgentEvent[];
    const { backend, events } = make({ runTurn: fakeTurn({ events: evs }) });
    await backend.sendChat({ sessionId: 's', prompt: 'x' });
    expect(events.find((e) => e.event === 'tool')?.payload).toEqual({ phase: 'end', name: 'x', id: 'c2', ok: true });
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
        return { sessionId: o.sessionId, messageCount: 0, reply: '', newMessages: [], compactions: 0, usage: { in: 0, out: 0 }, pressure: { systemTokens: 0, harnessTokens: 0, historyTokens: 0, usedTokens: 0, windowTokens: 0, ratio: null } };
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
        return { sessionId: o.sessionId, messageCount: 0, reply: '', newMessages: [], compactions: 0, usage: { in: 0, out: 0 }, pressure: { systemTokens: 0, harnessTokens: 0, historyTokens: 0, usedTokens: 0, windowTokens: 0, ratio: null } };
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

  test('★ 非法会话 id **响亮抛** —— store 的路径白名单穿过这一层没有被吞掉', async () => {
    // 初版这条用了一个中文 id 当"不存在", 结果撞上白名单当场红 —— 那不是 bug,
    // 是存储层防路径穿越的闸。把它钉住: 这一层不许把它降级成"返回空历史"。
    expect(make().backend.loadHistory({ sessionId: '../逃逸' })).rejects.toThrow('非法会话 id');
  });

  test('listSessions / loadHistory 读的是真 store(不是内存里的一份影子)', async () => {
    const cwd = fresh();
    const store = createOmdSessionStore(cwd);
    const s = await store.create('s1', '标题');
    await s.append({ role: 'user', content: 'hi', timestamp: 1 } as never);
    const backend = createEmbeddedBackend({
      cwd, store, tools: [], resolveModel: () => 'a:1', runTurn: fakeTurn(),
    });
    expect((await backend.listSessions()).map((m) => m.id)).toEqual(['s1']);
    expect((await backend.loadHistory({ sessionId: 's1' })).length).toBe(1);
  });
});

describe('★ 一轮 chat 只上一次账 (2026-08-09 双计账修复)', () => {
  // 反向自检 (实跑): 把 backend-embedded 那段轮末补记加回去 ——
  //   `if (r.usage && ...) deps.usage?.record(r.usage, deps.resolveModel(), 'chat');`
  // → 这条当场红成 calls=3 / in=600 (逐条 100+200 之外多出一笔合计 300)。
  // 那正是修复前的生产形状: 账本上 in/out 相同、相差 1-5ms 的孪生行。
  const u = (input: number, output: number) => ({ input, output, cacheRead: 0, cacheWrite: 0, totalTokens: 0 });
  const assistant = (text: string, usage: ReturnType<typeof u>): AgentMessage =>
    ({ role: 'assistant', content: [{ type: 'text', text }], timestamp: 1, stopReason: 'stop', usage }) as unknown as AgentMessage;

  test('★ 两次 provider 调用 = 账本两行 (in 合计 300), 且两行都记成 chat', async () => {
    const cwd = fresh();
    const led = createTuiUsageLedger({ dir: cwd });
    const rows: UsageRecord[] = [];
    // 与 cli.ts 的装配同形状: 账本的**唯一**入口就是这条订阅, source 照抄 emit 侧的第三参。
    const detach = observeModelUsage((usage, model, origin) => rows.push(led.record(usage, model, origin)));
    try {
      const backend = createEmbeddedBackend({
        cwd,
        store: createOmdSessionStore(cwd),
        tools: [],
        resolveModel: () => 'deepseek:deepseek-v4-flash',
        // 真 `runChatTurn` + 假循环 —— 逐条 emit 那一段必须真的跑到 (假轮子会绕过它)。
        runTurn: ((o: ChatTurnOpts): Promise<ChatTurnResult> =>
          runChatTurn({
            ...o,
            loopFn: (async (prompts: AgentMessage[]) => [
              ...prompts,
              assistant('答一', u(100, 10)),
              assistant('答二', u(200, 20)),
            ]) as never,
          })) as never,
      });
      await backend.sendChat({ sessionId: 's', prompt: 'q' });
      const w = led.window();
      expect(w.calls).toBe(2);
      expect(w.in).toBe(300);
      expect(rows.map((r) => r.source)).toEqual(['chat', 'chat']);
    } finally {
      detach();
    }
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

/**
 * §1.3(2026-08-11):会话树与 pi 式分支的接线。
 *
 * 引擎行为(摘要挂在谁下面 / 旧分支不丢 / 模型看得到)由
 * `harness/chat/branch-summary.test.ts` 管;这里只量**接线**:
 * 能力探测面、树的取材是不是整棵树、以及那条 **fail-closed** ——
 * 摘要失败时后端不许把会话切过去。
 */
describe('★ 会话树与分支(§1.3)', () => {
  const msg = (text: string): AgentMessage => ({ role: 'user', content: [{ type: 'text', text }], timestamp: 1 }) as unknown as AgentMessage;

  /** 假的摘要调用:回一份固定摘要 / 或塌掉。 */
  const okCall = (async () => ({ text: '## Goal\n那条分支在试别的路子', usage: { in: 1, out: 1 }, raw: {}, model: 'fake:branch', attempts: 1 })) as never;
  const badCall = (async () => {
    throw new Error('provider said no');
  }) as never;

  /** 造一条四消息的会话, 返回后端与第二条条目的 id(= 回去重走的落点)。 */
  const seeded = async (branchCallModel: unknown = okCall) => {
    const m = make({ branchCallModel: branchCallModel as never });
    // ⚠ 这里另开一个 store 实例是安全的:单写者表是**模块级按路径**的, 同一份文件
    //   拿到的仍是同一个 `Session`(session-store 文件头第 1 条)。
    const store = createOmdSessionStore(m.cwd);
    const sess = await store.create('s', 't');
    for (const t of ['一问', '一答', '二问 —— 要被放弃', '二答 —— 要被放弃']) await sess.append(msg(t));
    const tree = await m.backend.sessionTree?.({ sessionId: 's' });
    return { ...m, forkPoint: tree?.entries[1]?.id as string, tree };
  };

  test('★ 取材是**整棵树**, 不是当前分支 —— 被放弃的那一支必须还在里面', async () => {
    // 反向自检(实跑): 把 backend 里的 `allEntries()` 换成 `entries()` → 分支之后
    // 旧分支那两条消失, 这条当场红(而树看起来仍然完整)。
    const { backend, forkPoint } = await seeded();
    expect((await backend.branchTo?.({ sessionId: 's', entryId: forkPoint }))?.ok).toBe(true);
    const after = await backend.sessionTree?.({ sessionId: 's' });
    expect(after?.entries.map((e) => e.kind)).toContain('branch_summary');
    // 四条 message 一条不少 + 新增那条摘要 = 5。
    expect(after?.entries).toHaveLength(5);
    expect(JSON.stringify(after?.entries)).toContain('二答');
    // 叶换成了新分支的那条摘要。
    expect(after?.entries.find((e) => e.id === after.leafId)?.kind).toBe('branch_summary');
  });

  test('★★ fail-closed:摘要失败 → **不切**(leafId 一动不动), 判词原样带出', async () => {
    // 反向自检(实跑): 把 branchTo 里的 `if (!plan.ok) return` 去掉、失败也照样 navigateTo
    // → 后两句当场红, 而红出来的正是那个静默态: 分支被放弃且没有任何交代。
    const { backend, forkPoint, tree } = await seeded(badCall);
    const r = await backend.branchTo?.({ sessionId: 's', entryId: forkPoint });
    expect(r?.ok).toBe(false);
    expect(r?.text).toContain('provider said no');
    expect(r?.summarized).toBe(false);
    const after = await backend.sessionTree?.({ sessionId: 's' });
    expect(after?.leafId).toBe(tree?.leafId as string);
    expect(after?.entries.some((e) => e.kind === 'branch_summary')).toBe(false);
  });

  test('★ `summarized:false` 与 `ok:false` 不是一回事 —— 切到当前叶 = 切成了但没什么可交代', async () => {
    const { backend, tree } = await seeded();
    const r = await backend.branchTo?.({ sessionId: 's', entryId: tree?.leafId as string });
    expect(r?.ok).toBe(true);
    expect(r?.summarized).toBe(false);
    expect(r?.text).toContain('no [branch summary] node');
  });

  test('会话不存在:树是空的(不是抛), 而 branchTo 明确说不(不是静默成功)', async () => {
    const { backend } = make();
    expect(await backend.sessionTree?.({ sessionId: 'nope' })).toEqual({ leafId: null, entries: [] });
    const r = await backend.branchTo?.({ sessionId: 'nope', entryId: 'x' });
    expect(r?.ok).toBe(false);
    expect(r?.text).toContain('no such session');
  });
});
