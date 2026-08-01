/**
 * src/model/kimi-oauth-extension —— kimi-coding OAuth 的**交互-TUI 侧**接线 (pi 扩展注册 + 条件挂载)。
 *
 * 2026-08-01 从 `kimi-oauth.ts` 拆出来。那个文件里其实是**两个东西**:
 *   · 登录件本体 (`createKimiCodingOAuthProvider`) —— `callModel` 刷 kimi token 用的, 留在原处;
 *   · 这里的扩展 —— 只给 pi 会话 (`/login` 菜单项 + ModelRegistry 重放)。
 * 只有后者需要 `pi-coding-agent`, 而前者被 `pi-transport` 消费、进而被 MCP 那条路径拖着走。
 *
 * 现在的约定: **`*-extension.ts` 只放 pi TUI 的门面**。由 `src/mcp/no-cli-dep.test.ts` 守。
 */
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { createKimiCodingOAuthProvider } from './kimi-oauth';

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

/** 坐标前半 = provider ('kimi-coding:k3' → 'kimi-coding'; 裸 provider 名原样)。 */
function providerOfCoord(coord: string): string {
  const i = coord.indexOf(':');
  return (i === -1 ? coord : coord.slice(0, i)).trim();
}

/**
 * **条件挂载** (2026-07-29): 这次会话真的解析到 kimi-coding 坐标才挂登录件, 否则返 null。
 *
 * 此前三条链全是恒挂。恒挂的代价不是"多一个 import" —— `registerProvider` 参与 pi 的
 * `ModelRegistry.refresh` **全局 wipe+replay** (见上方注与 agent-leaf.ts:228 那条 ctx-stale 教训),
 * 即每建一个 headless 会话就为一个本次绝不会调用的 provider 走一遍全局注册表变更。kimi 计费周期
 * 用尽后, 那是纯开销。
 *
 * 判据取**已解析出来的坐标**而非"auth.json 里有没有凭证": 座位/池把这次会话派到 kimi 才需要刷新件,
 * 派到别处就不需要 —— 凭证在不在是另一回事 (起跑自检管那个)。于是 kimi 渠道恢复、分配表把座位改回
 * `kimi-coding:*` 的那一刻它自动挂回来, **不用改代码**。
 *
 * ⚠ 不适用于**交互主会话** (tui main): 那里恒挂是对的 —— `/login` 菜单项正是由 registerProvider
 * 提供的, 而 `/login` 是取得 kimi 凭证的唯一入口。把它也做成条件挂载 = 一旦不用 kimi 就再也登不回去
 * (鸡生蛋)。交互会话一辈子只建一次注册表, 代价是一次调用。
 *
 * @param coord 'provider:modelId' 坐标或裸 provider 名。
 */
export function kimiOAuthExtensionFor(coord: string, fetchImpl: typeof fetch = fetch): ExtensionFactory | null {
  return providerOfCoord(coord) === 'kimi-coding' ? createKimiOAuthExtension(fetchImpl) : null;
}
