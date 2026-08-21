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
  const tools = createMemoryTools({ memory });
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

  // ── 拒因必须点名**是哪个字段** (2026-08-21, 一次真实误诊换来的) ────────────────────
  //
  // 现场: `confidence` 传成字符串 (`"human_verified"`) 而 schema 要对象
  // (`{level, by, verified_at}`)。原拒因是光秃秃的
  //   `schema:Invalid input: expected object, received string`
  // —— 那句话在**顶层 `fact` 参数**上读起来同样成立。于是我一路误诊成"MCP 把 fact 序列化成
  // 字符串了", 连改三轮 fact、提了两个补丁去修一个**不存在的传输故障**, 而问题从头到尾
  // 在一个嵌套字段上。两个补丁事后已 revert。
  //
  // **path 就是那条证据。** 丢掉它 = fail-open 吞证据, 而且吞的是判词自己的定位信息。
  // 判词指错方向比不报还贵: 不报会让人去查, 指错方向会让人去改一个没坏的东西。
  test('★ confidence 传成字符串 → 拒因必须出现 "confidence" 三个字', async () => {
    // 怎么让它红: 把 validator.ts 里那个 `at` 前缀去掉 (回到只取 first.message) → 这条红,
    // 而那正是 2026-08-21 之前的实装。
    const { memory, remember } = wire();
    const res = await remember({ fact: { ...VALID_FACT, confidence: 'human_verified' } });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('confidence');
    memory.close();
  });

  test('★ 顶层问题(namespace 不在 allowlist)不加空路径前缀 —— 别让判词更难读', async () => {
    // 反面锚: path 为空时不许拼出 `schema:: xxx` 这种双冒号。
    const { memory, remember } = wire();
    const res = await remember({ fact: OUT_OF_NAMESPACE_FACT });
    expect(res.content[0]!.text).not.toContain('schema::');
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
