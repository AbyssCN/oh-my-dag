/**
 * outcome-partial 终态语义闸 — #165① 洞① (SDD: docs/plan/2026-08-18-按-pathfinder-票-165-*.md)。
 *
 * 真值表 (冻结判据绿? = r.converged, 即 loopOk && oracleOk; 图内子节点红? = exec 结果里存在
 * LeafResult.status === 'failed'):
 *
 * | converged | 图红 | 终态                      |
 * |-----------|------|---------------------------|
 * | 绿        | 无   | success (INV-1)           |
 * | 绿        | 有   | delivered-with-red (INV-2)|
 * | 红        | 无   | 失败终态 (INV-3)           |
 * | 红        | 有   | 失败终态 (INV-3, 交付没达标 > 节点红) |
 *
 * `delivered-with-red` 只在 `converged=true ∧ 图红`; `converged=false` 任何情况都给失败终态。
 * 实装锚: run-goal.ts N5 outcome 阶梯 (1131-1147)。此刻实装尚未改阶梯 —— 用例 ② 天然红,
 * 那正是这条闸要抓的缺口 (TEST→RED→IMPL→GREEN 波形第一步), 不许为让它绿而动 src/。
 * 全注入 (_classify / _runDag) — 零 live 模型、零真检索, 惯例逐字照抄 run-goal.test.ts。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGoal, type RunGoalConfig } from './run-goal';
import type { AcceptanceSpec, GoalClassification, GoalTier } from './classify-acceptance';
import type { ConductorPlan } from '../conductor-plan';
import type { ExecutorDagConfig, ExecutorDagResult } from '../dag/types';
import { pinLegacyExecutionPath } from './pin-legacy-path';

// P3 S6b (2026-09-02): 本文件钉 P3 之前的执行路径 (fake _runDag 产 `execute` 节点); 循环路径的判据见 orchestrating-loop.test.ts。
pinLegacyExecutionPath();

const ACC_EXEC: AcceptanceSpec = { kind: 'executable', command: 'bun test', expectExit: 0 };
const cls =
  (tier: GoalTier, acceptance: AcceptanceSpec = ACC_EXEC) =>
  async (): Promise<GoalClassification> => ({ tier, acceptance });

/** 契约段缺省结果 (复杂档先跑契约段, 与本文件无关, 照抄 run-goal.test.ts 的形状)。 */
function contractDag(): ExecutorDagResult {
  return {
    plan: { name: 'goal-contract', nodes: {} },
    results: {
      contract: {
        id: 'contract', status: 'done', kind: 'conductor',
        output: '# SDD\n...', deps: [], usage: { in: 1, out: 1 },
      },
    },
  } as unknown as ExecutorDagResult;
}

/**
 * 造一份「执行段 conductor 节点」的执行结果 (同 run-goal.test.ts 的注入面)。
 * `converged` 是内环结论 (runGoal 的 loopOk 取自它); `redLeaf` 往图里塞一个
 * status === 'failed' 的叶子节点 —— outcome-partial 真值表「图红」那一列的判据。
 */
function executeDag(
  opts: {
    converged?: boolean;
    accept?: 'done' | 'failed' | 'absent';
    status?: 'done' | 'failed';
    redLeaf?: boolean;
  } = {},
): ExecutorDagResult {
  const accept = opts.accept ?? 'done';
  return {
    plan: { name: 'goal-execute', nodes: {} },
    results: {
      ...(accept === 'absent'
        ? {}
        : {
            accept: {
              id: 'accept', status: accept, kind: 'command', output: accept === 'done' ? '' : '[exit 1]',
              deps: ['execute'], usage: { in: 0, out: 0 }, timedOut: false, signal: null,
            },
          }),
      ...(opts.redLeaf
        ? {
            'execute::leaf-b': {
              id: 'execute::leaf-b', status: 'failed', kind: 'agent',
              output: '[子节点红了]', deps: ['execute'], usage: { in: 1, out: 1 }, filesTouched: [],
            },
          }
        : {}),
      execute: {
        id: 'execute',
        status: opts.status ?? 'done',
        kind: 'conductor',
        output: '[conductor 子图: 1/2 成功]',
        deps: [],
        usage: { in: 1, out: 1 },
        rounds: 1,
        ...(opts.converged === undefined ? {} : { converged: opts.converged }),
      },
    },
    reusedNodes: [],
  } as unknown as ExecutorDagResult;
}

/** 两段共用一个 `_runDag`, 按 plan.name 路由 (省略的那段走缺省)。 */
const dagRouter = (h: {
  contract?: (plan: ConductorPlan) => Promise<ExecutorDagResult>;
  execute?: (plan: ConductorPlan) => Promise<ExecutorDagResult>;
}) =>
  (async (plan: ConductorPlan) =>
    plan.name === 'goal-execute'
      ? await (h.execute ?? (async () => executeDag({ converged: true })))(plan)
      : await (h.contract ?? (async () => contractDag()))(plan)) as never;

const dirs: string[] = [];
function cfg(dag: Partial<ExecutorDagConfig> = {}, extra: Partial<RunGoalConfig> = {}): RunGoalConfig {
  const cwd = mkdtempSync(join(tmpdir(), 'omd-goal-'));
  dirs.push(cwd);
  return {
    cwd,
    dag: { conductorModel: 'c:m', leafModel: 'l:m', ...dag } as ExecutorDagConfig,
    _today: () => '2026-07-28',
    _runDag: dagRouter({}),
    ...extra,
  };
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// ── #165① outcome-partial: 终态词按 (converged, 图红) 真值表落, 红节点不漂白 ──────────
describe('#165① outcome-partial: 终态语义闸 (delivered-with-red 只在判据绿∧图红)', () => {
  // 反向自检: 把 outcome 阶梯的 no-red 分支改成 'delivered-with-red'，用例 #165①-1 红。
  test('#165①-1 绿 ∧ 图内无红 → success 且 converged=true (判据绿收敛的最干净终态)', async () => {
    const r = await runGoal('goal', {
      ...cfg(),
      _classify: cls('complex'),
      _runDag: dagRouter({ execute: async () => executeDag({ converged: true }) }),
    });
    expect(r.converged).toBe(true);
    expect(r.outcome).toBe('success');
  });

  // 反向自检: 把阶梯里「converged∧图红」改成 'not-converged' 或失败，用例 #165①-2 红。
  test('#165①-2 绿 ∧ 图内有红 → delivered-with-red, 且红节点 status 仍是 failed (不漂白)', async () => {
    let execResult: ExecutorDagResult | undefined;
    const r = await runGoal('goal', {
      ...cfg(),
      _classify: cls('complex'),
      _runDag: dagRouter({ execute: async () => (execResult = executeDag({ converged: true, redLeaf: true })) }),
    });
    expect(r.converged).toBe(true);
    expect(r.outcome).toBe('delivered-with-red');
    // 终态词不许把红节点漂白: 注入进 runGoal 的那份结果里, 红叶子的 status 必须原样是 failed。
    expect(execResult!.results['execute::leaf-b']!.status).toBe('failed');
  });

  // 反向自检: 删掉「判据红优先失败」判断，用例 #165①-3 红。
  test('#165①-3 红 ∧ 图内无红 → 落失败终态, 不出 delivered-with-red', async () => {
    const r = await runGoal('goal', {
      ...cfg(),
      _classify: cls('complex'),
      _runDag: dagRouter({ execute: async () => executeDag({ converged: false }) }),
    });
    expect(r.converged).toBe(false);
    expect(r.outcome).not.toBe('delivered-with-red');
    expect(r.outcome).toBe('not-converged');
  });

  // 反向自检: 若红节点分支抢在 converged=false 之前返回 'delivered-with-red'，用例 #165①-4 红。
  test('#165①-4 红 ∧ 图内有红 → 交付没达标优先于节点红, 落失败终态', async () => {
    const r = await runGoal('goal', {
      ...cfg(),
      _classify: cls('complex'),
      _runDag: dagRouter({ execute: async () => executeDag({ converged: false, redLeaf: true }) }),
    });
    expect(r.converged).toBe(false);
    expect(r.outcome).not.toBe('delivered-with-red');
    expect(r.outcome).toBe('not-converged');
  });
});
