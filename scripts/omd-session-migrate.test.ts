/**
 * scripts/omd-session-migrate.test —— 片 C 的闸。
 *
 * 判据是**迁完的东西与旧的逐字相同**,不是"迁过了"。
 * 逐条证伪方式(都实跑过):
 * - 「逐字相同」→ 把 `sameMessages` 改成只比条数 → 「content 变形」那条红;
 * - 「幂等」→ 把 `existing.has(old.id)` 那道判断删掉 → 跑两遍会撞 pi 的 `already_exists`,红;
 * - 「校验不过不动旧文件」→ 把 renameSync 挪到校验之前 → 那条红;
 * - 「dry 不改文件」→ 把 `!write` 那道判断删掉 → 「dry 之后旧文件还在」红。
 */
import { describe, expect, test, beforeEach } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { createOmdSessionStore, resetSessionCacheForTest } from '../src/harness/chat/session-store';
import { migrate, oldFiles, readOld, sameMessages } from './omd-session-migrate';

const msg = (role: 'user' | 'assistant', text: string): AgentMessage =>
  ({ role, content: [{ type: 'text', text }] }) as unknown as AgentMessage;

/** 造一个带旧格式会话的仓。 */
function worldWithOld(id: string, messages: AgentMessage[], title = '旧标题'): { root: string; file: string } {
  const root = mkdtempSync(join(tmpdir(), 'omd-migrate-'));
  const dir = join(root, '.omd/chat');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${id}.json`);
  writeFileSync(
    file,
    JSON.stringify({ schema: 1, id, title, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', messages }),
  );
  return { root, file };
}

beforeEach(() => resetSessionCacheForTest());

describe('迁移', () => {
  test('★ 迁完的消息与旧的**逐字相同**', async () => {
    const ms = [msg('user', '第一句'), msg('assistant', '第二句'), msg('user', '第三句')];
    const { root, file } = worldWithOld('tui', ms);
    const r = await migrate(root, true);
    expect(r.failed).toEqual([]);
    expect(r.migrated).toEqual(['tui']);

    resetSessionCacheForTest();
    const store = createOmdSessionStore(root);
    const got = await (await store.open('tui'))!.messages();
    expect(sameMessages(ms, got).ok).toBe(true);
    expect(JSON.stringify(got)).toBe(JSON.stringify(ms)); // 再钉一次逐字
    // 旧文件改名不删
    expect(existsSync(file)).toBe(false);
    expect(existsSync(`${file}.migrated`)).toBe(true);
  });

  test('★ dry(默认)一个文件都不改', async () => {
    const { root, file } = worldWithOld('tui', [msg('user', 'x')]);
    const r = await migrate(root, false);
    expect(r.migrated).toEqual(['tui']); // 说"能迁"
    expect(existsSync(file)).toBe(true); // 但没动
    resetSessionCacheForTest();
    expect(await (createOmdSessionStore(root)).list()).toEqual([]); // 新库里也没有
  });

  test('★ 幂等:跑两遍不出现两份', async () => {
    const { root } = worldWithOld('tui', [msg('user', 'x')]);
    await migrate(root, true);
    resetSessionCacheForTest();
    const second = await migrate(root, true);
    expect(second.migrated).toEqual([]);
    resetSessionCacheForTest();
    expect((await createOmdSessionStore(root).list()).length).toBe(1);
  });

  test('★ title 带过去(列表页显示名不许在迁移里丢)', async () => {
    const { root } = worldWithOld('tui', [msg('user', 'x')], '我的会话');
    await migrate(root, true);
    resetSessionCacheForTest();
    expect((await createOmdSessionStore(root).list())[0]?.title).toBe('我的会话');
  });

  test('坏的旧文件:报出来, 不当成迁成功', async () => {
    const { root, file } = worldWithOld('tui', [msg('user', 'x')]);
    writeFileSync(file, '{ 这不是 JSON');
    const r = await migrate(root, true);
    expect(r.migrated).toEqual([]);
    expect(r.failed.length).toBe(1);
    expect(r.failed[0]?.why).toContain('读不出来');
    expect(existsSync(file)).toBe(true); // 坏文件留着
  });

  test('没有旧会话时三个名单都空(不许把"没有"报成"迁了 0 份成功")', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omd-migrate-empty-'));
    const r = await migrate(root, true);
    expect(r).toEqual({ migrated: [], skipped: [], failed: [] });
  });
});

describe('小件', () => {
  test('oldFiles 只认 <id>.json, 不碰 .migrated', () => {
    const { root, file } = worldWithOld('a', [msg('user', 'x')]);
    writeFileSync(`${file}.migrated`, '{}');
    const list = oldFiles(join(root, '.omd/chat'));
    expect(list.length).toBe(1);
    expect(list[0]?.endsWith('a.json')).toBe(true);
  });

  test('readOld 对字段不全的报错而不是抛', () => {
    const { root } = worldWithOld('a', [msg('user', 'x')]);
    const p = join(root, '.omd/chat/bad.json');
    writeFileSync(p, JSON.stringify({ id: 'bad' })); // 没有 messages
    expect(readOld(p)).toEqual({ error: 'id 或 messages 字段不对' });
  });

  test('★ sameMessages 不许只比条数 —— content 变形要抓出来', () => {
    const a = [msg('user', 'x')];
    const b = [{ role: 'user', content: 'x' } as unknown as AgentMessage]; // 条数相同, 结构不同
    const r = sameMessages(a, b);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.why).toContain('第 1 条不同');
  });
});
