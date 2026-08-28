/**
 * test/core/mcp-memory-tools.test.ts — memory_remember / memory_recall 工具测试 (SDD task-tools-memory 先红补票)。
 *
 * 真闸非 fake: createOmdMemory(':memory:') + UNIVERSAL_SAFEGUARD (与 tui/MCP 生产装配同一闸料) —
 *   校验闸拒写 → isError + 拒因回显 (非 crash);
 *   合法 fact → 写入 OK;
 *   写入后 recall 命中 (混合检索真跑, 默认 embed 零依赖)。
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryTools } from '../../src/mcp/tools/memory';
import { createOmdMemory } from '../../src/harness/memory';
import { fileFingerprint } from '../../src/harness/memory/staleness';
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

// ─── L2 读侧:预算 · 分层 · 陈旧标签 ────────────────────────────────────────

/**
 * 三条都是**过去没有上界**的现场:
 *  - recall 无总预算 —— 实测本仓 omd.pattern 均长 1161 / 最长 4518, k 默认 10 ⇒ 最坏一次吐 45k 字符;
 *  - 单条无上界 —— 要么全吐要么(自动注入那条路)砍到 400 字符**且没有取全文的出口**;
 *  - 无陈旧信号 —— 主张的证据文件改了, 读侧看不出来。
 *
 * 反向自检(实跑):把 `RECALL_TOTAL_CHARS` 调到 1e9 ⇒ 「超预算要说丢了几条」红;
 * 删掉 `memory_fact` ⇒ 「截断有出口」红;把 `annotateStaleness` 那行去掉 ⇒ 「⚠证据已变」红。
 */
describe('L2 — recall 预算 / memory_fact / 陈旧标签', () => {
  const bigFact = (i: number) => ({
    namespace: 'omd.pattern',
    situation: `压预算用例 ${i} 编排 leaf 档位`,
    // 2000 字符 > RECALL_PER_FACT_CHARS(1500) —— 对标真实分布的**尾巴**:
    // 本仓 omd.pattern 均长 1161(多数不截断), 最长 4518(会截断)。刻意只让尾巴触发。
    approach: `编排 leaf 档位 判据 ${'长'.repeat(2000)}`,
    outcome: 'worked',
    scope: 'plan-family',
    source_doc_id: `run:budget-${i}`,
    confidence: { level: 'agent_tentative', source_event_ids: [`ev-${i}`], created_at: new Date().toISOString() },
  });

  test('★ 总预算生效, 且丢掉的条数**说出来**(不做无声截断)', async () => {
    const { memory, remember, recall } = wire();
    for (let i = 0; i < 10; i++) await remember({ fact: bigFact(i) });
    const res = await recall({ query: '编排 leaf 档位 判据', k: 10 });
    const text = res.content[0]!.text;
    expect(text).toContain('未列出');
    expect(text).toMatch(/另有 \d+ 条命中因总预算/);
    memory.close();
  });

  test('★ 单条超长 → 头部 + id + 取全文的出口(截断必须配出口, 否则就是丢失)', async () => {
    const { memory, remember, recall } = wire();
    await remember({ fact: bigFact(0) });
    const text = (await recall({ query: '编排 leaf 档位 判据', k: 1 })).content[0]!.text;
    expect(text).toContain('[截断');
    expect(text).toContain('memory_fact(');
    memory.close();
  });

  test('★ 证据文件改了 → recall 行上出现 ⚠;没改 → 出现 ✓', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omd-l2-recall-'));
    mkdirSync(join(root, 'src'), { recursive: true });
    const abs = join(root, 'src', 'anchored.ts');
    writeFileSync(abs, 'export const v = 1;\n');
    const sha = fileFingerprint(abs)!;

    const memory = createOmdMemory({ path: ':memory:', safeguard: UNIVERSAL_SAFEGUARD });
    const tools = createMemoryTools({ memory, root });
    const remember = getTool(tools, 'memory_remember');
    const recall = getTool(tools, 'memory_recall');
    const fact = getTool(tools, 'memory_fact');

    await remember({
      fact: {
        namespace: 'omd.pattern',
        situation: '锚定用例 编排',
        approach: '这条主张挂在 anchored.ts 上',
        outcome: 'worked',
        scope: 'plan-family',
        evidence: [{ path: 'src/anchored.ts', sha }],
        source_doc_id: 'run:anchor-1',
        confidence: { level: 'agent_tentative', source_event_ids: ['ev-a'], created_at: new Date().toISOString() },
      },
    });

    expect((await recall({ query: '锚定用例 编排', k: 3 })).content[0]!.text).toContain('✓证据未变');

    writeFileSync(abs, 'export const v = 2;\n'); // 一个字符
    const after = (await recall({ query: '锚定用例 编排', k: 3 })).content[0]!.text;
    expect(after).toContain('⚠证据已变');

    // memory_fact 要能把逐个 anchor 的明细摊开(记的 sha / 现在的 sha)。
    const id = after.match(/id=([0-9a-f-]{36})/)![1]!;
    const full = (await fact({ id })).content[0]!.text;
    expect(full).toContain('src/anchored.ts stale');
    expect(full).toContain(sha);

    memory.close();
    rmSync(root, { recursive: true, force: true });
  });

  test('memory_fact 拿不到 → 说清是"不存在"还是"已 tombstone"(两种别塌成一种)', async () => {
    const { memory, remember } = wire();
    const tools = createMemoryTools({ memory });
    const fact = getTool(tools, 'memory_fact');

    const gone = await fact({ id: 'no-such-id' });
    expect(gone.isError).toBe(true);
    expect(gone.content[0]!.text).toContain('不存在');

    // 同 identity 再写一次 ⇒ 前一条被 supersede(墓碑带 reason + 继任者)。
    const first = await remember({ fact: VALID_FACT });
    const firstId = first.content[0]!.text.match(/id=([0-9a-f-]{36})/)![1]!;
    await remember({ fact: { ...VALID_FACT, value: 'plain edits' } });
    const dead = await fact({ id: firstId });
    expect(dead.isError).toBe(true);
    expect(dead.content[0]!.text).toContain('tombstone');
    expect(dead.content[0]!.text).toContain('继任者');
    memory.close();
  });
});
