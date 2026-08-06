/**
 * summarizeGoalFailure 契约测试。fixture 直接手搓 RunGoalResult 对象字面量, 零 live。
 *
 * 钉的是失败摘要与 `summarizeGoal` 的分工: 只答「怎么结束的、下一步干嘛」——
 * ① 不带 goal 原文 (两份真相会漂); ② 终止原因行逐字来自 RUN_OUTCOME_INFO 词表;
 * ③ criteria 缺席时不编判据 (execute 没跑, 一条都没判过); ④ 只印非 success 阶段。
 */
import { describe, expect, test } from 'bun:test';
import { summarizeGoalFailure } from './summarize-goal-failure';
import type { GoalStage, RunGoalResult } from './run-goal';
import { RUN_OUTCOME_INFO } from '../run-outcome';

function mkResult(over: Partial<RunGoalResult> = {}): RunGoalResult {
  return {
    goal: '',
    tier: 'complex',
    acceptance: { kind: 'exploratory', learningGoal: 'x', affordableLoss: '一轮' },
    stages: [],
    sources: [],
    repoContext: '',
    converged: false,
    rounds: 1,
    reusedNodes: [],
    outcome: 'blocked',
    ...over,
  };
}

describe('summarizeGoalFailure', () => {
  // ① 失败摘要进 runRegistry.fail, 只回答「怎么结束的」—— 再带一遍 goal 原文 = 两份真相会漂。
  test('输出不含 goal 原文 (取一段独特长子串断言)', () => {
    const marker = 'XYZZY-契约原文-唯一长标记-冻结判据环外验收';
    const out = summarizeGoalFailure(mkResult({
      goal: `给 omd 加一个自主 goal 引擎, 由一份 SDD 契约驱动, ${marker}, 失败时只答怎么结束与下一步干嘛`,
    }));
    expect(out).not.toContain(marker);
    expect(out).not.toContain('XYZZY'); // 任何形式都不许带
  });

  // ② 终止原因行的 outcome / loopState / nextAction 逐字来自词表 (测试直接引表拼期望值, 不手抄)。
  test('终止原因行含 outcome 与 nextAction 字面, rounds 数值在', () => {
    const out = summarizeGoalFailure(mkResult({ outcome: 'blocked', rounds: 3 }));
    const info = RUN_OUTCOME_INFO.blocked;
    expect(out).toContain(`终止原因: blocked (${info.loopState}) · 下一步: ${info.nextAction}`);
    expect(out).toContain('rounds: 3 轮');
    expect(out).toContain('converged: 未收敛');
  });

  // ③ 契约段就结束 → execute 没跑, 两条判据一条都没判过: 逐字「没判过」, 不许拿布尔冒充判据。
  test('criteria 缺席 → 两条判据逐字「没判过 (execute 没跑到)」, 无编造结果', () => {
    const out = summarizeGoalFailure(mkResult({ criteria: undefined }));
    const lines = out.split('\n');
    expect(lines.filter((l) => l.startsWith('criteria.judge'))).toEqual([
      'criteria.judge: 没判过 (execute 没跑到)',
    ]);
    expect(lines.filter((l) => l.startsWith('criteria.oracle'))).toEqual([
      'criteria.oracle: 没判过 (execute 没跑到)',
    ]);
    expect(out).not.toContain('false'); // 布尔结果出现在这里 = 编造判据
  });

  // ④ 失败摘要只看没成的阶段: 非 success 标识逐字出现, success 阶段一行都不印, summary 截 200。
  test('混合阶段 → 只印非 success 阶段, 标识逐字匹配, summary 超 200 被截', () => {
    const longSummary = '阻塞'.repeat(105) + 'TAIL-唯一-201+'; // 210 字, 超 200 截断线
    const stages: GoalStage[] = [
      { stage: 'classify', status: 'done', outcome: 'success', summary: 'complex 档' },
      { stage: 'spec', status: 'done', outcome: 'not-converged', summary: '判未达标' },
      { stage: 'execute', status: 'failed', outcome: 'blocked', summary: longSummary },
    ];
    const out = summarizeGoalFailure(mkResult({ stages }));
    // status=done 的阶段不带 /status 后缀; status=failed 的带。
    expect(out).toContain('  [not-converged] spec — 判未达标');
    expect(out).toContain(`  [blocked/failed] execute — ${'阻塞'.repeat(100)}`);
    expect(out).not.toContain('TAIL-唯一-201+'); // 200 字之外被截掉
    expect(out).not.toContain('  [success] classify — '); // success 阶段不印占位行
  });
});
