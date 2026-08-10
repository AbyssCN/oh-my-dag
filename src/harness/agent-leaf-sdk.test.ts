/**
 * agent-leaf 的 claude-code 订阅通道分支契约测试(sdkQueryFn 接缝替换真 SDK)。
 * 钉四条:分派 + effort/工具面映射 / usage 累账口径(cacheWrite 并进 in)/
 * provider 错误响亮 / 0-token empty-done 仍被抓(反向自检:证明这两道闸在 SDK 路上也会红)。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { createAgentLeafRunner } from './agent-leaf';

const MODEL = 'claude-code:claude-sonnet-5';
let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'omd-leaf-sdk-'));
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

const asst = (text: string): SDKMessage =>
  ({
    type: 'assistant',
    session_id: 's',
    message: {
      content: [{ type: 'text', text }],
      usage: { input_tokens: 20, output_tokens: 9, cache_read_input_tokens: 5, cache_creation_input_tokens: 4 },
      stop_reason: 'end_turn',
    },
  }) as unknown as SDKMessage;

const success = (): SDKMessage =>
  ({ type: 'result', subtype: 'success', result: 'done', session_id: 's', usage: {} }) as unknown as SDKMessage;

const fakeQuery = (script: SDKMessage[], seen: { options?: Options } = {}) => {
  return (props: { prompt: string; options: Options }) => {
    seen.options = props.options;
    return (async function* () {
      for (const m of script) yield m;
    })();
  };
};

describe('claude-code leaf 分支', () => {
  test('★ 分派 + 映射:缺省档 = medium(订阅通道不吃 pi 路的 xhigh 默认 —— flash 定价惯性),内置工具清空,omd 工具面桥过去', async () => {
    const seen: { options?: Options } = {};
    // 刻意不传 thinkingLevel:钉的是**通道缺省档**本身,不是透传。
    const run = createAgentLeafRunner({ cwd, sdkQueryFn: fakeQuery([asst('改完了'), success()], seen) });
    const r = await run({ prompt: '把 a.ts 里的 bug 修了', model: MODEL });
    expect(r.text).toBe('改完了');
    // usage 口径与 pi leaf 同:in = input + cacheWrite (全价近似) + cacheRead, cacheHit = cacheRead
    expect(r.usage).toEqual({ in: 29, out: 9, cacheHit: 5 });
    expect(seen.options?.effort).toBe('medium');
    expect(seen.options?.tools).toEqual([]); // 内置全清 —— 工具面就是闸
    expect(seen.options?.allowedTools).toContain('mcp__omd__read');
    expect(seen.options?.allowedTools).toContain('mcp__omd__write');
    expect(seen.options?.resume).toBeUndefined(); // leaf 每发独立, 无会话续接
  });

  test('★ 显式 thinkingLevel 恒覆盖通道缺省(A/B 钉档位的前提)', async () => {
    const seen: { options?: Options } = {};
    const run = createAgentLeafRunner({ cwd, thinkingLevel: 'xhigh', sdkQueryFn: fakeQuery([asst('好'), success()], seen) });
    await run({ prompt: 'x', model: MODEL });
    expect(seen.options?.effort).toBe('xhigh');
  });

  test('★ provider 错误 → 响亮抛 subtype 原文(闸在 SDK 路上也会红)', async () => {
    const run = createAgentLeafRunner({
      cwd,
      sdkQueryFn: fakeQuery([asst('半截'), { type: 'result', subtype: 'error_max_turns', session_id: 's' } as unknown as SDKMessage]),
    });
    await expect(run({ prompt: 'x', model: MODEL })).rejects.toThrow('error_max_turns');
  });

  test('★ 0-token empty-done:空文本 + 零落盘 + 非停摆非超时 → 仍然响亮失败', async () => {
    const empty = {
      type: 'assistant',
      session_id: 's',
      message: { content: [], usage: { input_tokens: 1, output_tokens: 0 }, stop_reason: 'end_turn' },
    } as unknown as SDKMessage;
    const run = createAgentLeafRunner({ cwd, sdkQueryFn: fakeQuery([empty, success()]) });
    await expect(run({ prompt: 'x', model: MODEL })).rejects.toThrow('empty-done');
  });
});
