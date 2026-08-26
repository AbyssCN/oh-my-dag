/**
 * `frozen-tests` —— 本次写集有没有动到**既有**测试(2026-08-26, RED)。
 *
 * ## 它防的是什么
 *
 * 到绿的禁行路线里最难机械发现的一条:**放松断言**。测试与实装由同一个执行体在同一轮产出时,
 * 「改实装让测试过」和「改测试让它别红」在结果上完全同形 —— 都是全绿。
 *
 * 本仓此前对这条只有散文(`INV-10` 的 THE MARKING SCHEME IS FROZEN)和契约里的手工步骤
 * (`git diff --stat -- <TEST paths>` 要求输出为空)。散文拦不住,手工步骤靠人记得,
 * 而且那条命令本身还是空转源(在循环里跑必然非空)。
 *
 * ## 判据
 *
 * 写集里的 `.test.ts`,凡在 base 上**已存在**的,报出来。新建的不报 —— 新建测试正是该做的事。
 *
 * 报的是 finding 不是判决:合法更新既有测试确实存在(判据本身错了要改、锚过期要重钉),
 * 所以它挂 `advisory`,记录 + 交人看,不杀节点。判据是启发式的,按本仓的层级规则就不该 fail-closed。
 *
 * ## 反向自检(实跑)
 *
 * 把 `existsInBase` 改成恒 false ⇒ 第一条红(既有测试不再被报);
 * 把「只挑 .test.ts」去掉 ⇒ 第三条红(实装文件被误报成测试)。
 */
import { describe, expect, it } from 'bun:test';
import { pickFrozenTestEdits } from './frozen-tests';

describe('frozen-tests:动了既有测试要留痕', () => {
  const base = new Set(['src/a.test.ts', 'src/keep.ts']);
  const inBase = (f: string): boolean => base.has(f);

  it('★ 写集含 base 上已存在的测试 → 报', () => {
    const r = pickFrozenTestEdits(['src/a.test.ts', 'src/keep.ts'], inBase);
    expect(r).toEqual(['src/a.test.ts']);
  });

  it('★ 新建测试不报(新建测试正是该做的事)', () => {
    expect(pickFrozenTestEdits(['src/brand-new.test.ts'], inBase)).toEqual([]);
  });

  it('★ 非测试文件不报(改实装是本分)', () => {
    expect(pickFrozenTestEdits(['src/keep.ts'], inBase)).toEqual([]);
  });

  it('★ 空写集 → 空(判定不适用, 不是通过)', () => {
    expect(pickFrozenTestEdits([], inBase)).toEqual([]);
  });
});
