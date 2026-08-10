/**
 * L1 判据:`/tree` 的会话树视图(台账 §1.3 / C11)。
 *
 * ## 为什么这几条值得有闸
 *
 * 树画错是**看得见但测不到**的那一类:分叉点标错、当前分支标反、旁支被悄悄丢掉 ——
 * 三种都渲染得出一棵"看起来没问题"的树。本仓刚吃过同形状的账(状态映射标签是反的,
 * 而 `tsc` 干净 + 测试全绿)。所以位置信息全在 `buildTreeRows` 里算,在这里逐条钉。
 *
 * 逐条证伪方式写在各条里,都实跑过。
 */
import { describe, expect, test } from 'bun:test';
import type { TuiTreeEntry } from './backend';
import { buildTreeRows, formatTree, parseTreeCommand, treeLabel } from './tree-picker';

const e = (id: string, parentId: string | null, seq: number, kind = 'message/user', preview = id): TuiTreeEntry => ({
  id,
  parentId,
  seq,
  kind,
  preview,
});

/**
 * 一棵分叉过的树(正是 pi 式分支之后文件里的样子):
 *   a → b → c → d   (旧分支, 被放弃)
 *        └→ s → e   (新分支, `s` 是那条 branch_summary)
 */
const FORKED: TuiTreeEntry[] = [
  e('a', null, 1),
  e('b', 'a', 2, 'message/assistant'),
  e('c', 'b', 3),
  e('d', 'c', 4, 'message/assistant'),
  e('s', 'b', 5, 'branch_summary', '[branch summary] 试了一条别的路子'),
  e('e', 's', 6),
];

describe('★ buildTreeRows —— 位置信息全在这里算完', () => {
  test('★ 分叉点是**孩子多于一个**的那条, 不是别的', () => {
    // 反向自检(实跑): 把判据写成 `kids.length > 0` → b 之外的 a/c/s 也被标成分叉点, 当场红。
    const rows = buildTreeRows(FORKED, 'e');
    expect(rows.filter((r) => r.branchPoint).map((r) => r.id)).toEqual(['b']);
  });

  test('★ 当前分支 = 当前叶回溯到根那条路径, 旁支不许算进去', () => {
    // 反向自检(实跑): 把 onBranch 写成"全都算" → 这条红; 写成"只有叶自己" → 也红。
    const rows = buildTreeRows(FORKED, 'e');
    expect(rows.filter((r) => r.onBranch).map((r) => r.id).sort()).toEqual(['a', 'b', 'e', 's']);
    expect(rows.find((r) => r.current)?.id).toBe('e');
  });

  test('★ 旁支(被放弃那条)照画 —— 看不见就选不回去, 那条分支等于丢了', () => {
    const rows = buildTreeRows(FORKED, 'e');
    expect(rows.map((r) => r.id).sort()).toEqual(['a', 'b', 'c', 'd', 'e', 's']);
    expect(rows.filter((r) => !r.onBranch).map((r) => r.id)).toEqual(['c', 'd']);
  });

  test('先序 + 同层按 seq —— 父恒在孩子之前', () => {
    const rows = buildTreeRows(FORKED, 'e');
    expect(rows.map((r) => r.id)).toEqual(['a', 'b', 'c', 'd', 's', 'e']);
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 2, 3, 2, 3]);
  });

  test('★ 空会话:`leafId` 为 null 时**没有任何一行属于当前分支**(不是"全都属于")', () => {
    expect(buildTreeRows([], null)).toEqual([]);
    const rows = buildTreeRows(FORKED, null);
    expect(rows.filter((r) => r.onBranch)).toEqual([]);
    expect(rows.filter((r) => r.current)).toEqual([]);
  });

  test('★ 孤儿条目当根画, 不静默丢 —— 丢了树看起来完整无缺, 而取材漏了东西', () => {
    // 反向自检: 把"父不在集合里就挂 null"改成 continue → 这条红(x 消失)。
    const rows = buildTreeRows([e('x', 'ghost', 1), e('y', 'x', 2)], 'y');
    expect(rows.map((r) => [r.id, r.depth])).toEqual([['x', 0], ['y', 1]]);
  });

  /**
   * 环只可能来自被手改坏的 jsonl(pi 的 append 恒把 `parentId` 指向更早的条目)。
   * 不为它写"修复"逻辑(本仓纪律:不给不可能发生的场景写错误处理),但**必须返回** ——
   * 祖先回溯那一步是个 `while`,没有那句 `if (onBranch.has(cursor)) break` 就是死循环,
   * 而它跑在 UI 那条线上 ⇒ 症状是整个 TUI 冻住。
   *
   * 反向自检(实跑):去掉那句 break → 这条**永不返回**,测试超时(不是断言红)。
   * ⚠ 读数如实记:环里的条目在这里是**画不出来的**(互为孤儿 ⇒ 没有根)。
   * 那是"取材坏了"的显形,不是这一层要修的东西 —— 断言写成真读数,不写成期望。
   */
  test('数据坏成一个环:不挂死(会返回), 而环里的条目画不出来', () => {
    expect(buildTreeRows([e('p', 'q', 1), e('q', 'p', 2)], 'p')).toEqual([]);
  });
});

describe('渲染', () => {
  test('四种标记各画各的:* 当前叶 · + 分叉点 · | 在当前分支 · 空格 旁支', () => {
    const rows = buildTreeRows(FORKED, 'e');
    const mark = (id: string) => treeLabel(rows.find((r) => r.id === id) as never).charAt(0);
    expect([mark('e'), mark('b'), mark('a'), mark('c')]).toEqual(['*', '+', '|', ' ']);
  });

  test('★ 裁过的树必须说出裁了多少 —— 不说的话它读起来就是一棵完整的树', () => {
    // 反向自检(实跑): 把 head 恒写成 `Session tree (N entries)` → 这条红。
    const many = Array.from({ length: 50 }, (_, i) => e(`n${i}`, i === 0 ? null : `n${i - 1}`, i + 1));
    const out = formatTree(buildTreeRows(many, 'n49'), 40);
    expect(out).toContain('last 40 of 50 entries');
    expect(out).toContain('picker, which has search'); // 省掉的仍然选得到, 这句不许省
    expect(out.split('\n').filter((l) => l.startsWith('  '))).toHaveLength(41); // 40 行 + 图例
  });

  test('没裁就不说裁 —— 短树原样画', () => {
    const out = formatTree(buildTreeRows(FORKED, 'e'));
    expect(out).toContain('Session tree (6 entries):');
    expect(out).not.toContain('last');
  });

  test('空会话说真话, 不画一棵空树', () => {
    expect(formatTree([])).toContain('no entries yet');
  });
});

describe('parseTreeCommand', () => {
  test('只认 `/tree` 本身', () => {
    expect(parseTreeCommand('  /tree ')).toBe(true);
    // `/treex` 回落成普通文本 —— 与 `/sessionx` 同纪律。
    for (const t of ['/treex', 'tree', '/tree 3', '/t']) expect(parseTreeCommand(t)).toBe(false);
  });
});
