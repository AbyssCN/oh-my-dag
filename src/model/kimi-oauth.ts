/**
 * kimi-oauth —— kimi-coding (Kimi For Coding) 的 pi OAuth 登录件 (device flow + 刷新), omd 自包含。
 *
 * pi-ai 内置 OAuth 只有 anthropic / github-copilot / openai-codex; kimi-coding 此前依赖外部工具写
 * auth.json (过期即 401, 无人刷新)。本模块把登录件注册进 pi-ai **全局 OAuth 注册表**
 * (registerOAuthProvider) → 三条链全部自包含, 不需要任何外部 CLI:
 *   ① wizard 内联登录 (getOAuthProviders 自动可见)
 *   ② pi 会话层 AuthStorage.getApiKey 的过期自动刷新 (锁内走注册表 refreshToken)
 *   ③ pi-transport 的 getOAuthApiKey 同上 (401 快照天花板随之消失)
 *
 * 端点/协议对齐官方 kimi-cli (MoonshotAI/kimi-cli, MIT · src/kimi_cli/auth/oauth.py):
 *   POST {host}/api/oauth/device_authorization   form{client_id}
 *   POST {host}/api/oauth/token   form{client_id, device_code, grant_type=…device_code} (RFC 8628 轮询)
 *   POST {host}/api/oauth/token   form{client_id, grant_type=refresh_token, refresh_token}
 * client_id 为 kimi-cli 公开发布的 device-flow 公共客户端 id (device flow 无 secret)。
 */
import {
  getOAuthProvider,
  registerOAuthProvider,
  type OAuthCredentials,
  type OAuthLoginCallbacks,
  type OAuthProviderInterface,
} from '@earendil-works/pi-ai/oauth';
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';

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
export function createKimiCodingOAuthProvider(fetchImpl: typeof fetch = fetch): OAuthProviderInterface {
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
 * 幂等注册进 pi-ai 全局 OAuth 注册表。已有同 id 注册 (宿主/pi 扩展先到) → 尊重不覆盖。
 * 调用点: model/index (进程内所有链路共享同一注册表) + wizard realOAuthProviders (防加载顺序)。
 *
 * ⚠ 覆盖面天花板: pi 的 ModelRegistry.refresh() 会 resetOAuthProviders() **清空全局注册表**
 * (pi session 创建/reload 时必发) → 全局注册在 pi 会话里活不过 boot。pi 会话路径必须走正门
 * createKimiOAuthExtension (registerProvider 进 registeredProviders, refresh 后重放)。
 * 本函数只兜非 pi-session 链路 (wizard 内联登录 / pi-transport 在无 pi 会话的脚本进程里)。
 */
export function registerKimiCodingOAuth(fetchImpl: typeof fetch = fetch): void {
  if (getOAuthProvider('kimi-coding')) return;
  registerOAuthProvider(createKimiCodingOAuthProvider(fetchImpl));
}

/**
 * pi 扩展 (正门注册): `pi.registerProvider('kimi-coding', { oauth })` — 进 ModelRegistry 的
 * registeredProviders, 每次 refresh (启动/reload) 由 applyProviderConfig 重放, 并顺带把登录件
 * 重新写回 pi-ai 全局注册表 → 交互主会话 / agent-leaf 会话的 AuthStorage 过期自动刷新 + /login
 * 菜单项都由此而来。挂载点: tui main() · agent-leaf · pi-runtime 的 extensionFactories。
 */
export function createKimiOAuthExtension(fetchImpl: typeof fetch = fetch): ExtensionFactory {
  const p = createKimiCodingOAuthProvider(fetchImpl);
  return (pi) => {
    pi.registerProvider('kimi-coding', {
      oauth: { name: p.name, login: (cb) => p.login(cb), refreshToken: (c) => p.refreshToken(c), getApiKey: (c) => p.getApiKey(c) },
    });
  };
}
