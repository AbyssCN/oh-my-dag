/**
 * models-json reader 测试 (统一-registry Phase 1 / C-1)。
 * 覆盖: 完整自定条目带出 · builtin-override 跳过 (INV-5) · $ENV key 解析 + 缺 key fail-open (INV-4) ·
 * 字面 key · per-model maxTokens/contextWindow 带出 · 文件缺/坏 → [] (静默不抛)。
 * 全走临时 models.json + 注入 env, 零网络零全局态。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCustomProviders, modelsJsonPath } from './models-json';
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
