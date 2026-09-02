/**
 * src/harness/goal/contract-stage-gate.test —— INV-11 (D-26 / D-27, 2026-09-02)
 *
 * 契约段(survey / research / spec)的唯一触发换成了 `sddPath` —— `tier` 不再门控它。
 * 两格钉住 D-27 的表态:
 *
 *   ① 无 sddPath (不论 tier) → 契约段调用 0 次, 三 stage 全 skipped, specSource='loop'。
 *   ② 有 sddPath 且 prior.contract 命中 → 走闸 C 复用分支, 不重转录 (防它变成永不执行的死代码——
 *      D-27 的 why 段写明: 若把 `if (tier==='complex')` 直接换成 `if (sdd)` 而不重排分支顺序,
 *      sdd-direct 恒先命中, 复用分支永远够不着)。
 *
 * 反向自检 (证伪方式):
 *   ① 把 run-goal.ts 的门控从 `if (sdd)` 改回 `if (tier === 'complex')` → 第一格红
 *      (tier=complex 时契约段调用变回 >0 次, stages 不再是 skipped)。
 *   ② 把 `if (sdd) { if (priorContract...) ... else sdd-direct }` 的分支顺序颠倒
 *      (sdd-direct 判在 priorContract 判之前) → 第二格红 (复用分支永不可达, summary 变成
 *      "SDD 直通" 而不是 "闸 C")。
 *   ③ (P2 回流修正, 2026-09-02) 把 run-goal.ts:1394 条件里的 `existsSync(priorContract.specPath)`
 *      摘掉 (只留 `priorContract` 真值判断) → 第三格红 (specPath 指向盘上不存在的文件时仍误判复用,
 *      summary 变成"闸 C"而不是"SDD 直通")。
 */
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runGoal } from './run-goal';
import type { GoalTier } from './classify-acceptance';
import type { ConductorPlan } from '../conductor-plan';
import type { ExecutorDagConfig, ExecutorDagResult } from '../dag/types';

const executeDag = (): ExecutorDagResult =>
  ({
    plan: { name: 'goal-execute', nodes: {} },
    results: {
      execute: { id: 'execute', status: 'done', kind: 'conductor', output: 'ok', deps: [], usage: { in: 1, out: 1 }, rounds: 1, converged: true },
    },
    reusedNodes: [],
  }) as unknown as ExecutorDagResult;

/** 契约段假图 (若被误调用会被 `contractCalls` 计数捉到)。 */
const contractDag = (): ExecutorDagResult =>
  ({
    plan: { name: 'goal-contract', nodes: {} },
    results: {
      contract: { id: 'contract', status: 'done', kind: 'agent', output: '不该发生', deps: [], usage: { in: 1, out: 1 }, filesTouched: [] },
    },
    reusedNodes: [],
  }) as unknown as ExecutorDagResult;

describe('INV-11 ① —— 无 sddPath (不论 tier) → 契约段调用 0 次, 三 stage skipped, specSource=loop', () => {
  const runNoSdd = async (tier: GoalTier, agentRunner?: ExecutorDagConfig['agentRunner']) => {
    let contractCalls = 0;
    const cwd = mkdtempSync(join(tmpdir(), 'omd-contract-gate-'));
    const r = await runGoal('给 omd 加一个字段', {
      cwd,
      dag: { conductorModel: 'c:m', ...(agentRunner ? { agentRunner } : {}) } as ExecutorDagConfig,
      _classify: async () => ({ tier, acceptance: { kind: 'exploratory' as const, learningGoal: 'x', affordableLoss: 'y' } }),
      _runDag: async (plan: ConductorPlan) => {
        if (plan.name === 'goal-contract') {
          contractCalls++;
          return contractDag();
        }
        return executeDag();
      },
    });
    return { r, contractCalls };
  };

  test('★ tier=complex 且无 sddPath → conductor 契约段调用 0 次, 三 stage skipped, specSource=loop', async () => {
    const { r, contractCalls } = await runNoSdd('complex', (async () => ({ text: 'x', usage: { in: 1, out: 1 } })) as never);
    expect(contractCalls).toBe(0); // 零契约段调用 (INV-11)
    expect(r.stages.map((s) => `${s.stage}:${s.status}`)).toEqual([
      'classify:done',
      'survey:skipped',
      'research:skipped',
      'spec:skipped',
      'execute:done',
    ]);
    expect(r.specPath).toBeUndefined();
  });

  test('tier=simple 且无 sddPath → 同样零调用, 三 stage skipped (与 tier 取值无关)', async () => {
    const { r, contractCalls } = await runNoSdd('simple');
    expect(contractCalls).toBe(0);
    expect(r.stages.map((s) => `${s.stage}:${s.status}`)).toEqual([
      'classify:done',
      'survey:skipped',
      'research:skipped',
      'spec:skipped',
      'execute:done',
    ]);
  });
});

describe('INV-11 ② —— 有 sdd + prior.contract 命中 → 走闸 C 复用分支, 不重转录', () => {
  test('★ prior.contract.specPath 存在于盘上 → 复用, execute 之外零 _runDag 调用', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-contract-gate-c-'));
    const goal = '续跑一个带闸 C 契约的目标';
    const runId = 'gate-c-run';
    const goalHash = createHash('sha256').update(goal).digest('hex');
    const stateDir = join(cwd, '.omd', 'continuity', runId);
    mkdirSync(stateDir, { recursive: true });

    const priorSpecPath = join(cwd, 'docs', 'plan', 'prior-contract.md');
    mkdirSync(dirname(priorSpecPath), { recursive: true });
    writeFileSync(priorSpecPath, '# 旧契约正文 (续跑前那一趟产的)');

    writeFileSync(
      join(stateDir, 'goal-state.json'),
      JSON.stringify({
        goalHash,
        classified: { tier: 'complex', acceptance: { kind: 'exploratory', learningGoal: 'x', affordableLoss: 'y' } },
        contract: {
          specPath: priorSpecPath,
          evidence: '# 旧契约正文 (续跑前那一趟产的)',
          repoContext: 'src/a.ts:1 — 老勘察事实',
          sources: [],
        },
      }),
    );

    const sddPath = join(cwd, 'sdd.md');
    writeFileSync(
      sddPath,
      '# 契约\n\n## 契约\nNEW_SDD_MARKER 做这件事。\n\n## 分解\n1. 做 → verify: `bun test`\n',
    );

    const runDagCalls: string[] = [];
    const plans: ConductorPlan[] = [];
    const r = await runGoal(goal, {
      cwd,
      sddPath,
      dag: { conductorModel: 'c:m', leafModel: 'l:m', continuity: { manager: {} as never, runId } } as ExecutorDagConfig,
      _runDag: async (plan: ConductorPlan) => {
        runDagCalls.push(plan.name);
        plans.push(plan);
        return executeDag();
      },
    });

    // 不重转录: execute 之外没有第二次 _runDag 调用 (契约段没有一个独立子图要跑)。
    expect(runDagCalls).toEqual(['goal-execute']);
    // P1 回流修正 (review 264df08b): sdd 在场时 specPath/evidence 取本轮 sdd, 不许被旧契约
    // 顶掉 —— 复用分支只并入不冲突的旧勘察增量 (repoContext/sources)。
    expect(r.specPath).toBe(sddPath);
    expect(r.repoContext).toBe('src/a.ts:1 — 老勘察事实');
    const execPlan = plans.find((p) => p.name === 'goal-execute')!;
    const execGoal = String((execPlan.nodes.execute as { goal?: unknown }).goal ?? '');
    expect(execGoal).toContain('NEW_SDD_MARKER');
    expect(execGoal).not.toContain('旧契约正文');
    const survey = r.stages.find((s) => s.stage === 'survey')!;
    expect(survey.status).toBe('done');
    expect(survey.summary).toContain('闸 C');
    expect(r.stages.find((s) => s.stage === 'research')!.status).toBe('skipped');
    expect(r.stages.find((s) => s.stage === 'spec')!.status).toBe('done');
  });

  test('对照臂: 有 sdd 但**没有** prior.contract → 走 sdd-direct (复用分支不是恒命中)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-contract-gate-c2-'));
    const sddPath = join(cwd, 'sdd.md');
    writeFileSync(sddPath, '# 契约\n\n## 契约\n做这件事。\n\n## 分解\n1. 做 → verify: `bun test`\n');
    const r = await runGoal('目标乙 (无续跑状态)', {
      cwd,
      sddPath,
      dag: { conductorModel: 'c:m' } as ExecutorDagConfig,
      _runDag: async () => executeDag(),
    });
    expect(r.stages.find((s) => s.stage === 'spec')!.summary).toContain('SDD 直通');
    expect(r.specPath).toBe(sddPath);
  });

  test('P2 回流修正: prior.contract.specPath 记了但盘上文件已不在 → 不复用, 照走 sdd-direct (状态不是真源, 盘上文件才是)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-contract-gate-c3-'));
    const goal = '续跑一个契约文件已被清掉的目标';
    const runId = 'gate-c3-run';
    const goalHash = createHash('sha256').update(goal).digest('hex');
    const stateDir = join(cwd, '.omd', 'continuity', runId);
    mkdirSync(stateDir, { recursive: true });

    // ⚠ 故意不写这个文件到盘上 —— specPath 记了但盘上文件没了。
    const missingSpecPath = join(cwd, 'docs', 'plan', 'gone-contract.md');

    writeFileSync(
      join(stateDir, 'goal-state.json'),
      JSON.stringify({
        goalHash,
        classified: { tier: 'complex', acceptance: { kind: 'exploratory', learningGoal: 'x', affordableLoss: 'y' } },
        contract: {
          specPath: missingSpecPath,
          evidence: '# 旧契约正文 (盘上文件已清)',
          repoContext: 'src/a.ts:1 — 老勘察事实',
          sources: [],
        },
      }),
    );

    const sddPath = join(cwd, 'sdd.md');
    writeFileSync(sddPath, '# 契约\n\n## 契约\n做这件事。\n\n## 分解\n1. 做 → verify: `bun test`\n');

    const r = await runGoal(goal, {
      cwd,
      sddPath,
      dag: { conductorModel: 'c:m', leafModel: 'l:m', continuity: { manager: {} as never, runId } } as ExecutorDagConfig,
      _runDag: async () => executeDag(),
    });

    const survey3 = r.stages.find((s) => s.stage === 'survey')!;
    expect(survey3.status).toBe('skipped'); // sdd-direct 的 survey 是 skipped; 闸 C 复用是 done
    expect(survey3.summary).not.toContain('闸 C');
    expect(r.specPath).toBe(sddPath);
  });
});
