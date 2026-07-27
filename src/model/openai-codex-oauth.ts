/**
 * openai-codex-oauth —— OpenAI Codex (ChatGPT Plus/Pro) 的 pi OAuth 刷新件, omd 自包含。
 *
 * pi-ai 0.80 内置了 openai-codex 的 OAuth flow (auth/oauth/openai-codex.ts), 但其 loader
 * (loadOpenAICodexOAuth) 不在包的 public export map 内, omd 无法干净 import; 0.80 又删了全局 OAuth
 * 注册表, 于是 pi-transport 此前只接了 kimi —— codex 的过期刷新一直缺位, token 靠外部 pi/codex CLI
 * 刷新, 不刷即 401 (与 kimi 0.80 前同病)。本模块自实现 refresh, 让 omd 侧过期自动刷新。
 *
 * 端点/协议对齐 pi-ai 同源实现 (auth/oauth/openai-codex.ts) 与 openai codex CLI:
 *   POST https://auth.openai.com/oauth/token  form{ grant_type=refresh_token, refresh_token, client_id }
 *   → { access_token, refresh_token, expires_in };  getApiKey = access token (ChatGPT backend bearer)。
 * client_id 为 codex 公开 PKCE/device 公共客户端 id (无 secret)。登录 (首次授权) 仍由外部 pi/codex
 * CLI 完成; 本件只管刷新 + 取 key, 这正是 pi-transport 过期路所需。
 */
import type { OAuthCredentials } from '@earendil-works/pi-ai/oauth';

/** 刷新件形状 (与 kimi-oauth KimiOAuthFlow 同结构面; pi-transport deps 只消费 id/getApiKey/refreshToken)。 */
export interface OpenAICodexOAuthFlow {
  readonly id: 'openai-codex';
  readonly name: string;
  refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials>;
  getApiKey(credentials: OAuthCredentials): string;
}

const TOKEN_URL = 'https://auth.openai.com/oauth/token';
const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

/** 造刷新件 (fetch 注入便于测试)。 */
export function createOpenAICodexOAuthProvider(fetchImpl: typeof fetch = fetch): OpenAICodexOAuthFlow {
  return {
    id: 'openai-codex',
    name: 'OpenAI (ChatGPT Plus/Pro)',
    async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
      const res = await fetchImpl(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: credentials.refresh,
          client_id: CODEX_CLIENT_ID,
        }).toString(),
      });
      if (res.status === 401 || res.status === 403) {
        throw new Error(
          `openai-codex refresh 被拒 (HTTP ${res.status}) — refresh token 失效, 需在 pi/codex CLI 重新登录`,
        );
      }
      if (res.status !== 200) {
        const text = await res.text().catch(() => '');
        throw new Error(`openai-codex refresh 失败 (HTTP ${res.status}): ${text.slice(0, 200)}`);
      }
      const j = (await res.json()) as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
      };
      if (!j.access_token || !j.refresh_token || typeof j.expires_in !== 'number') {
        throw new Error(`openai-codex refresh 响应缺字段: ${Object.keys(j).join(',')}`);
      }
      return {
        access: j.access_token,
        refresh: j.refresh_token, // codex 每次轮换 refresh token (上面校验保证非空, 同 pi-ai 语义)
        expires: Date.now() + j.expires_in * 1000,
      };
    },
    getApiKey(credentials: OAuthCredentials): string {
      return credentials.access;
    },
  };
}
