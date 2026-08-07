/**
 * fan-in 产物锚保留率的闸 —— **每一条都带反向自检**。
 *
 * 一把"量丢失"的尺子最容易悄悄变成永远读 0 的:正则收得太紧 → 什么都认不出 → `anchors:0`
 * → 看上去满分。所以这里的每条正向断言旁边都有一条**它该红的**用例。
 */
import { describe, expect, test } from 'bun:test';
import { faninAnchorLoss } from './fanin-summary';

const FULL = [
  '实现改在 src/harness/fanin-summary.ts, 契约测试 src/harness/fanin-summary.test.ts。',
  '还动了 scripts/probes/retro-write-race.ts 与 docs/silent-failures.md。',
  '性能 3.14 倍, 分支 feat/and-or, 参考 e.g. 上游做法。',
].join('\n');

describe('faninAnchorLoss', () => {
  test('全部路径被保留 → lost 0', () => {
    const view = `<fan-in-summary>{"artifacts":["src/harness/fanin-summary.ts","src/harness/fanin-summary.test.ts","scripts/probes/retro-write-race.ts","docs/silent-failures.md"]}</fan-in-summary>`;
    const r = faninAnchorLoss(FULL, view);
    expect(r.anchors).toBe(4);
    expect(r.lost).toBe(0);
    expect(r.kept).toBe(4);
  });

  // ★ 反向自检:摘要丢掉一个路径必须被数出来。这条红不了 = 上面那条是假的。
  test('★ 摘要丢掉一个路径 → lost 1 且它在样本里', () => {
    const view = `{"artifacts":["src/harness/fanin-summary.ts","src/harness/fanin-summary.test.ts","scripts/probes/retro-write-race.ts"]}`;
    const r = faninAnchorLoss(FULL, view);
    expect(r.lost).toBe(1);
    expect(r.lostSample).toEqual(['docs/silent-failures.md']);
  });

  // ★ 反向自检:摘要把路径**改写**了(哪怕语义一样)也算丢 —— 承诺的原话是 "never paraphrase"。
  test('★ 路径被改写成别的形式 → 算丢', () => {
    const view = `{"artifacts":["fanin-summary.ts (在 src/harness 下)"]}`;
    const r = faninAnchorLoss('见 src/harness/fanin-summary.ts', view);
    expect(r.lost).toBe(1);
  });

  test('散文不许被误认成路径锚', () => {
    // and/or 没扩展名 · 3.14 没斜杠 · e.g. 没斜杠 · feat/and-or 没扩展名
    const r = faninAnchorLoss('性能 3.14 倍, 分支 feat/and-or, 参考 e.g. 上游, 走 and/or 分支', '');
    expect(r.anchors).toBe(0);
  });

  // ★ 反向自检:上面那条"零命中"必须是**正则挑剔**而不是**函数坏了**。
  test('★ 同一段散文里塞一个真路径 → 必须认出来 (证明上条零命中不是函数瘫了)', () => {
    const r = faninAnchorLoss('性能 3.14 倍, 分支 feat/and-or, 改的是 src/model/seats.ts', '');
    expect(r.anchors).toBe(1);
    expect(r.lostSample).toEqual(['src/model/seats.ts']);
  });

  test('去重 + 确定性序 (同一输入两次给同一份)', () => {
    const full = 'a/x.ts 又提了一次 a/x.ts, 还有 b/y.ts';
    const r1 = faninAnchorLoss(full, '');
    const r2 = faninAnchorLoss(full, '');
    expect(r1.anchors).toBe(2);
    expect(r1.lostSample).toEqual(['a/x.ts', 'b/y.ts']);
    expect(r2.lostSample).toEqual(r1.lostSample);
  });

  test('样本最多 8 个 (读数不许把日志撑爆)', () => {
    const full = Array.from({ length: 20 }, (_, i) => `pkg/m${i}.ts`).join(' ');
    const r = faninAnchorLoss(full, '');
    expect(r.anchors).toBe(20);
    expect(r.lost).toBe(20);
    expect(r.lostSample.length).toBe(8);
  });

  /**
   * 三态:`anchors:0` 是「全文里没有路径锚」,**不是「无损」**。
   * 这条用例存在的唯一理由是把这个区分钉在测试里 —— 读数板上两者长得一模一样(都是 lost 0),
   * 而下一步完全不同:前者说明这把尺子对这份输出**不适用**, 后者才是真的没丢。
   */
  test('anchors 0 与 lost 0 是两件事 (不适用 ≠ 无损)', () => {
    const 不适用 = faninAnchorLoss('一段完全没有文件路径的结论文字。', '摘要');
    const 真无损 = faninAnchorLoss('改了 src/a.ts', '{"artifacts":["src/a.ts"]}');
    expect(不适用.lost).toBe(0);
    expect(真无损.lost).toBe(0);
    // 分辨靠 anchors 这一位 —— 靠 lost 分不出来, 这正是要钉住的。
    expect(不适用.anchors).toBe(0);
    expect(真无损.anchors).toBe(1);
  });
});
