/**
 * INV-5 rubric 显式终态 —— 契约 `docs/plan/2026-08-29-veto-feedback-revision-edges.md` D-5 / GWT-5。
 *
 * ## 它钉的那件事
 *
 * `rubricVerdictInputs` 今天**无人注入** (生产常态, 见 run-goal.ts 那条注)。于是 rubric 分型
 * 恒非 success, 而终态被折进 `oracle-failed` —— 三批 240 trial 里这一格占 13~20 个/批,
 * 且它们的 reward 均值**高于**整批: 标签与成败零相关, 归因时纯噪声。
 * 本片只改标签: 终态字面独立成 `rubric-unwired`, success 仍不可达 (fail-closed 一字不动)。
 *
 * ## 反向自检 (每条新分支当场证伪过一次, 仓惯例)
 *
 *  · `rubricAcceptanceUnwired` 里把 `kind === 'rubric'` 改成 `true` ⇒ 「executable 不算 unwired」当场红;
 *  · run-goal 的 outcome 链里把 rubricUnwiredTerminal 那一支删掉 ⇒ 「终态不是 oracle-failed」当场红;
 *  · 摘要里去掉 `TERMINAL_RUBRIC_UNWIRED` 那一段 ⇒ 「摘要含 rubric-unwired」当场红;
 *  · 把 fail-closed 初值 (`rubricOracleOk`) 改回 `true` ⇒ 「converged 仍不为 true」当场红。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGoal, rubricAcceptanceUnwired, TERMINAL_RUBRIC_UNWIRED, type RunGoalConfig } from './run-goal';
import { freezeRubric, type RubricItem } from './rubric-spec';
import type { GoalClassification } from './classify-acceptance';
import type { ExecutorDagConfig, ExecutorDagResult } from '../dag/types';

// ── 纯函数面 ────────────────────────────────────────────────────────────────

describe('INV-5 纯核: rubricAcceptanceUnwired —— 「rubric 分型 + 验收步缺席」的判据', () => {
  test('rubric + 既无判词也无拒因 ⇒ true (这正是今天生产的形状)', () => {
    expect(rubricAcceptanceUnwired({ kind: 'rubric', verdictPresent: false, rejectionPresent: false })).toBe(true);
  });

  test('★ 判别力: rubric 但**判过了** (有判词) ⇒ false —— 判红不是"没接线"', () => {
    expect(rubricAcceptanceUnwired({ kind: 'rubric', verdictPresent: true, rejectionPresent: false })).toBe(false);
  });

  test('★ 判别力: rubric 且被拒 (frozen-drift / probe) ⇒ false —— 拒也是判过', () => {
    expect(rubricAcceptanceUnwired({ kind: 'rubric', verdictPresent: false, rejectionPresent: true })).toBe(false);
  });

  test('★ 判别力: 非 rubric 分型一律 false (接线不污染另两格)', () => {
    expect(rubricAcceptanceUnwired({ kind: 'executable', verdictPresent: false, rejectionPresent: false })).toBe(false);
    expect(rubricAcceptanceUnwired({ kind: 'exploratory', verdictPresent: false, rejectionPresent: false })).toBe(false);
  });

  test('字面是 rubric-unwired (契约 GWT-5 逐字)', () => {
    expect(TERMINAL_RUBRIC_UNWIRED).toBe('rubric-unwired');
  });
});

// ── 接线面 ──────────────────────────────────────────────────────────────────

const items: readonly RubricItem[] = [
  { id: 'r1', requirement: '报告里点名了数据来源' },
  { id: 'r2', requirement: '每条结论都带一条可复跑的命令' },
];
const frozenSpec = freezeRubric([...items]);

const executeDag = (): ExecutorDagResult =>
  ({
    plan: { name: 'goal-orchestrating-loop', nodes: {} },
    results: {
      conductor: {
        id: 'conductor',
        status: 'done',
        kind: 'agent',
        output: '[conductor 报告]',
        deps: [],
        usage: { in: 1, out: 1 },
        // conductor 跑完 (status done) —— GWT-5 的 Given 第三条「内环收敛」在循环路径上的形状。
      },
    },
    reusedNodes: [],
  }) as unknown as ExecutorDagResult;

const cfg = (over: Partial<RunGoalConfig> = {}): RunGoalConfig => ({
  cwd: mkdtempSync(join(tmpdir(), 'omd-rubric-terminal-')),
  dag: { conductorModel: 'c:m', leafModel: 'l:m' } as ExecutorDagConfig,
  _today: () => '2026-08-29',
  _classify: (async (): Promise<GoalClassification> => ({
    tier: 'complex',
    acceptance: { kind: 'rubric', checklist: frozenSpec },
  })) as RunGoalConfig['_classify'],
  _runDag: (async () => executeDag()) as never,
  ...over,
});

describe('INV-5 接线: rubric 分型 + 验收步缺席 + 内环收敛 ⇒ 终态字面 rubric-unwired', () => {
  test('★ GWT-5: 终态字面含 rubric-unwired 且不含 oracle-failed', async () => {
    const r = await runGoal('写一份报告', cfg());
    expect(r.terminalLabel).toBe(TERMINAL_RUBRIC_UNWIRED);
    expect(r.terminalLabel).not.toContain('oracle-failed');
    expect(r.outcome).not.toBe('oracle-failed');
  });

  test('★ 摘要里也要看得见 (人第一眼读的是那一行, 不是字段)', async () => {
    const r = await runGoal('写一份报告', cfg());
    const execStage = r.stages.at(-1)!;
    expect(execStage.summary).toContain(TERMINAL_RUBRIC_UNWIRED);
  });

  test('★ fail-closed 保持: success 仍不可达 (改标签不许顺手放行)', async () => {
    const r = await runGoal('写一份报告', cfg());
    expect(r.converged).toBe(false);
    expect(r.outcome).not.toBe('success');
    expect(r.criteria?.oracle).toBe(false);
  });

  test('★ 判别力 (执行型没被顺手改): conductor 说成了而冻结判据没过 ⇒ 走判据分支 (not-converged), 不是 rubric-unwired', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-rubric-terminal-exec-'));
    const r = await runGoal('做一件事', {
      cwd,
      dag: { conductorModel: 'c:m', leafModel: 'l:m' } as ExecutorDagConfig,
      _today: () => '2026-08-29',
      _classify: (async (): Promise<GoalClassification> => ({
        tier: 'simple',
        acceptance: { kind: 'executable', command: 'true', expectExit: 0 },
      })) as RunGoalConfig['_classify'],
      _runDag: (async () =>
        ({
          plan: { name: 'goal-orchestrating-loop', nodes: {} },
          results: {
            conductor: { id: 'conductor', status: 'done', kind: 'agent', output: '', deps: [], usage: { in: 1, out: 1 }, },
            // accept 真跑真红 —— 冻结判据没过那一格。
            accept: { id: 'accept', status: 'failed', kind: 'command', output: '', deps: ['conductor'], usage: { in: 0, out: 0 }, exitCode: 1 },
          },
          reusedNodes: [],
        }) as unknown as ExecutorDagResult) as never,
    });
    // 循环路径: 有可执行判据 ⇒ 停止规则唯一 = 冻结判据, 判据红即 not-converged (run-goal.ts loopOk)。
    expect(r.outcome).toBe('not-converged');
    expect(r.terminalLabel).toBe('not-converged');
    expect(r.terminalLabel).not.toBe(TERMINAL_RUBRIC_UNWIRED);
  });
});
