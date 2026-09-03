/**
 * src/harness/conductor/conductor-tools-wiring.test —— T-1 / INV-1 / GWT-1 (P3 契约 D-22, S6b, 2026-09-02):
 * 两条入口 (solve 的 conductor 面 · conductor_chat 的轮工具面) 是**包含**关系, 不是相等; 两处 conductor 卡都来自
 * 同一构造点 `createConductorTools`; `createConductorChatTools` 仍在 conductor_chat 路径上 (装配期闸每轮仍跑)。
 *
 * 证伪方式:
 *  · chat.ts 的 buildChatRoundTools 去掉 `createConductorCardChatTools` 那一段 → 「七卡 ⊆ roundTools」红;
 *  · 把 roundTools 换成只有 conductor 卡 → 「omd_run_plan 仍在」红 (装配期闸消失, 不是变红 —— 这条替它变红);
 *  · conductor 面里混进 dag_ / omd_set_ 工具 → 前缀断言红。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OmdMcpTool } from '../../mcp/server';
import { buildHeadlessChatTools, HEADLESS_HANDS } from '../../mcp/tools/chat';
import { buildConductorFace, CONDUCTOR_HAND_TOOLS } from '../goal/orchestrating-loop';
import { CONDUCTOR_TOOL_NAMES } from './tools/index';
import type { ConductorCtx } from './types';

const fakeMcpTool = (name: string, text: string): OmdMcpTool => ({
  name,
  description: name,
  inputSchema: {},
  handler: async () => ({ content: [{ type: 'text' as const, text }] }),
});
const FAKE_MCP_TOOLS: OmdMcpTool[] = [
  fakeMcpTool('run', 'runId: run-abc'),
  fakeMcpTool('solve', 'runId: solve-abc'),
  fakeMcpTool('dag_run_plan', 'runId: plan-xyz\nstatus: running'),
  ...['dag_status', 'dag_runs', 'dag_node_output', 'dag_cancel', 'map_tickets', 'omd_plans', 'memory_recall', 'history_read', 'history_search'].map((n) => fakeMcpTool(n, `${n} ok`)),
];

const CTX: ConductorCtx = {
  cwd: '/tmp/x',
  writeRoot: '/tmp/x',
  allowlist: [],
  maxFanout: 2,
  seats: { worker: 'w:1', escalation: 'e:1', verify: 'v:1' },
  researchAvailable: false,
};

describe('INV-1 — 两条入口: 包含 + 单构造点', () => {
  test('★ GWT-1: solve 侧 conductor 面的七卡 ⊆ conductor_chat 轮工具面; roundTools 仍含 conductor 独有工具; hands 在', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-conductor-wiring-'));
    const face = buildConductorFace(
      { goal: 'g', writeRoot: cwd, minutesLeft: null, tokensLeft: null, maxFanout: 2, researchAvailable: false },
      { ctx: CTX, runChild: async () => { throw new Error('not in this test'); } },
    );
    const conductorNames = new Set(face.customTools!.map((t) => t.name));
    expect([...conductorNames]).toEqual([...CONDUCTOR_TOOL_NAMES]);
    const roundNames = new Set(buildHeadlessChatTools({ cwd, tools: FAKE_MCP_TOOLS }).map((t) => t.name));
    for (const n of conductorNames) expect(roundNames.has(n)).toBe(true);
    // conductor 独有工具仍在 = createConductorChatTools 仍在调用路径上 (它体内第一行是装配期闸)。
    expect(roundNames.has('omd_run_plan')).toBe(true);
    expect(roundNames.has('omd_run')).toBe(true);
    for (const h of HEADLESS_HANDS) expect(roundNames.has(h)).toBe(true);
    // 包含而非相等: chat 位有 conductor 面没有的东西。
    expect(roundNames.size).toBeGreaterThan(conductorNames.size + CONDUCTOR_HAND_TOOLS.length);
  });

  test('conductor 面 (headless 执行侧) 无 dag_ / omd_set_ 前缀工具, 无 write / edit', () => {
    const face = buildConductorFace(
      { goal: 'g', writeRoot: '/tmp/x', minutesLeft: null, tokensLeft: null, maxFanout: 2, researchAvailable: false },
      { ctx: CTX, runChild: async () => { throw new Error('not in this test'); } },
    );
    const all = [...face.toolNames, ...face.customTools!.map((t) => t.name)];
    for (const n of all) {
      expect(n.startsWith('dag_')).toBe(false);
      expect(n.startsWith('omd_set_')).toBe(false);
    }
    expect(all).not.toContain('write');
    expect(all).not.toContain('edit');
  });

  test('chat 位的 conductor 卡: 合法 work → 经 dag_run_plan 派图, 回执带 runId; 非法 → manual 走 tool result', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-conductor-chat-card-'));
    let planned: string | null = null;
    const tools = FAKE_MCP_TOOLS.map((t) =>
      t.name === 'dag_run_plan'
        ? { ...t, handler: (async (args: unknown) => { planned = (args as { plan: string }).plan; return { content: [{ type: 'text' as const, text: 'runId: plan-1\nstatus: running' }] }; }) as OmdMcpTool['handler'] }
        : t,
    );
    const work = buildHeadlessChatTools({ cwd, tools }).find((t) => t.name === 'work')!;
    const ok = (await work.execute('t', { goal: 'fix add()', brief: 'repro: bun test → 1 fail; scope src/a.ts; do not touch b.ts' })) as { content: { text: string }[] };
    expect(ok.content[0]!.text).toContain('runId: plan-1');
    expect(planned).not.toBeNull();
    expect(JSON.parse(planned!).name.startsWith('conductor-work-')).toBe(true);
    const bad = (await work.execute('t', { goal: 'x' })) as { content: { text: string }[] };
    expect(bad.content[0]!.text).toContain('--- rejected ---');
  });
});
