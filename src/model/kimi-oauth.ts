/**
 * kimi-oauth —— kimi-coding (Kimi For Coding) 的 pi OAuth 登录件 (device flow + 刷新), omd 自包含。
 *
 * pi 0.80 的 kimi-coding provider 只带 env key 认证 (KIMI_API_KEY), 无 OAuth flow; 此前订阅
 * 凭证依赖外部工具写 auth.json (过期即 401, 无人刷新)。本模块自实现 device flow + 刷新,
 * 三条链全部自包含, 不需要任何外部 CLI:
 *   ① pi 会话 (交互 TUI / agent-leaf): createKimiOAuthExtension 走扩展正门 registerProvider
 *   ② wizard 内联登录: 直接消费 createKimiCodingOAuthProvider
 *   ③ pi-transport 过期刷新: 同上直接消费 (401 快照天花板随之消失)
 *
 * 端点/协议对齐官方 kimi-cli (MoonshotAI/kimi-cli, MIT · src/kimi_cli/auth/oauth.py):
 *   POST {host}/api/oauth/device_authorization   form{client_id}
 *   POST {host}/api/oauth/token   form{client_id, device_code, grant_type=…device_code} (RFC 8628 轮询)
 *   POST {host}/api/oauth/token   form{client_id, grant_type=refresh_token, refresh_token}
 * client_id 为 kimi-cli 公开发布的 device-flow 公共客户端 id (device flow 无 secret)。
 */
import type { OAuthCredentials, OAuthLoginCallbacks } from '@earendil-works/pi-ai/oauth';
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';

/**
 * 登录件形状 (0.80: pi-ai 的 OAuthProviderInterface 与全局注册表一并移除; 扩展正门
 * ProviderConfig.oauth 与 wizard 消费的就是这个结构面)。
 */
export interface KimiOAuthFlow {
  readonly id: 'kimi-coding';
  readonly name: string;
  login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials>;
  refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials>;
  getApiKey(credentials: OAuthCredentials): string;
}

const KIMI_OAUTH_HOST = (): string => process.env.KIMI_OAUTH_HOST?.trim() || 'https://auth.kimi.com';
const KIMI_CODE_CLIENT_ID = '17e5f671-d194-4dfb-9706-5516cb48c098';
/** 兼容头: 服务端按平台分流 (与 kimi-cli 同值)。 */
const PLATFORM_HEADERS = { 'X-Msh-Platform': 'kimi_cli' } as const;

async function postForm(
  path: 'device_authorization' | 'token',
  form: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<{ status: number; data: Record<string, unknown> }> {
  const res = await fetchImpl(`${KIMI_OAUTH_HOST()}/api/oauth/${path}`, {
    method: 'POST',
    headers: { ...PLATFORM_HEADERS, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  });
  let data: Record<string, unknown> = {};
  try {
    data = (await res.json()) as Record<string, unknown>;
  } catch {
    /* 非 JSON body → 空对象, 由 status 驱动错误 */
  }
  return { status: res.status, data };
}

/** token 响应 → pi OAuthCredentials (expires = ms epoch; kimi 回 expires_in 秒)。 */
function toCredentials(data: Record<string, unknown>): OAuthCredentials {
  return {
    access: String(data.access_token ?? ''),
    refresh: String(data.refresh_token ?? ''),
    expires: Date.now() + Number(data.expires_in ?? 0) * 1000,
  };
}

/** 造登录件 (fetch 注入便于测试)。 */
export function createKimiCodingOAuthProvider(fetchImpl: typeof fetch = fetch): KimiOAuthFlow {
  return {
    id: 'kimi-coding',
    name: 'Kimi For Coding',
    async login(cb: OAuthLoginCallbacks): Promise<OAuthCredentials> {
      const auth = await postForm('device_authorization', { client_id: KIMI_CODE_CLIENT_ID }, fetchImpl);
      if (auth.status !== 200) {
        throw new Error(`kimi-coding device authorization 失败 (HTTP ${auth.status}): ${JSON.stringify(auth.data).slice(0, 200)}`);
      }
      const deviceCode = String(auth.data.device_code ?? '');
      let interval = Math.max(1, Number(auth.data.interval ?? 5));
      cb.onDeviceCode({
        userCode: String(auth.data.user_code ?? ''),
        verificationUri: String(auth.data.verification_uri_complete ?? auth.data.verification_uri ?? ''),
        intervalSeconds: interval,
        ...(auth.data.expires_in ? { expiresInSeconds: Number(auth.data.expires_in) } : {}),
      });
      const deadline = Date.now() + Math.max(60, Number(auth.data.expires_in ?? 900)) * 1000;
      while (Date.now() < deadline) {
        if (cb.signal?.aborted) throw new Error('kimi-coding 登录已取消');
        await new Promise((r) => setTimeout(r, interval * 1000));
        const poll = await postForm(
          'token',
          { client_id: KIMI_CODE_CLIENT_ID, device_code: deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' },
          fetchImpl,
        );
        if (poll.status === 200) return toCredentials(poll.data);
        const err = String(poll.data.error ?? '');
        if (err === 'authorization_pending') continue; // RFC 8628: 用户还没在手机/浏览器点授权
        if (err === 'slow_down') {
          interval += 5;
          continue;
        }
        if (poll.status >= 500) continue; // 瞬时服务端错 → 继续轮询到 deadline
        throw new Error(`kimi-coding 登录失败: ${String(poll.data.error_description || err || `HTTP ${poll.status}`)}`);
      }
      throw new Error('kimi-coding device flow 超时 (授权码过期) — 请重跑登录');
    },
    async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
      const { status, data } = await postForm(
        'token',
        { client_id: KIMI_CODE_CLIENT_ID, grant_type: 'refresh_token', refresh_token: credentials.refresh },
        fetchImpl,
      );
      if (status === 401 || status === 403) {
        throw new Error(`kimi-coding refresh 被拒 (HTTP ${status}) — refresh token 失效, 需重新登录 (omd 里 /login)`);
      }
      if (status !== 200) {
        throw new Error(`kimi-coding refresh 失败 (HTTP ${status}): ${String(data.error_description ?? '')}`);
      }
      const next = toCredentials(data);
      // 服务端可能不轮换 refresh token → 保留旧值 (kimi-cli 同语义)。
      if (!next.refresh) next.refresh = credentials.refresh;
      return next;
    },
    getApiKey(credentials: OAuthCredentials): string {
      return credentials.access;
    },
  };
}

/**
 * pi 扩展 (正门注册): `pi.registerProvider('kimi-coding', { oauth })` — 进 ModelRegistry 的
 * registeredProviders, 每次 refresh (启动/reload) 重放 → 交互主会话 / agent-leaf 会话的
 * 过期自动刷新 + /login 菜单项都由此而来。挂载点: tui main() · agent-leaf · pi-runtime 的
 * extensionFactories。(0.77 时代的 pi-ai 全局注册表已在 0.80 移除 — 正门是唯一注册路径;
 * 非 pi-session 链路 [wizard 内联登录 / pi-transport 刷新] 直接消费 createKimiCodingOAuthProvider。)
 */
export function createKimiOAuthExtension(fetchImpl: typeof fetch = fetch): ExtensionFactory {
  const p = createKimiCodingOAuthProvider(fetchImpl);
  return (pi) => {
    pi.registerProvider('kimi-coding', {
      oauth: { name: p.name, login: (cb) => p.login(cb), refreshToken: (c) => p.refreshToken(c), getApiKey: (c) => p.getApiKey(c) },
    });
  };
}
