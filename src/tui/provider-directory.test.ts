/**
 * L1 判据:provider 全目录(2026-08-10,owner 点名照 pi 的 /login 选单)。
 *
 * 起因:`/login` 只列 discoverProviders() 探到的 —— 新机器上是空表,而 pi 列全目录
 * 42 家、每家挂配没配的状态。这里量的是目录的**并集、三态、排序**,不量真机配了什么
 * (全部注入假件;真机打包 `fullModelCatalogDeps` 的组合逻辑在 model-picker.test 里量)。
 */
import { describe, expect, test } from 'bun:test';
import type { DiscoveredProvider } from '../config/config-discovery';
import { listModelChoices } from './model-picker';
import { CLAUDE_CODE_ID, fullModelCatalogDeps, listProviderRows, providerRowLabel } from './provider-directory';
import { findRiskyGlyphs } from './render/glyphs';

const none = {
  catalog: () => [] as string[],
  discovered: () => [] as DiscoveredProvider[],
  envKey: () => undefined,
  registered: () => [] as string[],
  claudeCliCreds: () => false,
  catalogModels: () => [] as string[],
};

const disc = (id: string, source: DiscoveredProvider['source'], hasKey = true): DiscoveredProvider => ({
  id,
  source,
  hasKey,
  isOAuth: source === 'auth.json',
});

describe('目录并集与三态', () => {
  test('★ 目录家即使一个凭证都没有也在列 —— 这正是修的那个洞(此前空表)', () => {
    const rows = listProviderRows({ ...none, catalog: () => ['anthropic', 'xai'] });
    // claude-code 恒在列(订阅通道是本仓一等座位家族)。
    expect(rows.map((r) => r.id).sort()).toEqual(['anthropic', CLAUDE_CODE_ID, 'xai'].sort());
    expect(rows.every((r) => r.status === 'unconfigured')).toBe(true);
  });

  test('auth.json/models.json 探到 → stored;env/go 探到 → env —— 三态不抹平', () => {
    const rows = listProviderRows({
      ...none,
      discovered: () => [disc('kimi-coding', 'auth.json'), disc('zhipu', 'env'), disc('opencode-go', 'go-subscription')],
    });
    const by = new Map(rows.map((r) => [r.id, r.status]));
    expect(by.get('kimi-coding')).toBe('stored');
    expect(by.get('zhipu')).toBe('env');
    expect(by.get('opencode-go')).toBe('env');
  });

  test('目录家配了 env key → env;registry 注册的 → env', () => {
    const rows = listProviderRows({
      ...none,
      catalog: () => ['deepseek', 'xai'],
      envKey: (id) => (id === 'deepseek' ? 'sk-x' : undefined),
      registered: () => ['mimo'],
    });
    const by = new Map(rows.map((r) => [r.id, r.status]));
    expect(by.get('deepseek')).toBe('env');
    expect(by.get('xai')).toBe('unconfigured');
    expect(by.get('mimo')).toBe('env');
  });

  test('★ 同 id 多源:强状态不被弱源降级(stored 不被后到的 env 盖掉)', () => {
    const rows = listProviderRows({
      ...none,
      catalog: () => ['kimi-coding'],
      discovered: () => [disc('kimi-coding', 'auth.json'), disc('kimi-coding', 'env')],
    });
    expect(rows.find((r) => r.id === 'kimi-coding')?.status).toBe('stored');
  });

  test('claude CLI 凭证在盘上 → claude-code stored;不在 → unconfigured', () => {
    expect(listProviderRows({ ...none, claudeCliCreds: () => true }).find((r) => r.id === CLAUDE_CODE_ID)?.status).toBe('stored');
    expect(listProviderRows(none).find((r) => r.id === CLAUDE_CODE_ID)?.status).toBe('unconfigured');
  });

  test('★ 配了的排前(stored → env → unconfigured), 组内按 id', () => {
    const rows = listProviderRows({
      ...none,
      catalog: () => ['bb', 'aa'],
      discovered: () => [disc('zz', 'auth.json'), disc('mm', 'env')],
    });
    expect(rows.map((r) => r.id)).toEqual(['zz', 'mm', 'aa', 'bb', CLAUDE_CODE_ID]);
  });
});

describe('标签', () => {
  test('三态各有其文案(照 pi), 字形全在白名单', () => {
    const texts = (['stored', 'env', 'unconfigured'] as const).map((status) => providerRowLabel({ id: 'x', status }));
    expect(texts[0]).toContain('✓ stored');
    expect(texts[1]).toContain('API key configured');
    expect(texts[2]).toContain('unconfigured');
    for (const t of texts) expect(findRiskyGlyphs(t)).toEqual([]);
  });
});

describe('fullModelCatalogDeps → listModelChoices(真机打包的组合逻辑, 全注入)', () => {
  const base = {
    ...none,
    catalog: () => ['deepseek', 'xai'],
    discovered: () => [disc('deepseek', 'env')],
    catalogModels: (p: string) =>
      p === 'deepseek' ? ['v4-flash'] : p === 'anthropic' ? ['claude-sonnet-5'] : p === 'xai' ? ['grok-4'] : [],
  };
  const empty = { providers: () => [] as string[], models: () => [] as string[] };

  test('★ 只出 configured 家的模型 —— 没配的 xai 不出场(照 pi 的 configured 过滤)', () => {
    const coords = listModelChoices({ ...empty, ...fullModelCatalogDeps(base) }).map((c) => c.coord);
    expect(coords).toContain('deepseek:v4-flash');
    expect(coords.some((c) => c.startsWith('xai:'))).toBe(false);
  });

  test('★ claude-code 配了订阅 → 从 anthropic 目录派生 claude-code:* 坐标', () => {
    const coords = listModelChoices({ ...empty, ...fullModelCatalogDeps({ ...base, claudeCliCreds: () => true }) }).map((c) => c.coord);
    expect(coords).toContain('claude-code:claude-sonnet-5');
    // 反向:没配订阅就不派生 —— 列一个必失败的坐标是误导。
    const without = listModelChoices({ ...empty, ...fullModelCatalogDeps(base) }).map((c) => c.coord);
    expect(without.some((c) => c.startsWith('claude-code:'))).toBe(false);
  });

  test('registry 与目录同坐标 → 一条(registry 在前), 不重复', () => {
    const deps = { providers: () => ['deepseek'], models: () => ['v4-flash'], ...fullModelCatalogDeps(base) };
    const coords = listModelChoices(deps).map((c) => c.coord);
    expect(coords.filter((c) => c === 'deepseek:v4-flash')).toHaveLength(1);
  });

  test('★ 缺省(不给 catalog 三件套)不偷读目录 —— 既有调用方行为一字不变', () => {
    expect(listModelChoices(empty)).toEqual([]);
  });
});
