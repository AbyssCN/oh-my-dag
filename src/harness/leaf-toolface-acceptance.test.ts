/**
 * P3 S2 / INV-4 —— `run_acceptance` 只在本次派了冻结判据时出现在 leaf 的工具面上。
 *
 * 走 SDK 通道的假 query 抓 `allowedTools` 与 `systemPrompt`(与 agent-tools.test.ts 的 I-1 同一夹具口径):
 *   · 无 self_check → 面上没有它, prompt 里没有它 (零配置叶子逐字节不变, 由 I-1 守);
 *   · 有 self_check → 面上多它一件, prompt 的工具段有它的一行。
 *
 * 证伪方式: 把 agent-leaf.ts 里 `withAcceptance` 的条件改成恒 true → 第一格红 (无判据也挂了假手);
 * 改成恒 false → 第二格红 (有判据却没手)。
 */
import { describe, expect, it } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { createAgentLeafRunner } from './agent-leaf';

const MODEL = 'claude-code:claude-sonnet-5';
const asst = (text: string): SDKMessage =>
  ({
    type: 'assistant',
    session_id: 's',
    message: { content: [{ type: 'text', text }], usage: { input_tokens: 2, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, stop_reason: 'end_turn' },
  }) as unknown as SDKMessage;
const success = (): SDKMessage => ({ type: 'result', subtype: 'success', result: 'done', session_id: 's', usage: {} }) as unknown as SDKMessage;
const fakeQuery = (seen: { options?: Options }) => (props: { prompt: string; options: Options }) => {
  seen.options = props.options;
  return (async function* () {
    yield asst('好');
    yield success();
  })();
};

describe('INV-4 · run_acceptance 随冻结判据按调用出现', () => {
  it('★ 无 self_check → 工具面与 prompt 都没有 run_acceptance', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omd-acc-face-'));
    const seen: { options?: Options } = {};
    const run = createAgentLeafRunner({ cwd: root, sdkQueryFn: fakeQuery(seen), skillDeps: { roots: [] } });
    const r = await run({ prompt: 'x', model: MODEL });
    expect(seen.options?.allowedTools).not.toContain('mcp__omd__run_acceptance');
    expect(seen.options?.systemPrompt ?? '').not.toContain('run_acceptance');
    expect('acceptance' in r).toBe(false);
  });

  it('★ 有 self_check → 面上多一件 run_acceptance, prompt 工具段有它; 台账三态 = 派了没调', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omd-acc-face-'));
    const seen: { options?: Options } = {};
    const run = createAgentLeafRunner({ cwd: root, sdkQueryFn: fakeQuery(seen), skillDeps: { roots: [] } });
    const r = await run({ prompt: 'x', model: MODEL, self_check: { command: 'bun test', expect_exit: 0 } });
    expect(seen.options?.allowedTools).toContain('mcp__omd__run_acceptance');
    expect(seen.options?.systemPrompt ?? '').toContain('run_acceptance');
    expect(r.acceptance).toEqual({ ran: false, rounds: 0, last: null });
  });
});
