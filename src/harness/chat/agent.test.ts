/**
 * runChatTurn 契约测试(loopFn 测试接缝替换真循环;模型坐标用 pi-ai 内置目录离线可解的真坐标)。
 * 钉四条:持久化拼接语义 / 历史随轮携带 / 失败不落盘 / provider 错误响亮。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { runChatTurn } from './agent';
import { ChatStore } from './store';

const MODEL = 'deepseek:deepseek-v4-flash'; // pi-ai 内置目录离线可解(agent.test 不发网络请求)
let root: string;
let store: ChatStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'omd-chat-agent-'));
  store = new ChatStore(root);
  delete process.env.OMD_DATA_HOME;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** fake 循环:复刻 runAgentLoop 语义 —— 返回 prompts+生成,不动 context.messages。 */
const fakeLoop =
  (replyText: string, seen: { history?: AgentMessage[] } = {}) =>
  async (prompts: AgentMessage[], context: { messages: AgentMessage[] }): Promise<AgentMessage[]> => {
    seen.history = [...context.messages];
    const reply = {
      role: 'assistant',
      content: [{ type: 'text', text: replyText }],
      timestamp: 2,
      stopReason: 'stop',
    } as unknown as AgentMessage;
    return [...prompts, reply];
  };

describe('持久化拼接语义', () => {
  test('★ 首轮:会话新建 + 标题取自首条输入 + 落盘 = user+assistant 两条', async () => {
    const r = await runChatTurn({
      store, sessionId: 's1', prompt: '给我看看 DAG 引擎的进度', model: MODEL, cwd: root,
      loopFn: fakeLoop('好的,当前有 2 个 run。'),
    });
    expect(r.reply).toBe('好的,当前有 2 个 run。');
    const disk = store.load('s1');
    expect(disk?.title).toBe('给我看看 DAG 引擎的进度');
    expect(disk?.messages.length).toBe(2);
  });

  test('★ 次轮:历史逐字进 context(fake 循环亲眼所见),落盘追加到 4 条', async () => {
    await runChatTurn({ store, sessionId: 's1', prompt: '第一问', model: MODEL, cwd: root, loopFn: fakeLoop('答一') });
    const seen: { history?: AgentMessage[] } = {};
    await runChatTurn({ store, sessionId: 's1', prompt: '第二问', model: MODEL, cwd: root, loopFn: fakeLoop('答二', seen) });
    expect(seen.history?.length).toBe(2); // 上一轮的 user+assistant 都在
    expect((seen.history?.[0] as { content?: string }).content).toBe('第一问');
    expect(store.load('s1')?.messages.length).toBe(4);
  });
});

describe('失败语义(半轮不入库)', () => {
  test('★ 循环抛错 → 不落盘(会话文件不存在)', async () => {
    await expect(
      runChatTurn({
        store, sessionId: 's1', prompt: 'x', model: MODEL, cwd: root,
        loopFn: async () => { throw new Error('boom'); },
      }),
    ).rejects.toThrow('boom');
    expect(store.load('s1')).toBeNull();
  });

  test('★ stopReason=error 的轮 → 响亮抛出 errorMessage,不落盘', async () => {
    const erroredLoop = async (prompts: AgentMessage[]): Promise<AgentMessage[]> => [
      ...prompts,
      { role: 'assistant', content: [], timestamp: 2, stopReason: 'error', errorMessage: 'HTTP 401' } as unknown as AgentMessage,
    ];
    await expect(
      runChatTurn({ store, sessionId: 's1', prompt: 'x', model: MODEL, cwd: root, loopFn: erroredLoop }),
    ).rejects.toThrow('HTTP 401');
    expect(store.load('s1')).toBeNull();
  });

  test('坐标解析不出 → 在进循环前就响亮拒', async () => {
    await expect(
      runChatTurn({ store, sessionId: 's1', prompt: 'x', model: 'ghost:model-x', cwd: root, loopFn: fakeLoop('') }),
    ).rejects.toThrow('解析不出模型');
  });
});
