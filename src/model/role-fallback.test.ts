/**
 * role-fallback 守卫 (issue #6): 角色模型兜底链 + 起跑坐席检查。
 * 证: 有凭证→原样返; 无凭证 (含 pi 目录认识但缺 key 的 deepseek 全坐标)→顺延注册表; 全不可达→原样返;
 *     坐席检查纯告警不抛。判据 = 凭证维度 (非 key-blind 的 assertModelResolvable)。
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearProviders, registerProvider } from './providers';
import { piEnvApiKey, setPiTransportDepsForTest } from './pi-transport';
import { PERIOD_COOLDOWN_MS, reportProviderFailure, resetProviderCooldowns } from './provider-health';
import { roleModelWithFallback, resetRoleFallbackWarned, warnUnregisteredRoles, usable } from './role-fallback';

const FAKE = { baseUrl: 'http://x.invalid', apiKey: 'k', api: 'openai-compatible' as const };
// auth.json 指向不存在文件 → piHasCredential 只认显式注册/传入 env, 不被真机 ~/.pi/agent/auth.json 干扰。
const isolateAuth = (): void => setPiTransportDepsForTest({ authPath: '/nonexistent/omd-test-auth.json' });

describe('roleModelWithFallback (issue #6)', () => {
  beforeEach(() => {
    clearProviders();
    resetRoleFallbackWarned();
    resetProviderCooldowns();
    isolateAuth();
  });
  afterEach(() => {
    clearProviders();
    resetProviderCooldowns();
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
    expect(roleModelWithFallback('deepseek', 'continuity', {})).toBe('mimo');
  });

  test('顺延取注册表首个 (插入序) 有凭证 provider', () => {
    registerProvider('mimo', { ...FAKE, defaultModel: 'mimo-v2.5-pro' });
    registerProvider('kimi', { ...FAKE, defaultModel: 'k' });
    expect(roleModelWithFallback('deepseek', 'continuity', {})).toBe('mimo'); // 插入序首个
  });

  test('env 提供凭证 → 视为有凭证, 不兜底', () => {
    registerProvider('mimo', { ...FAKE, defaultModel: 'mimo-v2.5-pro' });
    // DEEPSEEK_API_KEY 在传入 env 里 → deepseek 有凭证 → 原样返 (不落 mimo)
    expect(roleModelWithFallback('deepseek:deepseek-v4-pro', 'judge', { DEEPSEEK_API_KEY: 'sk-x' })).toBe('deepseek:deepseek-v4-pro');
  });

  test('全不可达 (空注册表, 无凭证) → 原样返首选 (下游 fail-loud/降级)', () => {
    expect(roleModelWithFallback('deepseek:deepseek-v4-flash', 'continuity', {})).toBe('deepseek:deepseek-v4-flash');
  });

  test('首选有凭证但**运行时熔断中** → 顺延到健康 provider (健康维度)', () => {
    registerProvider('deepseek', { ...FAKE, defaultModel: 'deepseek-v4-pro' });
    registerProvider('mimo', { ...FAKE, defaultModel: 'mimo-v2.5-pro' });
    reportProviderFailure('deepseek'); // deepseek 刚 429/宕机 → 冷却
    // deepseek 有凭证但冷却中 → usable=false → 顺延注册表首个健康者 (mimo)
    expect(roleModelWithFallback('deepseek:deepseek-v4-pro', 'leaf', {})).toBe('mimo');
  });

  test('兜底跳过同样熔断中的 provider (不顺延到另一个不健康后端)', () => {
    registerProvider('deepseek', { ...FAKE, defaultModel: 'deepseek-v4-pro' });
    registerProvider('mimo', { ...FAKE, defaultModel: 'mimo-v2.5-pro' });
    registerProvider('kimi', { ...FAKE, defaultModel: 'k' });
    reportProviderFailure('deepseek'); // 首选冷却
    reportProviderFailure('mimo'); // 注册序首个兜底也冷却 → 应跳过, 落 kimi
    expect(roleModelWithFallback('deepseek:deepseek-v4-pro', 'leaf', {})).toBe('kimi');
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

describe('claude-code 订阅通道凭证判据 (issue #6 根因修, 2026-08-10)', () => {
  beforeEach(() => {
    clearProviders();
    resetProviderCooldowns();
    isolateAuth();
  });
  afterEach(() => {
    clearProviders();
    resetProviderCooldowns();
  });
  afterAll(() => {
    setPiTransportDepsForTest(); // 复位, 不污染其它测试文件 (D6 INV-D6-3)
  });

  // 反向自检: 把 credentialed 的 CLAUDE_SDK_PROVIDER 分支删掉 → 这条当场红 (回到恒 false 的旧缺陷:
  // 探测面不认订阅通道, 叶座位在所有进程静默降档 kimi, 见 role-fallback.ts claudeSdkCredentialed 头注)。
  test('★ 有 SDK 凭证 (CLAUDE_CONFIG_DIR 下有 .credentials.json) → usable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omd-claude-cred-'));
    writeFileSync(join(dir, '.credentials.json'), '{}');
    expect(usable('claude-code:claude-sonnet-5', { CLAUDE_CONFIG_DIR: dir })).toBe(true);
  });

  test('★ 已知坏样本: 凭证目录不存在且无 token → 仍判 no-credential (修的是盲区不是放水)', () => {
    expect(usable('claude-code:claude-sonnet-5', { CLAUDE_CONFIG_DIR: '/nonexistent/omd-claude-x' })).toBe(false);
  });

  test('CLAUDE_CODE_OAUTH_TOKEN 也算凭证 (SDK 第二凭证源, 无盘文件的 CI 形态)', () => {
    expect(
      usable('claude-code:claude-sonnet-5', {
        CLAUDE_CONFIG_DIR: '/nonexistent/omd-claude-x',
        CLAUDE_CODE_OAUTH_TOKEN: 't',
      }),
    ).toBe(true);
  });
});

/**
 * 健康维度按 (channel, model) 精确判 —— 票 t-judge-cred (2026-09-02)。
 *
 * 根因: `usable()` 手里拿着全坐标, 却只问 channel 级宽门 `channelInCooldown(provider)` ——
 * 把 model 那一半扔了。于是同一 channel 里**任何一个** model 的冷却会把整条 channel 判死。
 * 盘上实测 (run 1a4e83ce, 2026-09-01T11:56Z): `.omd/seat-health.json` 里只有
 * `opencode-go:deepseek-v4-pro` 一条 403 周期档 (11:51:24Z → 17:51:24Z), judge
 * `opencode-go:glm-5.2` 就被判不可用 → 静默顺延兜底; 而座位探针对 glm-5.2 发真调用是 ✓。
 * 两个面判词相反, 且 WARN 把「冷却中」写成「无凭证」, 于是这票一开始被当成凭证 bug。
 *
 * 反向自检 (逐条验过):
 * - 把 `coordInCooldown` 改回 `channelInCooldown(p)` → 第一条当场红 (回到本 bug);
 * - 删掉 `inCooldown(provider)` 那一跳 → 第二条当场红 (裸名上报的整条 channel 冷却被漏掉);
 * - 把健康闸整个删掉 → 第二、三条当场红 (修的是粒度, 不是放水)。
 */
describe('健康闸按 (channel, model) 精确判 (票 t-judge-cred)', () => {
  const KEYED = { OPENCODE_API_KEY: 'sk-x' };
  let prevHealthPath: string | undefined;

  beforeEach(() => {
    clearProviders();
    resetProviderCooldowns();
    isolateAuth();
    // 周期档会写盘 (`.omd/seat-health.json`, 进程 cwd 锚) → 改道 tmp, 否则测试污染仓内真账本。
    prevHealthPath = process.env.OMD_SEAT_HEALTH_PATH;
    process.env.OMD_SEAT_HEALTH_PATH = join(
      mkdtempSync(join(tmpdir(), 'omd-seat-health-')),
      'seat-health.json',
    );
  });
  afterEach(() => {
    clearProviders();
    resetProviderCooldowns();
    if (prevHealthPath === undefined) delete process.env.OMD_SEAT_HEALTH_PATH;
    else process.env.OMD_SEAT_HEALTH_PATH = prevHealthPath;
  });
  afterAll(() => {
    setPiTransportDepsForTest();
  });

  test('★ 同 channel 里**另一个** model 周期熔断 → 本坐标仍 usable (run 1a4e83ce 原样重放)', () => {
    reportProviderFailure('opencode-go:deepseek-v4-pro', PERIOD_COOLDOWN_MS);
    expect(usable('opencode-go:glm-5.2', KEYED)).toBe(true);
    // 真坏的那一个仍判死 —— 精确到 model 不等于放水。
    expect(usable('opencode-go:deepseek-v4-pro', KEYED)).toBe(false);
  });

  test('整条 channel 熔断 (裸名上报) → 该 channel 全坐标不可用 (宽门那一半不许丢)', () => {
    reportProviderFailure('opencode-go');
    expect(usable('opencode-go:glm-5.2', KEYED)).toBe(false);
  });

  test('裸 channel 坐标 → 仍走宽门 (落到哪个 model 未知, 保守判死)', () => {
    reportProviderFailure('opencode-go:glm-5.2');
    expect(usable('opencode-go', KEYED)).toBe(false);
  });

  /**
   * 结构闸: 凭证的 provider→env-key 映射只有一份 (pi-transport 的 `PI_ENV_KEY_MAP`),
   * role-fallback 这一侧不许再抄一张 —— 探针的真调用取 key 走的也是它。
   * 反向自检: 在 `credentialed()` 里补一句 `env.OPENCODE_API_KEY` 兜底 → 第一条当场红;
   * 从 `PI_ENV_KEY_MAP` 删掉 `opencode-go` 那一行 → 第二条当场红。
   */
  test('凭证判据单一真源: role-fallback 不自存 env-key 表', () => {
    const src = readFileSync(new URL('./role-fallback.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/_API_KEY/);
    expect(piEnvApiKey('opencode-go', KEYED)).toBe('sk-x');
  });
});
