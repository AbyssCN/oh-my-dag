/**
 * rubric 形状与逐条判定 —— F2 片 1。
 *
 * 契约源:`docs/plan/2026-08-27-F2-rubric验收分型-执行契约.md` §INV-1 · §INV-2 · §INV-3。
 *
 * ## 这一片钉住的三件事
 *
 * 1. **逐条痕迹不许被压成总分**(INV-2)。压掉的那一列事后再也分不回来(仓规坑 ①):
 *    「3 条里挂了哪一条」正是重规划要用的定位信息,压成 `2/3` 之后它就没了。
 * 2. **checklist 先于产物冻结,验收期改一个字即拒**(INV-3)。rubric 是无 oracle 线的东西,
 *    它唯一的可信来源就是「写它的时候还不知道产物长什么样」;允许改一个字就退化成事后合理化。
 *    所以拒是**当场拒且不判**,不是记一条警告然后照判。
 * 3. **「几条不过算不过」是注入值不是常数**。SDD 未决第 1 条仍开,代码里不许出现 owner 数值。
 *
 * ## 反向自检(每条真跑过一次)
 * · 把整体裁决改成只返回一个通过条数 → 「逐条痕迹恰 3 条且逐条带理由」当场红。
 * · 把哈希比对改成只记警告然后照判 → 「漂了就不判」当场红。
 * · 把 `maxFailures` 写成常量 0 → 「注入 1 时允许 1 条不过」当场红。
 */
import { describe, expect, test } from 'bun:test';
import {
  freezeRubric,
  verifyFrozen,
  settleRubric,
  type RubricItem,
  type RubricItemTrace,
} from './rubric-spec';

const items: RubricItem[] = [
  { id: 'r1', requirement: '报告里点名了数据来源' },
  { id: 'r2', requirement: '每条结论都带一条可复跑的命令' },
  { id: 'r3', requirement: '没有把推断写成事实' },
];

const trace = (id: string, pass: boolean, reason: string): RubricItemTrace => ({ itemId: id, pass, reason });

describe('rubric 形状:条目与冻结', () => {
  test('★ 冻结产出的 spec 逐字带回全部条目,且哈希对同一份条目稳定', () => {
    const a = freezeRubric(items);
    const b = freezeRubric(items);
    expect(a.items).toHaveLength(3);
    expect(a.contentHash).toBe(b.contentHash);
    expect(a.contentHash.length).toBeGreaterThan(0);
  });

  test('★ 条目改一个字符 → 哈希必变 (否则冻结是虚的)', () => {
    const changed = items.map((i) => (i.id === 'r2' ? { ...i, requirement: `${i.requirement}。` } : i));
    expect(freezeRubric(changed).contentHash).not.toBe(freezeRubric(items).contentHash);
  });

  test('★ 条目 id 重复 / 空条目数组 → 当场拒 (冻不出一份判不了的 rubric)', () => {
    expect(() => freezeRubric([{ id: 'x', requirement: 'a' }, { id: 'x', requirement: 'b' }])).toThrow(/重复/);
    expect(() => freezeRubric([])).toThrow(/至少/);
  });
});

describe('rubric 冻结校验 (INV-3):验收期改一个字即拒,且不判', () => {
  test('★ 逐字节相同 → 通过', () => {
    expect(verifyFrozen(freezeRubric(items), items).ok).toBe(true);
  });

  test('★ 改一个字符 → 拒,且返回具名理由;调用方据此**不得**进入逐条判定', () => {
    const spec = freezeRubric(items);
    const tampered = items.map((i) => (i.id === 'r3' ? { ...i, requirement: '没有把推断写成事实(大概)' } : i));
    const r = verifyFrozen(spec, tampered);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('content-drifted');
      // 改成「记一条警告然后照判」时, 这里会变成 ok:true → 当场红。
      expect(r.detail).toContain('r3');
    }
  });

  test('★ 条目数变了也算漂 (加一条 / 删一条都不许)', () => {
    const spec = freezeRubric(items);
    expect(verifyFrozen(spec, items.slice(0, 2)).ok).toBe(false);
    expect(verifyFrozen(spec, [...items, { id: 'r4', requirement: '新加的' }]).ok).toBe(false);
  });
});

describe('rubric 整体裁决 (INV-2):RUBRIC_ITEM_TRACE_FROZEN —— 逐条痕迹不许被压成总分', () => {
  test('★ 3 条里 2 yes 1 no → 逐条痕迹恰 3 条、逐条带理由、整体不过、点名挂的那条', () => {
    const traces = [
      trace('r1', true, '第 3 段列了三个来源'),
      trace('r2', true, '每条都有 bun test 命令'),
      trace('r3', false, '第 5 段把推断当成了结论'),
    ];
    const v = settleRubric(traces, { maxFailures: 0 });
    expect(v.pass).toBe(false);
    // 压成一个总分即判红 —— 逐条那一列是重规划要用的定位信息。
    expect(v.traces).toHaveLength(3);
    for (const t of v.traces) expect(t.reason.length).toBeGreaterThan(0);
    expect(v.failedIds).toEqual(['r3']);
  });

  test('★ 全 yes → 通过, failedIds 为空', () => {
    const v = settleRubric(items.map((i) => trace(i.id, true, 'ok')), { maxFailures: 0 });
    expect(v.pass).toBe(true);
    expect(v.failedIds).toHaveLength(0);
    expect(v.traces).toHaveLength(3);
  });

  test('★ maxFailures 是注入值:同一组痕迹注入 1 就通过, 注入 0 就不通过', () => {
    const traces = [trace('r1', true, 'ok'), trace('r2', false, '缺命令'), trace('r3', true, 'ok')];
    expect(settleRubric(traces, { maxFailures: 1 }).pass).toBe(true);
    expect(settleRubric(traces, { maxFailures: 0 }).pass).toBe(false);
    // 把 maxFailures 写死成常量 0 时, 上面第一条当场红。
  });

  test('★ 痕迹里出现空理由 → 当场拒 (没理由的 yes/no 不是判词, 是投票)', () => {
    expect(() => settleRubric([trace('r1', true, '')], { maxFailures: 0 })).toThrow(/理由/);
  });

  test('★ 零痕迹 → 当场拒, 不许静默判成通过 (仓规坑 ①: 没判 ≠ 判过了)', () => {
    expect(() => settleRubric([], { maxFailures: 0 })).toThrow(/至少/);
  });

  test('★ maxFailures 为负 → 当场拒 (注入值也要校验, 别把非法配置读成严格)', () => {
    expect(() => settleRubric([trace('r1', true, 'ok')], { maxFailures: -1 })).toThrow(/非负/);
  });
});
