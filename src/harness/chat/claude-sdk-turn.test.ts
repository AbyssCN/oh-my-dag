/**
 * claude-sdk-turn 契约测试(sdkQueryFn 测试接缝替换真 SDK —— 真 SDK 要真订阅 + claude CLI)。
 * 钉六条:分派路由 / 持久化+账本+映射 / resume 续接 / 失败不落盘(反向自检) /
 * MCP 桥真回路(InMemoryTransport,不摸内部 handler 表) / 工具循环消息映射。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentEvent } from '@earendil-works/pi-agent-core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Type } from 'typebox';
import { observeModelUsage } from '../../model/accounting';
import type { ModelUsage } from '../../model/types';
import type { AnyOmdTool } from '../agent-tools';
import { runChatTurn } from './agent';
import { buildOmdSdkMcpBridge, runChatTurnSdk } from './claude-sdk-turn';
import { type OmdSessionStore, createOmdSessionStore, resetSessionCacheForTest } from './session-store';

const MODEL = 'claude-code:claude-fable-5';
let root: string;
let store: OmdSessionStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'omd-claude-sdk-'));
  resetSessionCacheForTest();
  store = createOmdSessionStore(root);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const mapPath = () => join(root, '.omd', 'chat', 'claude-sdk-sessions.json');

const asst = (text: string, opts: { toolUse?: { id: string; name: string; input: unknown } } = {}): SDKMessage =>
  ({
    type: 'assistant',
    session_id: 'sdk-live',
    message: {
      content: [
        { type: 'text', text },
        ...(opts.toolUse ? [{ type: 'tool_use', id: opts.toolUse.id, name: opts.toolUse.name, input: opts.toolUse.input }] : []),
      ],
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 3 },
      stop_reason: opts.toolUse ? 'tool_use' : 'end_turn',
    },
  }) as unknown as SDKMessage;

const toolResult = (toolUseId: string, text: string): SDKMessage =>
  ({
    type: 'user',
    session_id: 'sdk-live',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: [{ type: 'text', text }] }] },
  }) as unknown as SDKMessage;

const success = (sid: string): SDKMessage =>
  ({
    type: 'result',
    subtype: 'success',
    result: 'done',
    session_id: sid,
    usage: {},
    // 真源口径 (owner 验收 D2): 账行从 result.modelUsage 来, per-message usage 只是兜底。
    modelUsage: {
      'claude-fable-5': { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 2, cacheCreationInputTokens: 3, contextWindow: 1_000_000 },
    },
  }) as unknown as SDKMessage;

const fakeQuery =
  (script: SDKMessage[], seen: { options?: Options } = {}) =>
  (props: { prompt: string; options: Options }) => {
    seen.options = props.options;
    return (async function* () {
      for (const m of script) yield m;
    })();
  };

describe('分派路由', () => {
  test('★ runChatTurn 对 claude-code:* 坐标走 SDK 通道(pi 目录解析不到也能跑)', async () => {
    const r = await runChatTurn({
      store, sessionId: 's1', prompt: '进度如何', model: MODEL, cwd: root, contextFiles: [],
      sdkQueryFn: fakeQuery([asst('两个 run 在跑'), success('sdk-a')]),
    });
    expect(r.reply).toBe('两个 run 在跑');
  });
});

describe('持久化 + 账本 + 会话映射', () => {
  test('★ 首轮:落盘 user+assistant,标题取首条输入,映射写 SDK session_id,usage 逐条入账', async () => {
    const emits: { u: ModelUsage; model: string; origin: string }[] = [];
    const un = observeModelUsage((u, model, origin) => emits.push({ u, model, origin }));
    try {
      const r = await runChatTurnSdk({
        store, sessionId: 's1', prompt: '给我看看 DAG 引擎的进度', model: MODEL, cwd: root, contextFiles: [],
        sdkQueryFn: fakeQuery([asst('好的'), success('sdk-a')]),
      });
      expect(r.messageCount).toBe(2);
      expect((await store.list())[0]?.title).toBe('给我看看 DAG 引擎的进度');
      const s = await store.open('s1');
      expect((await s!.messages()).length).toBe(2);
      // in = 10 直读 + 2 缓存读 + 3 缓存写 = 15;cacheHit ⊆ in
      expect(r.usage).toEqual({ in: 15, out: 5, cacheHit: 2 });
      expect(emits).toEqual([{ u: { in: 15, out: 5, cacheHit: 2 }, model: MODEL, origin: 'chat' }]);
      expect(JSON.parse(readFileSync(mapPath(), 'utf8'))).toEqual({ s1: 'sdk-a' });
    } finally {
      un();
    }
  });

  test('★ advisor:claude-code 坐标 → settings.advisorModel 裸 id;异族坐标 → 不挂(warn 不炸)', async () => {
    const seen: { options?: Options } = {};
    await runChatTurnSdk({
      store, sessionId: 's1', prompt: 'x', model: MODEL, cwd: root, contextFiles: [],
      advisor: 'claude-code:claude-opus-5',
      sdkQueryFn: fakeQuery([asst('好'), success('sdk-a')], seen),
    });
    expect((seen.options?.settings as { advisorModel?: string })?.advisorModel).toBe('claude-opus-5');
    expect(seen.options?.strictMcpConfig).toBe(true); // 全局 MCP 注入 = ~23k/session + 破工具闸

    const seen2: { options?: Options } = {};
    await runChatTurnSdk({
      store, sessionId: 's2', prompt: 'x', model: MODEL, cwd: root, contextFiles: [],
      advisor: 'openai-codex:gpt-5.6-sol',
      sdkQueryFn: fakeQuery([asst('好'), success('sdk-b')], seen2),
    });
    expect(seen2.options?.settings).toBeUndefined();
  });

  test('★ 次轮:resume 带上一轮的 SDK session_id,成功后映射更新为新 id', async () => {
    await runChatTurnSdk({
      store, sessionId: 's1', prompt: '一', model: MODEL, cwd: root, contextFiles: [],
      sdkQueryFn: fakeQuery([asst('答一'), success('sdk-a')]),
    });
    const seen: { options?: Options } = {};
    await runChatTurnSdk({
      store, sessionId: 's1', prompt: '二', model: MODEL, cwd: root, contextFiles: [],
      sdkQueryFn: fakeQuery([asst('答二'), success('sdk-b')], seen),
    });
    expect(seen.options?.resume).toBe('sdk-a');
    expect(JSON.parse(readFileSync(mapPath(), 'utf8'))).toEqual({ s1: 'sdk-b' });
  });
});

describe('失败语义(半轮不入库 —— 本闸的反向自检:两条都先证明它会红)', () => {
  test('★ result subtype 非 success → 响亮抛,会话与映射一个字节不写', async () => {
    await expect(
      runChatTurnSdk({
        store, sessionId: 's1', prompt: 'x', model: MODEL, cwd: root, contextFiles: [],
        sdkQueryFn: fakeQuery([asst('半截'), { type: 'result', subtype: 'error_during_execution', session_id: 'sdk-a' } as unknown as SDKMessage]),
      }),
    ).rejects.toThrow('error_during_execution');
    expect(await store.open('s1')).toBeNull();
    expect(existsSync(mapPath())).toBe(false);
  });

  test('★ 失败路也入账(P1):error result → 抛,但烧掉的 token 已 emit(半轮不入库 ≠ 账外)', async () => {
    const emits: { model: string; origin: string }[] = [];
    const un = observeModelUsage((_u, model, origin) => emits.push({ model, origin }));
    try {
      await expect(
        runChatTurnSdk({
          store, sessionId: 's1', prompt: 'x', model: MODEL, cwd: root, contextFiles: [],
          sdkQueryFn: fakeQuery([asst('半截'), { type: 'result', subtype: 'error_max_turns', session_id: 'sdk-a' } as unknown as SDKMessage]),
        }),
      ).rejects.toThrow('error_max_turns');
      expect(emits).toEqual([{ model: MODEL, origin: 'chat' }]); // 兜底累积行(error result 无 modelUsage)
    } finally {
      un();
    }
  });

  test('★ 流断了没 result → 响亮抛,不落盘', async () => {
    await expect(
      runChatTurnSdk({
        store, sessionId: 's1', prompt: 'x', model: MODEL, cwd: root, contextFiles: [],
        sdkQueryFn: fakeQuery([asst('半截')]),
      }),
    ).rejects.toThrow('没收到 result');
    expect(await store.open('s1')).toBeNull();
  });
});

describe('MCP 桥(InMemoryTransport 真回路)', () => {
  const echoTool = (executed: { args?: unknown } = {}): AnyOmdTool =>
    ({
      name: 'echo',
      label: 'echo',
      description: '回声',
      parameters: Type.Object({ what: Type.String() }),
      execute: async (_id: string, params: { what: string }) => {
        executed.args = params;
        return { content: [{ type: 'text', text: `echo:${params.what}` }], details: {} };
      },
    }) as unknown as AnyOmdTool;

  const connect = async (tools: AnyOmdTool[]) => {
    const bridge = buildOmdSdkMcpBridge(tools);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 't', version: '0' });
    await Promise.all([bridge.instance.server.connect(a), client.connect(b)]);
    return { bridge, client };
  };

  test('★ ListTools 原样透出 TypeBox schema;CallTool 真执行到 OmdTool', async () => {
    const executed: { args?: unknown } = {};
    const { bridge, client } = await connect([echoTool(executed)]);
    expect(bridge.allowedTools).toEqual(['mcp__omd__echo']);
    const listed = await client.listTools();
    expect(listed.tools[0]?.name).toBe('echo');
    expect((listed.tools[0]?.inputSchema as { properties?: Record<string, unknown> }).properties).toHaveProperty('what');
    const r = await client.callTool({ name: 'echo', arguments: { what: 'hi' } });
    expect(executed.args).toEqual({ what: 'hi' });
    expect((r.content as { text?: string }[])[0]?.text).toBe('echo:hi');
  });

  test('★ 未知工具 / 工具抛错 → isError=true 且带 [TOOL ERROR](桥的反向自检)', async () => {
    const boom = {
      name: 'boom', label: 'boom', description: '', parameters: Type.Object({}),
      execute: async () => { throw new Error('炸了'); },
    } as unknown as AnyOmdTool;
    const { client } = await connect([boom]);
    const missing = await client.callTool({ name: 'nope', arguments: {} });
    expect(missing.isError).toBe(true);
    const thrown = await client.callTool({ name: 'boom', arguments: {} });
    expect(thrown.isError).toBe(true);
    expect((thrown.content as { text?: string }[])[0]?.text).toContain('[TOOL ERROR] 炸了');
  });
});

describe('正文事件(TUI 渲染的唯一来源 —— 2026-08-11 实测:通道不发 text_delta 时正文整段不上屏)', () => {
  const deltasOf = (events: AgentEvent[]): string[] =>
    events
      .filter((e): e is Extract<AgentEvent, { type: 'message_update' }> => e.type === 'message_update')
      .map((e) => e.assistantMessageEvent as { type: string; delta?: string })
      .filter((a) => a.type === 'text_delta')
      .map((a) => a.delta ?? '');

  const streamEvt = (text: string): SDKMessage =>
    ({
      type: 'stream_event',
      session_id: 'sdk-live',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    }) as unknown as SDKMessage;

  test('★ SDK 没发增量 → assistant 正文合成一条 text_delta,且先于 message_end(反向自检:去掉合成即红)', async () => {
    const events: AgentEvent[] = [];
    await runChatTurnSdk({
      store, sessionId: 's1', prompt: 'x', model: MODEL, cwd: root, contextFiles: [],
      onEvent: (e) => events.push(e),
      sdkQueryFn: fakeQuery([asst('两个 run 在跑'), success('sdk-a')]),
    });
    expect(deltasOf(events)).toEqual(['两个 run 在跑']);
    const iDelta = events.findIndex((e) => e.type === 'message_update');
    const iEnd = events.findIndex((e) => e.type === 'message_end');
    expect(iDelta).toBeGreaterThanOrEqual(0);
    expect(iDelta).toBeLessThan(iEnd);
  });

  test('★ stream_event 增量逐片转发;assistant 到达时不再补整段(补了正文就是双份)', async () => {
    const events: AgentEvent[] = [];
    await runChatTurnSdk({
      store, sessionId: 's1', prompt: 'x', model: MODEL, cwd: root, contextFiles: [],
      onEvent: (e) => events.push(e),
      sdkQueryFn: fakeQuery([streamEvt('两个 run'), streamEvt(' 在跑'), asst('两个 run 在跑'), success('sdk-a')]),
    });
    expect(deltasOf(events)).toEqual(['两个 run', ' 在跑']);
  });

  test('正文为空的 assistant(纯工具调用轮)不合成空 delta;后续有增量的消息不受前一条影响', async () => {
    const events: AgentEvent[] = [];
    await runChatTurnSdk({
      store, sessionId: 's1', prompt: 'x', model: MODEL, cwd: root, contextFiles: [],
      onEvent: (e) => events.push(e),
      sdkQueryFn: fakeQuery([
        asst('', { toolUse: { id: 'tu-1', name: 'dag_status', input: {} } }),
        toolResult('tu-1', 'running'),
        asst('在跑'),
        success('sdk-a'),
      ]),
    });
    expect(deltasOf(events)).toEqual(['在跑']);
  });
});

describe('工具循环消息映射', () => {
  test('★ tool_use / tool_result 映射成 pi 形状且 toolName 经 id 关联', async () => {
    const r = await runChatTurnSdk({
      store, sessionId: 's1', prompt: '跑一下', model: MODEL, cwd: root, contextFiles: [],
      sdkQueryFn: fakeQuery([
        asst('我调一下工具', { toolUse: { id: 'tu-1', name: 'dag_status', input: { runId: 'r1' } } }),
        toolResult('tu-1', 'running'),
        asst('在跑'),
        success('sdk-a'),
      ]),
    });
    const [, first, result, last] = r.newMessages as unknown as Array<Record<string, unknown>>;
    expect((first!.content as Array<{ type: string; name?: string }>).find((b) => b.type === 'toolCall')?.name).toBe('dag_status');
    expect(result).toMatchObject({ role: 'toolResult', toolCallId: 'tu-1', toolName: 'dag_status', isError: false });
    expect(r.reply).toBe('我调一下工具在跑');
    expect((last!.content as Array<{ type: string }>)[0]?.type).toBe('text');
    expect(r.messageCount).toBe(4); // user + assistant + toolResult + assistant
  });
});
