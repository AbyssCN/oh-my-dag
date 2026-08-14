/**
 * 验收 delta 分辨率闸(图鉴 S-37)。
 *
 * **这份测试存在的理由,是一条今天真发生过的事**:夜跑 run `c02ac67d` 的引擎印了
 * 「D-1 delta: 未新增失败」,而那次它说对是**碰巧** —— 基线本来就红,四笔真引入一条
 * 回归它会印一模一样的话。第一条用例钉的就是这个形状。
 *
 * 证伪方式(每次改这块先跑一遍;**下面三行是实跑读数,不是预期**):
 * - 删掉 `buildAcceptDelta` 里逐条测试那段(退回只有 `accept` 一格)→ **4 条红**。
 * - 名字集从并集改成只铺 after 侧 → **★③ 单独红**。
 *   ⚠ 初稿我预测的是"★① 会变绿(落进 `newly-row`)",**实测它仍绿** —— 因为两侧的 step
 *   由同一份名字表生成,`B` 在 before 侧照样拿得到 `pass`。丢的是 `A` 那条 `fixed` 记录
 *   (它只在 before 侧出现过)。**判据留在这里的理由变了:它守的是"消失的老失败也要记账",
 *   不是我原以为的 `newly-run` 陷阱。**
 * - `stableFailSet` 的交集改成并集 → **★④ 与端到端那条红**(2 条)。
 */
import { describe, expect, test } from 'bun:test';
import { acceptSideOf, buildAcceptDelta, stableFailSet, unstableFailSet } from './accept-delta';

/** 一段像 `bun test` 的输出(只有 `(fail)` 行是判据面)。 */
const out = (...names: string[]): string =>
  [...names.map((n) => `(fail) ${n} [12.34ms]`), ' 4982 pass', ' 1 fail'].join('\n');

describe('★ 基线本来就红时, 新引入的失败还看得见吗(S-37 的要害)', () => {
  /**
   * ★① **这条是整条闸的存在理由**。
   * 老口径(只有 `accept` 一格)在这个输入上判 `unchanged-failure` → 不红 → 印「未新增失败」,
   * 而 after 侧多出来的 `B` 是真回归。
   */
  test('★ 基线红(A) → after 红(A + B): B 是 new-failure, 判红', () => {
    const d = buildAcceptDelta(acceptSideOf('fail', out('A')), acceptSideOf('fail', out('A', 'B')));
    expect(d.red).toBe(true);
    expect(d.newFailures).toEqual(['test:B']);
    // A 仍然是老失败, 不许跟着红 —— 否则存量语料首跑全红(INV-4)。
    expect(d.steps).toContainEqual({ id: 'test:A', kind: 'unchanged-failure', before: 'fail', after: 'fail' });
    // 整条命令那一格照旧 fail→fail, 它自己不是红的来源。
    expect(d.steps).toContainEqual({ id: 'accept', kind: 'unchanged-failure', before: 'fail', after: 'fail' });
  });

  test('★ 基线红(A) → after 仍只有 A: 不红(老失败单列, 这是老口径唯一说对的那一格)', () => {
    const d = buildAcceptDelta(acceptSideOf('fail', out('A')), acceptSideOf('fail', out('A')));
    expect(d.red).toBe(false);
    expect(d.newFailures).toEqual([]);
  });

  /**
   * ★③ 两侧红的**名字不一样** —— 今天实测的形状(A 臂 `F2` / B 臂 `F3`)。
   * 老口径判 `unchanged-failure` 不红;新口径必须把 B 报出来。
   * ⚠ 这一条同时是**假阳性的来源**,所以才要 `stableFailSet` 那一半(见下一段)。
   */
  test('★ 基线红(A) → after 红(B): 名字换了也要报, 且 A 记 fixed 不记红', () => {
    const d = buildAcceptDelta(acceptSideOf('fail', out('A')), acceptSideOf('fail', out('B')));
    expect(d.red).toBe(true);
    expect(d.newFailures).toEqual(['test:B']);
    expect(d.steps).toContainEqual({ id: 'test:A', kind: 'fixed', before: 'fail', after: 'pass' });
  });

  test('基线绿 → after 红(B): 整条命令与那条测试都判 new-failure', () => {
    const d = buildAcceptDelta(acceptSideOf('pass', out()), acceptSideOf('fail', out('B')));
    expect(d.red).toBe(true);
    expect(d.newFailures.sort()).toEqual(['accept', 'test:B']);
  });
});

describe('★ 老报告的形状逐字不变(没有 (fail) 行时, 与 D-1 落地那天完全一样)', () => {
  test('基线绿 → after 红(无测试名): 只有 accept 一格', () => {
    const d = buildAcceptDelta(acceptSideOf('pass', ''), acceptSideOf('fail', ''));
    expect(d.steps).toEqual([{ id: 'accept', kind: 'new-failure', before: 'pass', after: 'fail' }]);
  });

  test('基线绿 → after 缺席: 仍是 fail-closed 的 new-failure, 不铺逐条步', () => {
    const d = buildAcceptDelta(acceptSideOf('pass', out('A')), acceptSideOf(undefined, ''));
    expect(d.steps).toEqual([{ id: 'accept', kind: 'new-failure', before: 'pass' }]);
    expect(d.newFailures).toEqual(['accept']);
  });

  test('两侧都绿: 零 delta', () => {
    const d = buildAcceptDelta(acceptSideOf('pass', ''), acceptSideOf('pass', ''));
    expect(d.red).toBe(false);
    expect(d.steps).toEqual([]);
  });
});

describe('★ 一次红不算红 —— 复现过滤(否则闸会被抖动推到另一个极端)', () => {
  test('★④ 交集: 只有两次都在的才留下', () => {
    expect(stableFailSet(['A', 'B'], ['B', 'C'])).toEqual(['B']);
  });

  test('★ 没复现的那些要留证据(不写 = 偷偷放行)', () => {
    expect(unstableFailSet(['A', 'B'], ['B', 'C'])).toEqual(['A']);
  });

  /**
   * 端到端:第一次 after 读到 `A`(老) + `B`(抖),复跑只剩 `A` ⇒ 过滤后不红。
   * ⚠ 这条与 ★③ 是**同一个输入**的两种处理 —— 差别只在有没有第二次读数。
   * 少了它,今天量到的「每跑随机红一条」会让这条闸每跑必假红。
   */
  test('★ 过滤之后, 抖动那条不再判红; 而真回归(两次都在)照样红', () => {
    const before = acceptSideOf('fail', out('A'));
    const first = extract(out('A', 'B'));
    const flaky = buildAcceptDelta(before, { status: 'fail', failSet: stableFailSet(first, extract(out('A'))) });
    expect(flaky.red).toBe(false);
    const real = buildAcceptDelta(before, { status: 'fail', failSet: stableFailSet(first, extract(out('A', 'B'))) });
    expect(real.red).toBe(true);
    expect(real.newFailures).toEqual(['test:B']);
  });
});

/** 测试内复用 `acceptSideOf` 的抽取半边(判据与实装共用同一实现, 两处各写一遍必漂)。 */
function extract(output: string): string[] {
  return acceptSideOf('fail', output).failSet;
}
