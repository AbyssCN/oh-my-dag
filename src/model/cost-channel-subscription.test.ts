/**
 * 订阅通道**不止 claude-code** —— 套餐 key 的三态归属闸。
 *
 * ## 为什么要这条
 *
 * 账本三态是「计价(数字) / unpriced(价表缺, 0+旗) / subscription(不是美元计价的资源)」。
 * `channelOf` 此前硬编码 `coord.startsWith('claude-code:')`, 于是任何**别家的套餐 key**
 * 都掉进 `unpriced` ——「这资源不按美元算」与「我们忘了填价」印出来一模一样(都是 0),
 * 而这两件事的处置完全相反: 前者不用管, 后者要去补价表。
 *
 * 2026-08-12 装 `minimax-cn:MiniMax-M3`(套餐 key)当多模态池时撞上: 它落 `unpriced`,
 * 而多模态那部分成本从此与「忘了填价」不可分 —— 正是当天刚修完的低报那一族。
 *
 * ## 判据的形状: 结构性的那半写死, 属于账户的那半配出来
 *
 * - `claude-code:*` **恒** subscription: 该通道压根没有 API key(Agent SDK 自理凭证),
 *   这是**结构事实**, 不该被配置改掉 —— 配空了它也得是订阅。
 * - 其余由配置说了算: 哪个 provider 上跑的是套餐, 是**你账户的事实**, 不是源码的事实。
 *   (同 `pools` 那条的教训: 池是选择不是事实表, 改一个选择不该要改代码+提交。)
 *   解析序照 `resolveConfiguredPools`: env `OMD_SUBSCRIPTION_PROVIDERS` 压过 config。
 *
 * ## 反向自检
 *
 * 把 `channelOf` 里查配置那一段删掉(回到只认 `claude-code:` 前缀)→ ★① ★② 红。
 * ★③「没配的 provider 仍是 api」与 ★④「claude-code 不受配置影响」**都不会**变 ——
 * 它俩钉的是不该动的那两侧, 修不修都该绿; 没有它们, 上面两条可以靠「恒返 subscription」作弊。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { channelOf, computeCost } from './cost-ledger';
import { resolveSubscriptionProviders } from './role-models';

const ENV_KEY = 'OMD_SUBSCRIPTION_PROVIDERS';
const saved = process.env[ENV_KEY];
afterEach(() => {
  if (saved === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = saved;
});

/** 写一个只含 subscriptionProviders 的临时 config.json。 */
function configWith(providers: string[]): string {
  const d = mkdtempSync(join(tmpdir(), 'omd-subcfg-'));
  const p = join(d, 'config.json');
  writeFileSync(p, JSON.stringify({ version: 2, subscriptionProviders: providers }));
  return p;
}

describe('订阅通道: 结构性的写死, 属于账户的配出来', () => {
  test('★ 配了的 provider → subscription (今天红: 只认 claude-code 前缀)', () => {
    process.env[ENV_KEY] = 'minimax-cn';
    expect(channelOf('minimax-cn:MiniMax-M3')).toBe('subscription');
  });

  test('★ 三态落对格: costUsd=null + channel 列, 而不是 unpriced 的 0+旗', () => {
    process.env[ENV_KEY] = 'minimax-cn';
    const b = computeCost({ in: 266, out: 4, cacheHit: 128 }, 'minimax-cn:MiniMax-M3');
    expect(b.costUsd).toBeNull();
    expect(b.channel).toBe('subscription');
    expect(b.unpriced).toBe(false); // 「不是美元计价」≠「缺价」
  });

  test('对照 (修不修都绿): 没配的 provider 仍走 api, 不许一竿子全订阅', () => {
    process.env[ENV_KEY] = 'minimax-cn';
    expect(channelOf('deepseek:deepseek-v4-flash')).toBe('api');
    expect(computeCost({ in: 100, out: 10 }, 'deepseek:deepseek-v4-flash').costUsd).toBeGreaterThan(0);
  });

  test('对照 (修不修都绿): claude-code 是结构事实, 配置空了照样 subscription', () => {
    process.env[ENV_KEY] = '';
    expect(channelOf('claude-code:claude-opus-5')).toBe('subscription');
  });

  test('★ 解析序: env 压过 config (同 resolveConfiguredPools 的口径)', () => {
    const path = configWith(['from-config']);
    expect(resolveSubscriptionProviders(path, {})).toEqual(['from-config']);
    expect(resolveSubscriptionProviders(path, { [ENV_KEY]: 'from-env, another' })).toEqual(['from-env', 'another']);
    // 缺省两处都没有 → 空表 (不是 undefined, 也不许塞个出厂值进去)
    expect(resolveSubscriptionProviders(join(tmpdir(), 'nope-does-not-exist.json'), {})).toEqual([]);
  });
});
