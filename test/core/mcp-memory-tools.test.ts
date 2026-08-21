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

// ── inputSchema 那一层 (2026-08-21): 上面那组**全部直接调 handler**, 绕过了 zod ─────────
//
// 于是 `fact` 的入参编码从来没被测过, 而生产上 memory_remember 正是死在那里:
// Claude Code 这条通道把整个 `fact` 当 JSON 字符串塞进来, 原 `z.record(...)` 报
// `Invalid input: expected object, received string` —— 实测四次里三次写不进去, 一条都没落库。
//
// 扎人的地方: 它的失败**长得像内容问题**。判词说 schema 不合格, 于是人去反复改 fact 的字段
// (真实发生过三轮), 而字段从头到尾都是对的。这与本仓「判词指错方向比不报还贵」同一族。
describe('memory_remember 的 inputSchema —— 入口宽, 判据不宽', () => {
  /** 直接拿工具自己声明的那份 schema, 不复制一份会漂的。 */
  const factSchema = () => {
    const memory = createOmdMemory({ path: ':memory:', safeguard: UNIVERSAL_SAFEGUARD });
    const tools = createMemoryTools({ memory });
    const t = tools.find((x) => x.name === 'memory_remember')!;
    memory.close();
    return (t.inputSchema as unknown as { fact: { parse: (v: unknown) => unknown } }).fact;
  };

  test('★ fact 传对象 → 原样收下 (老行为, 零回归)', () => {
    expect(factSchema().parse(VALID_FACT)).toMatchObject({ namespace: 'user.preference' });
  });

  test('★ fact 传 **JSON 字符串** → parse 成对象收下 (这条红过: 生产上写不进去)', () => {
    // 怎么让它红: 把 FactInput 改回单独的 z.record(...) → 这条抛, 而那正是 2026-08-21 的生产实况。
    const parsed = factSchema().parse(JSON.stringify(VALID_FACT));
    expect(parsed).toMatchObject({ namespace: 'user.preference', category: 'editor' });
  });

  test('★ 收宽的只是**编码**, 不是判据: 字符串里的域外 namespace 照样被闸拒', async () => {
    // 这条是"入口宽"的护栏 —— 防止下次有人把它读成"字符串走后门可以绕闸"。
    const memory = createOmdMemory({ path: ':memory:', safeguard: UNIVERSAL_SAFEGUARD });
    const tools = createMemoryTools({ memory });
    const t = tools.find((x) => x.name === 'memory_remember')!;
    const fact = (t.inputSchema as unknown as { fact: { parse: (v: unknown) => unknown } }).fact.parse(
      JSON.stringify(OUT_OF_NAMESPACE_FACT),
    );
    const res = (await (t.handler as (a: Record<string, unknown>, e?: unknown) => unknown)({ fact }, {})) as {
      content: { text: string }[];
      isError?: boolean;
    };
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/^REJECTED/);
    memory.close();
  });

  test('★ 不是合法 JSON 的字符串 → 拒, 且判词说的是**传输**不是内容', () => {
    // 判词指错方向比不报还贵 —— 这条钉住它别再把编码问题说成 schema 问题。
    expect(() => factSchema().parse('这不是 JSON')).toThrow(/不是合法 JSON/);
  });

  test('★ JSON 数组 / 标量 → 拒 (parse 得出来但不是 fact, 不许带着错形状往下走)', () => {
    expect(() => factSchema().parse('[1,2,3]')).toThrow(/不是对象/);
    expect(() => factSchema().parse('"just a string"')).toThrow(/不是对象/);
  });
});
