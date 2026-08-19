/**
 * `isDeliveredOutcome` 真值表闸 (#201, 2026-08-19)。
 *
 * ## 这条钉的是什么
 *
 * 「交付达标了吗」在 2026-08-19 之前是**三处各写各的**, 于是同一个 `delivered-with-red`
 * 被读成三个意思:
 *   · `run-worktree.ts` 的 `shouldAutoCommit` —— 手写 `||`, **收编** (接对了);
 *   · `goal.ts` 的 `settleRunTicket` —— 判 `loopState`, 而这一格恒 `null` → 落 else → 票留 open,
 *     理由念成「下一步是接着跑」;
 *   · `afk-hook.ts` 的 `reflowGoalResults` —— 只认 `'success'` → 票留 ruled + 落续跑锚, 下次再派。
 * 后两处与 `RUN_OUTCOME_INFO['delivered-with-red'].nextAction` 逐字打架 (那里写的是「别整轮重跑」),
 * 而 tsc 与全量测试都抓不到 —— 三处各自都是合法代码。这就是本仓「oracle 绿 ≠ 语义对」那一格。
 *
 * 现在判据只有一份实现, 本文件钉的是**那份实现的真值表**: 新增终态词时这条会逼人当场表态,
 * 而不是让它默默落进 `false` 那侧。
 */
import { describe, expect, test } from 'bun:test';
import { isDeliveredOutcome, RUN_OUTCOME_INFO, RUN_OUTCOME_ORDER, type RunOutcomeKind } from './run-outcome';

/** 交付达标的那一档 —— 改这张表 = 改语义, 要连着上面那段注释一起改。 */
const DELIVERED: readonly RunOutcomeKind[] = ['success', 'delivered-with-red'];

describe('#201 isDeliveredOutcome: 交付达标 = 冻结判据绿, 与「环走完没有」是两个问题', () => {
  // ★ 反向自检 (已实测会红): 把 isDeliveredOutcome 里的 `|| outcome === 'delivered-with-red'`
  //   删掉 → 下面第一条的 delivered-with-red 那格红。
  test('全词表逐格判 —— 只有 success / delivered-with-red 算达标', () => {
    // 遍历全序而不是只测两格: 新增一个终态词时它会自动进这张表, 逼人在这里表态。
    const got = RUN_OUTCOME_ORDER.filter((o) => isDeliveredOutcome(o));
    expect(got).toEqual([...DELIVERED]);
  });

  /**
   * 这一条是**语义的证据面**, 不是重复上一条: 它证明「达标」这一档与表里那三位
   * (spendBucket / resumable / nextAction) 讲的是同一件事。若哪天有人把某个词加进 DELIVERED
   * 而它的表项还写着「可 resume」, 这条当场红 —— 那正是两处漂移开始的地方。
   */
  test('达标档的表项自洽: spendBucket=delivery ∧ resumable=false ∧ nextAction 不叫人重跑', () => {
    for (const o of DELIVERED) {
      const info = RUN_OUTCOME_INFO[o];
      expect(info.spendBucket).toBe('delivery');
      expect(info.resumable).toBe(false);
      expect(info.nextAction).not.toContain('接着跑');
    }
  });

  /**
   * ⚠ 刻意不改 `loopState`: 那一位回答「自主环走完了没有」, 而 delivered-with-red 的答案确实是
   * 「没走完」(书上五态没有这格 —— SUCCESS 会漂白红节点, STALLED 会骗人重跑)。**交付达标**与
   * **环走完**是两个问题, 用两位分别回答。这条钉住这个分离, 免得以后有人图省事把 loopState
   * 改成 SUCCESS —— 那才是真的把红节点漂白。
   */
  test('达标 ≠ 环走完: delivered-with-red 的 loopState 仍是 null (不许为了翻票改成 SUCCESS)', () => {
    expect(isDeliveredOutcome('delivered-with-red')).toBe(true);
    expect(RUN_OUTCOME_INFO['delivered-with-red'].loopState).toBeNull();
    expect(RUN_OUTCOME_INFO.success.loopState).toBe('SUCCESS');
  });

  test('不认识的词一律不算达标 (宽松 string 入参: tsc 拦不住调用方传别的)', () => {
    for (const junk of ['', 'SUCCESS', 'failed', 'delivered', 'delivered-with-red ']) {
      expect(isDeliveredOutcome(junk)).toBe(false);
    }
  });
});
