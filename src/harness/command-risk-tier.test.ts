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
  });

  test('omd 自己不是 leaf 的工具 —— 摘出白名单后既拒且 never (2026-07-31 the owner 裁)', () => {
    // 递归起图这条路必须从命令闸上封死: 借道 command leaf 起的子图没有深度上限、没有预算、
    // 留痕也挂不到父 trace 上。要嵌套走引擎接口。
    expect(commandBlockReason('omd dag-run --goal x', DEFAULT_COMMAND_ALLOWLIST)).not.toBeNull();
    expect(commandBlockReason('oh-my-dag dag-run --goal x', DEFAULT_COMMAND_ALLOWLIST)).not.toBeNull();
    expect(commandRiskTier('omd dag-run --goal x')).toBe('never');
  });

  test('`bun [--cwd D] x` 死形态拒得可教, bunx 放行 (2026-08-09, S2 图 oracle-tsc 实测)', () => {
    // 实测: `bun --cwd <dir> x tsc` 下 bun 把 x 当 script 名报 `Script not found "x"` ——
    // tsc 根本没跑, 节点红长得像类型错, verifier 还误判「违反冻结 oracle」。
    // 反向自检 (2026-08-09 当场证伪): 注释掉 command-leaf.ts ②.4 分支 → 下面两条 not.toBeNull
    // 断言当场红 (命令被放行, bun 在执行期才报 Script not found —— 闸没接住死形态)。
    const r1 = commandBlockReason('bun x tsc --noEmit', DEFAULT_COMMAND_ALLOWLIST);
    expect(r1).not.toBeNull();
    expect(r1!).toContain('bunx'); // 判词必须教改写, 让修复轮能自纠
    const r2 = commandBlockReason('bun --cwd /tmp/wt x tsc --noEmit', DEFAULT_COMMAND_ALLOWLIST);
    expect(r2).not.toBeNull();
    expect(r2!).toContain('bunx');
    // 正道放行: bunx 直写 + bun 自己的合法形态不受影响。
    expect(commandBlockReason('bunx tsc --noEmit -p /tmp/wt', DEFAULT_COMMAND_ALLOWLIST)).toBeNull();
    expect(commandBlockReason('bun --cwd /tmp/wt test', DEFAULT_COMMAND_ALLOWLIST)).toBeNull();
    expect(commandRiskTier('bunx tsc --noEmit')).toBe('scoped_write');
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

  test('merge-base 放行 (纯只读祖先查询), merge 仍拒 —— 子命令精确匹配不是前缀', () => {
    // 反向自检 (历史红): merge-base 缺席白名单时, S5 图 N0a ancestry 硬闸被
    // `[blocked git-write: 'merge-base' ∉ 只读子命令 …]` 拦下, 白烧一轮 LLM 修复轮
    // (NOTES 2026-08-10 样本 G, run 96fc81e2)。把本行从 GIT_READONLY_SUBCOMMANDS
    // 删掉即复现该红。
    expect(commandBlockReason('git merge-base --is-ancestor 070fd67 HEAD', DEFAULT_COMMAND_ALLOWLIST)).toBeNull();
    // 对照臂: 'merge' 是写操作, 必须仍拒 —— 若闸做了前缀匹配, 本断言红。
    expect(commandBlockReason('git merge --no-edit feature', DEFAULT_COMMAND_ALLOWLIST)).not.toBeNull();
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
    expect(scoped).toEqual(['bun', 'bunx', 'node', 'npx', 'tsc']);
  });

  test('级序是全序且由轻到重 (读数板按它排序)', () => {
    const tiers: CommandRiskTier[] = ['read_only', 'scoped_write', 'approval_required', 'never'];
    const orders = tiers.map((t) => RISK_TIER_ORDER[t]);
    expect(orders).toEqual([0, 1, 2, 3]);
  });
});
