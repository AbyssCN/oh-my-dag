/**
 * **ModelError 的两个轴各管各的** (2026-08-16, S-40 的后半)。
 *
 * 此前只有一个 `status`, 而它被当成两件事用: 别处放真 HTTP 码, `minimax-native` 放**业务码**。
 * 于是「该不该冷却这个 provider」与「再转一轮有没有用」两个问题共用一个数, 靠
 * 「业务码碰巧都 ≥ 1000, 于是落进 `s >= 500`」这个**数值巧合**得到今天的行为 —— 没人选过它。
 *
 * 两个轴**本来就不是一件事**, 一个字段服务不了:
 *   坏 API key → 冷却该 provider ✅ (下一跑顺延兜底) · 本跑再转一轮 ❌ (同一座位必然同样错)
 *
 * 所以拆成两个显式表态, 抛错方说了算, 省略才回落原来的启发式 (老调用点行为不变):
 *   `fault`     'provider' | 'quota' | 'request'  → 冷却轴 (provider-health)
 *   `transient` boolean                            → 环轴 (engine 的 unreachable)
 */
import { describe, expect, test } from 'bun:test';
import { ModelError, isProviderFault, isTransientModelFault } from './index';

describe('fault: 冷却轴 —— 抛错方显式表态压过 status 启发式', () => {
  test("★ fault:'request' → 不是 provider 故障, 即使 status 是 5xx", () => {
    // 请求本身错 (参数不合法): 冷却一个健康的 provider 是纯浪费, 换 provider 也不解决。
    expect(isProviderFault(new ModelError('http', 'invalid params', { status: 503, fault: 'request' }))).toBe(false);
  });

  test("★ fault:'provider' → 是 provider 故障, 即使 status 是 4xx", () => {
    // 坏 key 属于这一格: 换个座位就能跑, 所以该冷却 + 顺延兜底 (issue #6)。
    expect(isProviderFault(new ModelError('http', 'bad key', { status: 400, fault: 'provider' }))).toBe(true);
  });

  test("★ fault:'quota' → 是 provider 故障 (配额档, 冷却窗更长)", () => {
    expect(isProviderFault(new ModelError('http', 'balance', { fault: 'quota' }))).toBe(true);
  });

  test('省略 fault → 回落原启发式 (老调用点行为一个字不变)', () => {
    expect(isProviderFault(new ModelError('http', 'x', { status: 400 }))).toBe(false);
    expect(isProviderFault(new ModelError('http', 'x', { status: 402 }))).toBe(true);
    expect(isProviderFault(new ModelError('http', 'x', { status: 429 }))).toBe(true);
    expect(isProviderFault(new ModelError('http', 'x', { status: 500 }))).toBe(true);
    expect(isProviderFault(new ModelError('transport', 'socket hang up'))).toBe(true);
    expect(isProviderFault(new ModelError('transport', 'callModel: aborted'))).toBe(false);
    expect(isProviderFault(new ModelError('config', 'no creds'))).toBe(false);
  });
});

describe('transient: 环轴 —— 再转一轮有没有用', () => {
  test('★ 显式 transient:false 压过 kind (坏 key 虽是 provider 故障, 本跑再转也没用)', () => {
    const e = new ModelError('http', 'minimax: base_resp 1004', { fault: 'provider', transient: false });
    expect(isProviderFault(e)).toBe(true); // 冷却轴: 要冷却
    expect(isTransientModelFault(e)).toBe(false); // 环轴: 别再转
  });

  test('★ 显式 transient:true 压过 kind (kind 判不出来时抛错方说了算)', () => {
    expect(isTransientModelFault(new ModelError('config', 'x', { transient: true }))).toBe(true);
  });

  test('省略 transient → 回落 kind 规则 (老行为不变)', () => {
    expect(isTransientModelFault(new ModelError('parse', 'invalid JSON'))).toBe(true);
    expect(isTransientModelFault(new ModelError('validation', 'schema'))).toBe(true);
    expect(isTransientModelFault(new ModelError('truncation', 'cut'))).toBe(true);
    expect(isTransientModelFault(new ModelError('http', 'x', { status: 500 }))).toBe(true);
    expect(isTransientModelFault(new ModelError('http', 'x', { status: 400 }))).toBe(false);
    expect(isTransientModelFault(new ModelError('transport', 'socket'))).toBe(false);
    expect(isTransientModelFault(new ModelError('config', 'no creds'))).toBe(false);
  });
});

describe('providerCode: 业务码有自己的格子, 不再挤 status', () => {
  test('★ 业务码进 providerCode, status 留空 (status 只放真 HTTP 码)', () => {
    const e = new ModelError('http', 'minimax: base_resp 1004 鉴权失败', { fault: 'provider', providerCode: '1004' });
    expect(e.providerCode).toBe('1004');
    expect(e.status).toBeUndefined();
  });
});
