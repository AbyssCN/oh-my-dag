/**
 * models-json reader 测试 (统一-registry Phase 1 / C-1)。
 * 覆盖: 完整自定条目带出 · builtin-override 跳过 (INV-5) · $ENV key 解析 + 缺 key fail-open (INV-4) ·
 * 字面 key · per-model maxTokens/contextWindow 带出 · 文件缺/坏 → [] (静默不抛)。
 * 全走临时 models.json + 注入 env, 零网络零全局态。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  listCustomProviderStatus,
  readCustomProviders,
  modelsJsonPath,
  upsertModel,
  upsertProvider,
} from './models-json';
import { registerProvidersFromModelsJson, getProvider, clearProviders } from './providers';
import { MAX_TOKENS_DEFAULT } from './role-models';

function writeModelsJson(content: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'omd-models-json-'));
  const path = join(dir, 'models.json');
  writeFileSync(path, JSON.stringify(content));
  return path;
}

describe('readCustomProviders', () => {
  test('带出完整自定条目, 跳过 builtin-override (INV-5)', () => {
    const path = writeModelsJson({
      providers: {
        // 完整自定: baseUrl+apiKey+api 齐全
        zhipu: {
          baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
          apiKey: '$ZHIPU_API_KEY',
          api: 'openai-completions',
          models: [{ id: 'glm-5.2', maxTokens: 128000, contextWindow: 1000000 }],
        },
        // builtin-override: 只有 models, 无 baseUrl → 跳过 (pi-native)
        deepseek: { models: [{ id: 'deepseek-v4-pro' }] },
      },
    });
    const env = { ZHIPU_API_KEY: 'sk-real' };
    const out = readCustomProviders(env, path);
    expect(out).toHaveLength(1);
    const [entry] = out;
    expect(entry).toMatchObject({
      id: 'zhipu',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      apiKey: 'sk-real',
      api: 'openai-completions',
    });
    expect(entry!.models[0]).toEqual({ id: 'glm-5.2', maxTokens: 128000, contextWindow: 1000000 });
  });

  test('$ENV key 缺失 → 跳过该 provider (INV-4 fail-open)', () => {
    const path = writeModelsJson({
      providers: {
        zhipu: { baseUrl: 'https://x', apiKey: '$MISSING_KEY', api: 'openai-completions', models: [] },
      },
    });
    expect(readCustomProviders({}, path)).toHaveLength(0);
  });

  test('字面 key (非 $ 前缀) 原样带出', () => {
    const path = writeModelsJson({
      providers: {
        local: { baseUrl: 'http://localhost:8000', apiKey: 'literal-key', api: 'openai-completions', models: [] },
      },
    });
    const out = readCustomProviders({}, path);
    expect(out).toHaveLength(1);
    expect(out[0]!.apiKey).toBe('literal-key');
  });

  test('文件缺 → [] (静默不抛)', () => {
    expect(readCustomProviders({}, join(tmpdir(), 'omd-nope', 'models.json'))).toEqual([]);
  });

  test('坏 JSON → [] (静默不抛)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omd-models-json-'));
    const path = join(dir, 'models.json');
    writeFileSync(path, '{ not json');
    expect(readCustomProviders({}, path)).toEqual([]);
  });

  test('modelsJsonPath: PI_AGENT_DIR 覆盖', () => {
    expect(modelsJsonPath({ PI_AGENT_DIR: '/custom/dir' })).toBe('/custom/dir/models.json');
    expect(modelsJsonPath({}).endsWith('/.pi/agent/models.json')).toBe(true);
  });
});

describe('registerProvidersFromModelsJson', () => {
  afterEach(() => clearProviders());

  test('注册进 callModel registry: defaultModel = 首个 model, maxTokens = 条目内最大', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omd-models-json-'));
    writeFileSync(
      join(dir, 'models.json'),
      JSON.stringify({
        providers: {
          zhipu: {
            baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
            apiKey: '$ZHIPU_API_KEY',
            api: 'openai-completions',
            models: [
              { id: 'glm-5.2', maxTokens: 128000 },
              { id: 'glm-4.6', maxTokens: 65536 },
            ],
          },
          deepseek: { models: [{ id: 'deepseek-v4-pro' }] }, // builtin-override, 跳过
        },
      }),
    );
    const env = { PI_AGENT_DIR: dir, ZHIPU_API_KEY: 'sk-real' };
    const ids = registerProvidersFromModelsJson(env);
    expect(ids).toEqual(['zhipu']); // deepseek (builtin-override) 未注册 (INV-5)
    const cfg = getProvider('zhipu');
    expect(cfg).toMatchObject({
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      apiKey: 'sk-real',
      api: 'openai-compatible', // openai-completions → xihe 'openai-compatible'
      defaultModel: 'glm-5.2',
      maxTokens: 128000, // 条目内最大
    });
  });

  test('条目无 maxTokens → MAX_TOKENS_DEFAULT 兜底 (治 4096 太低)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omd-models-json-'));
    writeFileSync(
      join(dir, 'models.json'),
      JSON.stringify({
        providers: {
          foo: { baseUrl: 'http://x', apiKey: 'k', api: 'openai-completions', models: [{ id: 'm1' }] },
        },
      }),
    );
    registerProvidersFromModelsJson({ PI_AGENT_DIR: dir });
    expect(getProvider('foo')?.maxTokens).toBe(MAX_TOKENS_DEFAULT);
  });
});

// ---------------------------------------------------------------------------
// upsert (MCP 面写盘, C-4 / issue #12) — merge 不 clobber (GWT-6) 是核心不变量。
// ---------------------------------------------------------------------------
describe('upsertProvider / upsertModel', () => {
  const freshPath = (): string =>
    join(mkdtempSync(join(tmpdir(), 'omd-models-json-')), 'models.json');

  test('新建 provider: apiKey 落 $keyEnv 引用, api 默认 openai-completions', () => {
    const path = freshPath();
    const r = upsertProvider(
      { id: 'zhipu', baseUrl: 'https://open.bigmodel.cn/api/paas/v4/', keyEnv: 'ZHIPU_API_KEY', models: [{ id: 'glm-5.2', maxTokens: 128000 }] },
      path,
    );
    expect(r.created).toBe(true);
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { providers: Record<string, any> };
    expect(raw.providers.zhipu).toEqual({
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4', // 尾斜杠归一
      apiKey: '$ZHIPU_API_KEY', // 落引用, 非明文
      api: 'openai-completions',
      models: [{ id: 'glm-5.2', maxTokens: 128000 }],
    });
  });

  test('GWT-6: merge upsert 不 clobber 既有 compat/headers 等未提供字段', () => {
    const path = freshPath();
    // 既有条目带 opencode-go 风格 compat flags + 一个 model。
    writeFileSync(
      path,
      JSON.stringify({
        providers: {
          'opencode-go': {
            baseUrl: 'https://old.example',
            apiKey: '$OPENCODE_API_KEY',
            api: 'openai-completions',
            compat: { toolCalls: 'inline', noSystemRole: true },
            headers: { 'X-Foo': 'bar' },
            models: [{ id: 'deepseek-v4-pro', maxTokens: 8192 }],
          },
        },
        // 顶层无关键也应保留。
        someTopLevelKey: 42,
      }),
    );
    upsertProvider(
      { id: 'opencode-go', baseUrl: 'https://new.example', keyEnv: 'OPENCODE_API_KEY', models: [{ id: 'deepseek-v4-flash', maxTokens: 4096 }] },
      path,
    );
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { providers: Record<string, any>; someTopLevelKey: number };
    const p = raw.providers['opencode-go'];
    // 未提供字段原样保留 (GWT-6)。
    expect(p.compat).toEqual({ toolCalls: 'inline', noSystemRole: true });
    expect(p.headers).toEqual({ 'X-Foo': 'bar' });
    // 提供字段更新。
    expect(p.baseUrl).toBe('https://new.example');
    // models 按 id merge: 既有保留 + 新增追加。
    expect(p.models).toEqual([
      { id: 'deepseek-v4-pro', maxTokens: 8192 },
      { id: 'deepseek-v4-flash', maxTokens: 4096 },
    ]);
    // 顶层无关键保留。
    expect(raw.someTopLevelKey).toBe(42);
  });

  test('upsertModel: patch 既有 model 属性, provider 缺 → providerFound=false', () => {
    const path = freshPath();
    upsertProvider({ id: 'zhipu', baseUrl: 'https://x', keyEnv: 'ZHIPU_API_KEY', models: [{ id: 'glm-5.2', maxTokens: 100 }] }, path);
    const r = upsertModel('zhipu:glm-5.2', { maxTokens: 200, contextWindow: 999 }, path);
    expect(r).toMatchObject({ provider: 'zhipu', model: 'glm-5.2', providerFound: true, created: false });
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { providers: Record<string, any> };
    expect(raw.providers.zhipu.models[0]).toEqual({ id: 'glm-5.2', maxTokens: 200, contextWindow: 999 });
    // provider 不存在 → 报缺, 不写。
    expect(upsertModel('nope:m1', { maxTokens: 1 }, path).providerFound).toBe(false);
  });

  test('listCustomProviderStatus: 展示态含无凭证条目 (标 hasKey=false), builtin-override 不列', () => {
    const path = freshPath();
    writeFileSync(
      path,
      JSON.stringify({
        providers: {
          zhipu: { baseUrl: 'https://x', apiKey: '$ZHIPU_API_KEY', api: 'openai-completions', models: [{ id: 'glm-5.2' }] },
          deepseek: { models: [{ id: 'deepseek-v4-pro' }] }, // builtin-override → 不列
        },
      }),
    );
    const withKey = listCustomProviderStatus({ ZHIPU_API_KEY: 'sk' }, path);
    expect(withKey).toHaveLength(1);
    expect(withKey[0]).toMatchObject({ id: 'zhipu', keyEnv: 'ZHIPU_API_KEY', hasKey: true });
    const noKey = listCustomProviderStatus({}, path);
    expect(noKey[0]).toMatchObject({ id: 'zhipu', hasKey: false }); // 仍列出 (展示态), 只标无凭证
  });
});
