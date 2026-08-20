import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { createConductorChatTools } from './chat-tools';
import type { OmdMcpTool } from '../mcp/server';

function fake(name: string, inputSchema: Record<string, unknown> = {}): OmdMcpTool {
  return {
    name,
    description: `fake ${name}`,
    inputSchema: inputSchema as never,
    handler: (async () => ({ content: [{ type: 'text' as const, text: `${name} ok` }] })) as OmdMcpTool['handler'],
  };
}

// 全装配面: COVERED_MCP_NAMES 42 个 + conductor_chat (排除) + 一个 deprecated alias (跳过)。
const ALL_NAMES = [
  // 既有 12
  'run', 'solve', 'dag_run_plan', 'dag_status', 'dag_runs', 'dag_node_output',
  'dag_cancel', 'map_tickets', 'omd_plans', 'memory_recall', 'history_read', 'history_search',
  // 扩展 30
  'dag_research', 'dag_review', 'dag_slim', 'dag_deepen', 'dag_debug',
  'dag_triage', 'dag_rule', 'dag_intervene', 'dag_resume', 'dag_result',
  'map_init', 'map_open', 'map_add', 'map_rule', 'map_deliver', 'map_prefetch', 'map_confirm',
  'memory_remember', 'omd_web', 'omd_distill',
  'omd_set_key', 'omd_apply_preset', 'omd_set_role', 'omd_models_auto', 'omd_register_provider',
  'omd_set_model', 'omd_config_status', 'omd_toggle_hud', 'omd_primitive', 'omd_shapes',
];

const fullSurface = (): OmdMcpTool[] => [
  ...ALL_NAMES.map((n) => fake(n)),
  fake('conductor_chat'),
  { ...fake('dag_run'), description: '[deprecated → run] same tool, renamed 2026-08-04.' },
];

/** 取工具回执第一段文本 (AnyOmdTool.execute 的返回 content[0].text, 类型收窄)。 */
const textOf = (r: unknown): string | undefined =>
  (r as { content?: Array<{ text?: string }> }).content?.[0]?.text;

describe('createConductorChatTools', () => {
  test('本体 ⊇ MCP: 42 个 conductor 工具全部有本体对应, 排除 conductor_chat 与 alias', () => {
    const chat = createConductorChatTools(fullSurface());
    const names = new Set(chat.map((t) => t.name));
    expect(chat.length).toBe(42);
    expect(names.has('omd_research')).toBe(true);
    expect(names.has('omd_set_key')).toBe(true);
    expect(names.has('omd_map_deliver')).toBe(true);
    expect(names.has('omd_remember')).toBe(true);
    expect(names.has('conductor_chat')).toBe(false);
  });

  test('核心工具缺失 → must 响亮抛 (不静默残废)', () => {
    const surface = fullSurface().filter((t) => t.name !== 'run');
    expect(() => createConductorChatTools(surface)).toThrow(/找不到工具 'run'/);
  });

  test('扩展工具缺失 → 跳过不抛 (有就给, 没有就少)', () => {
    const surface = fullSurface().filter((t) => t.name !== 'dag_research');
    const chat = createConductorChatTools(surface);
    expect(chat.some((t) => t.name === 'omd_research')).toBe(false);
  });

  test('MCP 面冒出本体没包的工具 → ⊇ 闸响亮抛 (本体比外部窄 = 倒置)', () => {
    const surface = [...fullSurface(), fake('dag_new_tool')];
    expect(() => createConductorChatTools(surface)).toThrow(/缺 conductor 工具.*dag_new_tool/);
  });

  test('凭证写工具 confirm 闸: 不带 confirm → 拒绝, 带 confirm:true → 放行', async () => {
    const chat = createConductorChatTools(fullSurface());
    const setKey = chat.find((t) => t.name === 'omd_set_key')!;
    const blocked = await setKey.execute('x', { provider: 'p', key: 'k' });
    expect(textOf(blocked)).toContain('[BLOCKED]');
    const ok = await setKey.execute('x', { provider: 'p', key: 'k', confirm: true });
    expect(textOf(ok)).toBe('omd_set_key ok');
  });

  test('register_provider 同样受 confirm 闸', async () => {
    const chat = createConductorChatTools(fullSurface());
    const reg = chat.find((t) => t.name === 'omd_register_provider')!;
    const blocked = await reg.execute('x', { id: 'z', baseUrl: 'b', keyEnv: 'K' });
    expect(textOf(blocked)).toContain('[BLOCKED]');
  });

  test('zod schema 转成 typebox: 字段名/类型/描述保留', () => {
    const research = fake('dag_research', {
      question: z.string().describe('Research question (required)'),
      rounds: z.number().int().min(1).max(4).optional().describe('Second-pass rounds cap'),
    });
    const surface = [...fullSurface().filter((t) => t.name !== 'dag_research'), research];
    const chat = createConductorChatTools(surface);
    const t = chat.find((x) => x.name === 'omd_research')!;
    const schema = (t as unknown as { parameters: Record<string, unknown> }).parameters;
    expect(JSON.stringify(schema)).toContain('"question"');
    expect(JSON.stringify(schema)).toContain('Research question (required)');
    expect(JSON.stringify(schema)).toContain('"rounds"');
  });
});
