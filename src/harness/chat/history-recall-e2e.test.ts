/**
 * src/harness/chat/history-recall-e2e.test.ts —— S4 端到端验收(compact→recall 全链)。
 *
 * 三片全真、零 mock:真 store(JsonlSessionRepo 写盘,mkdtemp 临时目录)、真 footer
 * (appendCompaction 内拼,C-3)、真工具(createHistoryTools 生产装配,**不注入 recall 测试接缝**
 * → handler 动态 import S1 真模块)。唯一不参与的是"模型":回捞工具由测试直调 handler,
 * 与生产装配同参同形(SDD C-4 的 G1「When history_search("X")」即此口径)。
 * G1-G6 逐条对应 C-4 验收点;每条先证过会红,证伪方式写在断言上方注释里(全部实跑)。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { uuidv7 } from '@earendil-works/pi-ai';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { createOmdSessionStore, resetSessionCacheForTest, type OmdSessionStore } from './session-store';
import { listShadowedSpans, renderShadowedTranscript, type BranchEntries } from './history-recall';
import { createHistoryTools, HistoryCompactionNotFoundError } from '../../mcp/tools/history';
import type { OmdMcpTool } from '../../mcp/server';

const msg = (role: 'user' | 'assistant', text: string): AgentMessage =>
  ({ role, content: [{ type: 'text', text }] }) as unknown as AgentMessage;

let root: string;
let store: OmdSessionStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'omd-history-recall-e2e-'));
  delete process.env.OMD_DATA_HOME; // 会话根 = <root>/.omd/chat —— 绝不落进真实 .omd 数据
  resetSessionCacheForTest();
  store = createOmdSessionStore(root);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** 直调 MCP handler(与 serve/chat-tools 的 invoke 同形),text 内容解析成 JSON。 */
const call = async (tool: OmdMcpTool, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
  const res = (await (tool.handler as (a: unknown, e: unknown) => unknown)(args, {})) as {
    content: { text?: string }[];
    isError?: boolean;
  };
  expect(res.isError).not.toBe(true);
  return JSON.parse((res.content[0]?.text ?? '{}') as string) as Record<string, unknown>;
};

/** 会话 jsonl 全文快照(byte 口径,G6 用)。 */
const jsonlBytes = (): string => {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith('.jsonl')) files.push(p);
    }
  };
  walk(join(root, '.omd/chat'));
  return files.map((f) => readFileSync(f, 'utf8')).join('\n');
};

/** 会话全部消息型条目正文拼接(断言 X 唯一性用)。 */
const allMessageText = async (sid: string): Promise<string> => {
  const s = await store.open(sid);
  return (await s!.entries())
    .filter((e) => e.type === 'message')
    .map((e) => JSON.stringify((e as { message: unknown }).message))
    .join('\n');
};

describe('S4 端到端:compact → recall 全链(真 store / 真 footer / 真工具)', () => {
  test('G1 回归钉:X 只在被遮蔽段,history_search 命中带对 compactionEntryId 与 seq,scanned ≥ spans 总数', async () => {
    // 本票存在理由:回捞真的能捞到只在被遮蔽段的内容。X 只出现在 A2,两段压缩的尾巴
    // (A4、B3)与两条 summary 都不含 X —— 命中只可能来自 shadowed 段。
    // 证伪(实测红,两处各证一次):① 把 searchShadowedSpans 定界 compactions 的
    // `scanned += 1` 改成 `+= 0` → scanned 7→5,精确等式红(它同时承载
    // 「scanned ≥ spans 总数」的结构性钉);② 把 resolveSpans 的 `spanStart = i + 1`
    // 改回 `spanStart = 0` → C2 的 span 吞进 A 段,X 命中两条 → snippets.length 2≠1 红。
    const X = 'G1-回捞唯一串-4f2c8a';
    const sid = 'e2e-g1';
    const sess = await store.create(sid, 'G1 会话');
    await sess.append(msg('user', '项目背景甲'));
    await sess.append(msg('user', `唯一的串 ${X} 藏在被遮蔽段`));
    await sess.append(msg('assistant', '回答一'));
    await sess.append(msg('assistant', '回答二'));
    await sess.appendCompaction({ summary: '摘要一:背景与回答', tokensBefore: 10, retainedTail: [msg('assistant', '回答二')] });
    await sess.append(msg('user', '追问乙'));
    await sess.append(msg('assistant', '回答三'));
    await sess.append(msg('user', '追问丙'));
    await sess.appendCompaction({ summary: '摘要二:追问与回答', tokensBefore: 10, retainedTail: [msg('user', '追问丙')] });

    const entries = (await sess.entries()) as BranchEntries;
    const comps = entries.filter((e) => e.type === 'compaction') as unknown as Array<{ id: string; summary: string }>;
    expect(comps).toHaveLength(2);
    // X 只在被遮蔽段:两条 summary 不含 X,retainedTail 由构造保证不含 X,全文恰好一次。
    expect(comps.every((c) => !c.summary.includes(X))).toBe(true);
    expect((await allMessageText(sid)).split(X).length - 1).toBe(1);
    const hitEntry = entries.find(
      (e) => e.type === 'message' && JSON.stringify((e as { message: unknown }).message).includes(X),
    ) as { seq: number } | undefined;
    expect(hitEntry).toBeDefined();

    const spans = listShadowedSpans(entries);
    expect(spans).toEqual([
      { compactionEntryId: comps[0]!.id, startSeq: 1, endSeq: 3, count: 3 },
      { compactionEntryId: comps[1]!.id, startSeq: 6, endSeq: 7, count: 2 },
    ]);
    const [, searchTool] = createHistoryTools({ store, sessionId: sid });
    const r = (await call(searchTool, { query: X })) as {
      snippets: Array<{ compactionEntryId: string; seq: number; snippet: string }>;
      scanned: number;
      matched: number;
      truncated: boolean;
    };
    expect(r.snippets).toEqual([
      { compactionEntryId: comps[0]!.id, seq: hitEntry!.seq, snippet: `唯一的串 ${X} 藏在被遮蔽段` },
    ]);
    // scanned = 定界 compaction 条目数 + 被搜 shadowed 消息条目数 ≥ spans 总数(结构性成立)。
    expect(r.scanned).toBe(spans.length + spans.reduce((n, s) => n + s.count, 0));
    expect(r.scanned).toBeGreaterThanOrEqual(spans.length);
    expect(r.matched).toBe(1);
    expect(r.truncated).toBe(false);

    // 同一段内容,history_read 也捞得到(回捞的读面同源)。
    const [readTool] = createHistoryTools({ store, sessionId: sid });
    expect(((await call(readTool, { compactionEntryId: comps[0]!.id })) as { text: string }).text).toContain(X);
  });

  test('G2 重放确定性:同一份 jsonl 两次独立读盘,listShadowedSpans / renderShadowedTranscript 各跑两次 byte 相同', async () => {
    // 证伪(实测红):把 renderShadowedTranscript 的 text 拼接混入 `Date.now()` → 本闸红。
    // ⚠ 证红时发现裸连跑两次会落在同一毫秒(Date.now() 同值)→ 闸形同虚设 ——
    // 所以两次 run 之间隔 5ms 墙钟:任何时钟/随机混入必现 byte 不等。
    const sid = 'e2e-g2';
    const sess = await store.create(sid, 'G2 会话');
    await sess.append(msg('user', '甲'));
    await sess.append(msg('assistant', '乙'));
    await sess.append(msg('user', '丙'));
    await sess.appendCompaction({ summary: '摘要', tokensBefore: 1, retainedTail: [msg('user', '丙')] });
    const compId = (await sess.entries()).find((e) => e.type === 'compaction')!.id;

    // 同一份 jsonl 读两次(两次独立读盘,不是同一数组复用)。
    const a = (await sess.entries()) as BranchEntries;
    const b = (await (await store.open(sid))!.entries()) as BranchEntries;
    const run = (e: BranchEntries): string =>
      JSON.stringify({ spans: listShadowedSpans(e), rendered: renderShadowedTranscript(e, compId) });
    const first = run(a);
    await new Promise((resolve) => setTimeout(resolve, 5)); // 跨毫秒:时钟依赖无处藏
    expect(run(a)).toBe(first);
    expect(run(b)).toBe(first);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b)); // 两次读盘的条目序列也 byte 相同
  });

  test('G3 向后兼容:旧会话 compaction 无 footer,history_read 现算范围正常渲染不抛', async () => {
    // 旧格式 = 老版本 appendCompaction 的产物:summary 裸写、无 footer。范围永远按 D-7
    // 现算,不解析 summary。
    // 证伪(实测红):在 findResolved 加回「summary 必须含 '[compaction ' 否则抛」→ 本闸
    // history_read 直接抛 "旧摘要无 footer"(前驱日志实测同型红)。
    const sid = 'e2e-g3';
    const X = '旧会话里的独有串-9c1e';
    const sess = await store.create(sid, 'G3 会话');
    await sess.append(msg('user', '旧甲'));
    await sess.append(msg('user', `旧乙 ${X}`));
    await sess.append(msg('assistant', '旧丙'));
    await sess.tree.appendEntry(
      { type: 'compaction', id: uuidv7(), summary: '旧式摘要,没有 footer 行', tokensBefore: 1, retainedTail: [msg('assistant', '旧丙')] },
      'main',
    );

    const entries = (await sess.entries()) as BranchEntries;
    const comp = entries.find((e) => e.type === 'compaction') as { id: string; summary: string } | undefined;
    expect(comp!.summary.includes('[compaction ')).toBe(false);
    // 现算范围与 S1 同源:3 条消息 - 尾留 1 条 = 2 条 shadowed。
    expect(listShadowedSpans(entries)).toEqual([{ compactionEntryId: comp!.id, startSeq: 1, endSeq: 2, count: 2 }]);

    const [readTool] = createHistoryTools({ store, sessionId: sid });
    const read = (await call(readTool, { compactionEntryId: comp!.id })) as { text: string };
    expect(read.text).toContain(X);
    expect(read.text).not.toContain('旧丙'); // 尾留的那条不在遮蔽范围里
  });

  test('G4 交叉一致:真实压缩后 footer 的 count/startSeq/endSeq 与 listShadowedSpans 完全相等', async () => {
    // S3(footer 拼数)与 S1(D-7 现算)是两处独立实现 —— 本闸钉三数字不许漂。
    // 证伪(实测红):把 buildCompactionFooter 的 shadowed 多留一条
    // (`span.slice(0, n - t + 1)`)→ footer count 4 而 span count 3,本闸红。
    const sid = 'e2e-g4';
    const sess = await store.create(sid, 'G4 会话');
    await sess.append(msg('user', '一'));
    await sess.append(msg('assistant', '二'));
    await sess.append(msg('user', '三'));
    await sess.append(msg('assistant', '四'));
    await sess.append(msg('user', '五'));
    await sess.appendCompaction({ summary: '摘要四', tokensBefore: 3, retainedTail: [msg('assistant', '四'), msg('user', '五')] });

    const entries = (await sess.entries()) as BranchEntries;
    const comp = entries.find((e) => e.type === 'compaction') as { id: string; summary: string } | undefined;
    const m = comp!.summary.match(/\[compaction (\S+): shadows (\d+) msgs seq (\d+)-(\d+); originals via history_read\]$/);
    expect(m).not.toBeNull();
    const span = listShadowedSpans(entries)[0]!;
    // footer 的 id 与 entry 同源,三个数字与 S1 现算**完全相等**(不是范围包含)。
    expect(m![1]).toBe(comp!.id);
    expect(Number(m![2])).toBe(span.count);
    expect(Number(m![3])).toBe(span.startSeq);
    expect(Number(m![4])).toBe(span.endSeq);
    expect(
      comp!.summary.endsWith(
        `\n[compaction ${comp!.id}: shadows ${span.count} msgs seq ${span.startSeq}-${span.endSeq}; originals via history_read]`,
      ),
    ).toBe(true);
  });

  test('G5 错误面:不存在的 compactionEntryId 经两工具 → typed error 且文案含该 id', async () => {
    // 证伪(实测红):删掉 history.ts requireCompaction 里的 throw → 工具空结果返回,
    // 本闸 toBeInstanceOf(HistoryCompactionNotFoundError)当场红。
    const sid = 'e2e-g5';
    const sess = await store.create(sid, 'G5 会话');
    await sess.append(msg('user', '有内容'));
    await sess.appendCompaction({ summary: '摘要', tokensBefore: 1, retainedTail: [] });
    const missing = 'no-such-compaction-0000';
    const [readTool, searchTool] = createHistoryTools({ store, sessionId: sid });
    for (const [tool, args] of [
      [readTool, { compactionEntryId: missing }],
      [searchTool, { query: 'x', compactionEntryId: missing }],
    ] as const) {
      let thrown: unknown;
      try {
        await call(tool, args as Record<string, unknown>);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(HistoryCompactionNotFoundError);
      expect(thrown).toBeInstanceOf(Error);
      expect(String(thrown)).toContain(missing);
    }
  });

  test('G6 前缀不动:一次回捞后 jsonl 此前的消息序列 byte 不变(工具零写,只读)', async () => {
    // 证伪(实测红):在 before 快照与比较之间临时 append 一条消息 → `toBe(before)` 红,
    // 证明 byte 比较器真能嗅到写入(不是恒真断言)。
    const sid = 'e2e-g6';
    const X = 'G6-回捞串-77aa';
    const sess = await store.create(sid, 'G6 会话');
    await sess.append(msg('user', `六甲 ${X}`));
    await sess.append(msg('assistant', '六乙'));
    await sess.appendCompaction({ summary: '摘要六', tokensBefore: 1, retainedTail: [msg('assistant', '六乙')] });
    const compId = (await sess.entries()).find((e) => e.type === 'compaction')!.id;

    const before = jsonlBytes();
    const projBefore = JSON.stringify(await sess.messages());
    const [readTool, searchTool] = createHistoryTools({ store, sessionId: sid });
    const read = (await call(readTool, { compactionEntryId: compId })) as { text: string };
    const found = (await call(searchTool, { query: X })) as { snippets: Array<{ snippet: string }> };
    // 回捞内容进的是工具回执(= loop 落 tool/result 的正文),不碰此前序列。
    expect(read.text).toContain(X);
    expect(found.snippets[0]!.snippet).toContain(X);
    expect(jsonlBytes()).toBe(before); // 工具只读:磁盘字节一个不动
    expect(JSON.stringify(await sess.messages())).toBe(projBefore); // 投影也不动
    // 反向自检 (原先内联在正断言路径上, 于是这条闸恒红): 真写一条, 比较器必须嗅得到 ——
    // 证明上面两条不是恒真式。**顺序重要**: 干扰写必须在"工具只读"判完之后。
    await sess.append(msg('user', '证红干扰消息'));
    expect(jsonlBytes()).not.toBe(before);
  });
});