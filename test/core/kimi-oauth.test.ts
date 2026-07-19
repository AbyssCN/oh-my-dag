import { describe, expect, test } from 'bun:test';
import { createKimiCodingOAuthProvider } from '../../src/model/kimi-oauth';
import type { OAuthLoginCallbacks } from '@earendil-works/pi-ai/oauth';

// kimi-coding OAuth 登录件 (device flow + refresh), fake fetch 驱动, 不打真端点。

function fakeFetch(script: Array<{ status: number; body: unknown }>): { fetch: typeof fetch; calls: Array<{ url: string; body: string }> } {
  const calls: Array<{ url: string; body: string }> = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: String(init?.body ?? '') });
    const next = script.shift() ?? { status: 500, body: {} };
    return new Response(JSON.stringify(next.body), { status: next.status });
  }) as typeof fetch;
  return { fetch: f, calls };
}

const noopCallbacks = (deviceCodes: unknown[]): OAuthLoginCallbacks => ({
  onAuth: () => {},
  onDeviceCode: (i) => deviceCodes.push(i),
  onPrompt: async () => '',
  onSelect: async () => undefined,
});

describe('kimi-coding OAuth 登录件', () => {
  test('device flow: authorization_pending 轮询 → 换到 token', async () => {
    const { fetch: f, calls } = fakeFetch([
      { status: 200, body: { device_code: 'dc', user_code: 'AB-12', verification_uri_complete: 'https://auth.kimi.com/d/AB12', interval: 0, expires_in: 900 } },
      { status: 400, body: { error: 'authorization_pending' } },
      { status: 200, body: { access_token: 'at', refresh_token: 'rt', expires_in: 3600 } },
    ]);
    const shown: unknown[] = [];
    const creds = await createKimiCodingOAuthProvider(f).login(noopCallbacks(shown));
    expect(creds.access).toBe('at');
    expect(creds.refresh).toBe('rt');
    expect(creds.expires).toBeGreaterThan(Date.now());
    expect((shown[0] as { userCode: string }).userCode).toBe('AB-12');
    expect(calls[0]!.url).toContain('/api/oauth/device_authorization');
    expect(calls[1]!.body).toContain('grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code');
  });

  test('refresh: 200 换新 token; 服务端不轮换 refresh → 保留旧值', async () => {
    const { fetch: f, calls } = fakeFetch([{ status: 200, body: { access_token: 'at2', expires_in: 3600 } }]);
    const p = createKimiCodingOAuthProvider(f);
    const next = await p.refreshToken({ access: 'old', refresh: 'keep-me', expires: 0 });
    expect(next.access).toBe('at2');
    expect(next.refresh).toBe('keep-me');
    expect(calls[0]!.body).toContain('grant_type=refresh_token');
    expect(p.getApiKey(next)).toBe('at2');
  });

  test('refresh 401 → 明确要求重登录的错误 (不静默)', async () => {
    const { fetch: f } = fakeFetch([{ status: 401, body: { error_description: 'revoked' } }]);
    await expect(createKimiCodingOAuthProvider(f).refreshToken({ access: 'a', refresh: 'r', expires: 0 })).rejects.toThrow(/重新登录/);
  });
});
