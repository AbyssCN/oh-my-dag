/**
 * runGoal 契约测试 — INV-GOAL-1 (全自主) / INV-GOAL-4 (无环 + 有界)。
 * 全注入 (_classify / _runDag / researchRunner / agentRunner) — 零 live 模型、零真检索。
 *
 * **D-F (2026-07-30) 之后两段都是图**: 契约段 `goal-contract` 与执行段 `goal-execute` 各是一张
 * 单 conductor 节点的图, 共用 `_runDag` 注入口, 靠 `plan.name` 分辨 —— 所以这里的注入器是个路由器。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { goalSlug, runGoal, type RunGoalConfig } from './run-goal';
import type { AcceptanceSpec, GoalClassification, GoalTier } from './classify-acceptance';
import type { ConductorPlan } from '../conductor-plan';
import type { ExecutorDagConfig, ExecutorDagResult } from '../dag/types';

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

/**
 * 造一份「执行段 conductor 节点」的执行结果 (D-F: 环封在这个节点内)。
 * `converged` / `rounds` 是内环 judge 盖在 leaf 上的 —— runGoal 的整段结论就取自它俩。
 */
function executeDag(
  opts: {
    converged?: boolean;
    rounds?: number;
    reused?: string[];
    status?: 'done' | 'failed';
    /**
     * D-I 环外闸 (2026-07-30): 执行型验收会在图上多一个 `accept` command 节点, 它的退出码是
     * **冻结判据**。缺省 done —— 大部分用例关心的是判词那一侧; 要测"判词说成了但判据没过"
     * 这个 D-I 核心场景, 显式传 'failed'。
     */
    accept?: 'done' | 'failed' | 'absent';
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
              deps: ['execute'], usage: { in: 0, out: 0 },
            },
          }),
      execute: {
        id: 'execute',
        status: opts.status ?? 'done',
        kind: 'conductor',
        output: '[conductor 子图: 2/2 成功]',
        deps: [],
        usage: { in: 1, out: 1 },
        rounds: opts.rounds ?? 1,
        ...(opts.converged === undefined ? {} : { converged: opts.converged }),
      },
    },
    reusedNodes: opts.reused ?? [],
  } as unknown as ExecutorDagResult;
}

/** 两段共用一个 `_runDag`, 按 plan.name 路由 (省略的那段走缺省的"一切正常")。 */
const dagRouter = (h: {
  contract?: (plan: ConductorPlan) => Promise<ExecutorDagResult>;
  execute?: (plan: ConductorPlan) => Promise<ExecutorDagResult>;
}) =>
  (async (plan: ConductorPlan) =>
    plan.name === 'goal-execute'
      ? await (h.execute ?? (async () => executeDag({ converged: true })))(plan)
      : await (h.contract ?? (async () => contractDag({})))(plan)) as never;

function cfg(dag: Partial<ExecutorDagConfig> = {}, extra: Partial<RunGoalConfig> = {}): RunGoalConfig {
  return {
    cwd: mkdtempSync(join(tmpdir(), 'omd-goal-')),
    dag: { conductorModel: 'c:m', leafModel: 'l:m', ...dag } as ExecutorDagConfig,
    _today: () => '2026-07-28',
    _runDag: dagRouter({}),
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
      // D-G′: survey/research/spec 是**一个 conductor 节点**的子图; D-F: execute 段也是。
      _runDag: dagRouter({
        contract: async (plan) => {
          seen.push('contract');
          contractGoal = String(plan.nodes.contract!.goal);
          return contractDag({
            survey: 'src/harness/executor-dag.ts:497 — map 节点已有运行时展开',
            sources: ['https://a.example'],
            specFile: 'docs/plan/2026-07-28-给-omd-加一个自主-goal-引擎.md',
          });
        },
        execute: async (plan) => {
          seen.push('execute');
          const n = plan.nodes.execute!;
          expect(n.executor).toBe('conductor');
          expect(String(n.goal)).toContain('按下面这份 SDD 契约实施'); // 执行读的是契约不是对话
          return executeDag({ converged: true });
        },
      }),
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
      _runDag: dagRouter({
        execute: async (plan) => {
          task = String(plan.nodes.execute!.goal);
          return executeDag({ converged: true });
        },
      }),
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

/**
 * **D-I 的冻结判据必须真跑** (2026-07-30 第三次 live 冒烟补的环外闸)。
 *
 * 实测挖出来的洞: 判卷标准只进任务文本, 指望 conductor 把它连成图里一个 command 节点 —— 它没连。
 * 冻结的是 `grep -qx "hello omd" notes/hello.md`, 它自己画的验证步是 `cat notes/hello.md`。
 * 于是"执行型验收"这四个字在生产上**从没被真跑过**, D-J 整套防作弊的地基只剩一句提醒。
 *
 * 闸放**环外**是 D-I 方案 A 的直接后果: 判卷标准必须是执行体动不了的东西 —— 环每轮重画子图,
 * 判据进环就跟着能变。
 */
describe('D-I 冻结判据 — 环外确定性闸', () => {
  const execCfg = (over: Partial<RunGoalConfig> = {}): RunGoalConfig =>
    cfg({}, {
      acceptance: { kind: 'executable', command: 'grep -qx "hello" a.md', expectExit: 0 },
      tier: 'simple',
      ...over,
    });

  test('执行型 → 图上多一个 accept 节点, 逐字带着冻结的命令与期望退出码', async () => {
    let seen: ConductorPlan | undefined;
    await runGoal('写个文件', execCfg({
      _runDag: (async (plan: ConductorPlan) => {
        if (plan.name === 'goal-execute') seen = plan;
        return executeDag({ converged: true });
      }) as never,
    }));
    const accept = seen!.nodes.accept!;
    expect(accept.executor).toBe('command');
    expect(accept.command).toBe('grep -qx "hello" a.md');
    expect(accept.expect_exit).toBe(0);
    expect(accept.depends_on).toEqual(['execute']); // 环跑完才判 —— 它是环外的闸不是环内的一步
  });

  test('判词说成了但**冻结判据没过** → 不算收敛 (D-I 要抓的正是这种"作弊达标")', async () => {
    const r = await runGoal('写个文件', execCfg({
      _runDag: (async () => executeDag({ converged: true, accept: 'failed' })) as never,
    }));
    expect(r.converged).toBe(false);
    expect(r.stages.at(-1)!.summary).toContain('冻结判据没过');
  });

  test('accept 节点**根本没跑** → 也不算收敛 (没被证明过就不算成, 同 converged 缺席那条纪律)', async () => {
    const r = await runGoal('写个文件', execCfg({
      _runDag: (async () => executeDag({ converged: true, accept: 'absent' })) as never,
    }));
    expect(r.converged).toBe(false);
  });

  test('判据过了但判词说没成 → 仍不算收敛 (判据是必要非充分)', async () => {
    const r = await runGoal('写个文件', execCfg({
      _runDag: (async () => executeDag({ converged: false, accept: 'done' })) as never,
    }));
    expect(r.converged).toBe(false);
  });

  test('两边都过 → 收敛, 摘要里两条结论都在', async () => {
    const r = await runGoal('写个文件', execCfg({
      _runDag: (async () => executeDag({ converged: true, accept: 'done' })) as never,
    }));
    expect(r.converged).toBe(true);
    expect(r.stages.at(-1)!.summary).toContain('冻结判据 ✅');
  });

  test('探索型 → **不加** accept 节点 (没有机器判据就别伪造一个)', async () => {
    let seen: ConductorPlan | undefined;
    const r = await runGoal('摸清一个领域', cfg({}, {
      acceptance: { kind: 'exploratory', learningGoal: '学到什么', affordableLoss: '一轮' },
      tier: 'simple',
      _runDag: (async (plan: ConductorPlan) => {
        if (plan.name === 'goal-execute') seen = plan;
        return executeDag({ converged: true });
      }) as never,
    }));
    expect(seen!.nodes.accept).toBeUndefined();
    expect(r.converged).toBe(true); // 探索型只看判词
  });
});

describe('runGoal — 降级路径都留痕, 不假装', () => {
  // D-G′ 之后「要不要调研」由 conductor 自己判 —— 没分解出调研步就是它判了不需要, 如实记 skipped。
  test('子图里没有调研步 → research skipped (不是失败: 这个分支现在归它判)', async () => {
    const r = await runGoal('设计一个新机制', {
      ...cfg({ agentRunner: async () => ({ text: 'x', usage: { in: 1, out: 1 } }) }),
      _classify: cls('complex'),
      _runDag: dagRouter({ contract: async () => contractDag({ survey: 'src/x.ts:1 — 事实', specFile: 'docs/plan/2026-07-28-设计一个新机制.md' }) }),
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
      _runDag: dagRouter({ contract: async () => contractDag({ sources: [], specFile: 'docs/plan/2026-07-28-查点什么.md' }) }),
    });
    expect(r.stages.find((s) => s.stage === 'research')!.status).toBe('failed');
    expect(r.sources).toEqual([]); // 零来源的那段不算证据
  });

  test('契约段没产出文件 → spec failed 但不断流程 (下游改用正文当契约)', async () => {
    const r = await runGoal('做点事', {
      ...cfg({ agentRunner: async () => ({ text: 'x', usage: { in: 1, out: 1 } }) }),
      _classify: cls('complex'),
      _runDag: dagRouter({ contract: async () => contractDag({ specText: '# SDD 正文' }) }), // 无 specFile
    });
    expect(r.stages.find((s) => s.stage === 'spec')!.status).toBe('failed');
    expect(r.specPath).toBeUndefined();
    expect(r.stages.find((s) => s.stage === 'execute')!.status).toBe('done'); // 仍往下跑
  });

  test('契约段整个抛错 → 记 failed, execute 照跑 (不把异常抛给调用方)', async () => {
    const r = await runGoal('做点事', {
      ...cfg({ agentRunner: async () => ({ text: 'x', usage: { in: 1, out: 1 } }) }),
      _classify: cls('complex'),
      _runDag: dagRouter({
        contract: async () => {
          throw new Error('契约段崩了');
        },
      }),
    });
    expect(r.stages.find((s) => s.stage === 'spec')!.summary).toContain('契约段崩了');
    expect(r.stages.find((s) => s.stage === 'execute')!.status).toBe('done');
  });

  test('execute 抛错 → 记 failed 并返回 (不把异常抛给调用方)', async () => {
    const r = await runGoal('做点事', {
      ...cfg(),
      _classify: cls('simple'),
      _runDag: dagRouter({
        execute: async () => {
          throw new Error('conductor 崩了');
        },
      }),
    });
    expect(r.converged).toBe(false);
    expect(r.stages.at(-1)!.summary).toContain('conductor 崩了');
  });
});

describe('runGoal — INV-GOAL-4 有界 / INV-GOAL-3 可证', () => {
  // D-F: 轮数上限现在是**节点上的 max_rounds** (环在节点内), 不再是 iterate 的配置项。
  test('执行轮数上限默认 2 (= 1 轮修复), 可覆盖', async () => {
    const seen: (number | undefined)[] = [];
    const spy = dagRouter({
      execute: async (plan) => {
        seen.push(plan.nodes.execute!.max_rounds);
        return executeDag({ converged: true });
      },
    });
    await runGoal('g', { ...cfg(), _classify: cls('simple'), _runDag: spy });
    await runGoal('g', { ...cfg(), maxRounds: 4, _classify: cls('simple'), _runDag: spy });
    expect(seen).toEqual([2, 4]);
  });

  /**
   * D-F 的兜底: 撤了外层 fixpoint 之后, 「整体目标成了吗」这个问题只剩内环 judge 会问 ——
   * 而内环**最后一轮默认不请 judge**。执行段的节点若忘了写 `judge_final`, runGoal 就只能拿
   * "跑完了"当"成了"。这条钉的就是那个开关恒在。
   */
  test('执行段节点恒带 judge_final (撤外层之后 converged 的唯一来源)', async () => {
    let jf: boolean | undefined;
    await runGoal('g', {
      ...cfg(),
      _classify: cls('simple'),
      _runDag: dagRouter({
        execute: async (plan) => {
          jf = plan.nodes.execute!.judge_final;
          return executeDag({ converged: true });
        },
      }),
    });
    expect(jf).toBe(true);
  });

  test('内环判未收敛 → 整段 failed 且 converged=false (不因"跑完了"就算成)', async () => {
    const r = await runGoal('g', {
      ...cfg(),
      _classify: cls('simple'),
      _runDag: dagRouter({ execute: async () => executeDag({ converged: false, rounds: 2 }) }),
    });
    expect(r.converged).toBe(false);
    expect(r.rounds).toBe(2);
    expect(r.stages.at(-1)!.status).toBe('failed');
    expect(r.stages.at(-1)!.summary).toContain('未收敛');
  });

  // 缺席 ≠ 未收敛, 但**一律不算成**: 没人判过就说成了, 正是谎报完成最舒服的入口。
  test('leaf 上没有 converged (没人判过) → 不算成', async () => {
    const r = await runGoal('g', {
      ...cfg(),
      _classify: cls('simple'),
      _runDag: dagRouter({ execute: async () => executeDag({}) }), // converged 缺席
    });
    expect(r.converged).toBe(false);
  });

  test('execute 节点根本没结果 → failed 留痕 (不静默当收敛)', async () => {
    const r = await runGoal('g', {
      ...cfg(),
      _classify: cls('simple'),
      _runDag: dagRouter({
        execute: async () => ({ plan: { name: 'goal-execute', nodes: {} }, results: {} }) as unknown as ExecutorDagResult,
      }),
    });
    expect(r.converged).toBe(false);
    expect(r.stages.at(-1)!.summary).toContain('无结果');
  });

  // 合并成子图之后 researchRounds 只能经契约段的 goal 传下去 —— 不传就成了"配了但不生效"的空旋钮。
  test('research 内环轮数透传进契约段指令 (默认 1, 可覆盖)', async () => {
    const seen: string[] = [];
    const mk = (rounds?: number) =>
      runGoal('g', {
        ...cfg({ agentRunner: async () => ({ text: 'x', usage: { in: 1, out: 1 } }) }),
        ...(rounds ? { researchRounds: rounds } : {}),
        _classify: cls('complex'),
        _runDag: dagRouter({
          contract: async (plan) => {
            seen.push(String(plan.nodes.contract!.goal));
            return contractDag({ specFile: 'docs/plan/2026-07-28-g.md' });
          },
        }),
      });
    await mk();
    await mk(3);
    expect(seen[0]).toContain('"rounds": 1');
    expect(seen[1]).toContain('"rounds": 3');
  });

  // D-F 之后复用发生在**内环**里 (子节点内容寻址), 由引擎并进结果面的 reusedNodes。
  test('复用集进结果 (INV-GOAL-3 可证面)', async () => {
    const r = await runGoal('g', {
      ...cfg(),
      _classify: cls('simple'),
      _runDag: dagRouter({ execute: async () => executeDag({ converged: true, rounds: 2, reused: ['a', 'b'] }) }),
    });
    expect(r.reusedNodes).toEqual(['a', 'b']);
    expect(r.rounds).toBe(2);
  });
});

/**
 * 2026-07-30 第一次 live 冒烟才看见的空旋钮: `runGoal` 只读 `config.dag.generate` 去建分类器,
 * 而那是**注入口**, 生产从来不设 (引擎自己 `?? makeDefaultGenerate`) —— 于是真实路径上每一次
 * dag_goal 都走「无分类器」兜底 → 恒探索型 → **D-I 的执行型验收 (强制可跑命令) 从未成立过**。
 * 机制在、注入式测试全绿、生产零生效。这条钉的是"回落到引擎默认实现"这根接线。
 */
describe('runGoal — 分类器必须真接上 (D-I 的地基, 不许静默降级)', () => {
  test('不传 _classify 且 dag.generate 缺席 → 仍**建得出**分类器 (降级原因不是"无分类器")', async () => {
    const r = await runGoal('g', {
      ...cfg({ conductorModel: 'no-such-provider:m' }), // provider 没注册 → 调用会抛 → 走"调用失败"兜底
    });
    // 两种兜底文案分得开: "无分类器" = 压根没接上 (就是这次要防的那个 bug);
    // "分类调用或解析失败" = 接上了但这次调不通 (座位没配/网断, 那是另一回事)。
    const s = r.stages.find((x) => x.stage === 'classify')!.summary;
    expect(s).not.toContain('无分类器');
    expect(s).toContain('分类调用或解析失败');
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
      _runDag: dagRouter({
        contract: async () => {
          ranDag = true;
          return contractDag({});
        },
      }),
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
      _runDag: dagRouter({ contract: async () => contractDag({ survey: '   ', specFile: 'docs/plan/2026-07-28-g.md' }) }),
    });
    const s = r.stages.find((x) => x.stage === 'survey')!;
    expect(s.status).toBe('failed');
    expect(s.summary).toContain('空输出');
  });

  test('子图里压根没有勘察步 → skipped (与"跑了但空手"分开记)', async () => {
    const r = await runGoal('g', {
      ...cfg({ agentRunner: async () => ({ text: 'x', usage: { in: 1, out: 1 } }) }),
      _classify: cls('complex'),
      _runDag: dagRouter({ contract: async () => contractDag({ specFile: 'docs/plan/2026-07-28-g.md' }) }),
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

// ── 闸 C (2026-08-10 事故): 续跑复用 classify + 契约段 ───────────────────────
//
// 事故: 同一段 goal 被心跳续派重分类 117 遍 (平均 2.1M tokens/遍) —— 节点级 checkpoint
// 拦不住 (conductor 子图逐轮重展开, D-O 输入面恒判"依赖输出已变")。闸 C 把 classify 与
// 契约段产物按 goal 全文哈希锚在 `.omd/continuity/<runId>/goal-state.json`, 未变即复用。

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';

describe('闸 C — 续跑复用 classify + 契约段 (goal-state 锚)', () => {
  const mkCounted = (cwd: string, counters: { classify: number; contract: number; exec: number }): RunGoalConfig => ({
    cwd,
    dag: {
      conductorModel: 'c:m',
      leafModel: 'l:m',
      agentRunner: (async () => ({ text: 'x', usage: { in: 1, out: 1 } })) as never,
      continuity: { manager: {} as never, runId: 'run-c' },
    } as ExecutorDagConfig,
    _today: () => '2026-08-10',
    _classify: async () => (counters.classify++, { tier: 'complex' as GoalTier, acceptance: ACC_EXEC }),
    _runDag: async (plan) => {
      if (plan.name === 'goal-contract') {
        counters.contract++;
        return contractDag({ survey: 'src/a.ts:1 — 事实', specText: '# SDD 正文契约' });
      }
      counters.exec++;
      return executeDag({ converged: true, rounds: 1 });
    },
  });

  test('反向自检: 同 goal 同 runId 二跑 → classify/契约段各只跑一遍, 执行段照常跑两遍', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-goal-c-'));
    const counters = { classify: 0, contract: 0, exec: 0 };
    const r1 = await runGoal('目标甲', mkCounted(cwd, counters));
    expect([counters.classify, counters.contract, counters.exec]).toEqual([1, 1, 1]);
    const r2 = await runGoal('目标甲', mkCounted(cwd, counters));
    expect([counters.classify, counters.contract, counters.exec]).toEqual([1, 1, 2]);
    expect(r2.repoContext).toBe(r1.repoContext); // 勘察产物原样带回
    expect(r2.stages.find((s) => s.stage === 'classify')!.summary).toContain('闸 C');
    expect(r2.converged).toBe(true); // 复用不改变执行段结论
  });

  test('对照臂: goal 文本变了 → 状态作废, classify/契约段照常重跑', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-goal-c-'));
    const counters = { classify: 0, contract: 0, exec: 0 };
    await runGoal('目标甲', mkCounted(cwd, counters));
    await runGoal('目标乙 (一字之差也算变)', mkCounted(cwd, counters));
    expect([counters.classify, counters.contract]).toEqual([2, 2]);
  });

  test('对照臂: 无 continuity (无 runId 可锚) → 闸不启用, 两跑两遍', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-goal-c-'));
    const counters = { classify: 0, contract: 0, exec: 0 };
    const mk = (): RunGoalConfig => {
      const c = mkCounted(cwd, counters);
      delete (c.dag as { continuity?: unknown }).continuity;
      return c;
    };
    await runGoal('目标甲', mk());
    await runGoal('目标甲', mk());
    expect([counters.classify, counters.contract]).toEqual([2, 2]);
  });

  test('specPath 记了但盘上文件没了 → 不复用, 契约段重跑 (状态不是真源, 盘上文件才是)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-goal-c-'));
    const specFile = join(cwd, 'docs', 'plan', `2026-08-10-${goalSlug('目标甲')}.md`);
    mkdirSync(join(cwd, 'docs', 'plan'), { recursive: true });
    writeFileSync(specFile, '# SDD');
    const counters = { classify: 0, contract: 0, exec: 0 };
    const mk = (): RunGoalConfig => {
      const c = mkCounted(cwd, counters);
      c._runDag = async (plan) => {
        if (plan.name === 'goal-contract') {
          counters.contract++;
          return contractDag({ survey: 's', specFile });
        }
        counters.exec++;
        return executeDag({ converged: true, rounds: 1 });
      };
      return c;
    };
    await runGoal('目标甲', mk());
    expect(counters.contract).toBe(1);
    rmSync(specFile);
    await runGoal('目标甲', mk());
    expect(counters.contract).toBe(2); // 文件没了 → 复用条件不成立
  });
});
