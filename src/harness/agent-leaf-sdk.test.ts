/**
 * agent-leaf 的 claude-code 订阅通道分支契约测试(sdkQueryFn 接缝替换真 SDK)。
 * 钉四条:分派 + effort/工具面映射 / usage 累账口径(cacheWrite 并进 in)/
 * provider 错误响亮 / 0-token empty-done 仍被抓(反向自检:证明这两道闸在 SDK 路上也会红)。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { DEFAULT_MINIMAL_TOOLFACE_SEATS, createAgentLeafRunner } from './agent-leaf';
import { parseModelRef } from './fleet';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildOmdSdkMcpBridge } from './claude-sdk-loop';
import { createMcpClientTools } from '../mcp/client/meta-tools';

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
    // ★ 座位不在极简名单里 → 全工具面 (owner 2026-08-18: 只有 deepseek-v4-pro 极简, 其余全给)。
    expect(seen.options?.allowedTools).toContain('mcp__omd__grep');
    // ★ 文件系统设置一律不读: 叶子的 harness 文件由 loadProjectContext 显式拼进 systemPrompt,
    // 省略此字段的话 CLI 会把同两份 CLAUDE.md **再灌一遍** (双份计费), 且用户 hooks 进叶子轮。
    // 反向自检 (2026-08-18 真跑过): 删掉 claude-sdk-loop.ts 的 `settingSources: []` → 本行红。
    expect(seen.options?.settingSources).toEqual([]);
  });

  /**
   * 座位级极简工具面(owner 2026-08-18)。生产名单里的座位是 `deepseek-v4-pro`,它走 pi 通道 ——
   * 那条路上测试看不见 `allowedTools`,所以名单经 `minimalToolFaceSeats` 注入,在 SDK 座上观察
   * **同一条装配路**的产物。判的是"名单命中就缩面",不是"deepseek 这四个字"。
   *
   * 反向自检(2026-08-18 真跑过):把 agent-leaf.ts 里 `wantMinimalFace` 的三元分支删掉 →
   * 第一条(工具面缩没缩)当场红;把 `!input.profile && !opts.tools` 这个"显式优先"条件删掉 →
   * 第三条红(显式 tools 被座位规则盖住)。
   */
  test('★ 座位命中极简名单 → 工具面缩到 bash + hashline 对; systemPrompt 同步只列这几个', async () => {
    const seen: { options?: Options } = {};
    const run = createAgentLeafRunner({
      cwd,
      hashlineEdit: true,
      minimalToolFaceSeats: [MODEL.split(':')[1]!], // = claude-sonnet-5, 本测试的座位
      sdkQueryFn: fakeQuery([asst('好'), success()], seen),
    });
    await run({ prompt: 'x', model: MODEL });
    const names = (seen.options?.allowedTools ?? []).map((n) => n.replace('mcp__omd__', '')).sort();
    expect(names).toEqual(['bash', 'hashline_edit', 'hashline_read']);
    // prompt 里的工具清单是另一份真源 —— 只缩 allowedTools 会让模型照着 prompt 去调不存在的工具。
    expect(seen.options?.systemPrompt).not.toContain('grep');
    expect(seen.options?.systemPrompt).toContain('bash');
  });

  test('★ 极简名单不盖显式 tools —— 显式的永远胜(否则岗位档案就形同虚设)', async () => {
    const seen: { options?: Options } = {};
    const run = createAgentLeafRunner({
      cwd,
      tools: ['read', 'grep'],
      minimalToolFaceSeats: [MODEL.split(':')[1]!],
      sdkQueryFn: fakeQuery([asst('好'), success()], seen),
    });
    await run({ prompt: 'x', model: MODEL });
    const names = (seen.options?.allowedTools ?? []).map((n) => n.replace('mcp__omd__', '')).sort();
    expect(names).toEqual(['grep', 'read']);
  });

  test('★ 生产名单写的是 modelId 不是全坐标 —— 写成全坐标就永远命不中, 而且一声不吭', () => {
    // 失效形态: 名单里写 'deepseek:deepseek-v4-pro', 匹配的却是 parseModelRef 出来的 modelId,
    // 于是规则恒不触发、日志无一行、读数上只表现为"没省钱" (静默失效, NULL≠0 同族)。
    expect(DEFAULT_MINIMAL_TOOLFACE_SEATS).toContain(parseModelRef('deepseek:deepseek-v4-pro').modelId);
    expect(DEFAULT_MINIMAL_TOOLFACE_SEATS).not.toContain(parseModelRef('minimax-cn:MiniMax-M3').modelId);
  });

  test('★ 显式 thinkingLevel 恒覆盖通道缺省(A/B 钉档位的前提)', async () => {
    const seen: { options?: Options } = {};
    const run = createAgentLeafRunner({ cwd, thinkingLevel: 'xhigh', sdkQueryFn: fakeQuery([asst('好'), success()], seen) });
    await run({ prompt: 'x', model: MODEL });
    expect(seen.options?.effort).toBe('xhigh');
  });

  test('★ advisor:claude-code 坐标 → settings.advisorModel;pi 座异族坐标规则同 chat(officialAdvisorModelId 共用)', async () => {
    const seen: { options?: Options } = {};
    const run = createAgentLeafRunner({
      cwd, advisor: 'claude-code:claude-opus-5',
      sdkQueryFn: fakeQuery([asst('好'), success()], seen),
    });
    await run({ prompt: 'x', model: MODEL });
    expect((seen.options?.settings as { advisorModel?: string })?.advisorModel).toBe('claude-opus-5');
  });

  test('★ provider 错误 → 响亮抛 subtype 原文,且烧掉的 token 已入账(P1:失败 ≠ 账外)', async () => {
    const { observeModelUsage } = await import('../model/accounting');
    const emits: { model: string; origin: string }[] = [];
    const un = observeModelUsage((_u, model, origin) => emits.push({ model, origin }));
    try {
      const run = createAgentLeafRunner({
        cwd,
        sdkQueryFn: fakeQuery([asst('半截'), { type: 'result', subtype: 'error_max_turns', session_id: 's' } as unknown as SDKMessage]),
      });
      await expect(run({ prompt: 'x', model: MODEL })).rejects.toThrow('error_max_turns');
      expect(emits).toEqual([{ model: MODEL, origin: 'engine' }]);
    } finally {
      un();
    }
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
// ── SDD D-10: 外部 MCP meta-tool → leaf tools → SDK 桥 (agent-leaf.ts:1068-1086 通道) ──
describe('D-10 MCP meta-tool 桥接', () => {
  const withMcpConfig = (root: string) => {
    mkdirSync(join(root, '.omd'), { recursive: true });
    writeFileSync(join(root, '.omd', 'mcp.json'), JSON.stringify({ mcpServers: { t: { command: 'unused-by-inmemory' } } }));
  };

  test('★ 注册表非空 → leaf tools 含双 meta-tool, SDK 桥 ListTools + allowedTools 都带上', async () => {
    withMcpConfig(cwd);
    const seen: { options?: Options } = {};
    const run = createAgentLeafRunner({ cwd, sdkQueryFn: fakeQuery([asst('改完了'), success()], seen) });
    await run({ prompt: 'x', model: MODEL });
    // 桥的 allowedTools 由 runner 的 tools 数组生成 —— 含 meta-tool 即证明 leaf 装配挂上了。
    expect(seen.options?.allowedTools).toContain('mcp__omd__mcp_find');
    expect(seen.options?.allowedTools).toContain('mcp__omd__mcp_call');
    // promptSnippet 经 buildLeafSystemPrompt 既有机制进 system prompt (不另造注入路径)。
    expect(seen.options?.systemPrompt).toContain('mcp_find');
    // 桥本体 (真回路 InMemory, 同 claude-sdk-turn.test.ts:182): 同一 tools 面 → ListTools 透出双 meta-tool。
    const tools = createMcpClientTools({ cwd });
    expect(tools.map((t) => t.name)).toEqual(['mcp_find', 'mcp_call']);
    const bridge = buildOmdSdkMcpBridge(tools);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'd10', version: '0' });
    await Promise.all([bridge.instance.server.connect(a), client.connect(b)]);
    const listed = await client.listTools();
    expect(listed.tools.map((t) => t.name)).toEqual(expect.arrayContaining(['mcp_find', 'mcp_call']));
    await client.close();
  });

  test('★ 零注册 → 均不含 (证伪: 删掉 meta-tools.ts:76 零注册短路 / 无条件挂载 → 本条红)', async () => {
    // beforeEach 的 tmp cwd 无 .omd/mcp.json
    const seen: { options?: Options } = {};
    const run = createAgentLeafRunner({ cwd, sdkQueryFn: fakeQuery([asst('改完了'), success()], seen) });
    await run({ prompt: 'x', model: MODEL });
    expect(seen.options?.allowedTools).not.toContain('mcp__omd__mcp_find');
    expect(seen.options?.allowedTools).not.toContain('mcp__omd__mcp_call');
    expect(seen.options?.systemPrompt).not.toContain('mcp_find');
    expect(createMcpClientTools({ cwd })).toEqual([]); // I-2 零注册短路
  });
});
