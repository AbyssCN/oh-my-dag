/**
 * memory.db 路径解析闸(S0 单一真源的路径半边)。
 * 2026-09-11:交接专库 handoff.db 已删(写无读),本文件只剩共享库这一条。
 */
import { describe, expect, test } from 'bun:test';
import { resolveMemoryDbPath } from './db-path';

const env = (o: Record<string, string>): NodeJS.ProcessEnv => o as NodeJS.ProcessEnv;

describe('db-path — 共享记忆库', () => {
  test('默认 .omd/memory.db;OMD_MEMORY_PATH 覆盖', () => {
    expect(resolveMemoryDbPath(env({}))).toBe('.omd/memory.db');
    expect(resolveMemoryDbPath(env({ OMD_MEMORY_PATH: '/tmp/a.db' }))).toBe('/tmp/a.db');
  });
});
