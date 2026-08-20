/**
 * CubeSandbox leaf 测量器 —— **只冻结不变量, 不预判实测结果** (S0-TEST, 契约
 * `docs/plan/2026-08-11-四要素定稿-owner-2026-08-11-加第-4-条信号-假设-cubesandbox-能.md`)。
 *
 * TDD 红: 本文件断言 `./cubesandbox-leaf` 的接口形状, 该实现文件此时**尚不存在** —— import 会
 * 失败, 全部 test 红。这是刻意的第一步 (契约 S0-TEST verify: 实现文件保持缺席); 下一步的实现要
 * 让这些断言变绿, 不是相反。
 *
 * 只锁 INV-1..INV-6 的**判据形状**, 不锁 Cube 实测数值:
 *   - manifest 单变量比较 (INV-1): 逐字段比较, 除 leafLocation 与沙箱运行标识外任何差异 → 判「不可比」
 *   - 十名 env key 只记 present/count, value 绝不可序列化 (INV-4, D-9 冻结名单)
 *   - null+stage+原始错误的记账形态, NULL ≠ 0 (INV-3)
 *   - byte comparator 只接受 out-*.txt 路径 (INV-5)
 *   - retry 计数上限 2 (INV-6)
 * 不得断言 Cube 应泄露多少、应跑多少次、产物应相等 —— 那些是实测读数, 不是判据。
 */
import { describe, expect, test } from 'bun:test';
import {
  compareManifests,
  MANIFEST_EXEMPT_FIELDS,
  probeEnvKeys,
  ENV_KEY_ALLOWLIST,
  recordAttemptOutcome,
  compareBytes,
  boundRetry,
  MAX_RETRY,
} from './cubesandbox-leaf';

// D-9 冻结名单 —— 与契约行 17 逐字比对, 顺序与拼写不得漂移。
const D9_KEYS = [
  'ANYSEARCH_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'DEEPSEEK_API_KEY',
  'FIRECRAWL_API_KEY',
  'MIMO_API_KEY',
  'MIMO_PLATFORM_API_KEY',
  'OPENCODE_API_KEY',
  'PUBLER_API_KEY',
  'TAVILY_API_KEY',
  'XIAOMI_TOKEN_PLAN_AMS_API_KEY',
];

describe('INV-1 · manifest 单变量可审计', () => {
  const base = {
    repoHead: 'b7f46554923537fb4348e3a0924190eb047af48',
    worktree: '/home/nick/repos/oh-my-dag',
    planHash: 'sha256:deadbeef',
    planPath: 'docs/plan/2026-08-11-四要素定稿-owner-2026-08-11-加第-4-条信号-假设-cubesandbox-能.md',
    seat: 'claude-code:sonnet',
    thinking: 'medium',
    temperature: 0.7,
    topP: 1,
    goal: 'S0-TEST',
    nodeId: 'baseline_gate',
    envAllowlist: D9_KEYS,
    leafLocation: 'bwrap',
    sandboxRunId: 'bwrap-run-1',
  };

  test('除 leafLocation 与沙箱运行标识外逐字段相同 → 可比', () => {
    const other = { ...base, leafLocation: 'cube', sandboxRunId: 'cube-run-1' };
    const result = compareManifests(base, other);
    expect(result.comparable).toBe(true);
    expect(result.diffFields).toHaveLength(0);
  });

  test('豁免字段名单精确等于 {leafLocation, sandboxRunId}, 不多不少', () => {
    expect([...MANIFEST_EXEMPT_FIELDS].sort()).toEqual(['leafLocation', 'sandboxRunId'].sort());
  });

  test('任一非豁免字段不同 → 判「不可比」, 不解释差值', () => {
    const other = { ...base, leafLocation: 'cube', sandboxRunId: 'cube-run-1', seat: 'claude-code:opus' };
    const result = compareManifests(base, other);
    expect(result.comparable).toBe(false);
    expect(result.diffFields).toContain('seat');
    // 不解释差值: 结果里不得携带任何"为什么不同"的归因字段。
    expect(result).not.toHaveProperty('reason');
    expect(result).not.toHaveProperty('explanation');
  });

  test('多个非豁免字段同时不同 → 全部列出, 不挑一个代表', () => {
    const other = { ...base, leafLocation: 'cube', sandboxRunId: 'cube-run-1', seat: 'x', goal: 'y' };
    const result = compareManifests(base, other);
    expect(result.comparable).toBe(false);
    expect(result.diffFields).toEqual(expect.arrayContaining(['seat', 'goal']));
    expect(result.diffFields.length).toBeGreaterThanOrEqual(2);
  });
});

describe('INV-4 · 十名 env key 只记 presence/count, value 不可序列化', () => {
  test('固定十名冻结名单, 顺序拼写与契约逐字相同', () => {
    expect(ENV_KEY_ALLOWLIST).toHaveLength(10);
    expect(ENV_KEY_ALLOWLIST).toEqual(D9_KEYS);
  });

  test('每个探针结果只含 key/present, 不含 value 字段', () => {
    const env = { ANYSEARCH_API_KEY: 'sk-should-never-appear', PATH: '/usr/bin' };
    const probes = probeEnvKeys(env);
    expect(probes).toHaveLength(10);
    for (const p of probes) {
      expect(Object.keys(p).sort()).toEqual(['key', 'present']);
      expect(typeof p.present).toBe('boolean');
    }
  });

  test('present 计数正确, count 字段与 present=true 数一致', () => {
    const env = { ANYSEARCH_API_KEY: 'x', TAVILY_API_KEY: 'y' };
    const probes = probeEnvKeys(env);
    const presentCount = probes.filter((p) => p.present).length;
    expect(presentCount).toBe(2);
  });

  test('序列化探针结果 (JSON.stringify) 绝不包含任何注入的 value 字符串', () => {
    const secret = 'sk-topsecret-do-not-leak-1234567890';
    const env = { DEEPSEEK_API_KEY: secret, XIAOMI_TOKEN_PLAN_AMS_API_KEY: secret };
    const probes = probeEnvKeys(env);
    const serialized = JSON.stringify(probes);
    expect(serialized).not.toContain(secret);
  });

  test('非白名单 key 不出现在探针结果里 (只测冻结十名, 不扩分母)', () => {
    const env = { ANYSEARCH_API_KEY: 'x', SOME_OTHER_UNRELATED_KEY: 'y' };
    const probes = probeEnvKeys(env);
    expect(probes.map((p) => p.key)).not.toContain('SOME_OTHER_UNRELATED_KEY');
  });
});

describe('INV-3 · NULL ≠ 0 的记账形态', () => {
  test('起不来/没跑到/SDK 无该方法 → 记 null + stage + 原始错误, 不是 0', () => {
    const outcome = recordAttemptOutcome({ stage: 'create', error: new Error('bwrap: command not found') });
    expect(outcome.value).toBeNull();
    expect(outcome.stage).toBe('create');
    expect(outcome.error).toBeTruthy();
    expect(outcome.value).not.toBe(0);
  });

  test('正常成功的记账形态里 value 不是 null (与失败态可区分)', () => {
    const outcome = recordAttemptOutcome({ stage: 'create', value: 123 });
    expect(outcome.value).toBe(123);
    expect(outcome.error).toBeNull();
  });

  test('缺 stage 的记账形态不合法 —— NULL 必须带 stage, 否则无法分辨三种"没记"', () => {
    // @ts-expect-error 契约要求 stage 必填, 缺失应在类型或运行期即被拒绝
    expect(() => recordAttemptOutcome({ error: new Error('x') })).toThrow();
  });

  test('原始错误不得被吞成布尔或字符串摘要 —— 必须保留可读的原始错误对象/消息', () => {
    const raw = new Error('SDK method createSandbox not implemented');
    const outcome = recordAttemptOutcome({ stage: 'create', error: raw });
    expect(outcome.error).toBe(raw);
  });
});

describe('INV-5 · byte comparator 只接受 out-*.txt 路径', () => {
  test('两个合法 out-<nodeId>.txt 路径 → 正常执行比较, 返回退出状态与首个差异位置', () => {
    const result = compareBytes('.omd/probes/cubesandbox-leaf/bwrap/out-baseline_gate.txt', '.omd/probes/cubesandbox-leaf/cube/out-baseline_gate.txt');
    expect(result).toHaveProperty('exitStatus');
    expect(result).toHaveProperty('firstDiffOffset');
  });

  test('拒绝比较 summary/checkpoint JSON 或人工摘录路径', () => {
    expect(() => compareBytes('summary.json', 'out-baseline_gate.txt')).toThrow();
    expect(() => compareBytes('out-baseline_gate.txt', 'checkpoint.json')).toThrow();
    expect(() => compareBytes('.omd/probes/notes.md', '.omd/probes/notes-copy.md')).toThrow();
  });

  test('文件缺席记 null, 不得抛出未捕获异常掩盖缺席事实', () => {
    const result = compareBytes('.omd/probes/cubesandbox-leaf/does-not-exist/out-x.txt', '.omd/probes/cubesandbox-leaf/does-not-exist/out-y.txt');
    expect(result.exitStatus).toBeNull();
  });
});

describe('INV-6 · 重试有界', () => {
  test('MAX_RETRY 冻结为 2', () => {
    expect(MAX_RETRY).toBe(2);
  });

  test('首试之外最多重试 2 次, 第 3 次重试被拒绝', () => {
    let attempt = 0;
    const run = () => {
      attempt += 1;
      return boundRetry(attempt - 1); // attempt-1 = 首试之外已重试次数
    };
    expect(run()).toBe(true); // 首试
    expect(run()).toBe(true); // 重试 1
    expect(run()).toBe(true); // 重试 2
    expect(run()).toBe(false); // 重试 3 越界, 拒绝
  });

  test('起箱前置失败不得靠循环重试掩盖 —— 越界重试请求必须显式拒绝而非静默截断循环', () => {
    expect(boundRetry(MAX_RETRY + 1)).toBe(false);
  });
});
