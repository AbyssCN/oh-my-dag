/**
 * runChatTurn 的**交接接线**闸(#211)。
 *
 * 为什么单开一件:零件闸(`test/core/session-omd-continuity.test.ts`)证的是来源缝、触发口径、
 * 读回面各自成立;**接线**是另一回事。#206 的病就是"零件全绿、没人调它" —— 所以这里打的是
 * `runChatTurn` 本身:
 *   - 新会话第一轮,上一段的交接**真的进了 system prompt**(fake 循环亲眼所见);
 *   - 轮尾**真的派了存档**(盘上出现 checkpoint.md)。
 *
 * 反向自检(实跑):
 *   - 把 agent.ts 里 `readResumeBrief` 那一段删掉 → 「进 system prompt」当场红;
 *   - 把轮尾 `void maybeCheckpointOmdSession(...)` 删掉 → 「派了存档」当场红。
 *
 * 模型调用:`OMD_CONTINUITY_MECHANICAL=1` 跳过蒸馏那一发(与 CC hook 同旋钮)。
 * ⚠ 不设这个 env 的既有 chat 测试**不会**被误触发:fake 循环那两条消息的 ctx 远在默认 200k 档以下。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { runChatTurn } from './agent';
import { type OmdSessionStore, createOmdSessionStore, resetSessionCacheForTest } from './session-store';
import { runWriter } from '../session/writer';
import { omdSessionSource } from '../session/source';
import { resetOmdCheckpointStateForTest } from '../session/omd-checkpoint';
import { createDefaultMemory } from '../../mcp/assemble';
import { listCheckpoints } from '../session/sink';

const MODEL = 'deepseek:deepseek-v4-flash'; // pi-ai 内置目录离线可解(本件不发网络请求)
let root: string;
let store: OmdSessionStore;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'omd-chat-continuity-'));
  resetSessionCacheForTest();
  resetOmdCheckpointStateForTest();
  for (const k of ['OMD_DATA_HOME', 'OMD_SESSION_BUCKET', 'OMD_CONTINUITY_MECHANICAL', 'MEMORY_HUB_DATA']) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  store = createOmdSessionStore(root);
});
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(root, { recursive: true, force: true });
});

const fakeLoop =
  (replyText: string, seen: { systemPrompt?: string } = {}) =>
  async (
    prompts: AgentMessage[],
    context: { messages: AgentMessage[]; systemPrompt: string },
  ): Promise<AgentMessage[]> => {
    seen.systemPrompt = context.systemPrompt;
    const reply = {
      role: 'assistant',
      content: [{ type: 'text', text: replyText }],
      timestamp: 2,
      stopReason: 'stop',
    } as unknown as AgentMessage;
    return [...prompts, reply];
  };

/** 轮尾存档是 `void` 派出去的 —— 等它写盘或超时(超时即判失败,不"再等等")。 */
async function waitForFile(path: string, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (existsSync(path)) return true;
    if (Date.now() >= deadline) return false;
    await Bun.sleep(50);
  }
}

describe('★ #211 接线 — 交接读回进 system prompt', () => {
  test('新会话第一轮:上一段的 §1/§2 真的出现在循环收到的 system prompt 里', async () => {
    // 先造一份"上一段会话"的 checkpoint(走生产 writer + omd source,不是手捏文件)
    const prev = await runWriter({
      sessionId: 'prev-one',
      cwd: root,
      mechanical: true,
      source: omdSessionSource({
        entries: () => Promise.resolve([{ type: 'message', message: { role: 'user', content: [{ type: 'text', text: '上一段在做 #211 的来源缝' }] } }]),
      }),
    });
    expect(prev.ok).toBe(true);

    const seen: { systemPrompt?: string } = {};
    await runChatTurn({
      store,
      sessionId: 'fresh-one',
      prompt: '接着干',
      model: MODEL,
      cwd: root,
      loopFn: fakeLoop('好', seen) as never,
    });

    expect(seen.systemPrompt).toContain('上一段会话的交接');
    expect(seen.systemPrompt).toContain('prev-one'.slice(0, 8));
    expect(seen.systemPrompt).toContain(prev.checkpointPath);
  });

  test('同一会话的第二轮**不再注**(否则每轮重放一遍上一段, 还会滚雪球)', async () => {
    await runWriter({
      sessionId: 'prev-two',
      cwd: root,
      mechanical: true,
      source: omdSessionSource({
        entries: () => Promise.resolve([{ type: 'message', message: { role: 'user', content: [{ type: 'text', text: '上一段' }] } }]),
      }),
    });

    const first: { systemPrompt?: string } = {};
    await runChatTurn({ store, sessionId: 's-two', prompt: '一', model: MODEL, cwd: root, loopFn: fakeLoop('答一', first) as never });
    expect(first.systemPrompt).toContain('上一段会话的交接');

    const second: { systemPrompt?: string } = {};
    await runChatTurn({ store, sessionId: 's-two', prompt: '二', model: MODEL, cwd: root, loopFn: fakeLoop('答二', second) as never });
    expect(second.systemPrompt).not.toContain('上一段会话的交接');
  });

  test('★ persona 也注(#212): omd 开场与 Claude 那条同一份画像文件', async () => {
    // #211 首版 omd 只注交接不注 persona —— 于是 omd 自己比 Claude 那条少一角,
    // 而 omd 才是要建的 harness。反向: 把 agent.ts 换回 readResumeBrief → 本条红。
    const hub = join(root, 'hub');
    mkdirSync(join(hub, 'persona'), { recursive: true });
    writeFileSync(join(hub, 'persona', 'persona.md'), '## 工作方式\n- 文档先行, 先写 SDD 再编码');
    process.env.MEMORY_HUB_DATA = hub;

    const seen: { systemPrompt?: string } = {};
    await runChatTurn({ store, sessionId: 'persona-1', prompt: '一', model: MODEL, cwd: root, loopFn: fakeLoop('答', seen) as never });
    expect(seen.systemPrompt).toContain('用户画像');
    expect(seen.systemPrompt).toContain('先写 SDD 再编码');
  });

  test('没有上一段 → 不注(而不是注一段空的)', async () => {
    const seen: { systemPrompt?: string } = {};
    await runChatTurn({ store, sessionId: 'no-prev', prompt: '一', model: MODEL, cwd: root, loopFn: fakeLoop('答', seen) as never });
    expect(seen.systemPrompt).not.toContain('上一段会话的交接');
  });
});

describe('★ #211 接线 — 轮尾真的派存档', () => {
  test('跨档 → checkpoint.md 落盘(id = omd 的 sessionId)', async () => {
    process.env.OMD_SESSION_BUCKET = '1'; // 任何一轮都跨档
    process.env.OMD_CONTINUITY_MECHANICAL = '1'; // 跳过蒸馏那一发模型调用

    await runChatTurn({ store, sessionId: 'fire-1', prompt: '存一次', model: MODEL, cwd: root, loopFn: fakeLoop('好') as never });

    const cp = join(root, '.omd', 'session', 'fire-1', 'checkpoint.md');
    expect(await waitForFile(cp)).toBe(true);

    // 镜像层也要真写上 —— 生产装配的 chat 工具**不传** memory,所以这一格靠
    // `maybeCheckpointOmdSession` 自己开(反向:把 openContinuityMemory 那支去掉 → 这条红)。
    const memory = createDefaultMemory({ OMD_MEMORY_PATH: join(root, '.omd', 'memory.db') } as NodeJS.ProcessEnv);
    try {
      const rows = await listCheckpoints({ sessionId: 'fire-1' }, { memory });
      expect(rows.length).toBe(1);
      expect(rows[0]!.checkpointPath).toBe(cp);
    } finally {
      memory.close();
    }
  }, 30_000);

  test('默认档位(200k)下一轮小对话不触发 —— 既有 chat 测试不会被误拖去打模型', async () => {
    process.env.OMD_CONTINUITY_MECHANICAL = '1';
    await runChatTurn({ store, sessionId: 'quiet-1', prompt: '很短', model: MODEL, cwd: root, loopFn: fakeLoop('好') as never });
    // 给它一点时间证明"真的没派", 而不是"还没来得及"
    await Bun.sleep(300);
    expect(existsSync(join(root, '.omd', 'session', 'quiet-1', 'checkpoint.md'))).toBe(false);
  });
});
