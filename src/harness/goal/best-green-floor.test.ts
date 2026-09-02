/**
 * INV-1 终态棘轮 (best-green) + INV-2 陈旧红因分道 ——
 * 契约 `docs/plan/2026-08-29-veto-feedback-revision-edges.md` D-1 / D-2 / GWT-1 / GWT-2。
 *
 * ## 它治的那个病 (归因样本 4/12)
 *
 * 第 1 轮冻结判据**真绿** → verifier 否决 → 重规划 → 毒集丢绿 + 半回滚 → 后续修复轮全挂
 * → 终态 `agent.patch` **0 字节**。已经达标的交付被销毁, 而回执上看不出"它曾经绿过"。
 * 棘轮只加在**终态**: 中轮毒集回滚语义一字不动 (D-2, 理由在 poison-rollback.ts 文件头)。
 *
 * ## 绿快照怎么来的 (实装自选那一半)
 *
 * 引擎每轮跑完调一次 verifier, **那一刻树还是那一轮的样子** —— 这是 run-goal 唯一够得着
 * "中间那一轮"的钩子 (内环封在 conductor 节点里, 结果面只剩最后一轮)。于是 run-goal 包一层
 * `config.dag.verifier`: 只观察不改判, 那一轮 accept 绿就把该轮 leaf 报过写的文件内容照下来。
 *
 * ## 反向自检 (每条新分支当场证伪过一次)
 *
 *  · `decideBestGreenFloor` 里把 `currentGreen` 那一支删掉 ⇒ 「终态已绿不动盘」当场红;
 *  · 把 `snapshotFiles === 0` 那一支改成 `restore` ⇒ 「快照收不全时不假装还原」当场红;
 *  · 接线里去掉 verifier 包装 ⇒ 「绿快照被还原回盘」当场红 (棘轮拿不到中间轮);
 *  · `classifyCriterionRed` 把 `everGreen` 恒判 true ⇒ 「从未转绿的 run 红因不含 rolled-back」当场红。
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runGoal,
  decideBestGreenFloor,
  classifyCriterionRed,
  BEST_GREEN_LABEL,
  type RunGoalConfig,
} from './run-goal';
import type { GoalClassification } from './classify-acceptance';
import type { ConductorPlan } from '../conductor-plan';
import type { ExecutorDagConfig, ExecutorDagResult } from '../dag/types';
import type { VerifierVerdict } from '../verifier';
import { pinLegacyExecutionPath } from './pin-legacy-path';

// P3 S6b (2026-09-02): 本文件钉 P3 之前的执行路径 (fake _runDag 产 `execute` 节点); 循环路径的判据见 orchestrating-loop.test.ts。
pinLegacyExecutionPath();

// ── 纯核 ①: 终态棘轮判定 ─────────────────────────────────────────────────────

describe('INV-1 纯核: decideBestGreenFloor —— 四格互不压平', () => {
  test('从没绿过 ⇒ none (棘轮无地板可守, 一行不多跑)', () => {
    const d = decideBestGreenFloor({ everGreen: false, currentGreen: false, terminalDiffFiles: 0, snapshotFiles: 3 });
    expect(d.action).toBe('none');
  });

  test('★ 终态判据绿 + diff 非空 ⇒ already-green (不动盘)', () => {
    const d = decideBestGreenFloor({ everGreen: true, currentGreen: true, terminalDiffFiles: 2, snapshotFiles: 3 });
    expect(d.action).toBe('already-green');
    expect(d.label).toContain(BEST_GREEN_LABEL);
  });

  test('★ 终态判据绿而 diff 空 ⇒ 仍要还原 (INV-1 的两个条件是与, 不是或)', () => {
    const d = decideBestGreenFloor({ everGreen: true, currentGreen: true, terminalDiffFiles: 0, snapshotFiles: 3 });
    expect(d.action).toBe('restore');
  });

  test('★ 曾绿 + 终态红 + 有快照 ⇒ restore', () => {
    const d = decideBestGreenFloor({ everGreen: true, currentGreen: false, terminalDiffFiles: 1, snapshotFiles: 3 });
    expect(d.action).toBe('restore');
    expect(d.label).toContain(BEST_GREEN_LABEL);
  });

  test('★ 终态判据绿 + diff 空 + **没有绿快照** ⇒ already-green (没有可比的地板就别喊狼)', () => {
    // 「判据绿而 diff 空」还有一条合法成因: 活已提交 (diff 面量的是未提交改动)。
    // 反向自检: 把这一支去掉 ⇒ 每一条把活提交掉的绿 run 都会收到一句"终态低于那次绿"。
    const d = decideBestGreenFloor({ everGreen: true, currentGreen: true, terminalDiffFiles: 0, snapshotFiles: 0 });
    expect(d.action).toBe('already-green');
  });

  test('★ 曾绿 + 终态红 + 快照收不全 (0 文件) ⇒ unrestorable —— 说出来, 不假装还原', () => {
    const d = decideBestGreenFloor({ everGreen: true, currentGreen: false, terminalDiffFiles: 1, snapshotFiles: 0 });
    expect(d.action).toBe('unrestorable');
    expect(d.label).toContain(BEST_GREEN_LABEL);
  });

  test('★ diff 取不到 (undefined ≠ 0) ⇒ 不因"diff 空"去动盘', () => {
    // 非 git 仓 / git status 抛 —— 「不知道」不许被念成「空」(仓规坑 ①)。
    const d = decideBestGreenFloor({ everGreen: true, currentGreen: true, terminalDiffFiles: undefined, snapshotFiles: 3 });
    expect(d.action).toBe('already-green');
  });
});

// ── 纯核 ②: 陈旧红因分道 ─────────────────────────────────────────────────────

describe('INV-2 纯核: classifyCriterionRed —— 两个红因字面不同', () => {
  test('★ GWT-2 正面: 曾转绿而终态红 ⇒ rolled-back', () => {
    const c = classifyCriterionRed({ everGreen: true, replanned: true, recheckRan: true });
    expect(c.cause).toBe('rolled-back');
    expect(c.detail).toContain('rolled-back');
  });

  test('★ GWT-2 反面: 从未转绿 ⇒ never-green, 且红因**不含** rolled-back 串', () => {
    const c = classifyCriterionRed({ everGreen: false, replanned: true, recheckRan: true });
    expect(c.cause).toBe('never-green');
    expect(c.detail).not.toContain('rolled-back');
  });

  test('曾转绿但没重规划 ⇒ 仍是 rolled-back (口径是「低于绿快照」, 不是「谁回滚的」)', () => {
    expect(classifyCriterionRed({ everGreen: true, replanned: false, recheckRan: false }).cause).toBe('rolled-back');
  });

  test('复验跑没跑成写进 detail (fail-open 不吞证据)', () => {
    expect(classifyCriterionRed({ everGreen: true, replanned: true, recheckRan: false }).detail).toContain('没跑成');
  });

  test('★ P2b-runtime: harnessInconclusive=true ⇒ cause 是 harness-inconclusive, detail 带尾巴文本, 优先于 everGreen', () => {
    // 证伪: 把 classifyCriterionRed 里 harnessInconclusive 那条 if 挪到 everGreen 判定之后
    // (或删掉) → cause 落回 'rolled-back'/'never-green', 本条红。
    const c = classifyCriterionRed({
      everGreen: false,
      replanned: false,
      recheckRan: false,
      harnessInconclusive: true,
      tail: 'ERROR: file or directory not found',
    });
    expect(c.cause).toBe('harness-inconclusive');
    expect(c.detail).toContain('harness-inconclusive');
    expect(c.detail).toContain('ERROR: file or directory not found');
  });

  test('P2b-runtime 回归防呆: 不传新参数的既有两态调用形状行为逐字不变', () => {
    // 证明 harnessInconclusive/tail 是 optional-with-default, 不强迫既有调用点表态。
    expect(classifyCriterionRed({ everGreen: true, replanned: true, recheckRan: true }).cause).toBe('rolled-back');
    expect(classifyCriterionRed({ everGreen: false, replanned: true, recheckRan: true }).cause).toBe('never-green');
  });
});

// ── 接线面: 绿快照真被照下来、真被还原回盘 ───────────────────────────────────

const dissent = 'verifier 异议原文: 实装绕开了任务里的第 3 条要求 (shim 骗绿)';

const leaf = (over: Record<string, unknown>): Record<string, unknown> => ({
  id: 'x',
  status: 'done',
  kind: 'agent',
  output: '',
  deps: [],
  usage: { in: 1, out: 1 },
  ...over,
});

describe('INV-1 接线 (GWT-1): 第 1 轮绿 → 否决 → 回滚 → 终态还原到那次绿', () => {
  test('★ 终态树含绿快照的写集内容 · 摘要含 best-green · verifier 异议原文进 result', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-best-green-'));
    const artifact = join(cwd, 'delivered.txt');
    const verifier = (async (): Promise<VerifierVerdict> => ({
      pass: false,
      reason: dissent,
      target: 'implementation',
      usage: { in: 0, out: 0 },
    })) as ExecutorDagConfig['verifier'];

    const r = await runGoal('做一件事', {
      cwd,
      dag: { conductorModel: 'c:m', leafModel: 'l:m', verifier } as ExecutorDagConfig,
      _today: () => '2026-08-29',
      _classify: (async (): Promise<GoalClassification> => ({
        tier: 'simple',
        acceptance: { kind: 'executable', command: 'true', expectExit: 0 },
      })) as RunGoalConfig['_classify'],
      _runDag: (async (plan: ConductorPlan, dagCfg: ExecutorDagConfig): Promise<ExecutorDagResult> => {
        // 第 1 轮: 活真干了、冻结判据真绿 —— 判卷官在这一刻看见的就是这棵树。
        writeFileSync(artifact, '真交付');
        await dagCfg.verifier!({
          task: '',
          plan,
          results: {
            execute: leaf({ id: 'execute', filesTouched: [artifact], artifactRoot: cwd }),
            accept: leaf({ id: 'accept', kind: 'command', exitCode: 0 }),
          } as never,
        });
        // 否决 → 重规划 → 毒集丢绿 + 半回滚: 盘上那份真交付**没了**。
        rmSync(artifact);
        await dagCfg.verifier!({
          task: '',
          plan,
          results: {
            execute: leaf({ id: 'execute', status: 'failed' }),
            accept: leaf({ id: 'accept', kind: 'command', status: 'failed', exitCode: 1 }),
          } as never,
        });
        return {
          plan,
          results: {
            execute: leaf({ id: 'execute', kind: 'conductor', rounds: 2, converged: false }),
            accept: leaf({ id: 'accept', kind: 'command', status: 'failed', exitCode: 1 }),
          },
          reusedNodes: [],
          verification: { pass: false, reason: dissent, attempts: 2, escalated: true, conductorModel: 'c:m' },
        } as unknown as ExecutorDagResult;
      }) as never,
    });

    // ① 终态树 = 那次绿 (棘轮的全部意义: 已达标的交付不许被销毁)
    expect(existsSync(artifact)).toBe(true);
    expect(readFileSync(artifact, 'utf8')).toBe('真交付');
    // ② 摘要点名 best-green
    expect(r.stages.at(-1)!.summary).toContain(BEST_GREEN_LABEL);
    expect(r.bestGreenFloor?.action).toBe('restore');
    // ③ verifier 异议原文进 result (否决的理由不许只活在引擎日志里)
    expect(r.verifierDissent).toBe(dissent);
  });

  test('★ 判别力: 一轮都没绿过 ⇒ 棘轮不动盘, 摘要不提 best-green', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-best-green-none-'));
    const artifact = join(cwd, 'delivered.txt');
    const verifier = (async (): Promise<VerifierVerdict> => ({
      pass: false,
      reason: dissent,
      target: 'implementation',
      usage: { in: 0, out: 0 },
    })) as ExecutorDagConfig['verifier'];
    const r = await runGoal('做一件事', {
      cwd,
      dag: { conductorModel: 'c:m', leafModel: 'l:m', verifier } as ExecutorDagConfig,
      _today: () => '2026-08-29',
      _classify: (async (): Promise<GoalClassification> => ({
        tier: 'simple',
        acceptance: { kind: 'executable', command: 'true', expectExit: 0 },
      })) as RunGoalConfig['_classify'],
      _runDag: (async (plan: ConductorPlan, dagCfg: ExecutorDagConfig): Promise<ExecutorDagResult> => {
        writeFileSync(artifact, '半成品');
        await dagCfg.verifier!({
          task: '',
          plan,
          results: {
            execute: leaf({ id: 'execute', filesTouched: [artifact], artifactRoot: cwd }),
            accept: leaf({ id: 'accept', kind: 'command', status: 'failed', exitCode: 1 }),
          } as never,
        });
        rmSync(artifact);
        return {
          plan,
          results: {
            execute: leaf({ id: 'execute', kind: 'conductor', rounds: 1, converged: false }),
            accept: leaf({ id: 'accept', kind: 'command', status: 'failed', exitCode: 1 }),
          },
          reusedNodes: [],
        } as unknown as ExecutorDagResult;
      }) as never,
    });
    expect(existsSync(artifact)).toBe(false);
    expect(r.bestGreenFloor).toBeUndefined();
    expect(r.stages.at(-1)!.summary).not.toContain(BEST_GREEN_LABEL);
  });
});

describe('INV-2 接线 (GWT-2): 陈旧红的两个红因走不同字面', () => {
  const staleRun = async (recheckExit: number): Promise<Awaited<ReturnType<typeof runGoal>>> => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-stale-cause-'));
    return runGoal('做一件事', {
      cwd,
      dag: {
        conductorModel: 'c:m',
        leafModel: 'l:m',
        // 收尾复验: 最终这棵树上判据**不**成立 (绿是被回滚前那一轮量的)。
        commandRunner: (async () => ({ exitCode: recheckExit, text: '' })) as never,
      } as ExecutorDagConfig,
      _today: () => '2026-08-29',
      _classify: (async (): Promise<GoalClassification> => ({
        tier: 'simple',
        acceptance: { kind: 'executable', command: 'true', expectExit: 0 },
      })) as RunGoalConfig['_classify'],
      _runDag: (async (plan: ConductorPlan): Promise<ExecutorDagResult> =>
        ({
          plan,
          results: {
            execute: leaf({ id: 'execute', kind: 'conductor', rounds: 2, converged: true }),
            // accept 的绿是 resume 复用来的 (skipped), 而本 run 重规划过 ⇒ 判据陈旧闸开火。
            accept: leaf({ id: 'accept', kind: 'command', exitCode: 0, skipped: true }),
          },
          reusedNodes: [],
          verification: { pass: false, reason: dissent, attempts: 2, escalated: true, conductorModel: 'c:m' },
        }) as unknown as ExecutorDagResult) as never,
    });
  };

  test('★ 曾绿被回滚后收尾重量判红 ⇒ 红因含 rolled-back', async () => {
    const r = await staleRun(1);
    expect(r.criterionRedCause).toContain('rolled-back');
    expect(r.stages.at(-1)!.summary).toContain('rolled-back');
  });

  test('★ 判别力: 陈旧的绿在终态树上仍成立 ⇒ 压根不判红, 无红因', async () => {
    const r = await staleRun(0);
    expect(r.criterionRedCause).toBeUndefined();
  });

  test('★ 判别力: 从未转绿的 run 红因不含 rolled-back', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-never-green-'));
    const r = await runGoal('做一件事', {
      cwd,
      dag: { conductorModel: 'c:m', leafModel: 'l:m' } as ExecutorDagConfig,
      _today: () => '2026-08-29',
      _classify: (async (): Promise<GoalClassification> => ({
        tier: 'simple',
        acceptance: { kind: 'executable', command: 'true', expectExit: 0 },
      })) as RunGoalConfig['_classify'],
      _runDag: (async (plan: ConductorPlan): Promise<ExecutorDagResult> =>
        ({
          plan,
          results: {
            execute: leaf({ id: 'execute', kind: 'conductor', rounds: 2, converged: true }),
            accept: leaf({ id: 'accept', kind: 'command', status: 'failed', exitCode: 1 }),
          },
          reusedNodes: [],
        }) as unknown as ExecutorDagResult) as never,
    });
    expect(r.criterionRedCause).toBeDefined();
    expect(r.criterionRedCause).not.toContain('rolled-back');
    expect(r.criterionRedCause).toContain('never-green');
  });
});
