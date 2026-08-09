/**
 * src/harness/chat/session-store.test —— 片 A 的闸(SDD `docs/plan/2026-08-09-session-层换成-pi-session-sdd.md`)。
 *
 * ## 每条钉的都是**换存储层这件事本身会静默错的地方**
 *
 * - 六件事(create/open/list/fork/delete/投影)—— 换完之后语义要与 `ChatStore` 对得上;
 * - **并发两写两条都在** —— 这条是整片的理由:实测两个 `Session` 实例写同一份文件会写出
 *   重复 seq,下一次 `open()` 抛 `non-consecutive seq`,**整份会话读不出来**。
 * - **compaction 条目让投影自己截断** —— 它替掉的是 `agent.ts:165` 那次全量 save;
 * - **id 白名单取交集** —— pi 允许 `a.b`,omd 不许(id 来自 HTTP 边界)。
 *
 * ## 逐条证伪方式(都实跑过)
 *
 * - 「并发两写两条都在」→ 把 `SESSIONS` 那张单写者表去掉(`hold` 直接 `make()`)→ **当场红**,
 *   而且红在"重开读得回来"那一句上(正是 non-consecutive seq)。
 * - 「compaction 之后投影只剩摘要 + 尾巴」→ 不 append compaction 而是照旧全量替换 → 红。
 * - 「`a.b` 被拒」→ 把 `assertId` 换成 pi 的 `SESSION_ID_PATTERN` → 红。
 * - 「fork 记 parentSessionId」→ 改成 `repo.create` 后手抄消息(= ChatStore 的老做法)→ 红。
 */
import { describe, expect, test, beforeEach } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { OMD_SESSION_ID_RE, createOmdSessionStore, resetSessionCacheForTest } from './session-store';

/** 与 `store.ts` 的 `ID_RE` 逐字相同 —— 两处漂开就是白名单被悄悄放松。 */
const STORE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

const msg = (role: 'user' | 'assistant', text: string): AgentMessage =>
  ({ role, content: [{ type: 'text', text }] }) as unknown as AgentMessage;

const world = (): string => mkdtempSync(join(tmpdir(), 'omd-session-store-'));
const textOf = (ms: readonly AgentMessage[]): string => JSON.stringify(ms);

beforeEach(() => resetSessionCacheForTest());

describe('六件事与 ChatStore 语义对得上', () => {
  test('create → append → 投影读得回来', async () => {
    const s = createOmdSessionStore(world());
    const sess = await s.create('tui', '第一条');
    await sess.append(msg('user', 'hej'));
    await sess.append(msg('assistant', 'hej hej'));
    const ms = await sess.messages();
    expect(ms.length).toBe(2);
    expect(textOf(ms)).toContain('hej hej');
  });

  test('open 不存在的会话返回 null(不是抛)', async () => {
    const s = createOmdSessionStore(world());
    expect(await s.open('nope')).toBeNull();
  });

  test('list 拿到 id / title / parent,且 messageCount 是"没数过"的 0', async () => {
    const root = world();
    const s = createOmdSessionStore(root);
    await (await s.create('a', '标题甲')).append(msg('user', 'x'));
    const l = await s.list();
    expect(l.map((m) => m.id)).toEqual(['a']);
    expect(l[0]?.title).toBe('标题甲');
    // ⚠ 0 在这里是"没数过"不是"没有消息" —— 判据钉住这个语义, 免得下一个人拿它当消息数用。
    expect(l[0]?.messageCount).toBe(0);
    expect(l[0]?.parent).toBeUndefined();
  });

  test('★ fork 不再手抄消息, 而且记 parentSessionId', async () => {
    const root = world();
    const s = createOmdSessionStore(root);
    const a = await s.create('a');
    await a.append(msg('user', '源消息'));
    const b = await s.fork('a', 'a-f9');
    expect(textOf(await b.messages())).toContain('源消息');
    const l = await s.list();
    expect(l.find((m) => m.id === 'a-f9')?.parent).toBe('a');
    // 分支里再写不许污染源会话(ChatStore 那三条用户可见判据之一)
    await b.append(msg('user', '只在分支'));
    expect(textOf(await (await s.open('a'))!.messages())).not.toContain('只在分支');
  });

  test('delete 删不存在的不报错(与 ChatStore.delete 同语义)', async () => {
    const s = createOmdSessionStore(world());
    await s.delete('nope');
    await s.create('x');
    await s.delete('x');
    expect(await s.open('x')).toBeNull();
  });
});

describe('★ append 前 JSON round-trip 净化(pi loop 产 undefined 键 × pi storage 拒 undefined)', () => {
  test('★ 带 details/usage: undefined 的 toolResult 落得进去、读得回来(去掉 jsonSafe 当场红)', async () => {
    // 逐字复刻 pi `createToolResultMessage`(agent-loop.js:538)的形状:工具没给 details/usage
    // 时这两个键**存在且值为 undefined** —— 正是 assertJsonSerializable 拒的东西。
    const toolResult = {
      role: 'toolResult',
      toolCallId: 't1',
      toolName: 'omd_run',
      content: [{ type: 'text', text: 'runId: x' }],
      details: undefined,
      usage: undefined,
      isError: false,
      timestamp: 1,
    } as unknown as AgentMessage;
    const s = createOmdSessionStore(world());
    const sess = await s.create('tr1');
    await sess.append(msg('user', '跑个图'));
    await sess.append(toolResult); // 净化缺席 → 这里抛 'Durable payload contains undefined'
    const back = await sess.messages();
    expect(back.length).toBe(2);
    expect((back[1] as { toolName?: string }).toolName).toBe('omd_run');
  });
});

describe('★★ 单写者 —— 这一片存在的理由', () => {
  test('同一个 id 两次 open 拿到同一份底层 Session(并发两写两条都在, 且重开读得回来)', async () => {
    const root = world();
    const s = createOmdSessionStore(root);
    await (await s.create('t')).append(msg('user', '基线'));

    const w1 = await s.open('t');
    const w2 = await s.open('t');
    await Promise.all([w1!.append(msg('user', '写者甲')), w2!.append(msg('user', '写者乙'))]);

    // ① 内存态两条都在
    expect(textOf(await w1!.messages())).toContain('写者甲');
    expect(textOf(await w1!.messages())).toContain('写者乙');

    // ② ★ 重开读得回来 —— 去掉单写者表之后**红在这一句**:
    //    两个实例各有自己的 nextSequence, 写出重复 seq, load 直接抛 non-consecutive seq。
    resetSessionCacheForTest();
    const fresh = createOmdSessionStore(root);
    const reopened = await fresh.open('t');
    const all = textOf(await reopened!.messages());
    expect(all).toContain('写者甲');
    expect(all).toContain('写者乙');
  });
});

describe('★ compaction 是一条条目, 投影自己截断(替掉全量 save)', () => {
  test('append 三条 → 落一条 compaction → 投影只剩摘要 + 保留的尾巴', async () => {
    const s = createOmdSessionStore(world());
    const sess = await s.create('c');
    await sess.append(msg('user', '老消息一'));
    await sess.append(msg('assistant', '老消息二'));
    await sess.append(msg('user', '老消息三'));
    const tail = [msg('user', '保留的尾巴')];
    await sess.appendCompaction({ summary: '摘要:前面三条讲了 X', tokensBefore: 1234, retainedTail: tail });

    const ms = await sess.messages();
    const dump = textOf(ms);
    expect(dump).toContain('摘要:前面三条讲了 X'); // 摘要进了对话视图
    expect(dump).toContain('保留的尾巴');
    // ★ compaction 之前的东西**不在投影里** —— 这一条就是"不用再改数组"的全部依据。
    expect(dump).not.toContain('老消息一');
    expect(dump).not.toContain('老消息二');
    // ⚠ 但它们**还在磁盘上**(append-only 不删) —— 两件事不许混:视图截断 ≠ 数据丢失。
    const raw = JSON.stringify(await sess.entries());
    expect(raw).toContain('老消息一');
  });
});

describe('★ id 白名单取交集(pi 比 omd 松)', () => {
  test('与 store.ts 的 ID_RE 逐字相同', () => {
    expect(OMD_SESSION_ID_RE.source).toBe(STORE_ID_RE.source);
  });

  test('pi 允许的 `a.b` 在这里被拒 —— id 来自 HTTP 边界, 语义不许放松', async () => {
    const s = createOmdSessionStore(world());
    expect(OMD_SESSION_ID_RE.test('a.b')).toBe(false);
    await expect(s.create('a.b')).rejects.toThrow('非法会话 id');
    await expect(s.open('../etc/passwd')).rejects.toThrow('非法会话 id');
  });
});
