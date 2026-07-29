/**
 * runGoal 契约测试 — INV-GOAL-1 (全自主) / INV-GOAL-4 (无环 + 有界)。
 * 全注入 (_classify / _iterate / researchRunner / agentRunner) — 零 live 模型、零真检索。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { goalSlug, runGoal, type RunGoalConfig } from './run-goal';
import type { AcceptanceSpec, GoalClassification, GoalTier } from './acceptance';
import type { ExecutorDagConfig } from '../executor-dag-types';
import type { IterateResult } from '../plan/iterate';

/**
 * D-I: 分类器一次出两条轴 (成本轴 tier + 判据轴 acceptance)。本文件多数用例只关心成本轴,
 * 判据轴给一个固定的执行型即可 —— 判据轴自己的行为在 `acceptance.test.ts` 里测。
 */
const ACC_EXEC: AcceptanceSpec = { kind: 'executable', command: 'bun test', expectExit: 0 };
const cls =
  (tier: GoalTier, acceptance: AcceptanceSpec = ACC_EXEC) =>
  async (): Promise<GoalClassification> => ({ tier, acceptance });

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
    let researchGroundTruth: string | undefined;
    let agentCall = 0;
    const r = await runGoal('给 omd 加一个自主 goal 引擎', {
      ...cfg({
        researchRunner: async (i) => {
          seen.push('research');
          researchGroundTruth = i.groundTruth;
          return { text: '研究终稿', usage: { in: 1, out: 1 }, sources: ['https://a.example'], reportPath: '/tmp/r.md' };
        },
        agentRunner: async ({ prompt }) => {
          // 第一次 = 仓内勘察 (只读), 第二次 = spec 起草
          if (agentCall++ === 0) {
            seen.push('survey');
            expect(prompt).toContain('只读不改');
            return { text: 'src/harness/executor-dag.ts:497 — map 节点已有运行时展开', usage: { in: 1, out: 1 } };
          }
          seen.push('spec');
          expect(prompt).toContain('## 契约 (Contracts)'); // 卡骨架真被用上
          expect(prompt).toContain('研究终稿'); // 外部证据喂进去
          expect(prompt).toContain('executor-dag.ts:497'); // 仓内事实也喂进去
          return { text: '# SDD\n...', usage: { in: 1, out: 1 }, filesTouched: ['docs/plan/2026-07-28-给-omd-加一个自主-goal-引擎.md'] };
        },
      }),
      _classify: cls('complex'),
      _iterate: (async (task: string) => {
        seen.push('execute');
        expect(task).toContain('按下面这份 SDD 契约实施'); // 执行读的是契约不是对话
        return okIterate();
      }) as never,
    });
    expect(seen).toEqual(['survey', 'research', 'spec', 'execute']); // 阶段序固定, 中间没有人
    // research 的 leaf 是 inproc 看不见仓库 —— 仓内事实只能这么当锚点喂进去
    expect(researchGroundTruth).toContain('executor-dag.ts:497');
    expect(r.repoContext).toContain('executor-dag.ts:497');
    expect(r.stages.map((s) => `${s.stage}:${s.status}`)).toEqual([
      'classify:done',
      'survey:done',
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
      _classify: cls('simple'),
      _iterate: (async (t: string) => {
        task = t;
        return okIterate();
      }) as never,
    });
    expect(r.tier).toBe('simple');
    expect(r.stages.find((s) => s.stage === 'research')!.status).toBe('skipped');
    expect(r.sources).toEqual([]); // research 没跑 → 没有来源
    // 目标原文原样进执行, 后面只跟着**冻结的判卷标准** (D-I) —— simple 档不产 spec,
    // 判据没有别的落点, 不附上去这一档就成了"没有验收的自主执行"。
    expect(task.startsWith('把 foo 重命名成 bar\n\n## 判卷标准')).toBe(true);
    expect(task).toContain('bun test');
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
      _classify: cls('complex'),
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
      _classify: cls('complex'),
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
      _classify: cls('complex'),
    });
    expect(r.stages.find((s) => s.stage === 'spec')!.status).toBe('failed');
    expect(r.specPath).toBeUndefined();
    expect(r.stages.find((s) => s.stage === 'execute')!.status).toBe('done'); // 仍往下跑
  });

  test('execute 抛错 → 记 failed 并返回 (不把异常抛给调用方)', async () => {
    const r = await runGoal('做点事', {
      ...cfg(),
      _classify: cls('simple'),
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
    await runGoal('g', { ...cfg(), _classify: cls('simple'), _iterate: spy });
    await runGoal('g', { ...cfg(), maxRounds: 5, _classify: cls('simple'), _iterate: spy });
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
        _classify: cls('complex'),
      });
    await mk();
    await mk(3);
    expect(seen).toEqual([1, 3]);
  });

  test('最后一轮的复用集进结果 (INV-GOAL-3 可证面)', async () => {
    const r = await runGoal('g', {
      ...cfg(),
      _classify: cls('simple'),
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

// ── 仓内勘察 (survey): research 的 leaf 是 inproc 看不见仓库, agent 反过来有全套工具没 web。
// 这一站就是把两边接上 —— 少了它, research 是在不知道"仓里已有什么"的前提下去查外面。
describe('runGoal — survey 仓内勘察 (inproc 研究与仓库的接点)', () => {
  test('无 agentRunner → survey skipped, 且 spec 明写"未勘察"禁凭印象', async () => {
    // agentRunner 缺席时 spec 阶段也不会跑, 故直接看结果与 research 的 groundTruth
    let gt: string | undefined = 'sentinel';
    const r = await runGoal('g', {
      ...cfg({
        researchRunner: async (i) => {
          gt = i.groundTruth;
          return { text: 't', usage: { in: 1, out: 1 }, sources: ['https://x'] };
        },
      }),
      _classify: cls('complex'),
    });
    expect(r.stages.find((s) => s.stage === 'survey')!.status).toBe('skipped');
    expect(r.repoContext).toBe('');
    expect(gt).toBeUndefined(); // 没勘察就别塞空锚点
  });

  test('survey 空输出 → failed 留痕 (不当成"仓里什么都没有")', async () => {
    const r = await runGoal('g', {
      ...cfg({ agentRunner: async () => ({ text: '   ', usage: { in: 1, out: 1 } }) }),
      _classify: cls('complex'),
    });
    expect(r.stages.find((s) => s.stage === 'survey')!.status).toBe('failed');
  });

  test('survey 抛错 → 不断流程, 后续阶段照跑', async () => {
    let ran = false;
    const r = await runGoal('g', {
      ...cfg({
        agentRunner: async () => {
          throw new Error('勘察崩了');
        },
        researchRunner: async () => {
          ran = true;
          return { text: 't', usage: { in: 1, out: 1 }, sources: ['https://x'] };
        },
      }),
      _classify: cls('complex'),
    });
    expect(r.stages.find((s) => s.stage === 'survey')!.summary).toContain('勘察崩了');
    expect(ran).toBe(true);
  });

  test('simple 档不勘察 (做法已定的活不值一次读仓)', async () => {
    let called = false;
    const r = await runGoal('g', {
      ...cfg({
        agentRunner: async () => {
          called = true;
          return { text: 'x', usage: { in: 1, out: 1 } };
        },
      }),
      _classify: cls('simple'),
    });
    expect(called).toBe(false);
    expect(r.stages.find((s) => s.stage === 'survey')).toBeUndefined();
  });
});
