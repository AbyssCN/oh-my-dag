/**
 * headless-config 不变量: key 路由 (auth.json/​.env) + 合并不伤他人 + 活注入 + preset 落盘 +
 * 角色校验 (plan 拒) + HUD 开关。凭证 flag 依赖真 ~/.pi/auth.json, 由 dag_run 端到端验, 此处不锁。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearProviders, getProvider } from '../../model/providers';
import { resetConfigCache } from '../../model/role-models';
import { applyPresetHeadless, setKeyHeadless, setRoleHeadless, toggleHud } from './headless-config';

let dir: string;
let prevConfigPath: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'headless-cfg-'));
  prevConfigPath = process.env.OMD_CONFIG_PATH;
  process.env.OMD_CONFIG_PATH = join(dir, '.omd', 'config.json');
});

afterEach(() => {
  if (prevConfigPath === undefined) delete process.env.OMD_CONFIG_PATH;
  else process.env.OMD_CONFIG_PATH = prevConfigPath;
  clearProviders();
  resetConfigCache();
});

describe('setKeyHeadless 路由', () => {
  test('auto: kimi-coding → auth.json api_key (合并, 不动他人条目)', () => {
    const authPath = join(dir, 'auth.json');
    writeFileSync(authPath, JSON.stringify({ deepseek: { type: 'api_key', key: 'keep-me' } }));
    const env: Record<string, string | undefined> = {};
    const r = setKeyHeadless('kimi-coding', 'sk-kimi-x', 'auto', { cwd: dir, env, authPath });
    expect(r.target).toBe('authjson');
    expect(r.immediate).toBe(true);
    const auth = JSON.parse(readFileSync(authPath, 'utf8'));
    expect(auth['kimi-coding']).toEqual({ type: 'api_key', key: 'sk-kimi-x' });
    expect(auth.deepseek).toEqual({ type: 'api_key', key: 'keep-me' }); // 未被吞
  });

  test('auto: mimo → .env 落盘 + process.env 活注入 + re-register', () => {
    const env: Record<string, string | undefined> = { MIMO_BASE_URL: 'https://x/v1' };
    const r = setKeyHeadless('mimo', 'sk-mimo-x', 'auto', { cwd: dir, env, authPath: join(dir, 'auth.json') });
    expect(r.target).toBe('env');
    expect(env.MIMO_API_KEY).toBe('sk-mimo-x'); // 活注入
    expect(readFileSync(join(dir, '.env'), 'utf8')).toContain('MIMO_API_KEY'); // 落盘
    expect(getProvider('mimo')).toBeTruthy(); // base 在 → 注册成功
  });

  test('auto: mimo 无 base → warning', () => {
    const env: Record<string, string | undefined> = {};
    const r = setKeyHeadless('mimo', 'sk-mimo-x', 'auto', { cwd: dir, env, authPath: join(dir, 'auth.json') });
    expect(r.warnings.some((w) => w.includes('MIMO_BASE_URL'))).toBe(true);
  });

  test('target 覆盖: deepseek 强制 authjson', () => {
    const authPath = join(dir, 'auth.json');
    const r = setKeyHeadless('deepseek', 'sk-ds', 'authjson', { cwd: dir, env: {}, authPath });
    expect(r.target).toBe('authjson');
    expect(JSON.parse(readFileSync(authPath, 'utf8')).deepseek.key).toBe('sk-ds');
  });

  test('空 provider / 空 key → throw', () => {
    expect(() => setKeyHeadless('', 'k', 'auto', { cwd: dir })).toThrow(/provider required/);
    expect(() => setKeyHeadless('mimo', '  ', 'auto', { cwd: dir })).toThrow(/key required/);
  });
});

describe('applyPresetHeadless', () => {
  test('cn-trio: env 矩阵落盘+注入 + config 角色落 config.json (无 plan)', () => {
    const env: Record<string, string | undefined> = {};
    const r = applyPresetHeadless('cn-trio', { cwd: dir, env });
    expect(r.presetId).toBe('cn-trio');

    // env 矩阵注入 (精确值)。
    expect(env.OMD_ITER_CONDUCTOR_MODEL).toBe('kimi-coding:k3');
    expect(env.OMD_ITER_LEAF_MODEL).toBe('deepseek:deepseek-v4-flash');
    expect(env.OMD_REDUCE_MODEL).toBe('mimo:mimo-v2.5-pro-ultraspeed');
    expect(env.OMD_JUDGE_MODEL).toBe('kimi-coding:k3');
    // 落盘。
    expect(readFileSync(join(dir, '.env'), 'utf8')).toContain('OMD_ITER_CONDUCTOR_MODEL');

    // config 角色 → config.json (无 plan)。
    const cfg = JSON.parse(readFileSync(process.env.OMD_CONFIG_PATH!, 'utf8'));
    expect(cfg.models.conductor).toBe('kimi-coding:k3');
    expect(cfg.models.leaf).toBe('deepseek:deepseek-v4-flash');
    expect(cfg.models.verifier).toBe('kimi-coding:k3');
    expect(cfg.models.dream).toBe('deepseek:deepseek-v4-flash');
    expect(cfg.models.plan).toBeUndefined();
    expect(cfg.multimodalPool).toEqual(['mimo:mimo-v2.5-pro-ultraspeed']);
  });

  test('未知 preset → throw', () => {
    expect(() => applyPresetHeadless('nope', { cwd: dir, env: {} })).toThrow(/unknown preset/);
  });

  test('customApis preset → 自定 provider 写 models.json (统一-registry 迁移), PI_AGENT_DIR 隔离', () => {
    // base-opencode-go 带 customApis: opencode-go。env 里给 PI_AGENT_DIR (隔离到 temp, 不碰真 ~/.pi)。
    const env: Record<string, string | undefined> = { PI_AGENT_DIR: dir, OPENCODE_API_KEY: 'sk-oc' };
    const r = applyPresetHeadless('base-opencode-go', { cwd: dir, env });
    expect(r.customApis).toContain('opencode-go');
    // 自定 provider 落 models.json (不落 config.json.apis — 该链已废)。
    const mj = JSON.parse(readFileSync(join(dir, 'models.json'), 'utf8'));
    expect(mj.providers['opencode-go']).toMatchObject({
      baseUrl: expect.any(String),
      apiKey: '$OPENCODE_API_KEY', // 落引用, 非明文
      api: 'openai-completions',
    });
    // config.json 不再有 apis 段。
    const cfg = JSON.parse(readFileSync(process.env.OMD_CONFIG_PATH!, 'utf8'));
    expect(cfg.apis).toBeUndefined();
    // key 在 env → callModel 侧已注册 (registerProvidersFromModelsJson 活注入)。
    expect(getProvider('opencode-go')).toBeTruthy();
  });
});

describe('setRoleHeadless', () => {
  test('conductor 落 config.json', () => {
    const r = setRoleHeadless('conductor', 'kimi-coding:k3');
    expect(r).toEqual({ role: 'conductor', coord: 'kimi-coding:k3' });
    const cfg = JSON.parse(readFileSync(process.env.OMD_CONFIG_PATH!, 'utf8'));
    expect(cfg.models.conductor).toBe('kimi-coding:k3');
  });

  test('plan 不可调 + 坏坐标拒', () => {
    expect(() => setRoleHeadless('plan', 'x:y')).toThrow(/不可调/);
    expect(() => setRoleHeadless('conductor', 'not-a-coord')).toThrow(/格式非法/);
  });
});

describe('toggleHud', () => {
  test('on 装 → off 卸 (settings.local.json)', () => {
    const settings = join(dir, '.claude', 'settings.local.json');
    const on = toggleHud(dir, true, { cwd: dir });
    expect(on.status).toBe('installed');
    expect(JSON.parse(readFileSync(settings, 'utf8')).statusLine.command).toContain('omd-hud.ts');

    const off = toggleHud(dir, false, { cwd: dir });
    expect(off.status).toBe('removed');
    expect(JSON.parse(readFileSync(settings, 'utf8')).statusLine).toBeUndefined();
  });

  test('off 空 repo → not-present', () => {
    expect(toggleHud(dir, false, { cwd: dir }).status).toBe('not-present');
  });
});
