/**
 * R-1 (2026-09-03): `AgentLeafResult.llmCalls` —— pi 腿数 `turn_end` (一轮 = 一次模型响应), SDK 腿按 API message id 去重。
 * 它是「M3 调用/题」按 lead / worker 分解的引擎侧唯一来源 (桥日志只能按批)。
 * 证伪: 删 emit 里的 turn_end 计数 → 第一条红 (0 ≠ 2); SDK 腿改成数 assistant 条数 → 第二条红 (3 ≠ 2)。
 */
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentLeafRunner } from './agent-leaf';

const PI_MODEL = 'deepseek:deepseek-v4-flash';
const SDK_MODEL = 'claude-code:claude-sonnet-5';

const piAssistant = (text: string): AgentMessage =>
  ({
    role: 'assistant', content: [{ type: 'text', text }], timestamp: 1, stopReason: 'stop',
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  }) as unknown as AgentMessage;

let cwd = '';
afterEach(() => {
  if (cwd) rmSync(cwd, { recursive: true, force: true });
  cwd = '';
});

describe('R-1 llmCalls', () => {
  test('★ pi 腿: 两轮 (两个 turn_end) → llmCalls 2', async () => {
    cwd = mkdtempSync(join(tmpdir(), 'omd-leaf-llmcalls-pi-'));
    const fakeLoop = (async (prompts: AgentMessage[], _ctx: unknown, _cfg: unknown, emit: (e: unknown) => void) => {
      const a = piAssistant('a');
      const b = piAssistant('b');
      emit({ type: 'turn_end', message: a, toolResults: [] });
      emit({ type: 'turn_end', message: b, toolResults: [] });
      return [...prompts, a, b];
    }) as never;
    const run = createAgentLeafRunner({ cwd, loopFn: fakeLoop, thinkingLevel: 'low' });
    const r = await run({ prompt: 'x', model: PI_MODEL });
    expect(r.llmCalls).toBe(2);
    // R-1 第 3 步: 回报**实际用的**档 (显式 opts 钉档 → low) 与通道。
    expect(r.thinking).toEqual({ level: 'low', channel: 'pi' });
  });

  test('★ SDK 腿: 同一次 API 调用拆成两条 assistant (同 id) + 另一次调用 → llmCalls 2, 不是 3', async () => {
    cwd = mkdtempSync(join(tmpdir(), 'omd-leaf-llmcalls-sdk-'));
    const assistant = (id: string, text: string): SDKMessage =>
      ({ type: 'assistant', session_id: 's', message: { id, content: [{ type: 'text', text }], usage: { input_tokens: 20, output_tokens: 9 }, stop_reason: 'end_turn' } }) as unknown as SDKMessage;
    const fakeQuery = (props: { prompt: string; options: Options }) => {
      void props;
      return (async function* () {
        yield assistant('m1', 'part-1');
        yield assistant('m1', 'part-2');
        yield assistant('m2', 'done');
        yield { type: 'result', subtype: 'success', result: 'done', session_id: 's', usage: {}, modelUsage: { 'claude-sonnet-5': { inputTokens: 40, outputTokens: 18 } } } as unknown as SDKMessage;
      })();
    };
    const run = createAgentLeafRunner({ cwd, sdkQueryFn: fakeQuery, thinkingLevel: 'high' });
    const r = await run({ prompt: 'x', model: SDK_MODEL });
    expect(r.llmCalls).toBe(2);
    expect(r.thinking).toEqual({ level: 'high', channel: 'sdk' });
  });
});
