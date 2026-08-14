/**
 * src/harness/goal/accept-delta —— 验收 delta 的**分辨率**(图鉴 S-37 的闸)。
 *
 * ## 这条闸买的是什么
 *
 * `delta-compare` 的六档矩阵本身是对的,坏在**喂给它的 steps 只有一格** —— 整条验收命令
 * 的退出码。于是 `fail → fail` 判 `unchanged-failure`(语义正确:老失败不该红),
 * 而**只要基线那一格红了,after 无论因为什么红都被赦免**,闸还会主动印一句
 * 「未新增失败」让人放心。
 *
 * 而基线红在本仓是**常态不是意外**:2026-08-14 实测同一 HEAD 三次全量,`(fail)` 名字集
 * 是 `{shell-write-visibility …}` → `{node-failure-kind …}` → `{}`,**两两不相交**。
 * 只要验收命令里含 `bun test`,基线红就是大概率事件 ⇒ 这条闸对任何真回归都恒绿。
 *
 * 修法两条,缺一不可:
 *
 * 1. **粒度降到一条测试**(`buildAcceptDelta`)—— 两侧 `(fail)` 名字集取并集当 step 集,
 *    每个名字在各侧按"在不在集合里"给 pass/fail。于是 `A→A` 仍是 `unchanged-failure`,
 *    而 `pass→fail` 的那条当场 `new-failure`。
 * 2. **一次红不算红**(`stableFailSet`)—— 判红前再跑一次,只保留**复现**的失败。
 *    没有这一条,半 a 的抖动会把闸推到另一个极端:每跑必假红,人照样学会无视它。
 *
 * ## 方向:宁可吵,不可静默
 *
 * `blank-baseline.ts:13-19` 已经把这条不对称写死过:
 * 「乐观陈旧(少记红)→ 真基线红被当新增 → 白烧修复轮(**可恢复,吵**);
 *   悲观陈旧(多记红)→ 真回归被赦免成"基线本来就红"(**静默,致命**)」。
 * 本模块两条修法都朝"吵"那边偏,第 2 条只把吵压到可用,不把它压成静默。
 */
import { extractFailSet } from '../blank-baseline';
import { compareVerifyReports, type DeltaReport, type VerifyStep, type VerifyStepStatus } from './delta-compare';

/** 整条验收命令那一格的 step id —— 与 D-1 落地时的口径一致(老报告逐字兼容)。 */
export const ACCEPT_STEP = 'accept';

/** 逐条测试的 step id 前缀 —— 与 `accept` 那格在同一命名空间里分得开。 */
export const TEST_STEP_PREFIX = 'test:';

/** 验收的一侧读数。 */
export interface AcceptSide {
  /** 整条命令的判定。`undefined` = 这一侧没跑到(覆盖回退,由 `delta-compare` 按 mode 裁)。 */
  status: VerifyStepStatus | undefined;
  /** 该侧输出里的 `(fail)` 测试名集合(`extractFailSet` 的结果)。 */
  failSet: string[];
}

/** 从退出码 + 命令输出组一侧读数。`status === undefined` 表示这一侧根本没跑到。 */
export function acceptSideOf(status: VerifyStepStatus | undefined, output: string): AcceptSide {
  return { status, failSet: status === undefined ? [] : extractFailSet(output) };
}

/**
 * 两次 after 读数取**交集** —— 只有复现的失败才算真失败。
 *
 * 用在判红之前:第一次读到的红里混着抖动,再跑一次,只留两次都在的。
 * ⚠ 反过来(取并集)会把抖动也判红,那正是第 2 条修法要挡的东西。
 */
export function stableFailSet(first: readonly string[], second: readonly string[]): string[] {
  const s = new Set(second);
  return first.filter((n) => s.has(n)).sort();
}

/** 第一次红了、第二次没复现的那些 —— **抖动证据,要写进判词**(不写就成了偷偷放行)。 */
export function unstableFailSet(first: readonly string[], second: readonly string[]): string[] {
  const s = new Set(second);
  return first.filter((n) => !s.has(n)).sort();
}

/**
 * 组 delta 报告:整条命令那一格 + 逐条测试那些格。
 *
 * 逐条测试的 step **只在两侧都跑到时才建** —— 一侧缺席时 `accept` 那格已经判了
 * `new-failure`(fail-closed),再把每条测试铺一遍只会在报告里多出 N 条同因噪声。
 *
 * 名字集取**并集**是判据的要害:只铺 after 侧的失败名会让新失败落进 `newly-run`
 * (`delta-compare.ts:107`)而不是 `new-failure` —— 那样闸照样恒绿,只是换了个地方绿。
 */
export function buildAcceptDelta(before: AcceptSide, after: AcceptSide): DeltaReport {
  const beforeSteps: VerifyStep[] = before.status === undefined ? [] : [{ id: ACCEPT_STEP, status: before.status }];
  const afterSteps: VerifyStep[] = after.status === undefined ? [] : [{ id: ACCEPT_STEP, status: after.status }];
  if (before.status !== undefined && after.status !== undefined) {
    const b = new Set(before.failSet);
    const a = new Set(after.failSet);
    for (const name of [...new Set([...before.failSet, ...after.failSet])].sort()) {
      beforeSteps.push({ id: `${TEST_STEP_PREFIX}${name}`, status: b.has(name) ? 'fail' : 'pass' });
      afterSteps.push({ id: `${TEST_STEP_PREFIX}${name}`, status: a.has(name) ? 'fail' : 'pass' });
    }
  }
  return compareVerifyReports({ mode: 'full', steps: beforeSteps }, { mode: 'full', steps: afterSteps });
}
