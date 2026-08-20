/**
 * runChatTurn 的**崩溃恢复接线**闸(#185 H4)。
 *
 * 为什么单开一件:零件闸(`compaction-journal.test.ts`)证的是五个恢复态各自分得开;**接线**
 * 是另一回事。#206 与 #211 的病都是同一个 —— "零件全绿、没人调它"。本件交付前 `recoverCompaction`
 * 在 src/ 里**零非测试消费方**(实测:ugrep 只命中它自己和它的测试),即分类器活着而恢复路径不存在。
 * 所以这里打的是 `runChatTurn` 本身:上一次压缩留下的半截 sidecar,开会话时**真的被读到并清掉**。
 *
 * 反向自检(实跑):把 agent.ts 里 `recoverCompaction` 那一段删掉 → 「半截日志被清掉」当场红
 * (sidecar 原样留在盘上);恢复后绿。
 *
 * ⚠ 本件**不**证"摘要被复用" —— 那件事今天做不到:补 replace 还需要 retainedTail 的**内容**,
 * 而日志只存了**条数**。恢复目前只做「分辨 + 留证 + 清理」,见 agent.ts 那段注释。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { runChatTurn } from './agent';
import { journalPathFor, readCompactionJournal, writeCompactionJournal } from './compaction-journal';
import { type OmdSessionStore, createOmdSessionStore, resetSessionCacheForTest } from './session-store';

const MODEL = 'deepseek:deepseek-v4-flash'; // pi-ai 内置目录离线可解(本件不发网络请求)
let root: string;
let store: OmdSessionStore;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'omd-chat-recovery-'));
  resetSessionCacheForTest();
  for (const k of ['OMD_DATA_HOME', 'OMD_SESSION_BUCKET', 'MEMORY_HUB_DATA']) {
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
  (replyText: string) =>
  async (prompts: AgentMessage[]): Promise<AgentMessage[]> => {
    const reply = {
      role: 'assistant',
      content: [{ type: 'text', text: replyText }],
      timestamp: 2,
      stopReason: 'stop',
    } as unknown as AgentMessage;
    return [...prompts, reply];
  };

/** 跑一轮把会话建出来, 回它的 JSONL 绝对路径(sidecar 挂在它旁边)。 */
async function seedSession(sessionId: string): Promise<string> {
  await runChatTurn({ store, sessionId, prompt: '一', model: MODEL, cwd: root, loopFn: fakeLoop('答一') as never });
  const opened = await store.open(sessionId);
  expect(opened).not.toBeNull();
  return opened!.path;
}

describe('★ #185 接线 — 半截压缩日志在开会话时真的被读到', () => {
  test('崩在 start(摘要都没生成)→ 下一轮开会话即清掉 sidecar', async () => {
    const sessionId = 'crash-start';
    const path = await seedSession(sessionId);
    const journal = journalPathFor(path);

    // 手捏一次"上次死在 start"的现场(进程崩了, sidecar 留着)。
    writeCompactionJournal(journal, { step: 'start', sessionId, tokensBefore: 999, at: Date.now() });
    expect(existsSync(journal)).toBe(true);

    await runChatTurn({ store, sessionId, prompt: '二', model: MODEL, cwd: root, loopFn: fakeLoop('答二') as never });

    // 反向自检锚点: 删掉 agent.ts 的 recoverCompaction 那一段 → 这一行红。
    expect(existsSync(journal)).toBe(false);
  });

  test('崩在 replace 且条目没落(replace-lost)→ 同样清掉, 不留永久脏状态', async () => {
    const sessionId = 'crash-replace';
    const path = await seedSession(sessionId);
    const journal = journalPathFor(path);

    // entryId 在 store 里**不存在** → hasEntry 反查为假 = 「换没发生」。
    writeCompactionJournal(journal, {
      step: 'replace',
      sessionId,
      summary: '一段摘要',
      entryId: 'entry-that-never-landed',
      at: Date.now(),
    });

    await runChatTurn({ store, sessionId, prompt: '二', model: MODEL, cwd: root, loopFn: fakeLoop('答二') as never });

    expect(existsSync(journal)).toBe(false);
  });

  test('没有半截日志 → 什么都不做(不凭空造一个 sidecar)', async () => {
    const sessionId = 'clean-one';
    const path = await seedSession(sessionId);
    const journal = journalPathFor(path);
    expect(existsSync(journal)).toBe(false);

    await runChatTurn({ store, sessionId, prompt: '二', model: MODEL, cwd: root, loopFn: fakeLoop('答二') as never });

    expect(existsSync(journal)).toBe(false);
    expect(readCompactionJournal(journal)).toBeNull();
  });
});
