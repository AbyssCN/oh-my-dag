/**
 * solve 直通入口 (SDD 2026-08-10-solve-sdd-direct-entry) —— 装载件 + runGoal 接线。
 *
 * 钉两件事:
 *  ① fail-loud (G-2/G-5): 缺契约/分解段的文档**起跑即拒**, 错误指名缺段 —— 静默降级回全程
 *     goal 比不支持更坏 (调用方以为省了 224.5k 转录税, 实际付了全价)。
 *  ② 零转录 (G-1): sddPath 给了 → _runDag 只见 goal-execute 一张图 (契约段零展开),
 *     specPath = sddPath, SDD 全文原样进 execute 任务文本 (含并行波形)。
 *
 * 反向自检 (实跑过): 把 run-goal.ts 里 `if (sdd)` 那个分支临时改成 `if (false)` →
 * 本文件「只展开 goal-execute」当场红 (契约图出现)。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSddContract } from './sdd-direct';
import { runGoal, type RunGoalConfig } from './run-goal';
import type { AcceptanceSpec, GoalClassification } from './classify-acceptance';
import type { ConductorPlan } from '../conductor-plan';
import type { ExecutorDagConfig, ExecutorDagResult } from '../dag/types';

const SDD_OK = [
  '# 测试契约',
  '## 目标 (Destination)',
  '一句话。',
  '## 契约 (Contracts)',
  '- G-1 Given/When/Then。',
  '## 分解 (Breakdown)',
  '并行波形:{1,2} → {3}',
].join('\n');

const tmpSdd = (text: string): string => {
  const p = join(mkdtempSync(join(tmpdir(), 'omd-sdd-')), 'x.md');
  writeFileSync(p, text);
  return p;
};

describe('loadSddContract (fail-loud, G-2)', () => {
  test('六段齐的 SDD 装载成功, 原文逐字保留', () => {
    const p = tmpSdd(SDD_OK);
    const c = loadSddContract(p);
    expect(c.path).toBe(p);
    expect(c.text).toBe(SDD_OK);
  });

  test('缺契约段 → 拒, 错误指名缺段', () => {
    const p = tmpSdd('# 散文\n## 分解 (Breakdown)\n1. 做事');
    expect(() => loadSddContract(p)).toThrow(/契约/);
  });

  test('缺分解段 → 拒', () => {
    const p = tmpSdd('# 散文\n## 契约 (Contracts)\n- G-1');
    expect(() => loadSddContract(p)).toThrow(/分解/);
  });

  test('文件不存在 → 拒 (不静默)', () => {
    expect(() => loadSddContract('/nonexistent/x.md')).toThrow(/读不到/);
  });

  test('英文段名 (Contracts/Breakdown) 同样合法', () => {
    const p = tmpSdd('# t\n## Contracts\n- G-1\n## Breakdown\nwave: {1}');
    expect(() => loadSddContract(p)).not.toThrow();
  });
});

describe('runGoal 直通接线 (G-1 零转录)', () => {
  const ACC: AcceptanceSpec = { kind: 'executable', command: 'bun test', expectExit: 0 };
  const classify = async (): Promise<GoalClassification> => ({ tier: 'complex', acceptance: ACC });

  const execOk = (): ExecutorDagResult =>
    ({
      plan: { name: 'goal-execute', nodes: {} },
      results: {
        accept: { id: 'accept', status: 'done', kind: 'command', output: '', deps: ['execute'], usage: { in: 0, out: 0 } },
        execute: { id: 'execute', status: 'done', kind: 'conductor', output: '[ok]', deps: [], usage: { in: 1, out: 1 }, rounds: 1, converged: true },
      },
      reusedNodes: [],
    }) as unknown as ExecutorDagResult;

  const run = async (sddPath: string) => {
    const seenPlans: ConductorPlan[] = [];
    const seenTexts: string[] = [];
    const config: RunGoalConfig = {
      cwd: mkdtempSync(join(tmpdir(), 'omd-direct-')),
      dag: { conductorModel: 'c:m', leafModel: 'l:m' } as ExecutorDagConfig,
      _classify: classify,
      _runDag: (async (plan: ConductorPlan) => {
        seenPlans.push(plan);
        seenTexts.push(JSON.stringify(plan));
        return execOk();
      }) as never,
      sddPath,
    };
    const r = await runGoal('按 SDD 执行', config);
    return { r, seenPlans, seenTexts };
  };

  test('只展开 goal-execute —— 契约段子图零展开 (G-1 台账无 goal-contract)', async () => {
    const { seenPlans } = await run(tmpSdd(SDD_OK));
    expect(seenPlans.length).toBe(1);
    expect(seenPlans[0]!.name).toBe('goal-execute');
  });

  test('specPath = sddPath, SDD 全文 (含波形) 进 execute 任务文本', async () => {
    const p = tmpSdd(SDD_OK);
    const { r, seenTexts } = await run(p);
    expect(r.specPath).toBe(p);
    expect(seenTexts[0]).toContain('并行波形');
    // G-6 探针回归: 基座 specPath 不得进 execute 文本 (leaf 会拿它当仓根写出隔离树);
    // 改念执行根。证伪: 还原 run-goal 那个三元分支 → 本断言当场红。
    expect(seenTexts[0]).toContain('执行根');
    expect(seenTexts[0]).not.toContain(p);
    expect(r.stages.some((s) => s.summary.includes('SDD 直通'))).toBe(true);
  });

  test('坏 SDD → runGoal 起跑即抛, 一张图都不展开 (G-2)', async () => {
    const seenPlans: ConductorPlan[] = [];
    const config: RunGoalConfig = {
      cwd: mkdtempSync(join(tmpdir(), 'omd-direct-')),
      dag: { conductorModel: 'c:m', leafModel: 'l:m' } as ExecutorDagConfig,
      _classify: classify,
      _runDag: (async (plan: ConductorPlan) => {
        seenPlans.push(plan);
        return execOk();
      }) as never,
      sddPath: tmpSdd('# 散文而已'),
    };
    await expect(runGoal('g', config)).rejects.toThrow(/缺段/);
    expect(seenPlans.length).toBe(0);
  });
});
