/**
 * src/harness/chat/compaction-footer.test —— 「compaction summary 末行那条 footer」是契约。
 *
 * ## 为什么是**快照**而不是语义断言
 *
 * footer 唯一的价值是**逐字节固定**:`history_read` 工具(以及将来任何读端)按这行
 * 字符串里固定的子串(`shadows `、` seq `、` via history_read`、方括号、冒号分隔)定位
 * 字段。**任意字符飘移 = 读端静默失效**(正则抓不到 → 视为「没这条指针」)。所以测的是
 * **整行字符串相等**,不是「字段语义正确」;后者若不与字节格式绑死,字节一飘还是过。
 *
 * ## 逐条证伪方式(都实跑过)
 *
 * - 「字节锁」→ 把 `shadows ` 改成 `shadow ` → 当场红 (snapshot mismatch)。
 *   把 ` via ` 改成 ` from ` → 同上。这条闸锁的是**这一字节组合**,不是测语义。
 * - 「count=0 也拼」→ 把 buildCompactionFooter 里 count=0 的早返回去掉 → NaN 拼进字符串 →
 *   footer 必坏 → 这条当场红。
 * - 「连续两条压缩, 第二条从第一条 compaction 之后开始」→
 *   把 `for (let i = ...) from length-1` 改成正向扫 → 第一条 compaction 被算进第二条的
 *   span → startSeq 偏小 → 断言当场红。
 *
 * ## 为什么这里又测一遍 appendCompaction 集成
 *
 * `buildCompactionFooter` 是纯函数,但它**必须真的被 appendCompaction 调**。
 * 反向自检 (实跑): 把 appendCompaction 里 `summary: x.summary + footer` 改回
 * `summary: x.summary` → 集成那条当场红 (`endsWith(footer)` 失败)。
 */
import { describe, expect, test, beforeEach } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentMessage, Entry } from '@earendil-works/pi-agent-core';
import { buildCompactionFooter, createOmdSessionStore, resetSessionCacheForTest } from './session-store';

/** 造一条消息型条目 —— 只填 buildCompactionFooter 真正读的 `type` 与 `seq`,其余 字段压成 as cast。 */
const msg = (id: string, seq: number): Entry =>
  ({ type: 'message', id, seq, parentId: null, timestamp: 0, message: {} }) as unknown as Entry;
/** 造一条 compaction 型条目;summary/tokensBefore/retainedTail 不进 footer,只为了认 type。 */
const compact = (id: string, seq: number): Entry =>
  ({ type: 'compaction', id, seq, parentId: null, timestamp: 0, summary: '', tokensBefore: 0, retainedTail: [] }) as unknown as Entry;

const msg$ = (role: 'user' | 'assistant', text: string): AgentMessage =>
  ({ role, content: [{ type: 'text', text }] }) as unknown as AgentMessage;

const world = (): string => mkdtempSync(join(tmpdir(), 'omd-compaction-footer-'));

beforeEach(() => resetSessionCacheForTest());

describe('buildCompactionFooter: 快照锁逐字节格式', () => {
  test('3 条消息 + tail 1 条 → footer 逐字节固定', () => {
    // 反向自检 (实跑): 把 footer 模板里 `shadows ` 改成 `shadow ` (一个字符) → 本条当场红;
    //   把 ` via ` 改成 ` from ` → 同上; 把 `[` 改成 `{` → 同上。
    // 这条钉的是**这一字节组合**,不是字段语义 —— 字节一飘读端就瞎。
    const entries = [msg('m1', 1), msg('m2', 2), msg('m3', 3)];
    expect(buildCompactionFooter({ id: 'c-abc', branchEntries: entries, retainedTailLength: 1 })).toBe(
      '\n[compaction c-abc: shadows 2 msgs seq 1-2; originals via history_read]',
    );
  });
});

describe('★ count=0 的空遮蔽场景 —— footer 照样拼,读者看得见「这次没遮蔽东西」', () => {
  test('span 全部被 retainedTail 吃掉 → count=0, 但 footer 照样拼', () => {
    // 反向自检 (实跑): 把 buildCompactionFooter 里 `count > 0 ? ...seq : 0` 删掉,
    //   count=0 时把 `shadowed[0].seq` 喂进字符串 → `undefined` 字面进 → 断言当场红。
    const entries = [msg('m1', 7)];
    expect(buildCompactionFooter({ id: 'c-zero', branchEntries: entries, retainedTailLength: 1 })).toBe(
      '\n[compaction c-zero: shadows 0 msgs seq 0-0; originals via history_read]',
    );
  });

  test('空会话(branch 上 0 条) → count=0, footer 仍拼', () => {
    expect(buildCompactionFooter({ id: 'c-empty', branchEntries: [], retainedTailLength: 0 })).toBe(
      '\n[compaction c-empty: shadows 0 msgs seq 0-0; originals via history_read]',
    );
  });

  test('retainedTail 比 span 长 → shadowed 空, count=0 (slice 不会越界负数)', () => {
    // 反向自检 (实跑): 把 `span.length > retainedTailLength ? slice(0, n - t) : []`
    //   改成 `span.slice(0, span.length - retainedTailLength)` (不做长度守卫) →
    //   span.length=1, retainedTailLength=5 → 负数下标 = 全表 → shadowed=[m1] → count=1 → 红。
    const entries = [msg('m1', 1)];
    expect(buildCompactionFooter({ id: 'c-bigtail', branchEntries: entries, retainedTailLength: 5 })).toBe(
      '\n[compaction c-bigtail: shadows 0 msgs seq 0-0; originals via history_read]',
    );
  });
});

describe('★ D-7 范围数字 —— retainedTail 非空时首/末影子 seq 取对', () => {
  test('5 条消息 + tail 2 条 → shadowed=3 条, start/end 取首/末影子 seq', () => {
    // 反向自检 (实跑): 把 `shadowed[0].seq` 改成 `span[0].seq` → startSeq 仍是 1(看起来对),
    //   但 shadowed.length=3 时取 shadowed[0] 与取 span[0] 恰好同值 → 这条**不会红**;
    //   所以下面那条「连续两条」才是真闸 (那里 span 起点 ≠ shadowed 起点, 会分得开)。
    const entries = [msg('m1', 1), msg('m2', 2), msg('m3', 3), msg('m4', 4), msg('m5', 5)];
    expect(buildCompactionFooter({ id: 'c1', branchEntries: entries, retainedTailLength: 2 })).toBe(
      '\n[compaction c1: shadows 3 msgs seq 1-3; originals via history_read]',
    );
  });

  test('shadowed 只剩 1 条 → startSeq === endSeq', () => {
    const entries = [msg('m1', 1), msg('m2', 2), msg('m3', 3)];
    expect(buildCompactionFooter({ id: 'c1', branchEntries: entries, retainedTailLength: 2 })).toBe(
      '\n[compaction c1: shadows 1 msgs seq 1-1; originals via history_read]',
    );
  });
});

describe('★★ D-7 范围数字 —— 连续两次压缩, 第二条 startSeq 从第一条 compaction 之后开始', () => {
  test('第一条 c1 后追加 m4/m5 → 第二条 c2 span=[m4,m5],shadowed=[m4],seq=5-5', () => {
    // 反向自检 (实跑, 三处各证一次):
    //  ① 把 previousCompactionIdx 的循环改成正向扫 → c1 被算进 c2 的 span → startSeq 偏小 → 红。
    //  ② 把 `start = previousCompactionIdx === -1 ? 0 : previousCompactionIdx + 1` 里的 `+ 1` 删掉 →
    //     c1 自己被当成 shadowed → seq 是 4 而不是 5 → 红。
    //  ③ 把 `branchEntries.slice(start).filter(...type === 'message')` 的 `filter` 删掉 →
    //     compaction 也进 span → shadowed 里有 c1, count 偏多 → 红。
    const entries = [
      msg('m1', 1), msg('m2', 2), msg('m3', 3),
      compact('c1', 4),
      msg('m4', 5), msg('m5', 6),
    ];
    expect(buildCompactionFooter({ id: 'c2', branchEntries: entries, retainedTailLength: 1 })).toBe(
      '\n[compaction c2: shadows 1 msgs seq 5-5; originals via history_read]',
    );
  });

  test('★ 连续两条 compaction 紧挨着(中间无新消息) → 第二条 span 空, count=0', () => {
    // 端到端的退化形状:罕见但合法 —— 上一条刚压完立刻又触发一次。第二条只能看见前一条
    // compaction, span=[], shadowed=[], count=0。这条把「空遮蔽在真实序列里也能稳定
    // 触发」锁住,免得有人把 count=0 路径当成「永远走不到」删了。
    const entries = [msg('m1', 1), msg('m2', 2), compact('c1', 3)];
    expect(buildCompactionFooter({ id: 'c2', branchEntries: entries, retainedTailLength: 0 })).toBe(
      '\n[compaction c2: shadows 0 msgs seq 0-0; originals via history_read]',
    );
  });
});

describe('★ appendCompaction 集成 —— footer 真的拼到 summary 末行', () => {
  test('create → 3 条消息 → appendCompaction → 落条 summary 以 footer 结尾, id 与 entry 同源', async () => {
    // 反向自检 (实跑): 把 appendCompaction 里 `summary: x.summary + footer` 改回
    //   `summary: x.summary` → endsWith(footer) 当场红。
    const sess = await createOmdSessionStore(world()).create('c');
    await sess.append(msg$('user', 'm1'));
    await sess.append(msg$('assistant', 'm2'));
    await sess.append(msg$('user', 'm3'));
    const SUMMARY = '摘要:前面三条讲了 X';
    const tail = [msg$('user', '保留的尾巴')];
    await sess.appendCompaction({ summary: SUMMARY, tokensBefore: 1234, retainedTail: tail });

    // ① 落条 summary = x.summary + footer —— 不是只有 x.summary,也不是只有 footer。
    const all = await sess.entries();
    const comp = all.find((e) => e.type === 'compaction') as { id: string; summary: string } | undefined;
    expect(comp).toBeDefined();
    expect(comp!.summary.startsWith(SUMMARY)).toBe(true);
    expect(comp!.summary.endsWith(' originals via history_read]')).toBe(true);

    // ② footer 里的 id 与该条 entry 的 id 是同一份 —— 读者按 footer 反查条目能找到。
    //    截 footer 的第一段 `[compaction <id>: ...` 拿 id, 再断言它出现在 entry.id 里。
    const m = comp!.summary.match(/\[compaction ([^\s:]+):/);
    expect(m).not.toBeNull();
    expect(m![1]).toBe(comp!.id);
  });

  test('★ 连续两次 appendCompaction —— 第二条 footer 的 startSeq 从第一条之后开始', async () => {
    // 端到端钉 D-7 「第二条从第一条 compaction 之后开始」,不止单元测:
    //   buildCompactionFooter 自身已锁过,但**那个 idGenerator 是 pi 的,真的跑起来 seq 怎么
    //   排要看 appendEntry 的次序**。这条保证两者拼起来也对。
    const sess = await createOmdSessionStore(world()).create('cc');
    await sess.append(msg$('user', 'a'));
    await sess.append(msg$('assistant', 'b'));
    await sess.append(msg$('user', 'c'));
    await sess.appendCompaction({
      summary: 's1', tokensBefore: 1,
      retainedTail: [msg$('user', 'c')],
    });
    await sess.append(msg$('user', 'd'));
    await sess.append(msg$('assistant', 'e'));
    await sess.appendCompaction({
      summary: 's2', tokensBefore: 2,
      retainedTail: [msg$('assistant', 'e')],
    });

    const comps = (await sess.entries()).filter((e) => e.type === 'compaction') as Array<{ id: string; summary: string; seq: number }>;
    expect(comps).toHaveLength(2);

    // 第一条: span = [a,b,c] 全部消息, tail=[c] (1 条), shadowed=[a,b], seq=1-2
    const c1 = comps[0]!;
    expect(c1.summary).toMatch(/ shadows 2 msgs seq 1-2;/);

    // 第二条: span 从 c1 之后 = [d,e], tail=[e], shadowed=[d], seq=5-5
    //   (d 是第 5 个 seq: a=1, b=2, c=3, c1=4, d=5, e=6)
    const c2 = comps[1]!;
    expect(c2.summary).toMatch(/ shadows 1 msgs seq 5-5;/);
    // 第二条 footer 的 id 不与第一条重复,且与该条 entry 同源。
    const id1 = c1.summary.match(/\[compaction ([^\s:]+):/)![1]!;
    const id2 = c2.summary.match(/\[compaction ([^\s:]+):/)![1]!;
    expect(id1).not.toBe(id2);
    expect(id2).toBe(c2.id);
  });
});