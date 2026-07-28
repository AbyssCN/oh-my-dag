/**
 * runGoal 契约测试 — INV-GOAL-1 (全自主) / INV-GOAL-4 (无环 + 有界)。
 * 全注入 (_classify / _iterate / researchRunner / agentRunner) — 零 live 模型、零真检索。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { goalSlug, runGoal, type RunGoalConfig } from './run-goal';
import type { ExecutorDagConfig } from '../executor-dag-types';
import type { IterateResult } from '../plan/iterate';

const okIterate = (rounds = 1, reused: string[] = []): IterateResult =>
  ({
    rounds: Array.from({ length: rounds }, (_, i) => ({ round: i + 1, result: {}, verdict: {} })),
    finalRound: { round: rounds, result: { reusedNodes: reused }, verdict: {} },
    converged: true,
    status: 'converged',
  }) as unknown as IterateResult;

function cfg(dag: Partial<ExecutorDagConfig> = {}, extra: Partial<RunGoalConfig> = {}): RunGoalConfig {
  return {
    cwd: mkdtempSync(join(tmpdir(), 'omd-goal-')),
    dag: { conductorModel: 'c:m', leafModel: 'l:m', ...dag } as ExecutorDagConfig,
    _today: () => '2026-07-28',
    _iterate: (async () => okIterate()) as never,
    ...extra,
  };
}

describe('runGoal — INV-GOAL-1 全自主 (阶段间零人工介入)', () => {
  test('complex 档: research → spec → execute 一次跑完, 每阶段留结论', async () => {
    const seen: string[] = [];
    const r = await runGoal('给 omd 加一个自主 goal 引擎', {
      ...cfg({
        researchRunner: async () => {
          seen.push('research');
          return { text: '研究终稿', usage: { in: 1, out: 1 }, sources: ['https://a.example'], reportPath: '/tmp/r.md' };
        },
        agentRunner: async ({ prompt }) => {
          seen.push('spec');
          // spec-author 卡的骨架进了 prompt (卡真被用上, 不是空喊)
          expect(prompt).toContain('## 契约 (Contracts)');
          expect(prompt).toContain('研究终稿'); // 证据真喂进去
          return { text: '# SDD\n...', usage: { in: 1, out: 1 }, filesTouched: ['docs/plan/2026-07-28-给-omd-加一个自主-goal-引擎.md'] };
        },
      }),
      _classify: async () => 'complex',
      _iterate: (async (task: string) => {
        seen.push('execute');
        expect(task).toContain('按下面这份 SDD 契约实施'); // 执行读的是契约不是对话
        return okIterate();
      }) as never,
    });
    expect(seen).toEqual(['research', 'spec', 'execute']); // 阶段序固定, 中间没有人
    expect(r.stages.map((s) => `${s.stage}:${s.status}`)).toEqual([
      'classify:done',
      'research:done',
      'spec:done',
      'execute:done',
    ]);
    expect(r.sources).toEqual(['https://a.example']);
    expect(r.specPath).toContain('2026-07-28-');
    expect(r.converged).toBe(true);
  });

  // D-5: 做法已定的活不该先花一轮 research + 一份 SDD。
  test('simple 档: 跳过 research/spec 直接执行', async () => {
    let task = '';
    const r = await runGoal('把 foo 重命名成 bar', {
      ...cfg({ researchRunner: async () => ({ text: 'x', usage: { in: 1, out: 1 }, sources: ['https://x'] }) }),
      _classify: async () => 'simple',
      _iterate: (async (t: string) => {
        task = t;
        return okIterate();
      }) as never,
    });
    expect(r.tier).toBe('simple');
    expect(r.stages.find((s) => s.stage === 'research')!.status).toBe('skipped');
    expect(r.sources).toEqual([]); // research 没跑 → 没有来源
    expect(task).toBe('把 foo 重命名成 bar'); // 原样进执行
  });
});

describe('runGoal — 降级路径都留痕, 不假装', () => {
  test('无 researchRunner → research skipped 且 spec 提示"无外部证据"', async () => {
    let prompt = '';
    const r = await runGoal('设计一个新机制', {
      ...cfg({
        agentRunner: async (i) => {
          prompt = i.prompt;
          return { text: 'spec', usage: { in: 1, out: 1 }, filesTouched: [] };
        },
      }),
      _classify: async () => 'complex',
    });
    expect(r.stages.find((s) => s.stage === 'research')!.status).toBe('skipped');
    expect(prompt).toContain('本次无外部证据');
    expect(prompt).toContain('必须进「未决」段');
  });

  // 零来源 = 假 grounded (与 research 节点闸同一判据): 记 failed 且**不当证据用**。
  test('research 零来源 → failed 且证据不进 spec', async () => {
    let prompt = '';
    const r = await runGoal('查点什么', {
      ...cfg({
        researchRunner: async () => ({ text: '看着像研究的一段话', usage: { in: 1, out: 1 }, sources: [] }),
        agentRunner: async (i) => {
          prompt = i.prompt;
          return { text: 'spec', usage: { in: 1, out: 1 }, filesTouched: [] };
        },
      }),
      _classify: async () => 'complex',
    });
    expect(r.stages.find((s) => s.stage === 'research')!.status).toBe('failed');
    expect(prompt).not.toContain('看着像研究的一段话');
    expect(prompt).toContain('本次无外部证据');
  });

  test('spec 没真写盘 → failed 但不断流程 (下游改用正文当契约)', async () => {
    const r = await runGoal('做点事', {
      ...cfg({
        agentRunner: async () => ({ text: '# SDD 正文', usage: { in: 1, out: 1 }, filesTouched: [] }),
      }),
      _classify: async () => 'complex',
    });
    expect(r.stages.find((s) => s.stage === 'spec')!.status).toBe('failed');
    expect(r.specPath).toBeUndefined();
    expect(r.stages.find((s) => s.stage === 'execute')!.status).toBe('done'); // 仍往下跑
  });

  test('execute 抛错 → 记 failed 并返回 (不把异常抛给调用方)', async () => {
    const r = await runGoal('做点事', {
      ...cfg(),
      _classify: async () => 'simple',
      _iterate: (async () => {
        throw new Error('conductor 崩了');
      }) as never,
    });
    expect(r.converged).toBe(false);
    expect(r.stages.at(-1)!.summary).toContain('conductor 崩了');
  });
});

describe('runGoal — INV-GOAL-4 有界 / INV-GOAL-3 可证', () => {
  test('执行轮数上限默认 2 (= 1 轮修复), 可覆盖', async () => {
    const seen: number[] = [];
    const spy = (async (_t: string, c: { maxRounds?: number }) => {
      seen.push(c.maxRounds!);
      return okIterate();
    }) as never;
    await runGoal('g', { ...cfg(), _classify: async () => 'simple', _iterate: spy });
    await runGoal('g', { ...cfg(), maxRounds: 5, _classify: async () => 'simple', _iterate: spy });
    expect(seen).toEqual([2, 5]);
  });

  test('research 内环轮数有界且透传 (默认 1)', async () => {
    const seen: (number | undefined)[] = [];
    const mk = (rounds?: number) =>
      runGoal('g', {
        ...cfg({
          researchRunner: async (i) => {
            seen.push(i.rounds);
            return { text: 't', usage: { in: 1, out: 1 }, sources: ['https://x'] };
          },
        }),
        ...(rounds ? { researchRounds: rounds } : {}),
        _classify: async () => 'complex',
      });
    await mk();
    await mk(3);
    expect(seen).toEqual([1, 3]);
  });

  test('最后一轮的复用集进结果 (INV-GOAL-3 可证面)', async () => {
    const r = await runGoal('g', {
      ...cfg(),
      _classify: async () => 'simple',
      _iterate: (async () => okIterate(2, ['a', 'b'])) as never,
    });
    expect(r.reusedNodes).toEqual(['a', 'b']);
    expect(r.rounds).toBe(2);
  });
});

describe('goalSlug', () => {
  test('kebab 化 + 截断 + 空值兜底', () => {
    expect(goalSlug('Add A New Thing!')).toBe('add-a-new-thing');
    expect(goalSlug('!!!')).toBe('goal');
    expect(goalSlug('x'.repeat(80))).toHaveLength(48);
  });
});
