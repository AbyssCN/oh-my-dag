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
import type { ConductorPlan } from '../conductor-plan';
import type { ExecutorDagConfig, ExecutorDagResult } from '../executor-dag-types';
import type { IterateResult } from '../plan/iterate';

/**
 * D-I: 分类器一次出两条轴 (成本轴 tier + 判据轴 acceptance)。本文件多数用例只关心成本轴,
 * 判据轴给一个固定的执行型即可 —— 判据轴自己的行为在 `acceptance.test.ts` 里测。
 */
const ACC_EXEC: AcceptanceSpec = { kind: 'executable', command: 'bun test', expectExit: 0 };
const cls =
  (tier: GoalTier, acceptance: AcceptanceSpec = ACC_EXEC) =>
  async (): Promise<GoalClassification> => ({ tier, acceptance });

/**
 * 造一份「契约段 conductor 节点」的执行结果 (D-G′ 之后 survey/research/spec 都在它的子图里)。
 * 子节点 id 前缀 `contract::` 是 D-B 内容寻址的形状; runGoal 靠 kind 认出各段。
 */
function contractDag(opts: { survey?: string; sources?: string[]; specFile?: string; specText?: string }): ExecutorDagResult {
  const results: Record<string, unknown> = {};
  if (opts.survey !== undefined) {
    results['contract::survey'] = { id: 'contract::survey', status: 'done', kind: 'agent', output: opts.survey, deps: [], usage: { in: 1, out: 1 }, filesTouched: [] };
  }
  if (opts.sources) {
    results['contract::research'] = { id: 'contract::research', status: 'done', kind: 'research', output: '研究终稿', deps: [], usage: { in: 1, out: 1 }, sources: opts.sources };
  }
  results['contract'] = {
    id: 'contract', status: 'done', kind: 'conductor',
    output: opts.specText ?? '# SDD\n...', deps: [], usage: { in: 1, out: 1 },
    ...(opts.specFile ? { filesTouched: [opts.specFile] } : {}),
  };
  return { plan: { name: 'goal-contract', nodes: {} }, results } as unknown as ExecutorDagResult;
}

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
  test('complex 档: 契约段 (conductor 节点) → execute 一次跑完, 每阶段留结论', async () => {
    const seen: string[] = [];
    let contractGoal = '';
    const r = await runGoal('给 omd 加一个自主 goal 引擎', {
      ...cfg({ agentRunner: async () => ({ text: 'x', usage: { in: 1, out: 1 } }) }),
      _classify: cls('complex'),
      // D-G′: survey/research/spec 现在是**一个 conductor 节点**的子图 —— 这里注入它的执行结果。
      _runDag: (async (plan: ConductorPlan) => {
        seen.push('contract');
        contractGoal = String(plan.nodes.contract!.goal);
        return contractDag({
          survey: 'src/harness/executor-dag.ts:497 — map 节点已有运行时展开',
          sources: ['https://a.example'],
          specFile: 'docs/plan/2026-07-28-给-omd-加一个自主-goal-引擎.md',
        });
      }) as never,
      _iterate: (async (task: string) => {
        seen.push('execute');
        expect(task).toContain('按下面这份 SDD 契约实施'); // 执行读的是契约不是对话
        return okIterate();
      }) as never,
    });
    expect(seen).toEqual(['contract', 'execute']); // 阶段序固定, 中间没有人
    // 契约段的 goal 里该有的三样: 目标 / 起草卡点名 / **冻结的判卷标准** (D-I 方案 A)。
    expect(contractGoal).toContain('给 omd 加一个自主 goal 引擎');
    expect(contractGoal).toContain('spec-author');
    expect(contractGoal).toContain('## 判卷标准');
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
  // D-G′ 之后「要不要调研」由 conductor 自己判 —— 没分解出调研步就是它判了不需要, 如实记 skipped。
  test('子图里没有调研步 → research skipped (不是失败: 这个分支现在归它判)', async () => {
    const r = await runGoal('设计一个新机制', {
      ...cfg({ agentRunner: async () => ({ text: 'x', usage: { in: 1, out: 1 } }) }),
      _classify: cls('complex'),
      _runDag: (async () => contractDag({ survey: 'src/x.ts:1 — 事实', specFile: 'docs/plan/2026-07-28-设计一个新机制.md' })) as never,
    });
    const s = r.stages.find((x) => x.stage === 'research')!;
    expect(s.status).toBe('skipped');
    expect(s.summary).toContain('无需外部调研');
    expect(r.sources).toEqual([]);
  });

  // 零来源 = 假 grounded (与 research 节点闸同一判据): 记 failed, 且那段文字**不当证据用**。
  test('调研步零来源 → research failed 且不进证据面', async () => {
    const r = await runGoal('查点什么', {
      ...cfg({ agentRunner: async () => ({ text: 'x', usage: { in: 1, out: 1 } }) }),
      _classify: cls('complex'),
      _runDag: (async () => contractDag({ sources: [], specFile: 'docs/plan/2026-07-28-查点什么.md' })) as never,
    });
    expect(r.stages.find((s) => s.stage === 'research')!.status).toBe('failed');
    expect(r.sources).toEqual([]); // 零来源的那段不算证据
  });

  test('契约段没产出文件 → spec failed 但不断流程 (下游改用正文当契约)', async () => {
    const r = await runGoal('做点事', {
      ...cfg({ agentRunner: async () => ({ text: 'x', usage: { in: 1, out: 1 } }) }),
      _classify: cls('complex'),
      _runDag: (async () => contractDag({ specText: '# SDD 正文' })) as never, // 无 specFile
    });
    expect(r.stages.find((s) => s.stage === 'spec')!.status).toBe('failed');
    expect(r.specPath).toBeUndefined();
    expect(r.stages.find((s) => s.stage === 'execute')!.status).toBe('done'); // 仍往下跑
  });

  test('契约段整个抛错 → 记 failed, execute 照跑 (不把异常抛给调用方)', async () => {
    const r = await runGoal('做点事', {
      ...cfg({ agentRunner: async () => ({ text: 'x', usage: { in: 1, out: 1 } }) }),
      _classify: cls('complex'),
      _runDag: (async () => {
        throw new Error('契约段崩了');
      }) as never,
    });
    expect(r.stages.find((s) => s.stage === 'spec')!.summary).toContain('契约段崩了');
    expect(r.stages.find((s) => s.stage === 'execute')!.status).toBe('done');
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

  // 合并成子图之后 researchRounds 只能经契约段的 goal 传下去 —— 不传就成了"配了但不生效"的空旋钮。
  test('research 内环轮数透传进契约段指令 (默认 1, 可覆盖)', async () => {
    const seen: string[] = [];
    const mk = (rounds?: number) =>
      runGoal('g', {
        ...cfg({ agentRunner: async () => ({ text: 'x', usage: { in: 1, out: 1 } }) }),
        ...(rounds ? { researchRounds: rounds } : {}),
        _classify: cls('complex'),
        _runDag: (async (plan: ConductorPlan) => {
          seen.push(String(plan.nodes.contract!.goal));
          return contractDag({ specFile: 'docs/plan/2026-07-28-g.md' });
        }) as never,
      });
    await mk();
    await mk(3);
    expect(seen[0]).toContain('"rounds": 1');
    expect(seen[1]).toContain('"rounds": 3');
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
  test('无 agentRunner → 整个契约段跳过 (没有工具就没有勘察, 也就写不出有根据的契约)', async () => {
    let ranDag = false;
    const r = await runGoal('g', {
      ...cfg({ researchRunner: async () => ({ text: 't', usage: { in: 1, out: 1 }, sources: ['https://x'] }) }),
      _classify: cls('complex'),
      _runDag: (async () => {
        ranDag = true;
        return contractDag({});
      }) as never,
    });
    expect(ranDag).toBe(false); // 连图都不跑, 不白花一次 conductor 调用
    for (const st of ['survey', 'research', 'spec'] as const) {
      expect(r.stages.find((s) => s.stage === st)!.status).toBe('skipped');
    }
    expect(r.repoContext).toBe('');
  });

  test('勘察步跑了但空手而归 → failed 留痕 (与"这次不需要勘察"不是一回事)', async () => {
    const r = await runGoal('g', {
      ...cfg({ agentRunner: async () => ({ text: 'x', usage: { in: 1, out: 1 } }) }),
      _classify: cls('complex'),
      _runDag: (async () => contractDag({ survey: '   ', specFile: 'docs/plan/2026-07-28-g.md' })) as never,
    });
    const s = r.stages.find((x) => x.stage === 'survey')!;
    expect(s.status).toBe('failed');
    expect(s.summary).toContain('空输出');
  });

  test('子图里压根没有勘察步 → skipped (与"跑了但空手"分开记)', async () => {
    const r = await runGoal('g', {
      ...cfg({ agentRunner: async () => ({ text: 'x', usage: { in: 1, out: 1 } }) }),
      _classify: cls('complex'),
      _runDag: (async () => contractDag({ specFile: 'docs/plan/2026-07-28-g.md' })) as never,
    });
    expect(r.stages.find((x) => x.stage === 'survey')!.status).toBe('skipped');
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
