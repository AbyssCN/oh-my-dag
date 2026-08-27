/**
 * 验收分型的**具名谓词** —— 把散落的 `kind === 'executable'` 收敛成一处表态。
 *
 * ## 为什么要有这一层(实账,2026-08-28)
 *
 * `run-goal.ts` 里对分型的判定有十来处,但它们**不是十来个独立决定** —— 从 HEAD 逐处读过之后,
 * 收敛成两个问题被反复问 + 两处渲染:
 *
 * · 「这份验收规格有没有一条别人来跑的命令?」—— 8 处(要不要 SDD 直通判定 / 要不要 accept 叶 /
 *   要不要量基线侧 / 要不要复验 / 要不要写读数板…)
 * · 「没拿到证明时该判成没成?」—— 2 处
 * · 摘要渲染 —— 2 处
 *
 * 问题问了 10 次就有 10 个漏改的机会,而 `kind === 'x'` 型比较**加一格不会编译红**。
 * 收敛成谓词之后,新增一格只需要在**一个** switch 里表态,所有调用点继承那次表态;
 * 而那个 switch 末尾落 `assertNever`,漏表态就是编译错误。
 *
 * ## 这里钉住的一条真 bug
 *
 * 今天 `run-goal.ts` 写的是 `acceptance.kind !== 'executable' ? true : …` ——
 * 「不是执行型 ⇒ 没拿到证明也算绿」。加第三格之前这没错(不是执行型就只剩探索型,
 * 而探索型本来就没有机器判据)。**加了 rubric 之后它错了**:rubric 有判据,
 * 没被证明过同样不算成(同 `run-goal.ts` 那句「冻结判据的意义就是『没被证明过就不算成』」)。
 * 这正是「加一格不会红」那类静默错路的活体样本,由 {@link unprovenMeansFail} 钉死。
 *
 * ## 反向自检(每条真跑过一次)
 * · 把 `unprovenMeansFail` 的 rubric 一格改成 `false`(退回今天的二值行为)→ 该条当场红。
 * · 把任一 switch 的某个 case 删掉 → `tsc` 在 `assertNever` 那行点名,不是运行期才发现。
 * · 把 `acceptanceCommand` 的 rubric 一格改成返回一条假命令 → 「rubric 没有可跑命令」当场红。
 */
import { describe, expect, test } from 'bun:test';
import { acceptanceCommand, unprovenMeansFail, describeAcceptance } from './acceptance-shape';
import { freezeRubric } from './rubric-spec';
import type { AcceptanceSpec } from './classify-acceptance';

const exec: AcceptanceSpec = { kind: 'executable', command: 'bun test', expectExit: 0 };
const explore: AcceptanceSpec = { kind: 'exploratory', learningGoal: '摸清 X', affordableLoss: '两轮' };
const rubric: AcceptanceSpec = {
  kind: 'rubric',
  checklist: freezeRubric([
    { id: 'r1', requirement: '点名了数据来源' },
    { id: 'r2', requirement: '每条结论带一条可复跑命令' },
  ]),
};

describe('ACCEPTANCE_PREDICATES_EXHAUSTIVE:有没有一条别人来跑的命令', () => {
  test('★ 执行型有,原样带出命令与期望退出码', () => {
    expect(acceptanceCommand(exec)).toEqual({ command: 'bun test', expectExit: 0 });
  });

  test('★ 探索型没有 → null (它明说没有机器判据)', () => {
    expect(acceptanceCommand(explore)).toBeNull();
  });

  test('★ rubric 也没有 → null —— 它的判据是 checklist 不是命令', () => {
    // 返回一条假命令会让上游去跑一个不存在的东西, 比返回 null 坏得多。
    expect(acceptanceCommand(rubric)).toBeNull();
  });
});

describe('ACCEPTANCE_PREDICATES_EXHAUSTIVE:没拿到证明时该判成没成', () => {
  test('★ 执行型:没证明 = 不算成 (冻结判据的全部意义)', () => {
    expect(unprovenMeansFail(exec)).toBe(true);
  });

  test('★ 探索型:没证明**不**判成没成 —— 它本来就没有机器判据, 拿这个判它是伪造判据', () => {
    expect(unprovenMeansFail(explore)).toBe(false);
  });

  test('★ rubric:没证明 = 不算成 —— 它**有**判据, 与执行型同路 (今天二值分支在这一格是错的)', () => {
    // 这一条就是那个活体 bug: `kind !== "executable" ? true : …` 会给 rubric 探索型的答案。
    // 把这一格改回 false 即复现该 bug, 本条当场红。
    expect(unprovenMeansFail(rubric)).toBe(true);
  });

  test('★ 三格答案不是全相同 —— 一个在任何输入下都不动的谓词量的是尺子不是被测物', () => {
    const answers = [exec, explore, rubric].map(unprovenMeansFail);
    expect(new Set(answers).size).toBeGreaterThan(1);
  });
});

describe('ACCEPTANCE_PREDICATES_EXHAUSTIVE:摘要渲染三格各印各的', () => {
  test('★ 执行型印命令、探索型印学习目标、rubric 印条目数与「已冻结」', () => {
    expect(describeAcceptance(exec)).toContain('bun test');
    expect(describeAcceptance(explore)).toContain('摸清 X');
    const r = describeAcceptance(rubric);
    expect(r).toContain('2');
    expect(r).toContain('冻结');
  });

  test('★ 三格的摘要两两不同 (分不出来就等于没分型)', () => {
    const all = [exec, explore, rubric].map(describeAcceptance);
    expect(new Set(all).size).toBe(3);
  });
});

describe('ACCEPTANCE_PREDICATES_EXHAUSTIVE:运行期兜底', () => {
  test('★ 送进一个类型系统没见过的 kind → 抛, 不静默返回缺省', () => {
    const bogus = { kind: 'not-a-kind' } as unknown as AcceptanceSpec;
    // 三个谓词都要 fail-loud:静默返回缺省会让一个未知分型悄悄变成「什么都没做」,
    // 而调用方读到的是成功。判词里必须带上那个意外的值(不吞证据)。
    for (const fn of [acceptanceCommand, unprovenMeansFail, describeAcceptance]) {
      expect(() => (fn as (a: AcceptanceSpec) => unknown)(bogus)).toThrow(/not-a-kind/);
    }
  });
});
