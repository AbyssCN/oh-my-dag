/**
 * src/harness/chat/history-recall.test.ts —— C-1 纯函数的闸(SDD 2026-08-18-recallable-compaction-chat 切片 1)。
 *
 * 本仓惯例:每条新闸先证过一次会红,证伪方式写在各自注释里(全部实测,非空谈)。
 * fixture 都是字面条目序列,不写盘 —— 本文件零 IO,与被测件同为纯函数。
 */
import { describe, expect, it } from 'bun:test';
import {
  listShadowedSpans,
  renderShadowedTranscript,
  searchShadowedSpans,
  type BranchEntries,
} from './history-recall';

type Role = 'user' | 'assistant' | 'toolResult';

/** 消息型条目 fixture(与 pi 的 `Entry` 结构对齐;消息体沿用本仓测试惯例 `as unknown as`)。 */
const messageEntry = (id: string, seq: number, role: Role, text: string): BranchEntries[number] =>
  ({
    type: 'message',
    id,
    seq,
    parentId: null,
    timestamp: seq,
    message:
      role === 'user'
        ? { role, content: text, timestamp: seq }
        : { role, content: [{ type: 'text', text }], timestamp: seq },
  }) as unknown as BranchEntries[number];

const compactionEntry = (id: string, seq: number, retainedTailCount: number, summary = '摘要'): BranchEntries[number] =>
  ({
    type: 'compaction',
    id,
    seq,
    parentId: null,
    timestamp: seq,
    summary,
    tokensBefore: 0,
    // retainedTail 是消息副本、不带 entry id —— fixture 刻意用与消息本体无关的内容,
    // 让「按 id 匹配尾部」这类实现当场对不上。
    retainedTail: Array.from({ length: retainedTailCount }, (_, i) => ({
      role: 'user' as const,
      content: `retained-${id}-${i}`,
      timestamp: seq,
    })),
  }) as unknown as BranchEntries[number];

const customEntry = (id: string, seq: number): BranchEntries[number] =>
  ({ type: 'custom', id, seq, parentId: null, timestamp: seq, customType: 'note', data: { seq } }) as unknown as BranchEntries[number];

const branchSummaryEntry = (id: string, seq: number): BranchEntries[number] =>
  ({
    type: 'branch_summary',
    id,
    seq,
    parentId: null,
    timestamp: seq,
    fromId: 'elsewhere',
    summary: '分支摘要',
  }) as unknown as BranchEntries[number];

/**
 * 主 fixture:两条 compaction 串在 custom / branch_summary 与消息型条目夹杂的序里。
 * C1 遮蔽 m1,m2,t1(span 5 条消息,retainedTail 2 → 去掉 m3,m4);C2 遮蔽 m5(span 2 条,retainedTail 1)。
 * m7 在最后一条 compaction 之后 → 不在任何 span 里。
 */
const mainFixture = (): BranchEntries => [
  customEntry('c0', 1),
  messageEntry('m1', 2, 'user', '第一问'),
  messageEntry('m2', 3, 'assistant', '第一答'),
  messageEntry('t1', 4, 'toolResult', '工具输出\n多行'),
  customEntry('c1', 5),
  messageEntry('m3', 6, 'user', '第二问'),
  branchSummaryEntry('b1', 7),
  messageEntry('m4', 8, 'assistant', '第二答'),
  compactionEntry('C1', 9, 2),
  customEntry('c2', 10),
  messageEntry('m5', 11, 'user', '第三问'),
  messageEntry('m6', 12, 'assistant', '第三答'),
  compactionEntry('C2', 13, 1),
  messageEntry('m7', 14, 'user', '第四问'),
];

describe('listShadowedSpans(D-7)', () => {
  it('范围只含消息型条目,retainedTail 按条数对位', () => {
    // 证伪(实测红):把 `x.type === 'message'` 改成 `x.type !== 'compaction'`
    // → custom/branch_summary 混进 span,startSeq/endSeq/count 全对不上,本闸红。
    expect(listShadowedSpans(mainFixture())).toEqual([
      { compactionEntryId: 'C1', startSeq: 2, endSeq: 4, count: 3 },
      { compactionEntryId: 'C2', startSeq: 11, endSeq: 11, count: 1 },
    ]);
  });

  it('③ 极端夹杂序:custom / branch_summary 与消息型条目交错,消息筛选与 retainedTail 对位不漂', () => {
    // Open 项明确要求的 fixture。retainedTail = 2 该去掉的恰好是 m2,m3 两条**消息**,
    // 而它们之间有 custom(cx)与 branch_summary(bx)—— 按「全部条目」对位会多留一条、按
    // 内容/id 匹配则 retainedTail 内容与消息本体毫不相干。
    // 证伪(实测红):把筛选改成 `x.type !== 'compaction'` → count 3 / startSeq 1 / endSeq 3,本闸红;
    // 把 shadowed 直接取成 messages(retainedTail 对位整个失效)→ count 3,本闸红(实测)。
    const entries: BranchEntries = [
      messageEntry('m1', 1, 'user', '甲'),
      customEntry('cx', 2),
      messageEntry('m2', 3, 'assistant', '乙'),
      branchSummaryEntry('bx', 4),
      messageEntry('m3', 5, 'user', '丙'),
      compactionEntry('C', 6, 2),
    ];
    expect(listShadowedSpans(entries)).toEqual([{ compactionEntryId: 'C', startSeq: 1, endSeq: 1, count: 1 }]);
    expect(renderShadowedTranscript(entries, 'C')).toEqual({ text: 'User: 甲\n' });
  });

  it('④ 空 span → count 显式 0,startSeq 与 endSeq 相等', () => {
    // 两条空路都要:retainedTail 比消息多(C1)、两条 compaction 之间没有消息(C2)。
    // 证伪(实测红):把空 span 的 startSeq 写成 0 → startSeq ≠ endSeq,本闸红。
    const entries: BranchEntries = [
      messageEntry('m1', 1, 'user', '甲'),
      compactionEntry('C1', 2, 5),
      compactionEntry('C2', 3, 0),
    ];
    const spans = listShadowedSpans(entries);
    expect(spans).toEqual([
      { compactionEntryId: 'C1', startSeq: 2, endSeq: 2, count: 0 },
      { compactionEntryId: 'C2', startSeq: 3, endSeq: 3, count: 0 },
    ]);
    for (const s of spans) {
      expect(s.count).toBe(0);
      expect('count' in s).toBe(true);
      expect(s.startSeq === s.endSeq).toBe(true);
    }
  });

  it('⑤ 多条 compaction 串联:span 互不重叠且首尾相接(铺满全部消息型条目)', () => {
    // 证伪(实测红):把 `spanStart = i + 1` 改成 `spanStart = 0` → 每条 span 都从根起,C2/C3 与 C1 重叠,本闸红。
    const entries: BranchEntries = [
      messageEntry('m1', 1, 'user', '一'),
      messageEntry('m2', 2, 'assistant', '二'),
      compactionEntry('C1', 3, 1),
      messageEntry('m3', 4, 'user', '三'),
      messageEntry('m4', 5, 'assistant', '四'),
      compactionEntry('C2', 6, 2),
      messageEntry('m5', 7, 'user', '五'),
      messageEntry('m6', 8, 'assistant', '六'),
      compactionEntry('C3', 9, 0),
    ];
    const spans = listShadowedSpans(entries);
    expect(spans).toEqual([
      { compactionEntryId: 'C1', startSeq: 1, endSeq: 1, count: 1 },
      { compactionEntryId: 'C2', startSeq: 6, endSeq: 6, count: 0 },
      { compactionEntryId: 'C3', startSeq: 7, endSeq: 8, count: 2 },
    ]);
    // 互不重叠:前一条 span 的末 seq 严格小于后一条的首 seq(空 span 用 C.seq 对位)。
    for (let i = 1; i < spans.length; i++) {
      expect(spans[i - 1]!.endSeq < spans[i]!.startSeq).toBe(true);
    }
    // 首尾相接:shadowed ∪ retained 按 compaction 序无缝铺满全部消息型条目(无叠无漏)。
    const kept = ['m2', 'm3', 'm4']; // C1 留 1 条 + C2 留 2 条 + C3 留 0 条
    expect(['m1', ...kept, 'm5', 'm6']).toEqual(
      entries.filter((e) => e.type === 'message').map((e) => e.id),
    );
  });
});

describe('纯函数契约(零 IO,重放确定)', () => {
  it('① G2 重放确定性:同一份条目数组连跑两次,输出 byte 相同', () => {
    // 证伪(实测红):把 renderShadowedTranscript 的 text 拼接临时混入 `Date.now()` → 两次输出 byte 不等,本闸红。
    const entries = mainFixture();
    const before = JSON.stringify(entries);
    const run = () =>
      JSON.stringify({
        spans: listShadowedSpans(entries),
        rendered: renderShadowedTranscript(entries, 'C1'),
        searched: searchShadowedSpans(entries, '问'),
      });
    expect(run()).toBe(run());
    expect(JSON.stringify(entries)).toBe(before); // 输入不被改动
  });

  it('② G3 向后兼容:旧会话 compaction 的 summary 没有 footer,照 D-7 现算范围正常渲染、不抛', () => {
    // 范围永远现算、从不解析 summary —— 旧摘要有没有 footer 都不影响输出。
    // 证伪(实测红):在 findResolved 里临时加「summary 必须含 '[compaction ' 否则抛」→ 本闸当场红。
    const entries = mainFixture().map((e) =>
      e.type === 'compaction' && e.id === 'C1'
        ? { ...e, summary: '2026 年旧式摘要\n没有任何 footer 行' }
        : e,
    ) as BranchEntries;
    expect(renderShadowedTranscript(entries, 'C1')).toEqual({
      text: 'User: 第一问\nAssistant: 第一答\nTool result: 工具输出\n多行\n',
    });
    expect(listShadowedSpans(entries)[0]!.count).toBe(3);
  });
});

describe('renderShadowedTranscript', () => {
  it('三段式标签 + budgetChars/offset 分页,nextOffset 只在截断时在场', () => {
    // 证伪(实测红):把「渲染完」分支改成 `{ text, nextOffset: text.length }` → `'nextOffset' in tail` 红。
    const entries = mainFixture();
    const full = renderShadowedTranscript(entries, 'C1');
    expect(full).toEqual({ text: 'User: 第一问\nAssistant: 第一答\nTool result: 工具输出\n多行\n' });
    expect('nextOffset' in full).toBe(false);

    const page1 = renderShadowedTranscript(entries, 'C1', { budgetChars: 10 });
    expect(page1).toEqual({ text: full.text.slice(0, 10), nextOffset: 10 });
    const page2 = renderShadowedTranscript(entries, 'C1', { offset: 10, budgetChars: 10 });
    expect(page2).toEqual({ text: full.text.slice(10, 20), nextOffset: 20 });
    const tail = renderShadowedTranscript(entries, 'C1', { offset: 20 });
    expect(tail).toEqual({ text: full.text.slice(20) });
    expect('nextOffset' in tail).toBe(false);
    // offset 越界按已读完处理
    const past = renderShadowedTranscript(entries, 'C1', { offset: 999 });
    expect(past).toEqual({ text: '' });
    expect('nextOffset' in past).toBe(false);
  });

  it('不存在的 compactionEntryId → 抛,错误文案带 id;空 span 渲染成空串不抛', () => {
    // 证伪(实测红):findResolved 找不到时返回 undefined → 本闸的 toThrow 当场红。
    const entries = mainFixture();
    expect(() => renderShadowedTranscript(entries, 'NO_SUCH_ID')).toThrow('NO_SUCH_ID');
    const empty: BranchEntries = [messageEntry('m1', 1, 'user', '甲'), compactionEntry('C', 2, 5)];
    expect(renderShadowedTranscript(empty, 'C')).toEqual({ text: '' });
  });
});

describe('searchShadowedSpans', () => {
  const entries = mainFixture();

  it('只搜 shadowed 段:retained 与最后 compaction 之后的条目都不算命中;scanned/matched 如实计数', () => {
    // '问' 出现在 m1(C1 shadowed)、m3(C1 retained)、m5(C2 shadowed)、m7(末 compaction 后):
    // 命中只能是 m1,m5。证伪(实测红):把 scanned 的「定界 compaction 条目 +1」删掉
    // → scanned 6→4,本闸红(同时让 G1 的 scanned ≥ spans 总数失去结构性保证)。
    const r = searchShadowedSpans(entries, '问');
    expect(r.snippets).toEqual([
      { compactionEntryId: 'C1', seq: 2, snippet: '第一问' },
      { compactionEntryId: 'C2', seq: 11, snippet: '第三问' },
    ]);
    expect(r.scanned).toBe(6); // 2 条定界 compaction + 4 条 shadowed 消息
    expect(r.matched).toBe(2);
    expect(r.truncated).toBe(false);
  });

  it('无命中 → 空表不是错误;scanned 仍如实报', () => {
    const r = searchShadowedSpans(entries, '不存在的串');
    expect(r).toEqual({ snippets: [], scanned: 6, matched: 0, truncated: false });
  });

  it('limit 截断:truncated 如实,多出的命中不塞进 snippets', () => {
    const r = searchShadowedSpans(entries, '问', { limit: 1 });
    expect(r.snippets).toEqual([{ compactionEntryId: 'C1', seq: 2, snippet: '第一问' }]);
    expect(r.matched).toBe(2);
    expect(r.truncated).toBe(true);
  });

  it('compactionEntryId 过滤:scanned 只算被搜的那一段', () => {
    const r = searchShadowedSpans(entries, '问', { compactionEntryId: 'C2' });
    expect(r).toEqual({
      snippets: [{ compactionEntryId: 'C2', seq: 11, snippet: '第三问' }],
      scanned: 2, // C2 自己 + m5
      matched: 1,
      truncated: false,
    });
    expect(() => searchShadowedSpans(entries, '问', { compactionEntryId: 'NOPE' })).toThrow('NOPE');
  });

  it('纯字面扫描:大小写敏感;空 query 抛', () => {
    const fx: BranchEntries = [messageEntry('m', 1, 'user', 'Alpha'), compactionEntry('C', 2, 0)];
    expect(searchShadowedSpans(fx, 'alpha')).toEqual({
      snippets: [],
      scanned: 2,
      matched: 0,
      truncated: false,
    });
    expect(() => searchShadowedSpans(entries, '')).toThrow('不能为空');
  });

  it('snippet 取首个命中点前后各 120 字符,掐头去尾处补 …', () => {
    const long = `${'头'.repeat(200)}NEEDLE${'尾'.repeat(200)}`;
    const fx: BranchEntries = [messageEntry('m', 1, 'user', long), compactionEntry('C', 2, 0)];
    const r = searchShadowedSpans(fx, 'NEEDLE');
    expect(r.snippets).toEqual([
      { compactionEntryId: 'C', seq: 1, snippet: `…${'头'.repeat(120)}NEEDLE${'尾'.repeat(120)}…` },
    ]);
  });
});