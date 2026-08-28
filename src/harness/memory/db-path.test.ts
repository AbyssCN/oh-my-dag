/**
 * 库路径解析闸 —— 交接专库与共享记忆库**必须是两个文件**(2026-08-28 分库)。
 *
 * 为什么值得单开一件:分库是靠"两处构造点各自解析各自的路径"实现的,没有任何运行时结构
 * 阻止有人把 `resolveHandoffDbPath` 改回 `.omd/memory.db` —— 改回去之后一切照跑,
 * 只是 continuity 又开始堆进共享库,而那个症状要等库涨到几万行才看得见。
 *
 * 反向自检(实跑):把 `resolveHandoffDbPath` 的默认值改成 `'.omd/memory.db'`
 * → 「两个默认路径不同」当场红。
 */
import { describe, expect, test } from 'bun:test';
import { resolveHandoffDbPath, resolveMemoryDbPath } from './db-path';

const env = (o: Record<string, string>): NodeJS.ProcessEnv => o as NodeJS.ProcessEnv;

describe('db-path — 共享记忆库 vs 交接专库', () => {
  test('两个默认路径不同(分库的承重断言)', () => {
    expect(resolveMemoryDbPath(env({}))).toBe('.omd/memory.db');
    expect(resolveHandoffDbPath(env({}))).toBe('.omd/handoff.db');
    expect(resolveHandoffDbPath(env({}))).not.toBe(resolveMemoryDbPath(env({})));
  });

  test('各认各的 env 旋钮 —— 覆盖一个不会连带覆盖另一个', () => {
    const e = env({ OMD_MEMORY_PATH: '/tmp/a.db' });
    expect(resolveMemoryDbPath(e)).toBe('/tmp/a.db');
    expect(resolveHandoffDbPath(e)).toBe('.omd/handoff.db');

    const e2 = env({ OMD_HANDOFF_DB_PATH: '/tmp/b.db' });
    expect(resolveHandoffDbPath(e2)).toBe('/tmp/b.db');
    expect(resolveMemoryDbPath(e2)).toBe('.omd/memory.db');
  });

  test('两个都设 → 仍是两个不同的值', () => {
    const e = env({ OMD_MEMORY_PATH: '/tmp/a.db', OMD_HANDOFF_DB_PATH: '/tmp/b.db' });
    expect(resolveMemoryDbPath(e)).toBe('/tmp/a.db');
    expect(resolveHandoffDbPath(e)).toBe('/tmp/b.db');
  });
});
