/**
 * D5 切片 2 (#268) — pi 通道 agent leaf 的总用量经 emitModelUsage 入 tui 账。
 *
 * 这条此前**一个字都没进账本** (`agent-leaf.ts:2306` 跑 runAgentLoop 但不带 ledger、不 emit,
 * 与 SDK 通道对照 `:2300` 那里走 `ledger: { model, origin: 'engine' }`)。后果:`.omd/tui-usage.jsonl`
 * 系统性缺 agent leaf 大头,周预算闸 (`src/mcp/budget.ts`) 看的正是这本,等于对最大开销是瞎的。
 *
 * 测试两路:
 *   ① pi 通道 (loopFn 替身): 恰好一条记录,字段 = `mapSessionUsage(totals)`。
 *   ② SDK 通道 (sdkQueryFn 替身): 记录条数与今天相同 (不双记)。
 *
 * 反向自检 (1, 2026-08-25 实跑过思路): 把 agent-leaf.ts 里 `if (!isSdkChannel) { emitModelUsage(...) }`
 * 整段删掉 → 「pi 通道」那条红 (counts=0)。
 * 反向自检 (2): 去掉 gate `!isSdkChannel` → 「SDK 通道」那条红 (counts=2,SDK 内 + 收敛点 双记)。
 */
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { observeModelUsage } from '../model/accounting';
import { createAgentLeafRunner } from './agent-leaf';

const PI_MODEL = 'deepseek:deepseek-v4-flash';
const SDK_MODEL = 'claude-code:claude-sonnet-5';

const piAssistant = (
  text: string,
  u: { input: number; output: number; cacheRead?: number; cacheWrite?: number },
): AgentMessage =>
  ({
    role: 'assistant',
    content: [{ type: 'text', text }],
    timestamp: 1,
    stopReason: 'stop',
    usage: {
      input: u.input,
      output: u.output,
      cacheRead: u.cacheRead ?? 0,
      cacheWrite: u.cacheWrite ?? 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  }) as unknown as AgentMessage;

let cwd: string;
afterEach(() => {
  if (cwd) rmSync(cwd, { recursive: true, force: true });
  cwd = '';
});

describe('D5 切片 2: agent leaf 进 tui 账', () => {
  test('★ pi 通道 leaf 跑完 → emitModelUsage 恰好一条,字段 = mapSessionUsage(totals) (证伪: 删 emitModelUsage → counts=0)', async () => {
    cwd = mkdtempSync(join(tmpdir(), 'omd-leaf-pi-tui-'));
    const emits: { model: string; in: number; out: number; cacheHit?: number; origin: string }[] = [];
    const detach = observeModelUsage((u, model, origin) =>
      emits.push({
        model,
        in: u.in,
        out: u.out,
        ...(u.cacheHit !== undefined ? { cacheHit: u.cacheHit } : {}),
        origin,
      }));
    try {
      // pi leaf 替身: 返一条含用量的 assistant。
      // totals = { input: 500, output: 200, cacheRead: 9500 }
      // 预期 mapSessionUsage → { in: 10_000, out: 200, cacheHit: 9_500 } (cacheRead 补回 in,见 mapSessionUsage 口径契约)。
      const fakeLoop = (async (prompts: AgentMessage[]) => [
        ...prompts,
        piAssistant('改完了', { input: 500, output: 200, cacheRead: 9500 }),
      ]) as never;
      const run = createAgentLeafRunner({ cwd, loopFn: fakeLoop });
      await run({ prompt: '把 a.ts 的 bug 修了', model: PI_MODEL });
      expect(emits).toHaveLength(1);
      expect(emits[0]).toEqual({
        model: PI_MODEL,
        in: 10_000,
        out: 200,
        cacheHit: 9_500,
        origin: 'engine',
      });
    } finally {
      detach();
    }
  });

  test('★ pi 通道多轮 (多个 assistant 各自带 usage) → 仍只 emit 一条,字段 = 各轮 totals 累加 (证伪: 每轮 emit 一次 → counts=N 红)', async () => {
    cwd = mkdtempSync(join(tmpdir(), 'omd-leaf-pi-tui-multi-'));
    const emits: { in: number; out: number; cacheHit?: number }[] = [];
    const detach = observeModelUsage((u) => emits.push({ in: u.in, out: u.out, cacheHit: u.cacheHit }));
    try {
      // 两轮,模拟 pi 多轮工具循环: assistant(a) + assistant(b)。
      // 累加 totals: input = 100+200 = 300, output = 10+20 = 30, cacheRead = 0。
      const fakeLoop = (async (prompts: AgentMessage[]) => [
        ...prompts,
        piAssistant('a', { input: 100, output: 10 }),
        piAssistant('b', { input: 200, output: 20 }),
      ]) as never;
      const run = createAgentLeafRunner({ cwd, loopFn: fakeLoop });
      await run({ prompt: 'x', model: PI_MODEL });
      expect(emits).toHaveLength(1);
      expect(emits[0]).toEqual({ in: 300, out: 30, cacheHit: 0 });
    } finally {
      detach();
    }
  });

  test('★ SDK 通道不双记 —— emit 计数 = SDK 内部按行 emit 的数 (证伪: 去掉 `!isSdkChannel` gate → counts=2 红)', async () => {
    cwd = mkdtempSync(join(tmpdir(), 'omd-leaf-sdk-tui-'));
    const emits: unknown[] = [];
    const detach = observeModelUsage((...args) => emits.push(args));
    try {
      // SDK 替身: 一条含非零用量的 assistant + success result。claude-sdk-loop.ts:346 过滤后
      // 0 行过滤掉 → 仅这一条 emit (与 agent-leaf-sdk.test.ts:146 同一条 fixture 同样的行为)。
      const fakeQuery = (() => (props: { prompt: string; options: Options }) => {
        void props;
        return (async function* () {
          yield {
            type: 'assistant',
            session_id: 's',
            message: {
              content: [{ type: 'text', text: 'ok' }],
              usage: {
                input_tokens: 20,
                output_tokens: 9,
                cache_read_input_tokens: 5,
                cache_creation_input_tokens: 4,
              },
              stop_reason: 'end_turn',
            },
          } as unknown as SDKMessage;
          yield {
            type: 'result',
            subtype: 'success',
            result: 'done',
            session_id: 's',
            usage: {},
          } as unknown as SDKMessage;
        })();
      })();
      const run = createAgentLeafRunner({ cwd, sdkQueryFn: fakeQuery });
      await run({ prompt: 'x', model: SDK_MODEL });
      // SDK 内已 emit 1 次 (非零行);agent-leaf 收敛点必须 gate 住,不再 emit。
      expect(emits).toHaveLength(1);
    } finally {
      detach();
    }
  });
});