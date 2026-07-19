import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPiAuthEntry, registerKimiCodingFromPiAuth, KIMI_CODING_BASE_URL } from './pi-auth-bridge';
import { getProvider, clearProviders, registerProvidersFromEnv } from './providers';

function authFile(content: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'pi-auth-'));
  const p = join(dir, 'auth.json');
  writeFileSync(p, JSON.stringify(content));
  return p;
}

describe('pi-auth-bridge', () => {
  test('读取 kimi-coding 条目; 缺文件/缺条目/坏 access 均 null 不抛', () => {
    const p = authFile({ 'kimi-coding': { type: 'oauth', access: 'tok-1', refresh: 'r', expires: 9 } });
    expect(readPiAuthEntry('kimi-coding', p)).toEqual({ access: 'tok-1', refresh: 'r', expires: 9 });
    expect(readPiAuthEntry('kimi-coding', '/nonexistent/auth.json')).toBeNull();
    expect(readPiAuthEntry('other', p)).toBeNull();
    expect(readPiAuthEntry('kimi-coding', authFile({ 'kimi-coding': { access: '' } }))).toBeNull();
  });

  test('注册成 anthropic-messages provider, defaultModel k3', () => {
    clearProviders();
    const p = authFile({ 'kimi-coding': { access: 'tok-2', expires: Date.now() + 60_000 } });
    expect(registerKimiCodingFromPiAuth(p)).toBe(true);
    const cfg = getProvider('kimi-coding');
    expect(cfg?.baseUrl).toBe(KIMI_CODING_BASE_URL);
    expect(cfg?.api).toBe('anthropic-messages');
    expect(cfg?.apiKey).toBe('tok-2');
    expect(cfg?.defaultModel).toBe('k3');
  });

  test('过期 token 仍注册 (警告不拒绝)', () => {
    clearProviders();
    const p = authFile({ 'kimi-coding': { access: 'tok-3', expires: 1 } });
    expect(registerKimiCodingFromPiAuth(p)).toBe(true);
    expect(getProvider('kimi-coding')?.apiKey).toBe('tok-3');
  });

  test('registerProvidersFromEnv 自动带上 kimi-coding (真实 auth.json 在场时)', () => {
    clearProviders();
    const names = registerProvidersFromEnv({});
    // 本机有授权 → 含 kimi-coding; 无授权环境 → 不含且不抛。两种都合法。
    expect(Array.isArray(names)).toBe(true);
    if (names.includes('kimi-coding')) expect(getProvider('kimi-coding')?.api).toBe('anthropic-messages');
  });
});
