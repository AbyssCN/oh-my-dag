/**
 * src/tui/provider-directory —— **`/login` 与 `/models` 的 provider 全目录**(2026-08-10,owner 点名照 pi)。
 *
 * ## 它补的是"只列已配的"
 *
 * `/login` 此前只列 `discoverProviders()` 探到的(env/auth.json/models.json/go)——
 * 一台新机器上那是**空表**,而 pi 的 provider 选单列全目录 42 家、每家挂配没配的状态,
 * 人从列表里**挑**,不是凭记忆敲 id。owner 的截图里 pi 那边是
 * `Anthropic · unconfigured` / `OpenAI Codex ✓ stored` —— 这里照那个形。
 *
 * ## 目录从哪来 —— 不新造数据源
 *
 * pi-ai `/compat` 的 `getProviders()`(38 家)∪ `discoverProviders()`(自定/别名条目,
 * 如 zhipu / mimo / opencode-go)∪ callModel registry(env 注册的)∪ `claude-code`
 * (订阅通道,pi 目录里没有这个 id —— 它是本仓的 SDK 通道,见 claude-sdk-complete.ts)。
 *
 * ## 配没配的三态(NULL ≠ 0 的同族纪律:三种"有"分得开)
 *
 * - `stored`:凭证**在盘上**(auth.json / models.json / claude CLI 凭证文件)。
 * - `env`:key 从环境变量来 —— 本进程可用,换个 shell 未必。
 * - `unconfigured`:两处都没有。
 * 抹平成一个 boolean 的话,"为什么另一个窗口里不能用"这种问题就答不出来了。
 */
// compat shim 标了 deprecated (0.80 深迁移 Models API 另行) —— 与 pi-transport 同一条缝, 一起迁。
import { getModels, getProviders } from '@earendil-works/pi-ai/compat';

const piGetProviders = getProviders as () => string[];
const piGetModels = getModels as unknown as (provider: string) => { id: string }[];
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { discoverProviders, type DiscoveredProvider } from '../config/config-discovery';
import { piEnvApiKey } from '../model/pi-transport';
import type { ModelCatalogDeps } from './model-picker';

/** 订阅通道的 provider id(与 claude-sdk-complete.CLAUDE_SDK_PROVIDER 同值;不 import 它 ——
 * TUI 层引 model 层的**类型**可以,引运行时常量会把 SDK 通道整个拽进 TUI 的依赖图)。 */
export const CLAUDE_CODE_ID = 'claude-code';

export type ProviderStatus = 'stored' | 'env' | 'unconfigured';

export interface ProviderRow {
  id: string;
  status: ProviderStatus;
}

export interface ProviderDirectoryDeps {
  /** pi-ai 全目录。默认真 `getProviders()`。 */
  catalog?: () => string[];
  /** 凭证探测(env/auth.json/models.json/go)。默认真 `discoverProviders()`。 */
  discovered?: () => DiscoveredProvider[];
  /** provider → env key(pi 的映射表)。默认真 `piEnvApiKey`。 */
  envKey?: (id: string) => string | undefined;
  /** callModel registry 里已注册的(env 路注册的 mimo/deepseek 等)。默认真 `listProviders()`。 */
  registered?: () => string[];
  /** claude CLI 订阅凭证在不在盘上。默认查 `~/.claude/.credentials.json`。 */
  claudeCliCreds?: () => boolean;
  /** pi-ai 目录:provider → 模型 id 列表。默认真 `getModels()`。 */
  catalogModels?: (provider: string) => string[];
}

function realDeps(): Required<ProviderDirectoryDeps> {
  return {
    catalog: () => piGetProviders(),
    discovered: () => discoverProviders(),
    envKey: (id) => piEnvApiKey(id),
    registered: () => (require('../model/providers') as typeof import('../model/providers')).listProviders(),
    claudeCliCreds: () => existsSync(join(homedir(), '.claude', '.credentials.json')),
    catalogModels: (p) => piGetModels(p).map((m) => m.id),
  };
}

/** discovered 的 source → 三态。auth.json/models.json 是盘上的;env/go 是环境的。 */
function statusOf(d: DiscoveredProvider): ProviderStatus {
  if (!d.hasKey) return 'unconfigured';
  return d.source === 'auth.json' || d.source === 'models.json' ? 'stored' : 'env';
}

/**
 * 全目录 + 状态。排序:**配了的在前**(stored → env),没配的在后;组内按 id。
 * 配了的排前不是好看 —— 选单打开时人最常做的是"给已有的换 key / 看哪些能用",
 * 跟 model-picker「当前项排最前」同一条理由。
 */
export function listProviderRows(deps: ProviderDirectoryDeps = {}): ProviderRow[] {
  const d = { ...realDeps(), ...deps };
  const status = new Map<string, ProviderStatus>();
  for (const id of d.catalog()) status.set(id, 'unconfigured');
  for (const id of d.registered()) status.set(id, 'env');
  for (const p of d.discovered()) {
    const s = statusOf(p);
    // 已有更强的状态时不降级(stored > env > unconfigured):同 id 多源探到取最强。
    const prev = status.get(p.id);
    if (prev === 'stored' || (prev === 'env' && s === 'unconfigured')) continue;
    status.set(p.id, s);
  }
  // env key 探测只对目录里已知的 id 做(envKey 是 per-id 查询, 没有"全部枚举"的形)。
  for (const [id, s] of status) {
    if (s === 'unconfigured' && d.envKey(id)) status.set(id, 'env');
  }
  status.set(CLAUDE_CODE_ID, d.claudeCliCreds() ? 'stored' : 'unconfigured');

  const rank: Record<ProviderStatus, number> = { stored: 0, env: 1, unconfigured: 2 };
  return [...status.entries()]
    .map(([id, s]) => ({ id, status: s }))
    .sort((a, b) => rank[a.status] - rank[b.status] || a.id.localeCompare(b.id));
}

/** 一行的样子(照 pi):`<id> · ✓ stored` / `<id> · API key configured` / `<id> · unconfigured`。 */
export function providerRowLabel(r: ProviderRow): string {
  const s = r.status === 'stored' ? '✓ stored' : r.status === 'env' ? 'API key configured' : 'unconfigured';
  return `${r.id} · ${s}`;
}

/**
 * `/models` 的目录扩展面(喂给 `listModelChoices`):configured 的 pi 目录 provider 出全部模型,
 * claude-code 配了订阅就从 anthropic 目录派生裸 id(坐标同形,见 seats 里 claude-code:claude-sonnet-5)。
 * 组合逻辑在 model-picker(纯函数);这里只把真实数据源打包 —— 测试注入假件走的是同一条缝。
 */
export function fullModelCatalogDeps(deps: ProviderDirectoryDeps = {}): ModelCatalogDeps {
  const d = { ...realDeps(), ...deps };
  return {
    catalogProviders: () => d.catalog(),
    catalogModels: (p) => d.catalogModels(p),
    configured: () =>
      new Set(
        listProviderRows(d)
          .filter((r) => r.status !== 'unconfigured')
          .map((r) => r.id),
      ),
  };
}
