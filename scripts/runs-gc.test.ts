/**
 * `runs-gc` 分类判据的闸(#252)。
 *
 * 这里钉的是**判序**,不是「能不能删」——因为今天这个局面就是判序错出来的:
 * 票原本的护栏是「终态 < 2 天跳过」,而 51 棵树里 **35 棵既无 runs.db 账也无 continuity**
 * (测试造的残渣),它们被年龄护栏一路豁免,于是跑得越勤积得越多,29 棵是两小时内长出来的。
 *
 * 判序必须是:LIVE → 太新 → **无账残渣** → 太年轻 → DIRTY → UNMERGED → 干净。
 * - 残渣排在「太年轻」**之前**:否则它永远轮不到被回收(今天的病根);
 * - 但排在 LIVE / 太新**之后**:一个刚起跑还没记账的 run,长得就跟残渣一模一样,
 *   把它删了就是删活人的树。
 *
 * 反向自检(实测过):
 * - 把 debris 那一支挪到 too-young 之后 ⇒ ★③ 红;
 * - 把 debris 那一支挪到 too-fresh 之前 ⇒ ★② 红;
 * - 删掉 dirty 分支(让脏树直接走 merged-clean)⇒ ★④ 红。
 */
import { describe, expect, test } from 'bun:test';
import { classify, type SurveyDeps } from './runs-gc';

const DAY = 86_400_000;
const NOW = 1_700_000_000_000;

/** 缺省 = 一棵终态很久、干净、有账、已合并的树(= merged-clean)。逐用例只翻**一个**旋钮。 */
function deps(over: Partial<SurveyDeps> = {}): SurveyDeps {
  return {
    lookupRun: () => ({ status: 'done', updatedAt: NOW - 10 * DAY }),
    hasContinuity: () => true,
    pidAlive: () => false,
    dirtyCount: () => 0,
    aheadCount: () => 0,
    isMerged: () => true,
    createdAt: () => NOW - 10 * DAY,
    now: () => NOW,
    ...over,
  };
}

describe('runs-gc 分类判序', () => {
  test('★① LIVE 压过一切 —— 脏、领先、无账都不许让它被回收', () => {
    const r = classify('r1', '/d', deps({
      lookupRun: () => ({ status: 'running' }),
      hasContinuity: () => false,   // 无账
      dirtyCount: () => 7,          // 脏
      aheadCount: () => 3,          // 领先
      isMerged: () => false,
    }));
    expect(r.category).toBe('live');
  });

  test('★① LIVE 也认「属主 pid 还活着」(status 可能还没写回盘)', () => {
    const r = classify('r1', '/d', deps({ lookupRun: () => ({ status: 'failed', ownerPid: 4242 }), pidAlive: () => true }));
    expect(r.category).toBe('live');
  });

  test('★② 刚建出来的树跳过 —— 而且这一条要压过「无账」(刚起跑的 run 长得就像残渣)', () => {
    const r = classify('r1', '/d', deps({
      hasContinuity: () => false,
      lookupRun: () => undefined,          // 无账
      createdAt: () => NOW - 60_000,       // 1 分钟前
    }));
    expect(r.category).toBe('too-fresh');
  });

  test('★③ 无账残渣**不受**年龄护栏 —— 这是今天 35 棵积起来的病根', () => {
    const r = classify('r1', '/d', deps({
      hasContinuity: () => false,
      lookupRun: () => undefined,
      createdAt: () => NOW - 2 * 3_600_000, // 两小时前, 远超 fresh 但远不到 2 天
    }));
    expect(r.category).toBe('debris');
    expect(r.hasLedgerEntry).toBe(false);
  });

  test('★③ 对照臂: 同样两小时前、但**有账** → 走年龄护栏跳过, 不当残渣删', () => {
    const r = classify('r1', '/d', deps({
      lookupRun: () => ({ status: 'done', updatedAt: NOW - 2 * 3_600_000 }),
      createdAt: () => NOW - 2 * 3_600_000,
    }));
    expect(r.category).toBe('too-young');
  });

  test('★④ 脏树走 salvage, 不许混进 merged-clean 直接删', () => {
    const r = classify('r1', '/d', deps({ dirtyCount: () => 5 }));
    expect(r.category).toBe('dirty');
    expect(r.action).toContain('salvage');
    expect(r.action).toContain('archive/run/r1');
  });

  test('★⑤ 领先 main 且未合并 → 转 tag, 不直接删支', () => {
    const r = classify('r1', '/d', deps({ aheadCount: () => 2, isMerged: () => false }));
    expect(r.category).toBe('unmerged');
    expect(r.action).toContain('archive/run/r1');
  });

  test('领先但已合并 (merge 提交在 main 上) → 干净可删', () => {
    const r = classify('r1', '/d', deps({ aheadCount: () => 2, isMerged: () => true }));
    expect(r.category).toBe('merged-clean');
  });

  test('缺省路径: 终态很久 + 干净 + 已合并 → merged-clean', () => {
    expect(classify('r1', '/d', deps()).category).toBe('merged-clean');
  });

  test('minAgeDays 可调, 且真的被读 (不是个被忽略的旋钮)', () => {
    const d = deps({ lookupRun: () => ({ status: 'done', updatedAt: NOW - 3 * DAY }) });
    expect(classify('r1', '/d', d, { minAgeDays: 2 }).category).toBe('merged-clean'); // 3 天 > 2 天 → 过关
    expect(classify('r1', '/d', d, { minAgeDays: 5 }).category).toBe('too-young');    // 3 天 < 5 天 → 拦下
  });
});
