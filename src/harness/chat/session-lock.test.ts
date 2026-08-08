/**
 * src/harness/chat/session-lock.test —— 片 B 的闸(跨进程写锁)。
 *
 * ## 为什么这些断言值得写
 *
 * 这一层防的事有**实测代价**:两个写者写同一份 JSONL → 重复 seq → 下一次 `open()` 抛
 * `non-consecutive seq`,整份会话读不出来(探针 `pi-session-probe.ts` 第 7 条)。
 * 所以判据不是"锁文件在不在",而是:
 * ① **活着的持有者挡得住**,而且判词里说得出是谁(pid);
 * ② **死掉的持有者接管得了**(否则一次崩溃就永久锁死一份会话);
 * ③ 两者的**依据不许压成一档** —— 同机看 pid 是**事实**,跨机看陈旧是**推断**;
 * ④ `release()` **只删自己那把**(别人接管过之后不许把人家的锁删掉)。
 *
 * ## 逐条证伪方式(都实跑过)
 *
 * - ①「活锁挡得住」→ 把 `sameHost && deps.alive(...)` 那条 return 删掉 → 红。
 * - ②「死锁接管」→ 把 `alive` 的 `EPERM` 分支改成恒 `true` → 红(它会去挡一把死锁)。
 * - ③「跨机新锁挡得住」→ 把 `!sameHost && idleMs < staleAfterMs` 删掉 → 红。
 * - ④「只删自己那把」→ 把 release 里的 `cur.at === mine.at` 判断删掉 → 红。
 * - ⑤「store 写不进去要抛」→ 把 `ensureWritable` 的 throw 换成静默返回 → 红。
 */
import { describe, expect, test, beforeEach } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { FOREIGN_LOCK_STALE_MS, acquireWriteLock, currentHolder, type LockDeps } from './session-lock';
import { createOmdSessionStore, resetSessionCacheForTest } from './session-store';

const world = (): string => mkdtempSync(join(tmpdir(), 'omd-session-lock-'));
const sessionFile = (root: string): string => {
  const p = join(root, 's.jsonl');
  writeFileSync(p, '');
  return p;
};

const deps = (over: Partial<LockDeps> = {}): LockDeps => ({
  now: () => 1_000_000,
  pid: 1234,
  host: 'thisbox',
  alive: () => true,
  staleAfterMs: FOREIGN_LOCK_STALE_MS,
  ...over,
});

const msg = (text: string): AgentMessage => ({ role: 'user', content: [{ type: 'text', text }] }) as unknown as AgentMessage;

beforeEach(() => resetSessionCacheForTest());

describe('抢锁 / 拒绝 / 接管', () => {
  test('空地上抢得到, 锁文件记的是自己', () => {
    const f = sessionFile(world());
    const got = acquireWriteLock(f, deps());
    expect(got.ok).toBe(true);
    expect(currentHolder(f)).toEqual({ pid: 1234, host: 'thisbox', at: 1_000_000 });
  });

  test('★ 同机、持有者活着 → 拒绝, 而且判词里有 pid', () => {
    const f = sessionFile(world());
    acquireWriteLock(f, deps({ pid: 111 }));
    const second = acquireWriteLock(f, deps({ pid: 222, alive: (p) => p === 111 }));
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.holder.pid).toBe(111);
      expect(second.why).toContain('111'); // 说得出是谁 —— "现在不能写"没有 pid 等于没说
    }
  });

  test('★ 同机、持有者已死 → 接管(否则一次崩溃永久锁死一份会话)', () => {
    const f = sessionFile(world());
    acquireWriteLock(f, deps({ pid: 111 }));
    const second = acquireWriteLock(f, deps({ pid: 222, alive: () => false }));
    expect(second.ok).toBe(true);
    expect(currentHolder(f)?.pid).toBe(222);
  });

  test('同机同 pid 重入放行(一个进程里第二次写不许被自己挡)', () => {
    const f = sessionFile(world());
    acquireWriteLock(f, deps({ pid: 111 }));
    expect(acquireWriteLock(f, deps({ pid: 111 })).ok).toBe(true);
  });

  test('★ 跨机的新锁挡得住 —— 看不到对方进程表, 所以不许当它死了', () => {
    const f = sessionFile(world());
    acquireWriteLock(f, deps({ pid: 111, host: 'otherbox' }));
    const second = acquireWriteLock(f, deps({ pid: 222, host: 'thisbox', alive: () => false }));
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.why).toContain('otherbox');
  });

  test('★ 跨机的锁陈旧了才接管(这一档是**推断**, 与"pid 已死"那档不是一回事)', () => {
    const f = sessionFile(world());
    acquireWriteLock(f, deps({ pid: 111, host: 'otherbox', now: () => 0 }));
    const later = acquireWriteLock(f, deps({ pid: 222, now: () => FOREIGN_LOCK_STALE_MS + 1 }));
    expect(later.ok).toBe(true);
    expect(currentHolder(f)?.host).toBe('thisbox');
  });

  test('release 之后别人抢得到', () => {
    const f = sessionFile(world());
    const first = acquireWriteLock(f, deps({ pid: 111 }));
    if (first.ok) first.release();
    expect(currentHolder(f)).toBeNull();
    expect(acquireWriteLock(f, deps({ pid: 222, alive: () => true })).ok).toBe(true);
  });

  test('★ release 只删自己那把 —— 被接管之后不许删掉别人的锁', () => {
    const f = sessionFile(world());
    const first = acquireWriteLock(f, deps({ pid: 111 }));
    acquireWriteLock(f, deps({ pid: 222, alive: () => false })); // 接管
    if (first.ok) first.release(); // 迟到的释放
    expect(currentHolder(f)?.pid).toBe(222); // 222 的锁还在
  });

  test('锁文件坏了当作没有锁(不许因为一个坏 JSON 就写不进会话)', () => {
    const root = world();
    const f = sessionFile(root);
    writeFileSync(`${f}.lock`, '{ 这不是 JSON');
    expect(acquireWriteLock(f, deps()).ok).toBe(true);
  });
});

describe('★ 接进 store:读不上锁, 写抢不到就抛', () => {
  test('另一个进程持锁时:messages() 读得到, append() 抛且判词带 pid', async () => {
    const root = world();
    const mine = deps({ pid: 999, alive: (p) => p === 777 });
    const store = createOmdSessionStore(root, mine);
    const sess = await store.create('t');
    await sess.append(msg('第一条')); // 自己先抢到锁

    // 造一把"别的活进程"的锁:直接改锁文件(等价于另一个进程抢在前面)
    const listed = await store.list();
    expect(listed.length).toBe(1);
    resetSessionCacheForTest();
    const fresh = createOmdSessionStore(root, mine);
    const reopened = await fresh.open('t');
    const path = `${root}/.omd/chat`;
    // 找到那份 jsonl 的锁文件路径:store 内部用的是 metadata.path, 这里靠 currentHolder 反查
    // —— 用 list 的 id 拼不出路径(pi 的文件名带时间戳), 所以从锁文件本身入手:
    const { readdirSync } = await import('node:fs');
    const dirs = readdirSync(path);
    const inner = join(path, dirs[0] as string);
    const jsonl = readdirSync(inner).find((f) => f.endsWith('.jsonl')) as string;
    const sessionPath = join(inner, jsonl);
    writeFileSync(`${sessionPath}.lock`, JSON.stringify({ pid: 777, host: 'thisbox', at: 1_000_000 }));

    // 读:照样读得到(读永不上锁)
    expect(JSON.stringify(await reopened!.messages())).toContain('第一条');
    // 写:抛, 而且说得出是谁
    await expect(reopened!.append(msg('写不进去'))).rejects.toThrow('777');
  });
});
