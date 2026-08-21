/**
 * C 无效否决闸的反向自检(2026-08-21,run `58df6b9e`)。
 *
 * **一条永远绿的闸不是闸** —— 所以每条用例都注明"怎么让它红"。
 * 正样本直接取 P2 那跑的判词原文形状:「执行子图 5/7 成功、2 个失败」——
 * 它含 `5/7`,而那正是最容易被一条草率的"含斜杠就算路径"判据放行的串。
 */
import { describe, expect, test } from 'bun:test';
import { classifyVeto, isInfraVerdict } from './veto-guard';

const NODES = ['slice1_width_pass', 'slice2_missing_edges', 'accept'];

describe('classifyVeto —— 只挡"什么都没点名"', () => {
  test('★ P2 原形: 「5/7 成功、2 个失败」 → 不可证伪, 拦', () => {
    // 这是整条闸存在的理由。怎么让它红: 把 PATH_LIKE 换成 /\// (含斜杠就算路径) →
    // `5/7` 命中, 这条当场绿, 而闸在它唯一该红的样本上放行了。
    const v = classifyVeto('执行子图 5/7 成功、2 个失败, C-2 失败导致 C-3/C-4 及验收链跳过', NODES);
    expect(v.falsifiable).toBe(false);
    expect(v.anchors).toEqual([]);
  });

  test('★ 判词点名了图里真实存在的节点 → 可证伪, 放行', () => {
    // 怎么让它红: 把 node id 那一轮循环删掉 → 这条落进"拦", 断言红。
    const v = classifyVeto('slice2_missing_edges 声明的反向闸没有当场证伪过', NODES);
    expect(v.falsifiable).toBe(true);
    expect(v.anchors).toContain('node:slice2_missing_edges');
  });

  test('★ 判词点名了**图里不存在**的 id → 仍然拦(P2 的 ghost 形状)', () => {
    // engine.ts:1234 已经会把 ghost id 丢掉, 而丢掉之后重规划照样触发 —— 那就是这条闸补的洞。
    // 怎么让它红: 把判据从"id 在图里"放宽成"判词里有下划线词" → 这条绿。
    const v = classifyVeto('节点 C-2 与 ghost_node_不存在 没有交付', NODES);
    expect(v.falsifiable).toBe(false);
  });

  test('★ 判词点到文件路径(含行号) → 可证伪, 放行', () => {
    const v = classifyVeto('src/harness/plan-passes/width.ts:88 的边界条件没覆盖', NODES);
    expect(v.falsifiable).toBe(true);
    expect(v.anchors.some((a) => a.startsWith('path:'))).toBe(true);
  });

  test('★ 裸文件名(无目录)也算锚 —— 人能拿它去仓里找', () => {
    const v = classifyVeto('missing-edges.test.ts 里那条断言写反了', NODES);
    expect(v.falsifiable).toBe(true);
  });

  test('★ 空判词 → 拦("没说话"不是"说了但我没听懂")', () => {
    expect(classifyVeto('', NODES).falsifiable).toBe(false);
    expect(classifyVeto('   ', NODES).falsifiable).toBe(false);
  });

  test('★ 空 id 不当锚 —— 否则 `text.includes("")` 恒真, 整条闸恒放行', () => {
    // 这类"恒真谓词"是本仓的常见静默错法: 闸还在, 但它对任何输入都说 pass。
    // 怎么让它红: 去掉 `if (id && …)` 里的 `id &&` → 空 id 命中, 这条绿变红。
    const v = classifyVeto('什么都没点名的一句话', ['', 'real_node']);
    expect(v.falsifiable).toBe(false);
  });

  test('基础设施故障判词不归本闸管(那条路自己 fail-closed)', () => {
    expect(isInfraVerdict('[verifier-error] 判卷官调不通 (模型层重试已耗尽): ECONNRESET')).toBe(true);
    expect(isInfraVerdict('执行子图 5/7 成功')).toBe(false);
  });
});
