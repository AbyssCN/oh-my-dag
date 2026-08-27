/**
 * goal/acceptance-shape —— 验收分型的**具名谓词**(2026-08-28)。
 *
 * ## 它治的病
 *
 * `run-goal.ts` 里对分型的判定散了十来处,但它们**不是十来个独立决定**。逐处读过之后,
 * 收敛成两个问题被反复问 + 两处渲染:
 *
 * | 问题 | 今天散在几处 | 收敛到 |
 * |---|---|---|
 * | 有没有一条别人来跑的命令 | 8 | {@link acceptanceCommand} |
 * | 没拿到证明时该判成没成 | 2 | {@link unprovenMeansFail} |
 * | 摘要怎么印 | 2 | {@link describeAcceptance} |
 *
 * 同一个问题问 10 次就有 10 个漏改的机会,而 `kind === 'x'` 型比较**加一格不会编译红**
 * (读了新格没有的字段那一类才会红,`tsc` 会替你点名)。收敛之后,新增一格只需要在
 * **一个** switch 里表态,所有调用点继承那次表态;switch 末尾落 `assertNever`,漏表态即编译错误。
 *
 * ## 这里修掉的一条真 bug
 *
 * `run-goal.ts` 今天写的是 `acceptance.kind !== 'executable' ? true : …` ——
 * 「不是执行型 ⇒ 没拿到证明也算绿」。加第三格**之前**这没错:不是执行型就只剩探索型,
 * 而探索型本来就没有机器判据。**加了 rubric 之后它错了** —— rubric 有判据,
 * 没被证明过同样不算成(同 `run-goal.ts` 那句「冻结判据的意义就是『没被证明过就不算成』」)。
 * 那一格由 {@link unprovenMeansFail} 钉死,并由测试的「三格答案不全相同」兜住
 * (一个在任何输入下都不动的谓词量的是尺子,不是被测物)。
 *
 * ## 为什么谓词不返回缺省而是抛
 *
 * 三个函数遇到类型系统没见过的 `kind` 一律抛。静默返回缺省会让一个未知分型悄悄变成
 * 「什么都没做」,而调用方读到的是成功 —— 那正是本仓最贵的一类死法。
 *
 * @module
 */
import { assertNever } from '../exhaustive';
import type { AcceptanceSpec } from './classify-acceptance';

/** 一条别人来跑的验收命令 —— 有就带出命令与期望退出码,没有就是 `null`。 */
export interface RunnableAcceptance {
  readonly command: string;
  readonly expectExit: number;
}

/**
 * 这份验收规格有没有一条**别人来跑**的命令。
 *
 * `null` 不是「跑不起来」,是「这一型本来就不靠命令判」。
 * ⚠ 别给没有命令的分型返回一条假命令 —— 上游会真的去跑它。
 */
export function acceptanceCommand(a: AcceptanceSpec): RunnableAcceptance | null {
  switch (a.kind) {
    case 'executable':
      return { command: a.command, expectExit: a.expectExit };
    case 'exploratory':
      // 它明说没有机器判据。伪造一条比承认判不了坏得多。
      return null;
    case 'rubric':
      // 它的判据是 checklist,不是命令。逐条判走另一条路。
      return null;
    default:
      return assertNever(a, `acceptanceCommand: 未处理的验收分型 — ${JSON.stringify(a)}`);
  }
}

/**
 * **没拿到证明**时,该不该判成没成。
 *
 * 三格的答案不同,而且这正是加第三格时最容易搞错的一格:
 * · 执行型 → `true`,冻结判据的全部意义就是「没被证明过就不算成」;
 * · 探索型 → `false`,它**本来就没有**机器判据,拿这个判它等于伪造了一个判据;
 * · rubric → `true`,它**有**判据(那份冻结的 checklist),与执行型同路。
 *
 * ⚠ 今天 `run-goal.ts` 的二值写法在第三格上给的是探索型的答案 —— 那是错的,本函数是它的正解。
 */
export function unprovenMeansFail(a: AcceptanceSpec): boolean {
  switch (a.kind) {
    case 'executable':
      return true;
    case 'exploratory':
      return false;
    case 'rubric':
      return true;
    default:
      return assertNever(a, `unprovenMeansFail: 未处理的验收分型 — ${JSON.stringify(a)}`);
  }
}

/**
 * 摘要里那一行 —— 三格各印各的。
 *
 * 一份而不是两份是要点:同一句话在两处写,两处就会漂,而摘要正是人第一眼看「这次拿什么判的」。
 */
export function describeAcceptance(a: AcceptanceSpec): string {
  switch (a.kind) {
    case 'executable':
      return `执行型 \`${a.command}\` (期望退出码 ${a.expectExit})`;
    case 'exploratory':
      return `探索型 (无机器判据) · 学习目标: ${a.learningGoal}`;
    case 'rubric':
      return `rubric 逐条判 · ${a.checklist.items.length} 条 (判卷标准已冻结, 改一个字即拒)`;
    default:
      return assertNever(a, `describeAcceptance: 未处理的验收分型 — ${JSON.stringify(a)}`);
  }
}
