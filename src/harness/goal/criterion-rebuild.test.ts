/**
 * INV-4 判据重建边 —— 契约 `docs/plan/2026-08-29-veto-feedback-revision-edges.md` D-4 / GWT-4。
 *
 * ## 它治的那个病 (归因样本 A 桶 6/12)
 *
 * leaf 多数把活干对了, 判据命令却写错了路径/错目录 —— 而**没有任何人有权改判据**
 * (D-I 把它冻在环外, 防的是执行体移球门)。于是修复轮一轮轮烧, 每轮读到**逐字相同**的
 * exitCode, 直到预算耗尽。#1 (改动落对文件、判据 grep 错目录)、#4 (四轮同 exitCode)。
 *
 * ## 边界 (诚实标注, 别把它读成"判据已经会自己修好了")
 *
 * 重建出来的判据**不参与本 run 的终态判定** —— 让执行体家族提的判据当场决定自己的成败,
 * 正是 D-J 整套防作弊要杀的形态。本片做的是: 触发 → 重建 → 过全部自证门 → **留痕**,
 * 交给 owner / 下一次点火采纳。「重建判据当场冻结进下一轮」要等内环把重建轮接进来。
 *
 * ## 反向自检 (每条新分支当场证伪过一次)
 *
 *  · `shouldRebuildCriterion` 去掉 `alreadyRebuilt` 那一支 ⇒ 「第二次触发不再重建」当场红;
 *  · 去掉「两轮都要有非空 diff」那一条 ⇒ 「同 exitCode 但 leaf 空手」当场红;
 *  · `criterionRebuildAdmission` 把 `ran===false` 当放行 ⇒ 「门没跑成不准冻结」当场红;
 *  · 接线里去掉留痕串 ⇒ 「摘要含 criterion-rebuild」当场红。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runGoal,
  shouldRebuildCriterion,
  criterionRebuildAdmission,
  CRITERION_REBUILD_LABEL,
  type RunGoalConfig,
} from './run-goal';
import type { GoalClassification } from './classify-acceptance';
import type { ConductorPlan } from '../conductor-plan';
import type { ExecutorDagConfig, ExecutorDagResult } from '../dag/types';
import type { VerifierVerdict } from '../verifier';

// ── 纯核 ①: 触发谓词 ────────────────────────────────────────────────────────

const twoSameRounds = [
  { exitCode: 4, touched: 3 },
  { exitCode: 4, touched: 2 },
] as const;

describe('INV-4 纯核: shouldRebuildCriterion —— 两条触发路 + 一次上限', () => {
  test('★ 路 ①: 否决分型指向判据 ⇒ 重建 (哪怕只跑过一轮)', () => {
    const d = shouldRebuildCriterion({ verdictTarget: 'criterion', rounds: [{ exitCode: 1, touched: 0 }], alreadyRebuilt: false });
    expect(d.rebuild).toBe(true);
    expect(d.reason).toContain('criterion');
  });

  test('★ 路 ②: 连续 2 轮 exitCode 逐字相同且两轮 leaf 都有非空 diff ⇒ 重建', () => {
    const d = shouldRebuildCriterion({ verdictTarget: 'implementation', rounds: [...twoSameRounds], alreadyRebuilt: false });
    expect(d.rebuild).toBe(true);
    expect(d.reason).toContain('exitCode');
  });

  test('★ 判别力: 同 exitCode 但有一轮 leaf 空手 ⇒ 不重建 (那是执行侧没动, 不是判据瞎)', () => {
    const d = shouldRebuildCriterion({
      verdictTarget: 'implementation',
      rounds: [
        { exitCode: 4, touched: 3 },
        { exitCode: 4, touched: 0 },
      ],
      alreadyRebuilt: false,
    });
    expect(d.rebuild).toBe(false);
  });

  test('★ 判别力: exitCode 变了 ⇒ 不重建 (判据在动, 它量得出差别)', () => {
    const d = shouldRebuildCriterion({
      verdictTarget: 'implementation',
      rounds: [
        { exitCode: 4, touched: 3 },
        { exitCode: 1, touched: 3 },
      ],
      alreadyRebuilt: false,
    });
    expect(d.rebuild).toBe(false);
  });

  test('★ 判别力: exitCode 缺席 (null/undefined) 不算「逐字相同」—— NULL ≠ 0 ≠ 不适用', () => {
    expect(
      shouldRebuildCriterion({
        rounds: [
          { exitCode: null, touched: 3 },
          { exitCode: null, touched: 3 },
        ],
        alreadyRebuilt: false,
      }).rebuild,
    ).toBe(false);
    expect(
      shouldRebuildCriterion({
        rounds: [
          { exitCode: undefined, touched: 3 },
          { exitCode: undefined, touched: 3 },
        ],
        alreadyRebuilt: false,
      }).rebuild,
    ).toBe(false);
  });

  test('★ GWT-4 后半: 第二次触发时不再重建 (每 run 至多 1 次)', () => {
    const d = shouldRebuildCriterion({ verdictTarget: 'criterion', rounds: [...twoSameRounds], alreadyRebuilt: true });
    expect(d.rebuild).toBe(false);
    expect(d.reason).toContain('已重建');
  });

  test('一轮都没跑过 / 只跑了一轮 ⇒ 不重建 (没有"连续两轮"这回事)', () => {
    expect(shouldRebuildCriterion({ rounds: [], alreadyRebuilt: false }).rebuild).toBe(false);
    expect(shouldRebuildCriterion({ rounds: [{ exitCode: 4, touched: 3 }], alreadyRebuilt: false }).rebuild).toBe(false);
  });
});

// ── 纯核 ②: 自证门准入 ──────────────────────────────────────────────────────

describe('INV-4 纯核: criterionRebuildAdmission —— 全过才准冻结 (fail-closed)', () => {
  test('全部门都跑了且都放行 ⇒ 准入', () => {
    const a = criterionRebuildAdmission([
      { name: '命令闸', ran: true, reason: null },
      { name: '空世界自检', ran: true, reason: null },
    ]);
    expect(a.admitted).toBe(true);
  });

  test('★ 判别力: 任一门拒 ⇒ 不准入, 拒因原文进 why', () => {
    const a = criterionRebuildAdmission([
      { name: '命令闸', ran: true, reason: '[blocked missing-path-arg: 路径参数不存在 …]' },
      { name: '空世界自检', ran: true, reason: null },
    ]);
    expect(a.admitted).toBe(false);
    expect(a.why).toContain('路径参数不存在');
  });

  test('★ 判别力: 门没跑成 ⇒ 不准入 (拿不到证明就不准冻结, 不是 fail-open)', () => {
    const a = criterionRebuildAdmission([
      { name: '命令闸', ran: true, reason: null },
      { name: '空世界自检', ran: false, reason: null },
    ]);
    expect(a.admitted).toBe(false);
    expect(a.why).toContain('没跑成');
  });

  test('一道门都没有 ⇒ 不准入 (空集不算"全过")', () => {
    expect(criterionRebuildAdmission([]).admitted).toBe(false);
  });
});

// ── 接线面 ──────────────────────────────────────────────────────────────────

const leaf = (over: Record<string, unknown>): Record<string, unknown> => ({
  id: 'x',
  status: 'done',
  kind: 'agent',
  output: '',
  deps: [],
  usage: { in: 1, out: 1 },
  ...over,
});

/** 两轮判据 exitCode 均为 4、两轮 leaf 都有非空 diff 的一次 run。 */
const rebuildRun = async (over: Partial<RunGoalConfig> = {}): Promise<Awaited<ReturnType<typeof runGoal>>> => {
  const cwd = mkdtempSync(join(tmpdir(), 'omd-criterion-rebuild-'));
  writeFileSync(join(cwd, 'out.txt'), 'OK\n');
  const verifier = (async (): Promise<VerifierVerdict> => ({
    pass: false,
    reason: '判据命令指向仓里不存在的目录',
    target: 'implementation',
    usage: { in: 0, out: 0 },
  })) as ExecutorDagConfig['verifier'];
  return runGoal('做一件事', {
    cwd,
    dag: {
      conductorModel: 'c:m',
      leafModel: 'l:m',
      verifier,
      // 空世界自检要跑得起来才可能准入 —— 这条 runner 在"活还没干"的世界里判红 (exit 1),
      // 于是重建出的判据不是恒绿的。
      commandRunner: (async () => ({ exitCode: 1, text: '' })) as never,
    } as ExecutorDagConfig,
    _today: () => '2026-08-29',
    _classify: (async (): Promise<GoalClassification> => ({
      tier: 'simple',
      acceptance: { kind: 'executable', command: 'grep -q OK missing-dir/out.txt', expectExit: 0 },
    })) as RunGoalConfig['_classify'],
    _rebuildCriterion: (async () => ({ command: 'grep -q OK out.txt', expectExit: 0 })) as RunGoalConfig['_rebuildCriterion'],
    _runDag: (async (plan: ConductorPlan, dagCfg: ExecutorDagConfig): Promise<ExecutorDagResult> => {
      for (let round = 1; round <= 2; round += 1) {
        await dagCfg.verifier!({
          task: '',
          plan,
          results: {
            execute: leaf({ id: 'execute', filesTouched: [join(cwd, 'out.txt')], artifactRoot: cwd }),
            accept: leaf({ id: 'accept', kind: 'command', status: 'failed', exitCode: 4 }),
          } as never,
        });
      }
      return {
        plan,
        results: {
          execute: leaf({ id: 'execute', kind: 'conductor', rounds: 2, converged: false }),
          accept: leaf({ id: 'accept', kind: 'command', status: 'failed', exitCode: 4 }),
        },
        reusedNodes: [],
        verification: { pass: false, reason: '判据命令指向仓里不存在的目录', attempts: 2, escalated: true, conductorModel: 'c:m' },
      } as unknown as ExecutorDagResult;
    }) as never,
    ...over,
  });
};

describe('INV-4 接线 (GWT-4): 两轮同 exitCode + 两轮非空 diff ⇒ 走判据重建分支', () => {
  test('★ 留痕含 criterion-rebuild (result 与摘要两面都要看得见)', async () => {
    const r = await rebuildRun();
    expect(r.criterionRebuild).toBeDefined();
    expect(r.criterionRebuild!.trigger).toContain('exitCode');
    expect(r.stages.at(-1)!.summary).toContain(CRITERION_REBUILD_LABEL);
  });

  test('★ 重建出的判据过了全部自证门才记 admitted, 且原文带出来', async () => {
    const r = await rebuildRun();
    expect(r.criterionRebuild!.proposed).toBe('grep -q OK out.txt');
    expect(r.criterionRebuild!.admitted).toBe(true);
  });

  test('★ 判别力: 重建出的判据过不了门 (路径参数不存在) ⇒ 不准入, 拒因原文进 result', async () => {
    const r = await rebuildRun({
      _rebuildCriterion: (async () => ({ command: 'grep -q OK nowhere/out.ts', expectExit: 0 })) as RunGoalConfig['_rebuildCriterion'],
    });
    expect(r.criterionRebuild!.admitted).toBe(false);
    expect(r.criterionRebuild!.why).toContain('路径参数不存在');
  });

  test('★ 判别力: 重建者缺席 (没注入 / 无 agentRunner) ⇒ 触发照记, 但不假装重建过', async () => {
    const r = await rebuildRun({ _rebuildCriterion: undefined });
    expect(r.criterionRebuild).toBeDefined();
    expect(r.criterionRebuild!.proposed).toBeUndefined();
    expect(r.criterionRebuild!.admitted).toBe(false);
    expect(r.criterionRebuild!.why).toContain('重建者缺席');
  });

  test('★ 判别力: 判据没纹丝不动 (两轮 exitCode 不同) ⇒ 整段不触发', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-criterion-norebuild-'));
    const verifier = (async (): Promise<VerifierVerdict> => ({
      pass: false,
      reason: '实装没满足要求',
      target: 'implementation',
      usage: { in: 0, out: 0 },
    })) as ExecutorDagConfig['verifier'];
    const r = await runGoal('做一件事', {
      cwd,
      dag: { conductorModel: 'c:m', leafModel: 'l:m', verifier } as ExecutorDagConfig,
      _today: () => '2026-08-29',
      _classify: (async (): Promise<GoalClassification> => ({
        tier: 'simple',
        acceptance: { kind: 'executable', command: 'grep -q OK out.txt', expectExit: 0 },
      })) as RunGoalConfig['_classify'],
      _rebuildCriterion: (async () => ({ command: 'grep -q OK out.txt' })) as RunGoalConfig['_rebuildCriterion'],
      _runDag: (async (plan: ConductorPlan, dagCfg: ExecutorDagConfig): Promise<ExecutorDagResult> => {
        for (const exitCode of [4, 1]) {
          await dagCfg.verifier!({
            task: '',
            plan,
            results: {
              execute: leaf({ id: 'execute', filesTouched: [join(cwd, 'out.txt')], artifactRoot: cwd }),
              accept: leaf({ id: 'accept', kind: 'command', status: 'failed', exitCode }),
            } as never,
          });
        }
        return {
          plan,
          results: {
            execute: leaf({ id: 'execute', kind: 'conductor', rounds: 2, converged: false }),
            accept: leaf({ id: 'accept', kind: 'command', status: 'failed', exitCode: 1 }),
          },
          reusedNodes: [],
        } as unknown as ExecutorDagResult;
      }) as never,
    });
    expect(r.criterionRebuild).toBeUndefined();
    expect(r.stages.at(-1)!.summary).not.toContain(CRITERION_REBUILD_LABEL);
  });
});
