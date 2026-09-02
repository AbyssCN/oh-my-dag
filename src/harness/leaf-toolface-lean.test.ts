/**
 * P3 S4 / INV-4 —— 精益 worker leaf 的工具面。
 *
 * 经 SDK 假 query 抓 `allowedTools` 与 `systemPrompt`(与 agent-tools.test.ts I-1 同一夹具口径):
 *   · leanLeaf 开、三条件齐 → 恰四件;带冻结判据 → 五件 (多 run_acceptance);prompt 走 v2 前缀;
 *   · mcpAllow 非空 → 不进精益 (退回全面, mcp 工具照挂);
 *   · leanLeaf 缺席 → 老面 (零回归, 由 I-1 守字节)。
 * 首轮后不放开: 精益面不挂 withToolFaceEscalation —— 代码层判据 (wantMinimalFace 在精益下恒 false)。
 *
 * 证伪: 把 agent-leaf.ts 里 `leanScope` 的 mcpAllow 条件去掉 → ③ 红;把 `opts.leanLeaf === true` 改成恒 true → ④ 红。
 */
import { describe, expect, it } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { createAgentLeafRunner } from './agent-leaf';
import { LEAF_FACTS_BOUNDARY, LEAF_PROMPT_V2_PREFIX } from './leaf-prompt-v2';

const MODEL = 'claude-code:claude-sonnet-5';
const asst = (text: string): SDKMessage =>
  ({ type: 'assistant', session_id: 's', message: { content: [{ type: 'text', text }], usage: { input_tokens: 2, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, stop_reason: 'end_turn' } }) as unknown as SDKMessage;
const success = (): SDKMessage => ({ type: 'result', subtype: 'success', result: 'done', session_id: 's', usage: {} }) as unknown as SDKMessage;
const fakeQuery = (seen: { options?: Options }) => (props: { prompt: string; options: Options }) => {
  seen.options = props.options;
  return (async function* () {
    yield asst('好');
    yield success();
  })();
};
const FOUR = ['mcp__omd__read', 'mcp__omd__write', 'mcp__omd__edit', 'mcp__omd__bash'];

describe('INV-4 · 精益 worker leaf 工具面', () => {
  it('★ ① leanLeaf 开、无 profile/tools/mcp → 恰四件; prompt = v2 前缀 + 边界 + 事实', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omd-lean-'));
    const seen: { options?: Options } = {};
    const run = createAgentLeafRunner({ cwd: root, leanLeaf: true, sdkQueryFn: fakeQuery(seen), skillDeps: { roots: [] } });
    await run({ prompt: 'x', model: MODEL, leafTimeoutMs: 5 * 60_000 });
    expect(seen.options?.allowedTools).toEqual(FOUR);
    const sp = String(seen.options?.systemPrompt ?? '');
    expect(sp.startsWith(LEAF_PROMPT_V2_PREFIX)).toBe(true);
    expect(sp).toContain(LEAF_FACTS_BOUNDARY);
    expect(sp).toContain('5 minutes left');
    expect(sp).toContain(`- Work root: ${root}.`);
  });

  it('★ ② 带冻结判据 → 恰五件 (多 run_acceptance), 事实里有命令原文', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omd-lean-'));
    const seen: { options?: Options } = {};
    const run = createAgentLeafRunner({ cwd: root, leanLeaf: true, sdkQueryFn: fakeQuery(seen), skillDeps: { roots: [] } });
    await run({ prompt: 'x', model: MODEL, self_check: { command: 'bun test', expect_exit: 0 } });
    expect(seen.options?.allowedTools).toEqual([...FOUR, 'mcp__omd__run_acceptance']);
    expect(String(seen.options?.systemPrompt ?? '')).toContain('Acceptance command (frozen): `bun test`');
  });

  it('★ ③ mcpAllow 非空 → 不进精益: 面上不止四件 (mcp 授权面不被静默剥掉)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omd-lean-'));
    const seen: { options?: Options } = {};
    const run = createAgentLeafRunner({ cwd: root, leanLeaf: true, sdkQueryFn: fakeQuery(seen), skillDeps: { roots: [] } });
    await run({ prompt: 'x', model: MODEL, mcpAllow: ['some:tool'] });
    const tools = seen.options?.allowedTools ?? [];
    expect(tools.length).toBeGreaterThan(4);
    expect(tools).toContain('mcp__omd__grep');
    expect(String(seen.options?.systemPrompt ?? '').startsWith(LEAF_PROMPT_V2_PREFIX)).toBe(false);
  });

  it('★ ④ leanLeaf 缺席 → 老面 (八件), prompt 不是 v2 (零回归)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omd-lean-'));
    const seen: { options?: Options } = {};
    const run = createAgentLeafRunner({ cwd: root, sdkQueryFn: fakeQuery(seen), skillDeps: { roots: [] } });
    await run({ prompt: 'x', model: MODEL });
    expect(seen.options?.allowedTools).toHaveLength(8);
    expect(String(seen.options?.systemPrompt ?? '').startsWith(LEAF_PROMPT_V2_PREFIX)).toBe(false);
  });

  it('⑤ 显式 profile 胜过精益 (作用域条件之一)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omd-lean-'));
    const seen: { options?: Options } = {};
    const run = createAgentLeafRunner({ cwd: root, leanLeaf: true, sdkQueryFn: fakeQuery(seen), skillDeps: { roots: [] } });
    await run({ prompt: 'x', model: MODEL, profile: { name: 'p', tools: ['read', 'grep'] } as never });
    expect(String(seen.options?.systemPrompt ?? '').startsWith(LEAF_PROMPT_V2_PREFIX)).toBe(false);
  });
});
