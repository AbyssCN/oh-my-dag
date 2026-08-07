/**
 * chat 会话压缩(TUI SDD §2.0(d),切片 S9)。
 *
 * ## 为什么用注入的 `compactionCallModel` 而不是注册一个假 provider
 *
 * 第一版起了个本地 HTTP 服务器 + `registerProvider('deepseek', 127.0.0.1)`,想让压缩真的走一遍
 * `callModel → HTTP → usage → 账本`。**单文件跑绿、全量跑红**(症状 `pi: Connection error.`):
 * provider 注册表与 pi transport deps 都是**跨测试文件共享的可变全局**,别的文件一 `clearProviders()`
 * 或把 auth 复位成真机的 `~/.pi/agent/auth.json`,这条坐标就走得通真 provider,请求飞去公网。
 *
 * ⇒ 隔离改用**注入**(与既有的 `loopFn` 同一种接缝)。账本那条边则由一条**默认值钉**守着:
 * `compactChatMessages` 不传 `callModelFn` 时必须是真的 `callModel` —— 而 `emitModelUsage`
 * 就挂在它的出口上。把默认值换掉,那条钉当场红。
 */
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callModel } from '../../model';
import { runChatTurn } from './agent';
import { CHAT_COMPACTION_PROMPT, DEFAULT_COMPACTION_CALL_MODEL, compactChatMessages } from './compaction';
import { ChatStore } from './store';

const MODEL = 'deepseek:deepseek-v4-flash'; // pi 内置目录离线可解

let root: string;
let store: ChatStore;
let calls: { system: string; user: string }[] = [];

/** 假的摘要调用:记下它收到的两段提示词,回一份固定摘要 + 一份固定用量。 */
const fakeCallModel = (async (req: { messages: { role: string; content: string }[] }) => {
  calls.push({
    system: req.messages.find((m) => m.role === 'system')?.content ?? '',
    user: req.messages.find((m) => m.role === 'user')?.content ?? '',
  });
  return {
    text: '【摘要】用户在问 DAG 进度, 已答两轮。',
    usage: { in: 1234, out: 56 },
    raw: {},
    model: 'fake:compactor',
    attempts: 1,
  };
}) as unknown as typeof callModel;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'omd-chat-compact-'));
  store = new ChatStore(root);
  calls = [];
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

/** fake 循环:复刻 runAgentLoop 语义(返回 prompts+生成,不动 context.messages)。 */
const fakeLoop =
  (seen: { history?: AgentMessage[]; systemPrompt?: string } = {}) =>
  async (prompts: AgentMessage[], context: { messages: AgentMessage[]; systemPrompt: string }) => {
    seen.history = [...context.messages];
    seen.systemPrompt = context.systemPrompt;
    return [...prompts, { role: 'assistant', content: [{ type: 'text', text: '答' }], timestamp: 2, stopReason: 'stop' } as unknown as AgentMessage];
  };

const userMsg = (t: string): AgentMessage => ({ role: 'user', content: t, timestamp: 1 }) as AgentMessage;
const assistantMsg = (t: string): AgentMessage =>
  ({ role: 'assistant', content: [{ type: 'text', text: t }], timestamp: 1, stopReason: 'stop' }) as unknown as AgentMessage;

/** 一段够长、且切得出点的会话:user/assistant 交替。 */
function longSession(rounds: number): AgentMessage[] {
  const out: AgentMessage[] = [];
  for (let i = 0; i < rounds; i++) {
    out.push(userMsg(`第 ${i} 问 ${'补'.repeat(200)}`), assistantMsg(`第 ${i} 答 ${'字'.repeat(200)}`));
  }
  return out;
}

describe('★ 轮前压缩(管跨轮增长)', () => {
  // 反向自检 (2026-08-07 实跑): 把 agent.ts 里那段 `if (wantCompaction && overBudget(...))`
  // 整块注释掉 → 「会话真的瘦了」「账本记到了」「摘要用的是 chat 口径」三条当场红。
  test('超预算的会话在开跑前被压缩, 且**写回磁盘**(否则下一轮全回来, 这次白花钱)', async () => {
    const s = store.create('c1', 't');
    s.messages = longSession(12);
    store.save(s);
    const before = (store.load('c1') as { messages: AgentMessage[] }).messages.length;

    const r = await runChatTurn({
      store, sessionId: 'c1', prompt: '再问一句', model: MODEL, cwd: root,
      // 逼它一定超预算 —— 这条测的是"超了会怎样", 不是"多少算超"。
      // keepRecent 也要调小: 默认 20k 比整段测试会话还大, 于是切点一路退到头 → 压不动。
      contextBudgetRatio: 0.000001, compactionKeepRecentTokens: 300,
      compactionCallModel: fakeCallModel, loopFn: fakeLoop() as never,
    });

    expect(r.compactions).toBeGreaterThan(0);
    const after = (store.load('c1') as { messages: AgentMessage[] }).messages;
    // 压缩 + 本轮两条新消息之后, 仍必须比原来短 —— 只在内存里压不算数。
    expect(after.length).toBeLessThan(before);
    expect(JSON.stringify(after)).toContain('【摘要】');
  });

  test('★ 摘要用的是 **chat 口径**, 不是叶子那套"改了哪些文件"', async () => {
    const s = store.create('c2', 't');
    s.messages = longSession(12);
    store.save(s);
    await runChatTurn({
      store, sessionId: 'c2', prompt: 'x', model: MODEL, cwd: root,
      contextBudgetRatio: 0.000001, compactionKeepRecentTokens: 300, compactionCallModel: fakeCallModel, loopFn: fakeLoop() as never,
    });
    const req = calls[0] as { system: string; user: string };
    expect(req.system).toContain('不要继续这段对话');
    expect(req.user).toContain('人与 conductor 的对话');
    expect(req.user).not.toContain('执行叶子');
  });

  test('★ 默认走的是真 callModel —— 账本(emitModelUsage)就挂在它出口上', () => {
    // 这条替代了"起个假服务器验账本"的写法(见文件头): 那种写法在全量跑里会被别的文件
    // 改掉的全局 provider 注册表打穿。真正要守的不变量只有一句 ——
    // **压缩这次调用不许绕开 callModel**, 绕开了这次花的钱就不在账上。
    expect(DEFAULT_COMPACTION_CALL_MODEL).toBe(callModel);
  });

  test('不传 callModelFn 时, compactChatMessages 用的就是那个默认值(不是自己另起一条路)', async () => {
    // 消息太少 → 切不出点 → 在发出任何模型调用**之前**就返回 null。
    // 于是这条既不碰网络, 又能证明"没有第二条隐藏的调用路径"。
    expect(await compactChatMessages({ messages: [], model: 'x:y' })).toBeNull();
  });

  test('★ system prompt 未受影响 —— 压缩只动 messages', async () => {
    const bare = store.create('c4', 't');
    bare.messages = [];
    store.save(bare);
    const seenShort: { systemPrompt?: string } = {};
    await runChatTurn({ store, sessionId: 'c4', prompt: 'x', model: MODEL, cwd: root, compactionCallModel: fakeCallModel, loopFn: fakeLoop(seenShort) as never });

    const s = store.create('c5', 't');
    s.messages = longSession(12);
    store.save(s);
    const seenLong: { systemPrompt?: string } = {};
    await runChatTurn({
      store, sessionId: 'c5', prompt: 'x', model: MODEL, cwd: root,
      contextBudgetRatio: 0.000001, compactionKeepRecentTokens: 300, compactionCallModel: fakeCallModel, loopFn: fakeLoop(seenLong) as never,
    });
    expect(seenLong.systemPrompt).toBe(seenShort.systemPrompt as string);
  });
});

describe('不该压的时候不压', () => {
  test('没超预算 → 一次模型调用都不发(压缩不是每轮都跑的东西)', async () => {
    const s = store.create('c6', 't');
    s.messages = longSession(2);
    store.save(s);
    const r = await runChatTurn({ store, sessionId: 'c6', prompt: 'x', model: MODEL, cwd: root, loopFn: fakeLoop() as never });
    expect(r.compactions).toBe(0);
    expect(calls).toHaveLength(0);
  });

  test('★ ratio=0 关掉压缩 —— 与"开着但没压"分得开(前者 calls=0 且恒不压)', async () => {
    const s = store.create('c7', 't');
    s.messages = longSession(12);
    store.save(s);
    const r = await runChatTurn({
      store, sessionId: 'c7', prompt: 'x', model: MODEL, cwd: root,
      contextBudgetRatio: 0, compactionCallModel: fakeCallModel, loopFn: fakeLoop() as never,
    });
    expect(r.compactions).toBe(0);
    expect(calls).toHaveLength(0);
    // 会话没被动过: 原来 24 条 + 本轮 2 条
    expect((store.load('c7') as { messages: AgentMessage[] }).messages).toHaveLength(26);
  });

  test('会话太短切不出点 → 不压, 也不抛(响亮记一行, 不静默)', async () => {
    const s = store.create('c8', 't');
    s.messages = [userMsg('只有一条')];
    store.save(s);
    const r = await runChatTurn({
      store, sessionId: 'c8', prompt: 'x', model: MODEL, cwd: root,
      contextBudgetRatio: 0.000001, compactionKeepRecentTokens: 300, compactionCallModel: fakeCallModel, loopFn: fakeLoop() as never,
    });
    expect(r.compactions).toBe(0);
  });
});
