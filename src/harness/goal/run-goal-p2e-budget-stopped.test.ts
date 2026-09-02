/**
 * P2e review-fix (2026-09-02): 平铺图 (`solve+sddPath` 默认路径) 上一个被预算拒派的
 * 子节点 (`budgetStopped` 非空) 必须让 `outcome === 'budget-exhausted'`, 而不是
 * `oracle-failed`/`not-converged` —— 后两者的下一步指引 ("以判据为准"/"别加轮数") 恰是
 * 误导, 真相是"时钟到了, 加预算 resume 大概率就成"。
 *
 * ## 它补的是哪一格
 *
 * `run-goal.ts:2527` 此前只读 `exec.results.execute` —— 那个 id 只存在于 conductor 回落图
 * (`v1` 铺图), 平铺图节点键是 `s{sliceId}` (`sliceByNodeId`, run-goal.ts:1752)。于是同一个
 * `budgetStopped` 信号在 conductor 回落路径上翻得出 `budget-exhausted`, 在**默认的**平铺路径
 * 上却翻不出来 —— 两条路对同一个字段的语义不一致, 而平铺路径正是本仓夜批默认用的那条。
 *
 * ## 反向自检 (怎么让它红)
 * 把 `run-goal.ts` 里 `const budgetStopped = execLeaf?.budgetStopped;` 改回原样 (去掉
 * `Object.values(exec.results).find(...)` 那半回落) → 本文件唯一一条用例当场红
 * (`outcome` 落 `oracle-failed`/`not-converged`, 不是 `budget-exhausted`)。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGoal, type RunGoalConfig } from './run-goal';
import { setCoreLogger, type CoreLogger } from '../logger';
import type { AcceptanceSpec, GoalClassification } from './classify-acceptance';
import type { ConductorPlan } from '../conductor-plan';
import type { ExecutorDagConfig, ExecutorDagResult } from '../dag/types';
import type { ExecGit } from './slice-delivery';

const SLICE_VERIFY = 'bun test src/p2e-budget-target.test.ts';

const SDD_OK = [
  '# P2e budgetStopped 回归契约',
  '## 契约 (Contracts)',
  '- G-1 占位',
  '## 分解 (Breakdown)',
  '| 切片 | 写集 | 依赖 | verify |',
  '|---|---|---|---|',
  `| 1 占位切片 | src/p2e-budget-target.ts + test | — | ${SLICE_VERIFY} |`,
].join('\n');

const tmpSdd = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'omd-p2e-budget-sdd-'));
  const p = join(dir, 'x.md');
  writeFileSync(p, SDD_OK);
  return p;
};

const ACC: AcceptanceSpec = { kind: 'executable', command: 'bun test', expectExit: 0 };
const cls = async (): Promise<GoalClassification> => ({ tier: 'complex', acceptance: ACC });

// 模块级 logger 单例必须换回去 —— 跨文件污染教训照抄 o6-delivery 那份的注。
const quiet: CoreLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
const consoleLogger: CoreLogger = {
  debug: () => {},
  info: (o, m) => console.log(m ?? '', typeof o === 'string' ? o : ''),
  warn: (o, m) => console.warn(m ?? '', typeof o === 'string' ? o : ''),
  error: (o, m) => console.error(m ?? '', o),
};
beforeEach(() => setCoreLogger(quiet));
afterEach(() => setCoreLogger(consoleLogger));

/** git 替身: 写集在契约入库之后真被提交过 → O-6 放行, 平铺图照编不回落 (同 o6-delivery ★①)。 */
const fakeGit: ExecGit = (args) => {
  if (args[0] === 'log') return { stdout: 'shaBIRTH\nc1\nc2\n', exitCode: 0 };
  if (args[0] === 'status') return { stdout: '', exitCode: 0 };
  return { stdout: '', exitCode: 128 };
};

/** 引擎替身: 不管吃进什么 plan, 一律回一个 s1 节点被预算拒派的结果 —— 钉的是 goal 层怎么念它。 */
function makeBudgetStoppedRunDag(): NonNullable<RunGoalConfig['_runDag']> {
  return (async (plan: ConductorPlan): Promise<ExecutorDagResult> => ({
    plan,
    results: {
      s1: {
        id: 's1',
        status: 'failed',
        kind: 'agent',
        output: '[时间预算已尽, 未派发]',
        deps: [],
        usage: { in: 0, out: 0 },
        budgetStopped: '时间预算已尽: 剩余 0s ≤ 最小可用切片 5s (已用 60s / 上限 10s)',
      },
    },
    sessionId: 'p2e-budget-stopped-test',
    levels: [],
    usage: { conductor: { in: 0, out: 0 }, leavesIn: 0, leavesOut: 0, leavesCacheHit: 0 },
    reusedNodes: [],
  })) as never;
}

function makeConfig(): RunGoalConfig {
  const dag = { conductorModel: 'c:m', leafModel: 'l:m' } as ExecutorDagConfig;
  dag.commandRunner = async () => ({
    text: '',
    usage: { in: 0, out: 0 },
    exitCode: 0,
    timedOut: false,
    signal: null,
  });
  return {
    cwd: mkdtempSync(join(tmpdir(), 'omd-p2e-budget-cwd-')),
    dag,
    _classify: cls,
    _runDag: makeBudgetStoppedRunDag(),
    sddPath: tmpSdd(),
    gitExec: fakeGit,
    writeSet: { _collectChangedFiles: () => [] },
  };
}

describe('P2e review-fix: 平铺图上的 budgetStopped 必须翻成 outcome=budget-exhausted', () => {
  test('s1 节点带 budgetStopped (execute 键不存在) → outcome 不许落 oracle-failed/not-converged', async () => {
    const r = await runGoal('p2e budget-exhausted 平铺回归', makeConfig());
    expect(r.converged).toBe(false);
    expect(r.outcome).toBe('budget-exhausted');
  });
});
