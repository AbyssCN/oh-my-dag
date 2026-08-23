/**
 * claude-sdk 通道的**交接接线**闸(#211)。
 *
 * 为什么与 pi 通道那件分开写:两条通道各有一份接线,而 omd 主座位跑的正是**这一条**
 * (Claude 订阅通道)。"两处代码长得一样"不是它被接上的证据 —— #206 的教训。
 *
 * 反向自检(实跑):
 *   - 摘掉 claude-sdk-turn.ts 里 `readResumeBrief` 那一段 → 「进 systemPrompt」当场红;
 *   - 摘掉轮尾 `void maybeCheckpointOmdSession(...)` → 「派了存档」当场红。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { runChatTurnSdk } from './claude-sdk-turn';
import { type OmdSessionStore, createOmdSessionStore, resetSessionCacheForTest } from './session-store';
import { runWriter } from '../session/writer';
import { omdSessionSource } from '../session/source';
import { resetOmdCheckpointStateForTest } from '../session/omd-checkpoint';

const MODEL = 'claude-code:claude-fable-5';
let root: string;
let store: OmdSessionStore;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'omd-sdk-continuity-'));
  resetSessionCacheForTest();
  resetOmdCheckpointStateForTest();
  for (const k of ['OMD_DATA_HOME', 'OMD_SESSION_BUCKET', 'OMD_CONTINUITY_MECHANICAL']) {
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

const asst = (text: string): SDKMessage =>
  ({
    type: 'assistant',
    session_id: 'sdk-live',
    message: {
      content: [{ type: 'text', text }],
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 3 },
      stop_reason: 'end_turn',
    },
  }) as unknown as SDKMessage;

const success = (sid: string): SDKMessage =>
  ({
    type: 'result',
    subtype: 'success',
    result: 'done',
    session_id: sid,
    usage: {},
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

/** 轮尾存档是 `void` 派出去的 —— 等它写盘或超时。 */
async function waitForFile(path: string, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (existsSync(path)) return true;
    if (Date.now() >= deadline) return false;
    await Bun.sleep(50);
  }
}

async function seedPrevCheckpoint(sessionId: string): Promise<string> {
  const r = await runWriter({
    sessionId,
    cwd: root,
    mechanical: true,
    source: omdSessionSource({
      entries: () =>
        Promise.resolve([{ type: 'message', message: { role: 'user', content: [{ type: 'text', text: '上一段在做 #211' }] } }]),
    }),
  });
  return r.checkpointPath;
}

describe('★ #211 接线(sdk 通道)— 交接读回进 systemPrompt', () => {
  test('新会话第一轮:上一段的交接真的出现在传给 SDK 的 systemPrompt 里', async () => {
    const cp = await seedPrevCheckpoint('sdk-prev');
    const seen: { options?: Options } = {};
    await runChatTurnSdk({
      store,
      sessionId: 'sdk-fresh',
      prompt: '接着干',
      model: MODEL,
      cwd: root,
      sdkQueryFn: fakeQuery([asst('好'), success('sdk-a')], seen),
    });
    const sp = String(seen.options?.systemPrompt ?? '');
    expect(sp).toContain('上一段会话的交接');
    expect(sp).toContain(cp);
  });

  test('同一会话第二轮不再注', async () => {
    await seedPrevCheckpoint('sdk-prev2');
    const a: { options?: Options } = {};
    await runChatTurnSdk({ store, sessionId: 'sdk-s', prompt: '一', model: MODEL, cwd: root, sdkQueryFn: fakeQuery([asst('答一'), success('x')], a) });
    expect(String(a.options?.systemPrompt ?? '')).toContain('上一段会话的交接');

    const b: { options?: Options } = {};
    await runChatTurnSdk({ store, sessionId: 'sdk-s', prompt: '二', model: MODEL, cwd: root, sdkQueryFn: fakeQuery([asst('答二'), success('x')], b) });
    expect(String(b.options?.systemPrompt ?? '')).not.toContain('上一段会话的交接');
  });
});

describe('★ #211 接线(sdk 通道)— 轮尾真的派存档', () => {
  test('跨档 → checkpoint.md 落盘', async () => {
    process.env.OMD_SESSION_BUCKET = '1';
    process.env.OMD_CONTINUITY_MECHANICAL = '1';
    await runChatTurnSdk({
      store,
      sessionId: 'sdk-fire',
      prompt: '存一次',
      model: MODEL,
      cwd: root,
      sdkQueryFn: fakeQuery([asst('好'), success('sdk-a')]),
    });
    expect(await waitForFile(join(root, '.omd', 'session', 'sdk-fire', 'checkpoint.md'))).toBe(true);
  }, 30_000);
});
