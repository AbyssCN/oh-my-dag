/**
 * test/core/mcp-memory-tools.test.ts — memory_remember / memory_recall 工具测试 (SDD task-tools-memory 先红补票)。
 *
 * 真闸非 fake: createOmdMemory(':memory:') + UNIVERSAL_SAFEGUARD (与 tui/MCP 生产装配同一闸料) —
 *   校验闸拒写 → isError + 拒因回显 (非 crash);
 *   合法 fact → 写入 OK;
 *   写入后 recall 命中 (混合检索真跑, 默认 embed 零依赖)。
 */
import { describe, expect, test } from 'bun:test';
import { createMemoryTools } from '../../src/mcp/tools/memory';
import { createOmdMemory } from '../../src/harness/memory';
import { UNIVERSAL_SAFEGUARD } from '../../src/memory/safeguards/namespaces';

/** 合法 user.preference fact (过闸正控): namespace + category/value + source anchor + confidence。 */
const VALID_FACT = {
  namespace: 'user.preference',
  category: 'editor',
  value: 'hashline edits',
  source_doc_id: 'test-doc',
  confidence: { level: 'agent_tentative', source_event_ids: ['ev-1'], created_at: new Date().toISOString() },
};

/** 域外 namespace fact: UNIVERSAL 闸只收 user/omd 两个 namespace → 必拒。 */
const OUT_OF_NAMESPACE_FACT = { ...VALID_FACT, namespace: 'client.acme' };

/** Extract handler from tool list by name (same unwrap pattern as mcp-dag-tools.test.ts). */
function getTool(tools: ReturnType<typeof createMemoryTools>, name: string) {
  const t = tools.find((t) => t.name === name);
  if (!t) throw new Error(`tool ${name} not found`);
  return (args: Record<string, unknown>) =>
    (t.handler as (args: Record<string, unknown>, extra?: unknown) => unknown)(args, {}) as Promise<{
      content: { type: string; text: string }[];
      isError?: boolean;
    }>;
}

function wire() {
  const memory = createOmdMemory({ path: ':memory:', safeguard: UNIVERSAL_SAFEGUARD });
  const tools = createMemoryTools({ memory, cwd: process.cwd() });
  return { memory, remember: getTool(tools, 'memory_remember'), recall: getTool(tools, 'memory_recall') };
}

describe('memory 工具 (真校验闸)', () => {
  test('memory_remember 校验闸拒写 → isError + 拒因回显 (非 crash)', async () => {
    const { memory, remember } = wire();
    const res = await remember({ fact: OUT_OF_NAMESPACE_FACT });
    // MCP error 通道: isError=true, 拒因原文回显 (REJECTED: <reason>) — 客户端能读到为什么被拒。
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/^REJECTED/);
    expect(res.content[0]!.text).toContain('schema:'); // 域外 namespace 的拒因 = schema 鉴别器拒绝
    memory.close();
  });

  test('memory_remember 合法 fact → 写入 OK (正控, 闸非全拒)', async () => {
    const { memory, remember } = wire();
    const res = await remember({ fact: VALID_FACT });
    expect(res.isError).toBeFalsy();
    expect(res.content[0]!.text).toMatch(/^OK id=/);
    memory.close();
  });

  test('写入后 memory_recall 混合检索命中该 fact', async () => {
    const { memory, remember, recall } = wire();
    await remember({ fact: VALID_FACT });
    const res = await recall({ query: 'editor', k: 5 });
    expect(res.isError).toBeFalsy();
    expect(res.content[0]!.text).not.toBe('No matching facts found.');
    expect(res.content[0]!.text).toContain('user.preference');
    memory.close();
  });
});
