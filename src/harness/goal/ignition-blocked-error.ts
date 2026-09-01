/**
 * src/harness/goal/ignition-blocked-error —— IgnitionBlockedError (t-gate-inmigrate 票 SDD)。
 *
 * `runGoalInner` 入口直调 `ignitionPreflight`,verdict='blocked' → 抛本类。
 * 含 `preflight: PreflightReport` 让 caller (runGoal 外壳 / 装配层) 能拿到原始冲突报告。
 *
 * ## 它盖不住什么(诚实标注)
 *
 * `runGoal` 外壳 finally 块收 `infra-error` 终态时,**仅**看 `box.settled === false`,
 * 看到本类就抛 → box 未 settled → finally 兜底。但 `infra-error` 这个 label 在 run 终态分类
 * (RunOutcomeKind) 上是**单独一类**,不是 `blocked` —— 是有意:点火闸拒 = 引擎还没开始跑 = infra
 * 异常(闸就属于「infra」),不是语义上的 `blocked`(那是执行途中撞 owner-定-白)。
 */
import type { PreflightReport } from './ignition-preflight';

export class IgnitionBlockedError extends Error {
  override readonly name = 'IgnitionBlockedError';
  readonly preflight: PreflightReport;

  constructor(preflight: PreflightReport) {
    // message 是 caller 第一手要看的:把 conflicts 拼成一行 + 加头部标识。
    // 与 runGoal 外壳 finally 写的 `note: uncaught` 配套 —— caller 看到 `IgnitionBlockedError`
    // 第一时间知道是闸拒。
    const detail = preflight.conflicts
      .map((c) => `${c.runId} (${c.overlap.join('、')})`)
      .join('; ');
    super(`点火预检拒绝 (INV-5): ${detail || 'verdict=blocked 但 conflicts 为空'}`);
    this.preflight = preflight;
  }
}