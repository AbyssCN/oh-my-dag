import { describe, expect, test } from 'bun:test';
import { createOpenAICodexOAuthProvider } from './openai-codex-oauth';

const TOKEN_URL = 'https://auth.openai.com/oauth/token';

function mockFetch(status: number, json: unknown): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    expect(String(url)).toBe(TOKEN_URL);
    const body = String(init?.body ?? '');
    expect(body).toContain('grant_type=refresh_token');
    expect(body).toContain('client_id=app_EMoamEEZ73f0CkXaXp7hrann');
    return {
      status,
      ok: status >= 200 && status < 300,
      json: async () => json,
      text: async () => JSON.stringify(json),
    } as Response;
  }) as unknown as typeof fetch;
}

describe('openai-codex-oauth', () => {
  test('refreshToken: 200 → 新 access/refresh/expires', async () => {
    const p = createOpenAICodexOAuthProvider(
      mockFetch(200, { access_token: 'newA', refresh_token: 'newR', expires_in: 3600 }),
    );
    const before = Date.now();
    const next = await p.refreshToken({ access: 'oldA', refresh: 'oldR', expires: 0 });
    expect(next.access).toBe('newA');
    expect(next.refresh).toBe('newR');
    expect(next.expires).toBeGreaterThanOrEqual(before + 3600 * 1000);
  });

  test('refreshToken: 缺字段响应 → 报错', async () => {
    const p = createOpenAICodexOAuthProvider(
      mockFetch(200, { access_token: 'newA', expires_in: 3600 }), // 无 refresh_token
    );
    expect(p.refreshToken({ access: 'a', refresh: 'r', expires: 0 })).rejects.toThrow(/缺字段/);
  });

  test('refreshToken: 401 → 明确报错 (需重新登录)', () => {
    const p = createOpenAICodexOAuthProvider(mockFetch(401, { error: 'invalid_grant' }));
    expect(p.refreshToken({ access: 'a', refresh: 'r', expires: 0 })).rejects.toThrow(
      /refresh 被拒 \(HTTP 401\)/,
    );
  });

  test('getApiKey = access token', () => {
    const p = createOpenAICodexOAuthProvider();
    expect(p.getApiKey({ access: 'the-access', refresh: 'r', expires: 0 })).toBe('the-access');
    expect(p.id).toBe('openai-codex');
  });
});
