/**
 * gh 后端读裁决的**整段闸** —— 写进去是全的, 读回来只剩第一行。
 *
 * ## 实测(2026-08-12,切 gh 后端当天)
 *
 * `parseRuling` 的正则是 `/^\*\*ruling\*\*:\s*(.*)$/m`。JS 里 `.` **不匹配换行**、
 * `$` 在 `/m` 下是**行尾** —— 于是 `(.*)` 只捕获判词的第一行, 其余整段静默丢弃。
 *
 * 真样本 (issue #103 `proto-node-level-rerun`): 评论全长 1850,
 * 现行正则捕获 **93**,改 `[\s\S]` 后 **1838** —— **读回来丢 94.9%**。
 * 全图 33 张有判词的票里 7 张是多段, 合计约 13k 字符读不回来。
 *
 * ## 为什么它比"显示不全"严重得多
 *
 * `map_rule` 的工具说明写着判词 **becomes the slice node goal for task tickets** ——
 * `path_deliver` 编出来的执行目标就是它。首行通常是「修」「封存」「建闸」这种结论句,
 * 而**判据、边界、反向自检、不许动的前置条件全在后面几段**。执行体拿到的是一句结论,
 * 拿不到任何约束。本仓当天新写的 `task-watchdog-s3-gate` 就是这形状:
 * 「拿不到 S2 写回的两个数字不许动手」在第二段 —— 读回来直接不存在。
 *
 * 两侧都不报错: 写入面完整 (gh 评论里躺着全文)、`tsc` 无话可说、既有测试钉的是
 * 「评论字节形状」(`**ruling**: ` 前缀 + close), 不钉**读回来还剩多少**。
 *
 * ## 反向自检
 *
 * 把 `parseRuling` 的 `([\s\S]*)` 改回 `(.*)` → ★① ★② 当场红。
 * ★③(单行判词原样)与 ★④(没有判词评论 → undefined)**都不会**变 ——
 * 它俩钉的是不该动的两侧, 修不修都绿; 没有它们, 上面两条可以靠「整条评论原样返回」
 * (连 `**ruling**: ` 前缀一起) 蒙混过关。
 */
import { describe, expect, test } from 'bun:test';
import { parseRuling } from './backend-gh';

/** #103 的真实形状: 结论首行 + 空行 + 多个 `##` 段。 */
const MULTI = `**ruling**: **这是 \`grill-exec-fork-verdict\` 的解冻闸** —— 它出读数之前, exec-fork 不解冻。

## 四要素(动手前写死, 缺一不算实验)

**假设**: 「同起点比不同走法」有可测收益。

## 出口三选一

1. 节点级就够 → 永久归档`;

describe('gh 后端: 判词读回来必须是整段', () => {
  test('★ 多段判词整段读回 (今天红: 只回第一行)', () => {
    const got = parseRuling([{ body: MULTI }])!;
    expect(got).toContain('## 四要素'); // 第二段
    expect(got).toContain('## 出口三选一'); // 末段
    // 判据不用魔法数字, 用**旧行为的产物**当基线: 只取首行会得到什么, 现在必须严格多于它。
    const firstLineOnly = MULTI.slice('**ruling**: '.length).split('\n')[0]!;
    expect(got.length).toBeGreaterThan(firstLineOnly.length);
  });

  test('★ 一个字都不许少: 捕获长度 === 全文减去 `**ruling**: ` 前缀', () => {
    const got = parseRuling([{ body: MULTI }])!;
    expect(got).toBe(MULTI.slice('**ruling**: '.length));
  });

  test('对照 (修不修都绿): 单行判词原样返回, 且不带前缀', () => {
    const got = parseRuling([{ body: '**ruling**: 修。这是尺子坏了。' }]);
    expect(got).toBe('修。这是尺子坏了。');
  });

  test('对照 (修不修都绿): 没有判词评论 → undefined, 不是空串', () => {
    expect(parseRuling([{ body: '普通评论, 不是判词' }])).toBeUndefined();
    expect(parseRuling([])).toBeUndefined();
  });

  test('#137 重裁取**最后一条** —— 与 ruledAt 指同一条评论, 两半不再各说各话', () => {
    // rule() 每次新发一条评论 (gh 改不了旧评论), comments 时间正序 → 最后一条 = 现行判词。
    // 旧语义取第一条, 而 ruledAt 取最后一条的 createdAt: 重裁后文本旧、时间戳新, 双侧无警。
    // 证伪: parseRuling 换回正向遍历 (第一条命中) 即此条红。
    const got = parseRuling([{ body: '**ruling**: 第一条 (已被重裁覆盖)' }, { body: '**ruling**: 第二条 (现行)' }]);
    expect(got).toBe('第二条 (现行)');
  });

  test('对照 (修不修都绿): 判词评论只有一条时, 前后遍历同答案', () => {
    const got = parseRuling([{ body: '闲聊' }, { body: '**ruling**: 唯一判词' }, { body: '后续普通评论' }]);
    expect(got).toBe('唯一判词');
  });
});
