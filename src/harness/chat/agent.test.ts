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
import { type OmdSessionStore, createOmdSessionStore, resetSessionCacheForTest } from './session-store';

const MODEL = 'deepseek:deepseek-v4-flash'; // pi-ai 内置目录离线可解(agent.test 不发网络请求)
let root: string;
let store: OmdSessionStore;

/** 盘上真有几条(投影口径)。会话不存在 → `null`,与"存在但空"分得开(本仓 NULL ≠ 0)。 */
const persisted = async (id: string): Promise<number | null> => {
  const s = await store.open(id);
  return s ? (await s.messages()).length : null;
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'omd-chat-agent-'));
  resetSessionCacheForTest(); // 单写者表是模块级的 —— 不清会把上一条临时目录的实例带进来
  store = createOmdSessionStore(root);
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

describe('★ 两队列钩子直通 loop config (W1 —— 台账 0 次的字段第一次有供货方)', () => {
  test('给了原样直通, 没给不塞 undefined 占位', async () => {
    // 反向自检 (实跑): 把 agent.ts config 里两条 spread 删掉 → 「原样直通」当场红。
    const seen: { cfg?: Record<string, unknown> } = {};
    const loop = (async (prompts: AgentMessage[], context: { messages: AgentMessage[] }, cfg: Record<string, unknown>) => {
      seen.cfg = cfg;
      return fakeLoop('答')(prompts, context);
    }) as never;
    const steer = async (): Promise<AgentMessage[]> => [];
    await runChatTurn({ store, sessionId: 's1', prompt: 'x', model: MODEL, cwd: root, loopFn: loop, getSteeringMessages: steer });
    expect(seen.cfg?.getSteeringMessages).toBe(steer);
    // 没给的那个不许出现在 config 里 —— 塞个 undefined 键会盖掉 pi 侧"字段在不在"的判断。
    expect('getFollowUpMessages' in (seen.cfg ?? {})).toBe(false);
  });
});

describe('★ W5 片1: 图片附件进开轮消息', () => {
  test('有图 content 变 parts (文本逐字保留在首格); 无图仍是 string 原形', async () => {
    // 反向自检 (实跑): 把 parts 分支删掉恒走 string → 「有图变 parts」当场红。
    const seen: { prompts?: AgentMessage[] } = {};
    const loop = (async (prompts: AgentMessage[], context: { messages: AgentMessage[] }) => {
      seen.prompts = prompts;
      return fakeLoop('答')(prompts, context);
    }) as never;
    const img = { type: 'image' as const, data: 'aGk=', mimeType: 'image/png' };
    await runChatTurn({ store, sessionId: 's1', prompt: '看图 @a.png', model: MODEL, cwd: root, loopFn: loop, promptImages: [img] });
    const c1 = (seen.prompts?.[0] as { content?: unknown })?.content as { type: string; text?: string }[];
    expect(Array.isArray(c1)).toBe(true);
    expect(c1[0]).toEqual({ type: 'text', text: '看图 @a.png' }); // I2: 文本逐字保留
    expect(c1[1]).toMatchObject({ type: 'image', mimeType: 'image/png' });
    await runChatTurn({ store, sessionId: 's2', prompt: '无图', model: MODEL, cwd: root, loopFn: loop });
    expect((seen.prompts?.[0] as { content?: unknown })?.content).toBe('无图'); // 无图路径零改动
  });
});

describe('持久化拼接语义', () => {
  test('★ 首轮:会话新建 + 标题取自首条输入 + 落盘 = user+assistant 两条', async () => {
    const r = await runChatTurn({
      store, sessionId: 's1', prompt: '给我看看 DAG 引擎的进度', model: MODEL, cwd: root,
      loopFn: fakeLoop('好的,当前有 2 个 run。'),
    });
    expect(r.reply).toBe('好的,当前有 2 个 run。');
    expect((await store.list())[0]?.title).toBe('给我看看 DAG 引擎的进度');
    expect(await persisted('s1')).toBe(2);
    expect(r.messageCount).toBe(2);
  });

  test('★ 次轮:历史逐字进 context(fake 循环亲眼所见),磁盘上追加到 4 条', async () => {
    await runChatTurn({ store, sessionId: 's1', prompt: '第一问', model: MODEL, cwd: root, loopFn: fakeLoop('答一') });
    const seen: { history?: AgentMessage[] } = {};
    await runChatTurn({ store, sessionId: 's1', prompt: '第二问', model: MODEL, cwd: root, loopFn: fakeLoop('答二', seen) });
    expect(seen.history?.length).toBe(2); // 上一轮的 user+assistant 都在
    expect((seen.history?.[0] as { content?: string }).content).toBe('第一问');
    expect(await persisted('s1')).toBe(4);
  });
});

describe('失败语义(半轮不入库)', () => {
  test('★ 循环抛错 → 一个字节都不写(会话文件不存在)', async () => {
    await expect(
      runChatTurn({
        store, sessionId: 's1', prompt: 'x', model: MODEL, cwd: root,
        loopFn: async () => { throw new Error('boom'); },
      }),
    ).rejects.toThrow('boom');
    // ★ 换存储层之后这条更硬:新层的 `create()` 是**立刻建文件**的, 所以"会话根本没被建"
    //   要靠"轮子成了才 create"来保 —— 顺手也是空会话不进 `/session list` 的那条老纪律。
    expect(await persisted('s1')).toBeNull();
  });

  test('★ stopReason=error 的轮 → 响亮抛出 errorMessage,一个字节都不写', async () => {
    const erroredLoop = async (prompts: AgentMessage[]): Promise<AgentMessage[]> => [
      ...prompts,
      { role: 'assistant', content: [], timestamp: 2, stopReason: 'error', errorMessage: 'HTTP 401' } as unknown as AgentMessage,
    ];
    await expect(
      runChatTurn({ store, sessionId: 's1', prompt: 'x', model: MODEL, cwd: root, loopFn: erroredLoop }),
    ).rejects.toThrow('HTTP 401');
    expect(await persisted('s1')).toBeNull();
  });

  test('坐标解析不出 → 在进循环前就响亮拒', async () => {
    await expect(
      runChatTurn({ store, sessionId: 's1', prompt: 'x', model: 'ghost:model-x', cwd: root, loopFn: fakeLoop('') }),
    ).rejects.toThrow('解析不出模型');
  });
});
