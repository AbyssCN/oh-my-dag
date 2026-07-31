/**
 * **风险分级闸** (2026-07-31, R1)。
 *
 * 分级表 (`COMMAND_RISK_TIER`) 与闸 (`commandBlockReason`) 是两套东西, 各有各的真源 ——
 * 而"两套东西说同一件事"正是本仓反复付过账的那种漂移形态 (`acceptance.ts` 头注释: 判据各写一份,
 * 早晚一份先漂, 而漂的后果是「假红」)。这里不去合并它们 (合并会让分级变成闸, 而 R1 刻意只报不拦),
 * 改成把**一致性**钉成测试。
 *
 * 三条网:
 *   ① 白名单里的每个 bin 都登记了级 —— 加 bin 不加级 → 红 (同 empty-knobs 的「明示即承诺」)
 *   ② 登记表里没有已不在白名单的 bin —— 删 bin 要同步删级
 *   ③ 登记为 `never` 的 bin 不该出现在白名单里 —— 两套判断指向相反 = 至少有一套错了
 *
 * 第四条不是一致性而是**读数**: `approval_required` 今天是空集。它写成断言不是为了锁死这个事实,
 * 是为了让"我们补上了中间那一档"这件事**必须经过一次改测试**, 而不是悄悄发生。
 */
import { describe, expect, test } from 'bun:test';
import {
  COMMAND_RISK_TIER,
  DEFAULT_COMMAND_ALLOWLIST,
  RISK_TIER_ORDER,
  commandBlockReason,
  commandRiskTier,
  type CommandRiskTier,
} from './command-leaf';

describe('风险分级 × 白名单 — 两套判断必须指向同一边', () => {
  test('① 白名单里的每个 bin 都登记了风险级', () => {
    const unrated = DEFAULT_COMMAND_ALLOWLIST.filter((bin) => !(bin in COMMAND_RISK_TIER));
    expect(unrated).toEqual([]);
    // 不是空转: 白名单本身有成规模的条目。
    expect(DEFAULT_COMMAND_ALLOWLIST.length).toBeGreaterThan(20);
  });

  test('② 登记表里没有已不在白名单的 bin', () => {
    const stale = Object.keys(COMMAND_RISK_TIER).filter((bin) => !DEFAULT_COMMAND_ALLOWLIST.includes(bin));
    expect(stale).toEqual([]);
  });

  test('③ 登记为 never 的 bin 不在白名单里 (两套判断不许指向相反)', () => {
    const contradictory = Object.entries(COMMAND_RISK_TIER)
      .filter(([, tier]) => tier === 'never')
      .map(([bin]) => bin)
      .filter((bin) => DEFAULT_COMMAND_ALLOWLIST.includes(bin));
    expect(contradictory).toEqual([]);
  });
});

describe('commandRiskTier — 取链上最重的一级, 未登记即 never', () => {
  test('纯读命令 = read_only', () => {
    expect(commandRiskTier('cat docs/a.md')).toBe('read_only');
    expect(commandRiskTier('git status')).toBe('read_only');
    // 路径形式的 bin 取 basename (与白名单匹配同一条规则)。
    expect(commandRiskTier('/usr/bin/grep -n foo src/')).toBe('read_only');
  });

  test('跑项目代码 = scoped_write —— 「跑测试」不因为听起来无害就降级', () => {
    expect(commandRiskTier('bun test')).toBe('scoped_write');
    expect(commandRiskTier('tsc --noEmit')).toBe('scoped_write');
    // omd 能起整张图, 它的风险是图的风险。
    expect(commandRiskTier('omd dag-run --goal x')).toBe('scoped_write');
  });

  test('&& 链取最重的一级, 而不是第一环', () => {
    expect(commandRiskTier('cat a.md && bun test')).toBe('scoped_write');
    expect(commandRiskTier('bun test && cat a.md')).toBe('scoped_write');
    expect(commandRiskTier('cat a.md && wc -l a.md')).toBe('read_only');
  });

  test('未登记的 bin = never (fail-closed, 与白名单闸同向)', () => {
    expect(commandRiskTier('curl https://example.com')).toBe('never');
    expect(commandRiskTier('rm -rf /')).toBe('never');
    expect(commandRiskTier('')).toBe('never');
    // 一条链里只要有一环未登记, 整条就是 never。
    expect(commandRiskTier('cat a.md && curl https://x')).toBe('never');
  });

  test('分级不调闸 —— 被闸拒的命令仍能被分级 (读数不该刷告警)', () => {
    // `git commit` 过不了闸 (非只读子命令), 但 bin 'git' 是登记过的 → 分级仍给 read_only。
    // 这不是矛盾: 分级看的是 bin 的能力档, 放行与否是闸的事, 而闸确实拒了它。
    expect(commandBlockReason('git commit -m x', DEFAULT_COMMAND_ALLOWLIST)).not.toBeNull();
    expect(commandRiskTier('git commit -m x')).toBe('read_only');
  });
});

describe('登记表的读数 (改了要经过改测试, 不许悄悄发生)', () => {
  test('approval_required 今天是空集 —— omd 只有「随便做」和「一律不许」两档', () => {
    const approval = Object.entries(COMMAND_RISK_TIER).filter(([, t]) => t === 'approval_required');
    expect(approval).toEqual([]);
  });

  test('scoped_write 就是那组「等价于任意代码执行」的 bin', () => {
    const scoped = Object.entries(COMMAND_RISK_TIER)
      .filter(([, t]) => t === 'scoped_write')
      .map(([bin]) => bin)
      .sort();
    expect(scoped).toEqual(['bun', 'node', 'npx', 'oh-my-dag', 'omd', 'tsc']);
  });

  test('级序是全序且由轻到重 (读数板按它排序)', () => {
    const tiers: CommandRiskTier[] = ['read_only', 'scoped_write', 'approval_required', 'never'];
    const orders = tiers.map((t) => RISK_TIER_ORDER[t]);
    expect(orders).toEqual([0, 1, 2, 3]);
  });
});
