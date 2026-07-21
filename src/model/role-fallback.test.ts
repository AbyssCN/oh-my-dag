/**
 * role-fallback 守卫 (issue #6): 角色模型兜底链 + 起跑坐席检查。
 * 证: 有凭证→原样返; 无凭证 (含 pi 目录认识但缺 key 的 deepseek 全坐标)→顺延注册表; 全不可达→原样返;
 *     坐席检查纯告警不抛。判据 = 凭证维度 (非 key-blind 的 assertModelResolvable)。
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { clearProviders, registerProvider } from './providers';
import { setPiTransportDepsForTest } from './pi-transport';
import { roleModelWithFallback, resetRoleFallbackWarned, warnUnregisteredRoles } from './role-fallback';

const FAKE = { baseUrl: 'http://x.invalid', apiKey: 'k', api: 'openai-compatible' as const };
// auth.json 指向不存在文件 → piHasCredential 只认显式注册/传入 env, 不被真机 ~/.pi/agent/auth.json 干扰。
const isolateAuth = (): void => setPiTransportDepsForTest({ authPath: '/nonexistent/omd-test-auth.json' });

describe('roleModelWithFallback (issue #6)', () => {
  beforeEach(() => {
    clearProviders();
    resetRoleFallbackWarned();
    isolateAuth();
  });
  afterEach(() => {
    clearProviders();
  });
  afterAll(() => {
    setPiTransportDepsForTest(); // 复位, 不污染其它测试文件
  });

  test('首选有凭证 (自有 registry 命中) → 原样返 (不兜底)', () => {
    registerProvider('mimo', { ...FAKE, defaultModel: 'mimo-v2.5-pro' });
    expect(roleModelWithFallback('mimo:mimo-v2.5', 'leaf', {})).toBe('mimo:mimo-v2.5');
  });

  test('无凭证的 deepseek **全坐标** → 兜底 (关键: key-blind 可解析闸会漏掉这个)', () => {
    registerProvider('mimo', { ...FAKE, defaultModel: 'mimo-v2.5-pro' });
    // deepseek:deepseek-v4-flash 在 pi 目录"可解析", 但无 key → 无凭证 → 必须兜底到 mimo
    expect(roleModelWithFallback('deepseek:deepseek-v4-flash', 'judge', {})).toBe('mimo');
    expect(roleModelWithFallback('deepseek:deepseek-v4-pro', 'review', {})).toBe('mimo');
  });

  test('无凭证的裸 deepseek → 兜底', () => {
    registerProvider('mimo', { ...FAKE, defaultModel: 'mimo-v2.5-pro' });
    expect(roleModelWithFallback('deepseek', 'dream', {})).toBe('mimo');
  });

  test('顺延取注册表首个 (插入序) 有凭证 provider', () => {
    registerProvider('mimo', { ...FAKE, defaultModel: 'mimo-v2.5-pro' });
    registerProvider('kimi', { ...FAKE, defaultModel: 'k' });
    expect(roleModelWithFallback('deepseek', 'dream', {})).toBe('mimo'); // 插入序首个
  });

  test('env 提供凭证 → 视为有凭证, 不兜底', () => {
    registerProvider('mimo', { ...FAKE, defaultModel: 'mimo-v2.5-pro' });
    // DEEPSEEK_API_KEY 在传入 env 里 → deepseek 有凭证 → 原样返 (不落 mimo)
    expect(roleModelWithFallback('deepseek:deepseek-v4-pro', 'judge', { DEEPSEEK_API_KEY: 'sk-x' })).toBe('deepseek:deepseek-v4-pro');
  });

  test('全不可达 (空注册表, 无凭证) → 原样返首选 (下游 fail-loud/降级)', () => {
    expect(roleModelWithFallback('deepseek:deepseek-v4-flash', 'dream', {})).toBe('deepseek:deepseek-v4-flash');
  });
});

describe('warnUnregisteredRoles (issue #6 起跑坐席)', () => {
  beforeEach(() => {
    clearProviders();
    resetRoleFallbackWarned();
    isolateAuth();
  });
  afterEach(() => {
    clearProviders();
  });
  afterAll(() => {
    setPiTransportDepsForTest();
  });

  test('无凭证角色 → 纯告警不抛 (启动即可见, 非跑到一半炸)', () => {
    expect(() => warnUnregisteredRoles({})).not.toThrow();
  });

  test('角色全有凭证 → 不抛', () => {
    registerProvider('mimo', { ...FAKE, defaultModel: 'mimo-v2.5-pro' });
    registerProvider('deepseek', { ...FAKE, defaultModel: 'deepseek-v4-pro' });
    expect(() => warnUnregisteredRoles({})).not.toThrow();
  });
});
