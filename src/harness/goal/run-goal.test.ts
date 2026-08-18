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
import { BOARD_TERMINAL_OUTCOME, boardTerminalEntry, goalSlug, runGoal, type RunGoalConfig } from './run-goal';
import type { AcceptanceSpec, GoalClassification, GoalTier } from './classify-acceptance';
import type { ConductorPlan } from '../conductor-plan';
import type { ExecutorDagConfig, ExecutorDagResult } from '../dag/types';
import { SDD_DECLARED_WRITE_SET, SDD_REPORT_FILE, type DeclaredWriteSet } from '../write-set';
import { appendBoard, BOARD_RUN_ID, liveRuns, readBoard, type BoardEntry } from '../board/run-board';
import { publishEntry } from '../../../scripts/board-publish';
import type { RunOutcomeKind } from '../run-outcome';
import { ignitionPreflight } from './ignition-preflight';
import { fingerprintOf } from '../profiles/review-ledger';

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
    /** judge 自己那一票 (LeafResult.judgeConverged) —— 判据停时与 converged 可以不同向。 */
    judgeConverged?: boolean;
    rounds?: number;
    reused?: string[];
    status?: 'done' | 'failed';
    /**
     * D-I 环外闸 (2026-07-30): 执行型验收会在图上多一个 `accept` command 节点, 它的退出码是
     * **冻结判据**。缺省 done —— 大部分用例关心的是判词那一侧; 要测"判词说成了但判据没过"
     * 这个 D-I 核心场景, 显式传 'failed'。
     */
    accept?: 'done' | 'failed' | 'absent';
    /** accept 节点的输出正文 —— S-37 那条闸的判据面(`(fail)` 名字集从这里抽)。 */
    acceptOutput?: string;
    /**
     * S4 终态 emit 的注入面: N5 outcome 阶梯 (run-goal.ts) 的各停止轴都能经 execute 节点 /
     * dag 结果注入 —— 测"每个可达终态都真 append 过 terminal", 不靠投影表冒充端到端。
     */
    cancelled?: string;
    blocked?: string;
    budgetStopped?: string;
    infraStopped?: string;
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
              id: 'accept', status: accept, kind: 'command', output: opts.acceptOutput ?? (accept === 'done' ? '' : '[exit 1]'),
              deps: ['execute'], usage: { in: 0, out: 0 }, timedOut: false, signal: null,
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
        ...(opts.judgeConverged === undefined ? {} : { judgeConverged: opts.judgeConverged }),
        ...(opts.blocked === undefined ? {} : { blocked: opts.blocked }),
        ...(opts.budgetStopped === undefined ? {} : { budgetStopped: opts.budgetStopped }),
        ...(opts.infraStopped === undefined ? {} : { infraStopped: opts.infraStopped }),
      },
    },
    reusedNodes: opts.reused ?? [],
    ...(opts.cancelled === undefined ? {} : { cancelled: { reason: opts.cancelled, at: '2026-07-28T00:00:00Z', notRun: [] } }),
  } as unknown as ExecutorDagResult;
}

/** D-1 基线用 commandRunner fake: 固定退出码, 零副作用。 */
const cmdRunner = (exitCode: number) => async ({ command: _command }: { command: string }) => ({
  text: '', usage: { in: 0, out: 0 }, exitCode, timedOut: false, signal: null,
});

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

  // #148 (B0 run 6251afc4 的形状): 环按判据绿收敛 (converged=true), judge 的票是反对
  // (judgeConverged=false, 当时还是 D-4 合成的), 环外 accept 也绿 → 终态必须是 success ——
  // 旧代码让观测位压裁决位, 判 not-converged 且指引「加轮数 resume」(resume 进环判据仍绿,
  // round 1 再停, 不动点)。怎么让它红: 把 run-goal 的 loopOk 换回 judgeConverged 优先即红。
  test('#148 判据绿收敛 + judge 异议 → success (judge 票只观测不裁决), 异议进摘要', async () => {
    const r = await runGoal('写个文件', execCfg({
      _runDag: (async () => executeDag({ converged: true, judgeConverged: false, accept: 'done' })) as never,
    }));
    expect(r.converged).toBe(true);
    expect(r.outcome).toBe('success');
    expect(r.criteria).toEqual({ judge: false, oracle: true }); // 判据轴仍看得见那格异议
    expect(r.stages.at(-1)!.summary).toContain('judge 异议');
  });

  test('#148 反向: 判据绿收敛 + judge 异议 + 环外 accept 红 → oracle-failed (异议不救判据红)', async () => {
    const r = await runGoal('写个文件', execCfg({
      _runDag: (async () => executeDag({ converged: true, judgeConverged: false, accept: 'failed' })) as never,
    }));
    expect(r.converged).toBe(false);
    expect(r.outcome).toBe('oracle-failed');
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

describe('runGoal — D-1 mode 感知基线 delta (SDD cairness-distill D-1, 挂 goal 引擎验收路径)', () => {
  // 基线 = 批前用同一份 commandRunner 跑验收命令; after = accept 节点实判。
  // 只把「新引入失败」判红 (G-1), 老失败单列不红 (G-2 / INV-4)。
  const deltaCfg = (dag: Partial<ExecutorDagConfig>, run: (plan: ConductorPlan) => Promise<ExecutorDagResult>): RunGoalConfig =>
    cfg(dag, {
      acceptance: { kind: 'executable', command: 'grep -qx "hello" a.md', expectExit: 0 },
      tier: 'simple',
      _runDag: run as never,
    });

  /**
   * ★ **S-37 接线闸** —— 纯函数那侧在 `accept-delta.test.ts` 已经钉死;这两条钉的是
   * **run-goal 真把命令输出喂进去了**。少了它们,`buildAcceptDelta` 可以完全正确而
   * run-goal 照样只传一格退出码 —— 那正是 S-35「机制在、真发射点没接」的形状。
   *
   * 背景(为什么值得两条端到端):夜跑 run `c02ac67d` 的引擎印过「D-1 delta: 未新增失败」,
   * 而它说对是**碰巧** —— 基线本来就红,真引入回归它会印一模一样的话。
   */
  /** 按调用次序吐不同输出的 commandRunner(第 1 次 = 基线,第 2 次 = 判红前的复跑)。 */
  const cmdRunnerSeq = (...outs: Array<{ exitCode: number; text: string }>) => {
    let n = 0;
    return async ({ command: _command }: { command: string }) => ({ usage: { in: 0, out: 0 }, timedOut: false, signal: null, ...(outs[Math.min(n++, outs.length - 1)]!) });
  };
  const failLines = (...names: string[]): string => names.map((s) => `(fail) ${s} [1.00ms]`).join('\n');

  test('★ S-37: 基线本来就红(A) + after 红(A+B) → 报 test:B, 不再被 unchanged-failure 赦免', async () => {
    // 证伪(实跑): 把 run-goal 里 after 侧的 acceptSideOf 换回不带输出 → **这两条当场红**
    // (回到 S-37 的洞: 引擎会把 B 当老失败赦免掉)。
    const r = await runGoal('写个文件', deltaCfg(
      // 基线红且复跑同样红 ⇒ 复现确认放行, B 是真回归。
      { commandRunner: cmdRunnerSeq({ exitCode: 1, text: failLines('A') }, { exitCode: 1, text: failLines('A', 'B') }) },
      async () => executeDag({ converged: true, accept: 'failed', acceptOutput: failLines('A', 'B') }),
    ));
    expect(r.verifyDelta!.red).toBe(true);
    expect(r.verifyDelta!.newFailures).toEqual(['test:B']);
    expect(r.stages.at(-1)!.summary).toContain('D-1 delta: 新增失败 1 [test:B]');
  });

  test('★ S-37 另一半: 复跑没复现 → 不判红, 但抖动写进判词(不留证据 = 偷偷放行)', async () => {
    // 证伪(实跑): 删掉复跑确认那整段 → **本条当场红**(闸被抖动推到假阳性那一端,
    // 人照样学会无视它 —— 那是 S-37 的另一个极端, 不是修好)。
    const r = await runGoal('写个文件', deltaCfg(
      { commandRunner: cmdRunnerSeq({ exitCode: 1, text: failLines('A') }, { exitCode: 1, text: failLines('A') }) },
      async () => executeDag({ converged: true, accept: 'failed', acceptOutput: failLines('A', 'B') }),
    ));
    expect(r.verifyDelta!.red).toBe(false);
    expect(r.verifyDelta!.newFailures).toEqual([]);
    expect(r.stages.at(-1)!.summary).toContain('复跑未复现 1 [B]');
  });

  test('D-1 反向自检: 基线 pass → accept fail → new-failure, 红, 摘要点名新增失败', async () => {
    // 证伪: 若实现不判红 / 不挂 delta → 本次跑批引入的失败被当老账, 闸形同虚设 (G-1 主路)。
    const r = await runGoal('写个文件', deltaCfg(
      { commandRunner: cmdRunner(0) },
      async () => executeDag({ converged: true, accept: 'failed' }),
    ));
    expect(r.verifyDelta).toBeDefined();
    expect(r.verifyDelta!.red).toBe(true);
    expect(r.verifyDelta!.newFailures).toEqual(['accept']);
    expect(r.verifyDelta!.steps).toEqual([{ id: 'accept', kind: 'new-failure', before: 'pass', after: 'fail' }]);
    expect(r.converged).toBe(false);
    expect(r.stages.at(-1)!.summary).toContain('D-1 delta: 新增失败 1 [accept]');
  });

  test('D-1: 基线 fail → accept fail → unchanged-failure, 不红 (老段, INV-4 不混算)', async () => {
    // 证伪: 若实现把老失败判红 → 存量语料首跑全红, 与引擎回归混算。
    const r = await runGoal('写个文件', deltaCfg(
      { commandRunner: cmdRunner(1) },
      async () => executeDag({ converged: true, accept: 'failed' }),
    ));
    expect(r.verifyDelta!.red).toBe(false);
    expect(r.verifyDelta!.newFailures).toEqual([]);
    expect(r.verifyDelta!.steps).toEqual([{ id: 'accept', kind: 'unchanged-failure', before: 'fail', after: 'fail' }]);
  });

  test('D-1: 基线 pass → accept done → 零 delta 不红 (G-2)', async () => {
    const r = await runGoal('写个文件', deltaCfg(
      { commandRunner: cmdRunner(0) },
      async () => executeDag({ converged: true, accept: 'done' }),
    ));
    expect(r.verifyDelta!.red).toBe(false);
    expect(r.verifyDelta!.steps).toEqual([]);
    expect(r.verifyDelta!.total).toBe(1);
    expect(r.stages.at(-1)!.summary).toContain('D-1 delta: 无变化');
  });

  test('D-1: accept 节点没跑 (缺席) + 基线 pass → new-failure 红 (fail-closed: 覆盖回退)', async () => {
    // 证伪: 若实现把缺席当零 delta → 漏报 —— 「没被证明过就不算成」, 与 D-I 同一条纪律。
    const r = await runGoal('写个文件', deltaCfg(
      { commandRunner: cmdRunner(0) },
      async () => executeDag({ converged: true, accept: 'absent' }),
    ));
    expect(r.verifyDelta!.red).toBe(true);
    expect(r.verifyDelta!.newFailures).toEqual(['accept']);
    expect(r.verifyDelta!.steps).toEqual([{ id: 'accept', kind: 'new-failure', before: 'pass' }]);
  });

  test('D-1 fail-open: 没配 commandRunner → verifyDelta 缺席 (闸缺席 ≠ 零 delta)', async () => {
    const r = await runGoal('写个文件', deltaCfg(
      {},
      async () => executeDag({ converged: true, accept: 'failed' }),
    ));
    expect(r.verifyDelta).toBeUndefined();
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

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';

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
describe('runGoal — D-2 写集声明 + 跑后 diff 对账 (SDD cairness-distill D-2, 挂 goal 引擎验收路径)', () => {
  // 声明面 = exec 图里真跑过节点的 write_set; diff 面 = 注入式收集 (测试不碰真 git)。
  // 只把「走完归属阶梯无归属」判红 (G-3); 无声明 → undeclared 不红 (INV-3); 收集失败 → 闸缺席 (fail-open)。
  // G-4 (历史声明不授权) 由 wiring 的「只收 done/failed 且 results 有条目」+ 判定器的 activeNodeIds 双裁。
  const writeSetCfg = (opts: {
    diff?: string[];
    declared?: Record<string, string[]>;
    accept?: 'done' | 'failed' | 'absent';
    extra?: Partial<NonNullable<RunGoalConfig['writeSet']>>;
  }): RunGoalConfig =>
    cfg({}, {
      acceptance: { kind: 'executable', command: 'true', expectExit: 0 },
      tier: 'simple',
      writeSet: { _collectChangedFiles: () => opts.diff ?? [], ...opts.extra },
      _runDag: (async () => {
        const base = executeDag({ converged: true, accept: opts.accept ?? 'done' });
        return {
          ...base,
          plan: {
            name: 'goal-execute',
            nodes: {
              execute: { executor: 'conductor', goal: 'g', ...(opts.declared?.execute ? { write_set: opts.declared.execute } : {}) },
              accept: { executor: 'command', command: 'true' },
              // G-4 探针: 声明了但本轮 results 无条目 (= 没跑) 的节点 —— wiring 必须把它滤出声明面。
              ...(opts.declared?.history ? { history: { executor: 'command', command: 'true', write_set: opts.declared.history } } : {}),
            },
          },
        } as unknown as ExecutorDagResult;
      }) as never,
    });

  test('D-2 G-3 反向自检: 节点声明 [a.ts] 而 diff 含 a.ts+b.ts → b.ts orphan 红, 摘要点名越界', async () => {
    // 证伪: 若实现把 b.ts 放行 → 越界写 (声明了 A 却改了 B) 被当正常, 闸形同虚设。
    const r = await runGoal('写个文件', writeSetCfg({ diff: ['a.ts', 'b.ts'], declared: { execute: ['a.ts'] } }));
    expect(r.writeSet).toBeDefined();
    expect(r.writeSet!.red).toBe(true);
    expect(r.writeSet!.orphans).toEqual(['b.ts']);
    expect(r.writeSet!.files).toEqual([
      { file: 'a.ts', kind: 'node-owned', declaredBy: ['execute'] },
      { file: 'b.ts', kind: 'orphan' },
    ]);
    expect(r.stages.at(-1)!.summary).toContain('D-2 写集: 写集越界 1 [b.ts]');
  });

  test('D-2: b.ts 在 intentional 例外表 → 放行不红 (G-3 第二子句接线)', async () => {
    const r = await runGoal('写个文件', writeSetCfg({
      diff: ['a.ts', 'b.ts'],
      declared: { execute: ['a.ts'] },
      extra: { intentional: ['b.ts'] },
    }));
    expect(r.writeSet!.red).toBe(false);
    expect(r.writeSet!.orphans).toEqual([]);
    expect(r.writeSet!.files.find((f) => f.file === 'b.ts')!.kind).toBe('intentional');
  });

  test('D-2 G-4: 历史 run 的 done 节点声明过 c.ts → 后续 diff 改 c.ts 不因该历史声明放行 (orphan 红)', async () => {
    // 证伪: 若 wiring 把没跑过的节点声明也喂进判定器 → 历史声明变永久通行证 (归档即授权),
    // 正是 SDD 点名要堵的洞; 本测的 history 节点本轮 results 无条目, 必须被滤出声明面。
    const r = await runGoal('写个文件', writeSetCfg({
      diff: ['a.ts', 'c.ts'],
      declared: { execute: ['a.ts'], history: ['c.ts'] },
    }));
    expect(r.writeSet!.red).toBe(true);
    expect(r.writeSet!.orphans).toEqual(['c.ts']);
    expect(r.writeSet!.files.find((f) => f.file === 'c.ts')!.kind).toBe('orphan');
  });

  test('D-2 INV-3: 整 run 无节点声明 → verdict undeclared, diff 有文件也不红 (声明缺席 ≠ 违规)', async () => {
    // 证伪: 若实现把无声明 run 判红 → 误伤 (声明是可选字段, 没声明 = 没进对账契约, 那是 O-1 读数)。
    const r = await runGoal('写个文件', writeSetCfg({ diff: ['x.ts'] }));
    expect(r.writeSet).toBeDefined();
    expect(r.writeSet!.verdict).toBe('undeclared');
    expect(r.writeSet!.red).toBe(false);
    expect(r.stages.at(-1)!.summary).toContain('D-2 写集: 未声明');
  });

  test('D-2 fail-open: diff 收集抛错 → writeSet 缺席 (闸缺席 ≠ 零越界), 不阻断 run', async () => {
    // 证伪: 若实现把收集失败当「零越界」报绿 → 闸缺席被念成通过; 若实现让 run 抛错 → 闸变拦路虎。
    const r = await runGoal('写个文件', {
      ...writeSetCfg({}),
      writeSet: { _collectChangedFiles: () => { throw new Error('不是 git 仓'); } },
    });
    expect(r.writeSet).toBeUndefined();
    expect(r.converged).toBe(true); // 对账失败不影响 execute 结论本身
  });

  test('D-2: 没配 writeSet 注入面 → writeSet 缺席 (闸没进场)', async () => {
    const r = await runGoal('写个文件', cfg({}, { acceptance: { kind: 'executable', command: 'true', expectExit: 0 }, tier: 'simple' }));
    expect(r.writeSet).toBeUndefined();
  });

/**
 * S-2 (SDD cairness-distill 2026-08-10, run 级声明写集面): diff 逐文件裁
 * allowed / forbidden / outside —— 判据与 enforcement 同一真源 (write-set.ts 的
 * classifyWriteScope + SDD_DECLARED_WRITE_SET), run-goal.ts 只做 wiring: 收集 diff →
 * 分类 → 分列报告。与上面节点级 writeSet 正交 (阶梯裁「谁写的」, 声明面裁「该不该写」),
 * 分开报不混成一个红 (INV-4)。GWT 逐条对应 docs/plan/2026-08-10-concurrent-sdd-execute-test.md
 * run B 的「预期写集(声明)」: 允许 src/harness/** · docs/silent-failures.md · 本 run 报告
 * (精确名, R-3 互异); 禁写 src/model/** (run C) · src/eval/** (run A)。
 */
describe('runGoal — D-2 声明写集面 (S-2, run 级 runtime 面)', () => {
  // declared 缺席 → 回落 write-set.ts 的缺省面 (本 SDD run 自己的声明), 同 run-goal.ts 的
  // `config.writeSet.declared ?? SDD_DECLARED_WRITE_SET` 接线。
  const scopeCfg = (opts: {
    diff?: string[];
    declared?: DeclaredWriteSet;
    extra?: Partial<NonNullable<RunGoalConfig['writeSet']>>;
  }): RunGoalConfig =>
    cfg({}, {
      acceptance: { kind: 'executable', command: 'true', expectExit: 0 },
      tier: 'simple',
      writeSet: {
        _collectChangedFiles: () => opts.diff ?? [],
        ...(opts.declared ? { declared: opts.declared } : {}),
        ...opts.extra,
      },
      _runDag: (async () => executeDag({ converged: true })) as never,
    });

  test('S-2 fallback 阶梯: declared 缺席 → 回落缺省面, 本 run 落点全 allowed 不红', async () => {
    // 证伪: 若 wiring 不回落 SDD_DECLARED_WRITE_SET → 缺省声明面空转, 本 run 自己的
    // 测试落点 (src/harness/**) 全被裁 outside, S-2 自伤。
    const r = await runGoal('写个文件', scopeCfg({
      diff: ['src/harness/run-goal.test.ts', 'src/harness/plan/deep/x.test.ts', 'docs/silent-failures.md'],
    }));
    expect(r.writeScope).toBeDefined();
    expect(r.writeScope!.forbidden).toEqual([]);
    expect(r.writeScope!.outside).toEqual([]);
    expect(r.writeScope!.allowed.sort()).toEqual(['docs/silent-failures.md', 'src/harness/plan/deep/x.test.ts', 'src/harness/run-goal.test.ts']);
    expect(r.writeScope!.files.every((f) => f.kind === 'allowed')).toBe(true);
    expect(r.stages.at(-1)!.summary).toContain('声明面内');
  });

  test('S-2 R-3 精确报告路径: 本 run 报告文件名 → allowed, 并发 run 报告 → outside (docs/plan 不开通配)', async () => {
    // 证伪: 若 docs/plan/** 被当通配放行 → run A/C 的报告文件裁 allowed, R-3 互异形同虚设,
    // 并发 run 报告面相撞 (S-2 ① 不相交判据在报告面上失效)。
    expect(SDD_REPORT_FILE).toBe('docs/plan/2026-08-10-cairness-distill-report.md');
    const r = await runGoal('写个文件', scopeCfg({
      diff: [SDD_REPORT_FILE, 'docs/plan/2026-08-10-compression-experiment-report.md', 'docs/plan/2026-08-10-seats-doctor-report.md'],
    }));
    expect(r.writeScope!.allowed).toEqual([SDD_REPORT_FILE]);
    expect(r.writeScope!.outside.sort()).toEqual([
      'docs/plan/2026-08-10-compression-experiment-report.md',
      'docs/plan/2026-08-10-seats-doctor-report.md',
    ]);
    expect(r.writeScope!.forbidden).toEqual([]);
    expect(r.stages.at(-1)!.summary).toContain('声明面外 2 (INV-3 读数)');
  });

  test('S-2 注入 declared 压过缺省面 (fallback 不泄漏)', async () => {
    // 证伪: 若 wiring 只认缺省面 → 并发 run 注入自己互异的声明面失效, 声明写集变一仓一份,
    // 三写集互异 (concurrent-sdd-execute-test 三行声明) 无从表达。
    const r = await runGoal('写个文件', scopeCfg({
      diff: ['src/custom/x.ts', 'src/harness/x.ts', 'src/other/y.ts'],
      declared: { allowed: ['src/custom/**'], forbidden: ['src/other/**'] },
    }));
    expect(r.writeScope!.allowed).toEqual(['src/custom/x.ts']);
    expect(r.writeScope!.outside).toEqual(['src/harness/x.ts']); // 缺省面没搭车生效
    expect(r.writeScope!.forbidden).toEqual(['src/other/y.ts']);
  });

  test('S-2 禁写面: src/model/** (run C) 与 src/eval/** (run A) → forbidden, 摘要点名撞禁写面', async () => {
    // 证伪: 若禁写面缺失/放行 → 并发 run 的写面被本 run 静默踩踏且不落任何红,
    // S-2 隔离性第一道防线破 (concurrent-sdd-execute-test S-2 ①)。
    const r = await runGoal('写个文件', scopeCfg({
      diff: ['src/model/seat-quota.ts', 'src/model/a/b/c.ts', 'src/eval/runner.ts'],
    }));
    expect(r.writeScope!.forbidden.sort()).toEqual(['src/eval/runner.ts', 'src/model/a/b/c.ts', 'src/model/seat-quota.ts']);
    expect(r.writeScope!.allowed).toEqual([]);
    expect(r.stages.at(-1)!.summary).toContain('撞禁写面 3');
    expect(r.stages.at(-1)!.summary).toContain('src/model/seat-quota.ts');
  });

  test('S-2 INV-2 已知违规写必须红: 单文件 diff 撞 run C 写面 → forbidden 点名', async () => {
    // 证伪方法 (INV-2): 闸若缺失, classifyWriteScope 对该样本返回 allowed/outside,
    // 越界写被当正常 —— S-2 隔离破 → run C 写集面被静默踩踏且不落 orphan 语料 (D-2 手工首跑
    // 的判据正是 S-2 ①)。断言 forbidden 即当场证伪: 禁写面唯一合法答案就是红, 无灰色放行。
    const r = await runGoal('写个文件', scopeCfg({ diff: ['src/model/seat-quota.ts'] }));
    expect(r.writeScope!.forbidden).toEqual(['src/model/seat-quota.ts']);
    expect(r.writeScope!.files).toEqual([{ file: 'src/model/seat-quota.ts', kind: 'forbidden' }]);
    expect(r.stages.at(-1)!.summary).toContain('撞禁写面 1 [src/model/seat-quota.ts]');
  });

  test('S-2 近形负例: src/model.ts / src/eval.ts / src/harness.ts → outside, glob 不前缀匹配', async () => {
    // 证伪: 若 glob 退化成前缀匹配 → 顶层近形文件被裁 forbidden/allowed, 允许面/禁写面外扩,
    // 合法文件被当越界写 (假阳)。
    const r = await runGoal('写个文件', scopeCfg({ diff: ['src/model.ts', 'src/eval.ts', 'src/harness.ts'] }));
    expect(r.writeScope!.outside.sort()).toEqual(['src/eval.ts', 'src/harness.ts', 'src/model.ts']);
    expect(r.writeScope!.forbidden).toEqual([]);
    expect(r.writeScope!.allowed).toEqual([]);
  });

  test('S-2 混面 diff: 三种裁决各自点名, 禁写优先报红 (fail-closed 不回溯)', async () => {
    const r = await runGoal('写个文件', scopeCfg({
      diff: ['src/harness/x.ts', 'src/model/seat-quota.ts', 'scripts/foo.ts'],
    }));
    expect(r.writeScope!.allowed).toEqual(['src/harness/x.ts']);
    expect(r.writeScope!.forbidden).toEqual(['src/model/seat-quota.ts']);
    expect(r.writeScope!.outside).toEqual(['scripts/foo.ts']); // run C 允许面, 本 run 未声明 = INV-3 读数
    expect(r.stages.at(-1)!.summary).toContain('撞禁写面 1 [src/model/seat-quota.ts]');
  });

  test('S-2 fail-open: 没配 writeSet 注入面 → writeScope 缺席 (闸没进场, 不是零越界)', async () => {
    const r = await runGoal('写个文件', cfg({}, { acceptance: { kind: 'executable', command: 'true', expectExit: 0 }, tier: 'simple' }));
    expect(r.writeScope).toBeUndefined();
  });
});
});


// ── D-2 散雾出口 (SDD 2026-08-11-control-plane-unification 切片 1) ────────────────
//
// 这一组走**真 md 后端 + 真 map 落盘 + 真 frontier**: 判据本身在 pathfinder/run-tickets.test.ts,
// 这里钉的是「接线真的通了」—— 而"接线在不在"恰恰是 S-1 此前那条缝的全部内容
// (机制在、pathfinder 派发线生效、直接 run 零命中)。
import { resolveBackend } from '../pathfinder/backend';
import { loadMap } from '../pathfinder/map-store';
import { computeFrontier } from '../pathfinder/frontier';

/** 一份带未决段的 spec 正文 (经 `_readSpec` 注入, 不真落盘)。 */
const SPEC_WITH_OPEN = [
  '# 某 SDD',
  '',
  '## 决策 (Decisions)',
  '- **D-1 这条不是未决**',
  '',
  '## 未决 (Open)',
  '',
  '- **O-1(待 owner)** 超时时长定多少。',
  '- **O-2(待实测)** 接受率读数。',
].join('\n');

/** 真 md 后端 + 一张空图 (env 传 {} 绕开外部 OMD_PATH_BACKEND 干扰)。 */
function mapCfg(goalCfg: RunGoalConfig, runId: string): { backend: ReturnType<typeof resolveBackend>; tickets: NonNullable<RunGoalConfig['tickets']> } {
  const backend = resolveBackend(goalCfg.cwd, { env: {} });
  backend.createMap(goalCfg.cwd, '把散雾出口接上', 'fog-exit');
  return { backend, tickets: { slug: 'fog-exit', sink: backend, runId, at: '2026-08-11T00:00:00.000Z' } };
}

describe('D-2 散雾出口 — 任一 run 挂票 (G-1 / G-2)', () => {
  /**
   * **G-1**: 不经 pathfinder 派发的 run 产出「未决」→ map 上出现 suggested 票, 携 runId 锚,
   * 且**人 confirm 前不进前沿**。
   *
   * 反向自检 (G-6, 实跑证伪): 把 run-goal.ts 收尾那行 `openRunTickets(result, exec, config)` 注释掉 →
   * `map.tickets` 恒为空, 本条前两个 expect 当场红 (实测 `expected 2, got 0`)。
   * 换句话说这条测试证的是**接线**, 不是判据 —— 判据红不红在 run-tickets.test.ts 那边。
   */
  test('G-1: 契约段未决 → map 出现 suggested 票 (携 runId), 且不进前沿', async () => {
    const base = cfg({ agentRunner: async () => ({ text: 'x', usage: { in: 1, out: 1 } }) });
    const { tickets } = mapCfg(base, 'run-g1');
    let readSpecArg = '';
    const r = await runGoal('给 omd 加个散雾出口', {
      ...base,
      _classify: cls('complex'),
      _runDag: dagRouter({ contract: async () => contractDag({ specFile: 'docs/plan/2026-07-28-给-omd-加个散雾出口.md' }) }),
      tickets: {
        ...tickets,
        _readSpec: (p) => {
          readSpecArg = p;
          return SPEC_WITH_OPEN;
        },
      },
    });
    expect(r.converged).toBe(true); // run 本身照常收敛 —— 开票是收尾的旁路, 不改结论
    expect(readSpecArg).toBe(r.specPath!); // ① 的料确实来自这趟 run 的 spec

    const map = loadMap(base.cwd, 'fog-exit')!;
    expect(map.tickets).toHaveLength(2);
    expect(map.tickets.map((t) => t.status)).toEqual(['suggested', 'suggested']);
    expect(map.tickets[0]!.title).toBe('[未决] O-1(待 owner) 超时时长定多少。');
    expect(map.tickets.map((t) => t.suggestedBy)).toEqual(['run-g1', 'run-g1']);
    // 人 confirm 前不进前沿 (suggested 没有执行力, INV-S1-1)。
    expect(computeFrontier(map).map((t) => t.id)).toEqual([]);
  });

  /**
   * **G-2**: 同因熔断 → 票带原因 + blame 摘要 + resume 把手, 且 run 终态与票**双向可达**
   * (票 → `suggestedBy` = runId → 回执; 票 → 标题里的 resume 把手 → 同一个 runId)。
   *
   * 反向自检 (G-6, 实跑证伪): 把 run-goal.ts 的 `...(exec.verification ? { verification: exec.verification } : {})`
   * 那一行删掉 (熔断面不再传给纯核) → 熔断票消失, 只剩发现物票, 本条 `[同因熔断]` 断言当场红
   * (实测 `expected 2, got 1` + 标题不匹配)。
   */
  test('G-2: 同因熔断 → 票带原因 + blame + resume 把手, 票↔runId 双向可达', async () => {
    const base = cfg();
    const { tickets } = mapCfg(base, 'run-g2');
    const stalledDag = (): ExecutorDagResult =>
      ({
        ...executeDag({ converged: false, rounds: 3 }),
        verification: { pass: false, reason: '连撞同一根因: 产物缺失', attempts: 2, escalated: true, conductorModel: 'c:m', circuitBroken: true },
        blameRetry: { blameSize: 2, closureSize: 4, reuseHits: 1, rerunWallMs: 42 },
      }) as ExecutorDagResult;
    const r = await runGoal('修个东西', {
      ...base,
      _classify: cls('simple'),
      _runDag: dagRouter({ execute: async () => stalledDag() }),
      tickets,
    });
    expect(r.outcome).toBe('not-converged');

    const map = loadMap(base.cwd, 'fog-exit')!;
    const circuit = map.tickets.find((t) => t.title.startsWith('[同因熔断]'))!;
    expect(circuit).toBeDefined();
    expect(circuit.status).toBe('suggested');
    expect(circuit.title).toBe('[同因熔断] 连撞同一根因: 产物缺失 · blame 2 节点/失效闭包 4 · resume: dag_goal resume=run-g2');
    // 双向可达: 票 → runId (溯源字段) / 票 → resume 把手 (标题自足, 人不必读 transcript)。
    expect(circuit.suggestedBy).toBe('run-g2');
    expect(circuit.title).toContain('resume: dag_goal resume=run-g2');
    // 熔断票排在发现物票之前 (perRunCap 从尾巴丢, 带把手的那张不能被挤掉)。
    expect(map.tickets[0]!.id).toBe(circuit.id);
  });

  test('INV-1 fail-open: 没配 tickets → map 一张票都不开, run 结论一字不变', async () => {
    const base = cfg();
    const { backend } = mapCfg(base, 'run-none');
    const r = await runGoal('修个东西', { ...base, _classify: cls('simple') });
    expect(r.converged).toBe(true);
    expect(backend.readMap(base.cwd, 'fog-exit')!.tickets).toEqual([]);
  });

  test('INV-1 fail-open: 后端没实装 suggest → 不抛不吞, run 照常返回', async () => {
    const base = cfg();
    const r = await runGoal('修个东西', {
      ...base,
      _classify: cls('simple'),
      tickets: { slug: 'no-such-map', sink: {}, runId: 'run-x' },
    });
    expect(r.converged).toBe(true);
  });

  test('落图抛错 (图不存在) → 闸缺席不掀桌, run 照常返回', async () => {
    const base = cfg();
    const r = await runGoal('修个东西', {
      ...base,
      _classify: cls('simple'),
      _runDag: dagRouter({ execute: async () => executeDag({ converged: false, rounds: 1 }) }),
      tickets: { slug: 'no-such-map', sink: resolveBackend(base.cwd, { env: {} }), runId: 'run-y' },
    });
    expect(r.outcome).toBe('not-converged'); // 开票炸了不改 run 结论
  });
});

describe('runGoal — S4 run 生命周期接线 (board: claimed → terminal)', () => {
  // D-5 修订: compact 只删**超保留期**(默认 24h, 自 terminal ts 起算)的终态 run 条目 ——
  // 刚终态的 run 条目保留期内仍可读 (await 谓词的满足/中止信号, G-2/G-3)。所以 claimed 经
  // onClassified 在 run 中途观测, "terminal 真 append 过" 由终态后 terminal 条目仍在板上 (保留期内) 证明。
  test('点火即 claimed: 带声明写集 (相对路径, 与 sdd-direct 写集列同物) + runId 锚; 终态后条目保留期内仍可读', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-goal-s4-'));
    let claimedDuring: BoardEntry | undefined;
    await runGoal('做一个事', cfg(
      { sessionId: 'sess-s4-1' },
      {
        cwd,
        _classify: cls('simple'),
        writeSet: { declared: { allowed: ['docs/a.md', 'src/x/**'], forbidden: [] } },
        // claimed 在点火处已写、terminal 未写 —— 这个窗口正是观测点。
        onClassified: () => { claimedDuring = readBoard(cwd).find((e) => e.event === 'claimed'); },
      },
    ));
    expect(claimedDuring?.runId).toBe('sess-s4-1');
    expect(claimedDuring?.writeSet).toEqual(['docs/a.md', 'src/x/**']);
    // 终态后条目仍在板上 (保留期内, D-5: compact 不再"终态即清") —— terminal 确实经 appendBoard 落过。
    const after = readBoard(cwd);
    expect(after.some((e) => e.runId === 'sess-s4-1' && e.event === 'claimed')).toBe(true);
    expect(after.some((e) => e.runId === 'sess-s4-1' && e.event === 'terminal')).toBe(true);
  });

  test('缺省声明写集 = SDD_DECLARED_WRITE_SET.allowed', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-goal-s4-'));
    let claimedDuring: BoardEntry | undefined;
    await runGoal('做一个事', cfg({}, {
      cwd,
      _classify: cls('simple'),
      onClassified: () => { claimedDuring = readBoard(cwd).find((e) => e.event === 'claimed'); },
    }));
    expect(claimedDuring?.writeSet).toEqual(SDD_DECLARED_WRITE_SET.allowed);
  });

  test('终态 entry 内容: outcome 四值投影 + note 留细粒度 (纯函数面, compact 后读不到原行)', () => {
    const e = boardTerminalEntry('run-t1', 'not-converged');
    expect(e.event).toBe('terminal');
    expect(e.runId).toBe('run-t1');
    expect(e.outcome).toBe('not-converged');
    expect(e.note).toBe('not-converged');
    expect(boardTerminalEntry('run-t2', 'success').outcome).toBe('converged');
    expect(boardTerminalEntry('run-t3', 'cancelled').outcome).toBe('cancelled');
    expect(boardTerminalEntry('run-t4', 'blocked').outcome).toBe('failed');
  });

  test('BOARD_TERMINAL_OUTCOME 全表投影: 三格直通, 其余→failed', () => {
    const kinds: RunOutcomeKind[] = ['success', 'not-converged', 'oracle-failed', 'blocked', 'budget-exhausted', 'cancelled', 'infra-error', 'missing-capability', 'not-needed', 'empty-result', 'unclassified'];
    for (const k of kinds) {
      const want: 'converged' | 'failed' | 'cancelled' | 'not-converged' =
        k === 'success' ? 'converged' : k === 'cancelled' ? 'cancelled' : k === 'not-converged' ? 'not-converged' : 'failed';
      expect(BOARD_TERMINAL_OUTCOME[k]).toBe(want);
    }
  });
  // ── 终态 emit 的端到端面: 不只测投影表, 每个可达终态 outcome 都真 append 过 terminal ──
  // 可达 run 终态 = N5 outcome 阶梯 (run-goal.ts) 能产出的 8 个; stage 级 outcome
  // (missing-capability / not-needed / empty-result / unclassified) 到不了 run 终态, 由投影表测试兜底。
  const TERMINAL_CASES: {
    kind: RunOutcomeKind;
    want: 'converged' | 'failed' | 'cancelled' | 'not-converged';
    dag: () => ExecutorDagResult;
  }[] = [
    { kind: 'success', want: 'converged', dag: () => executeDag({ converged: true }) },
    { kind: 'not-converged', want: 'not-converged', dag: () => executeDag({ converged: false }) },
    { kind: 'oracle-failed', want: 'failed', dag: () => executeDag({ converged: true, accept: 'failed' }) },
    { kind: 'cancelled', want: 'cancelled', dag: () => executeDag({ converged: false, cancelled: '外部叫停' }) },
    { kind: 'blocked', want: 'failed', dag: () => executeDag({ converged: false, blocked: '等 owner 拍板' }) },
    { kind: 'budget-exhausted', want: 'failed', dag: () => executeDag({ converged: false, budgetStopped: '预算用尽' }) },
    { kind: 'infra-error', want: 'failed', dag: () => executeDag({ converged: false, infraStopped: 'judge 调不通' }) },
  ];
  for (const c of TERMINAL_CASES) {
    test(`终态 emit: ${c.kind} → terminal(${c.want}), 与 claimed 配对同 runId`, async () => {
      const cwd = mkdtempSync(join(tmpdir(), 'omd-goal-s4-'));
      const r = await runGoal('做一个事', cfg({ sessionId: 'sess-s4-t' }, {
        cwd,
        _classify: cls('simple'),
        _runDag: dagRouter({ execute: async () => c.dag() }),
      }));
      expect(r.outcome).toBe(c.kind); // 先证注入面把 run 推到了这个终态, 再证终态记了账
      const term = readBoard(cwd).find((e) => e.event === 'terminal');
      expect(term?.runId).toBe('sess-s4-t');
      expect(term?.outcome).toBe(c.want);
      expect(term?.note).toBe(c.kind); // 粗态进 outcome, 细粒度留在 note (S4)
      expect(readBoard(cwd).some((e) => e.runId === 'sess-s4-t' && e.event === 'claimed')).toBe(true);
    });
  }

  test('终态 emit: execute 抛错 (bail 路) → terminal(infra-error) 也落板', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-goal-s4-'));
    const r = await runGoal('做一个事', cfg({ sessionId: 'sess-s4-bail' }, {
      cwd,
      _classify: cls('simple'),
      _runDag: dagRouter({ execute: async () => { throw new Error('exec 引擎炸'); } }),
    }));
    expect(r.outcome).toBe('infra-error');
    const term = readBoard(cwd).find((e) => e.event === 'terminal');
    expect(term?.outcome).toBe('failed');
    expect(term?.note).toBe('infra-error');
  });

  test('删板不抹历史: board 是协调介质不是真源, RunGoalResult + 落盘 goal-state 才是', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-goal-s4-'));
    const runId = 'sess-s4-del';
    const counters = { classify: 0, contract: 0, exec: 0 };
    const mk = (): RunGoalConfig => ({
      cwd,
      dag: {
        conductorModel: 'c:m',
        leafModel: 'l:m',
        agentRunner: (async () => ({ text: 'x', usage: { in: 1, out: 1 } })) as never,
        continuity: { manager: {} as never, runId },
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
    const r1 = await runGoal('目标甲', mk());
    expect(r1.outcome).toBe('success');
    // 终态与落盘真源都在 —— 板只是协调介质上的指针
    expect(readBoard(cwd).some((e) => e.runId === runId && e.event === 'terminal')).toBe(true);
    const statePath = join(cwd, '.omd', 'continuity', runId, 'goal-state.json');
    expect(existsSync(statePath)).toBe(true);
    // 删板: 协调介质消失
    rmSync(join(cwd, '.omd', 'run-board.jsonl'));
    expect(readBoard(cwd)).toEqual([]);
    // 权威 run 历史不依赖板: 返回面 (RunGoalResult) 的终态结论一字未变
    expect(r1.converged).toBe(true);
    expect(r1.stages.find((s) => s.stage === 'execute')!.outcome).toBe('success');
    // 落盘 goal-state 才是续跑真源: 同 goal 同 runId 二跑 → 契约段复用 (闸 C 锚在盘上 state, 不在板)
    const contractBefore = counters.contract;
    const r2 = await runGoal('目标甲', mk());
    expect(counters.contract).toBe(contractBefore); // 0 次重跑 → 删板没抹掉可续跑的历史
    expect(r2.converged).toBe(true);
  });

  test('越闸必留账 (INV-5 后半): force → ok 且板上 note 点名撞了谁; note 不进活 run 判定', () => {
    const root = mkdtempSync(join(tmpdir(), 'omd-goal-s4-'));
    appendBoard(root, { v: 1, ts: new Date().toISOString(), runId: 'sess-other', event: 'claimed', writeSet: ['docs/a.md'] });
    // 无 force → blocked 且零越闸证据 (不许偷偷过)
    expect(ignitionPreflight(root, ['docs/a.md'], {}).verdict).toBe('blocked');
    expect(readBoard(root).filter((e) => e.event === 'note' && e.runId === BOARD_RUN_ID)).toHaveLength(0);
    // force → ok, 但账必留: note 点名撞了哪个 run、哪些文件
    const rep = ignitionPreflight(root, ['docs/a.md'], { force: true });
    expect(rep.verdict).toBe('ok');
    const notes = readBoard(root).filter((e) => e.event === 'note' && e.runId === BOARD_RUN_ID);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.note).toContain('sess-other');
    expect(notes[0]!.note).toContain('docs/a.md');
    // 账是板级证据 (BOARD_RUN_ID), 不冒充活 run: liveRuns 判定只看 claimed/terminal 对
    expect([...liveRuns(readBoard(root)).keys()]).toEqual(['sess-other']);
    // 二次独立重读账还在 (持久化, 不是单次读的瞬时态)
    expect(readBoard(root).filter((e) => e.event === 'note' && e.runId === BOARD_RUN_ID)).toHaveLength(1);
  });
});

describe('scripts/board-publish — published 条目 CLI (零 LLM)', () => {
  test('publishEntry 追加合法 published 条目 (artifact + commit)', () => {
    const root = mkdtempSync(join(tmpdir(), 'omd-board-publish-'));
    publishEntry(root, 'run-p1', 'docs/plan/x.md', 'deadbeef');
    const pub = readBoard(root).find((e) => e.event === 'published');
    expect(pub?.runId).toBe('run-p1');
    expect(pub?.artifact).toBe('docs/plan/x.md');
    expect(pub?.commit).toBe('deadbeef');
  });

  test('CLI 四参追加; 缺参 exit 2 且不写板', () => {
    const root = mkdtempSync(join(tmpdir(), 'omd-board-publish-'));
    const script = join(import.meta.dir, '..', '..', '..', 'scripts', 'board-publish.ts');
    const ok = Bun.spawnSync(['bun', 'run', script, root, 'run-p2', 'docs/plan/y.md', 'cafebabe']);
    expect(ok.exitCode).toBe(0);
    const bad = Bun.spawnSync(['bun', 'run', script, root, 'run-p2']);
    expect(bad.exitCode).toBe(2);
    const pubs = readBoard(root).filter((e) => e.event === 'published');
    expect(pubs).toHaveLength(1);
    expect(pubs[0]?.commit).toBe('cafebabe');
  });
});

// ── P4 设计审核集成 (INV-3 / INV-6 / G-4 / D-7) ──────────────────────────────
//
// 这些测试走 runGoal() 全路径 (非 maybeRunDesignReview 纯核直调), 验证接线真的通了。
// 纯核判据在 design-review.test.ts 里, 这里钉的是「runGoal → designReview 结果面」的契约。

describe('runGoal — P4 设计审核集成 (INV-3 / INV-6 / G-4 / D-7)', () => {
  /** 造一份带设计审核的 config: 注入文件列表 + 可选的审核 runner。 */
  const drCfg = (opts: {
    changedFiles: string[];
    runReview?: (diff: string, cwd: string) => Promise<{ findings: import('../profiles/review-ledger').ReviewFinding[]; usage: { in: number; out: number } }>;
    repairAttempted?: boolean;
  }): RunGoalConfig => {
    const c = cfg({}, {
      acceptance: { kind: 'executable', command: 'true', expectExit: 0 },
      tier: 'simple',
      writeSet: { _collectChangedFiles: () => opts.changedFiles },
      designReview: {
        _runReview: opts.runReview,
        ...(opts.repairAttempted !== undefined ? { repairAttempted: opts.repairAttempted } : {}),
      },
    });
    return c;
  };

  // ── G-4 / INV-6: 调度判定 ─────────────────────────────────────────────────

  test('INV-6 / G-4: [src/a.ts] 非前端文件 → designReview.scheduled=false, usage 零', async () => {
    const r = await runGoal('做个事', drCfg({ changedFiles: ['src/a.ts'] }));
    expect(r.designReview).toBeDefined();
    expect(r.designReview!.scheduled).toBe(false);
    expect(r.designReview!.usage.in).toBe(0);
    expect(r.designReview!.usage.out).toBe(0);
    expect(r.designReview!.added).toBe(0);
    expect(r.converged).toBe(true); // 不调度不影响收敛
  });

  test('G-4: [src/App.tsx] 前端文件 → designReview.scheduled=true, 用量如实', async () => {
    const fp = fingerprintOf('src/App.tsx', '间距不对');
    const r = await runGoal('做个事', drCfg({
      changedFiles: ['src/App.tsx'],
      runReview: async () => ({
        findings: [{
          where: 'src/App.tsx',
          severity: 'p2' as const,
          evidence: '间距不对',
          suggestion: '加 gap-4',
          uncertainty: '低',
          fingerprint: fp,
        }],
        usage: { in: 120, out: 60 },
      }),
    }));
    expect(r.designReview!.scheduled).toBe(true);
    expect(r.designReview!.usage.in).toBe(120);
    expect(r.designReview!.usage.out).toBe(60);
    expect(r.designReview!.added).toBe(1);
    expect(r.designReview!.findings).toHaveLength(1);
    expect(r.designReview!.findings[0]!.fingerprint).toBe(fp);
  });

  test('G-4: 写集混有前后端 → 仅前端部分触发调度, scheduled=true', async () => {
    const fp = fingerprintOf('src/ui/Modal.tsx', '层级错');
    const r = await runGoal('做个事', drCfg({
      changedFiles: ['src/model/types.ts', 'src/ui/Modal.tsx', 'README.md'],
      runReview: async () => ({
        findings: [{ where: 'src/ui/Modal.tsx', severity: 'p2', evidence: '层级错', suggestion: 'z-50', uncertainty: '中', fingerprint: fp }],
        usage: { in: 30, out: 15 },
      }),
    }));
    expect(r.designReview!.scheduled).toBe(true);
    expect(r.designReview!.added).toBe(1);
  });

  test('INV-6: 空写集 → 不调度, usage 零, 零模型调用', async () => {
    const r = await runGoal('做个事', drCfg({ changedFiles: [] }));
    expect(r.designReview!.scheduled).toBe(false);
    expect(r.designReview!.usage.in).toBe(0);
    expect(r.converged).toBe(true);
  });

  // ── INV-3: 审核失败/timeout → converged 与无审核逐位相同 ──────────────────

  test('INV-3: _runReview 抛错 → scheduled=true 但 added=0, converged 同无审核基线', async () => {
    const base = cfg({}, {
      acceptance: { kind: 'executable', command: 'true', expectExit: 0 },
      tier: 'simple',
      writeSet: { _collectChangedFiles: () => ['src/App.tsx'] },
    });
    // 有审核但审核崩了
    const rFail = await runGoal('做个事', {
      ...base,
      designReview: { _runReview: async () => { throw new Error('审核叶崩了'); } },
    });
    // 无审核基线
    const rBase = await runGoal('做个事', { ...base });
    // INV-3: converged 结论逐位相同
    expect(rFail.converged).toBe(rBase.converged);
    expect(rFail.outcome).toBe(rBase.outcome);
    expect(rFail.rounds).toBe(rBase.rounds);
    expect(rFail.stages.at(-1)!.status).toBe(rBase.stages.at(-1)!.status);
    expect(rFail.stages.at(-1)!.outcome).toBe(rBase.stages.at(-1)!.outcome);
    // 审核本身留痕: scheduled=true 但 added=0 (抛错后闸缺席不抛)
    expect(rFail.designReview!.scheduled).toBe(true);
    expect(rFail.designReview!.added).toBe(0);
    expect(rFail.designReview!.usage.in).toBe(0);
    // 基线无审核
    expect(rBase.designReview).toBeUndefined();
  });

  test('INV-3: 审核配了但 designReview 整段缺席 → 结果面 designReview=undefined, 收敛不变', async () => {
    const r = await runGoal('做个事', cfg({}, {
      acceptance: { kind: 'executable', command: 'true', expectExit: 0 },
      tier: 'simple',
    }));
    expect(r.designReview).toBeUndefined();
    expect(r.converged).toBe(true);
  });

  // ── D-7: 一波一修 / 同因熔断 / 存活转票 ───────────────────────────────────

  test('D-7: 首轮 findings → added≥1, fused/tickets 全空 (repairAttempted 缺省 = false)', async () => {
    const fp = fingerprintOf('src/Header.tsx', '对齐不一致');
    const r = await runGoal('做个事', drCfg({
      changedFiles: ['src/Header.tsx'],
      runReview: async () => ({
        findings: [{ where: 'src/Header.tsx', severity: 'p2', evidence: '对齐不一致', suggestion: 'flex + gap', uncertainty: '低', fingerprint: fp }],
        usage: { in: 40, out: 20 },
      }),
    }));
    expect(r.designReview!.added).toBe(1);
    expect(r.designReview!.findings).toHaveLength(1);
    expect(r.designReview!.fused).toEqual([]);
    expect(r.designReview!.tickets).toEqual([]);
  });

  test('D-7: repairAttempted=true + 同指纹 → fused (熔断), added=0, 不落账', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-goal-dr-'));
    const fp = fingerprintOf('src/Sidebar.tsx', '色相对比不够');
    const finding = { where: 'src/Sidebar.tsx', severity: 'p2' as const, evidence: '色相对比不够', suggestion: '加深', uncertainty: '中', fingerprint: fp };
    const mk = (repairAttempted: boolean): RunGoalConfig => ({
      cwd,
      dag: { conductorModel: 'c:m', leafModel: 'l:m' } as ExecutorDagConfig,
      _today: () => '2026-07-28',
      _runDag: dagRouter({}),
      _classify: cls('simple'),
      acceptance: { kind: 'executable', command: 'true', expectExit: 0 },
      tier: 'simple',
      writeSet: { _collectChangedFiles: () => ['src/Sidebar.tsx'] },
      designReview: {
        _runReview: async () => ({ findings: [finding], usage: { in: 10, out: 5 } }),
        repairAttempted,
      },
    });
    // 首轮: repairAttempted=false → 落账
    const r1 = await runGoal('修侧栏', mk(false));
    expect(r1.designReview!.added).toBe(1);
    expect(r1.designReview!.fused).toEqual([]);
    // 修复后: repairAttempted=true, 同指纹 → fused, 不落账
    const r2 = await runGoal('修侧栏', mk(true));
    expect(r2.designReview!.added).toBe(0);
    expect(r2.designReview!.fused).toHaveLength(1);
    expect(r2.designReview!.fused[0]!.fingerprint).toBe(fp);
    expect(r2.designReview!.tickets).toEqual([]); // 同指纹归 fused, 不是 tickets
  });

  test('D-7: repairAttempted=true + 新指纹 (台账无记录) → tickets (存活转票), added=0', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-goal-dr-'));
    const fpOld = fingerprintOf('src/Nav.tsx', '旧问题');
    const fpNew = fingerprintOf('src/Nav.tsx', '新问题');
    const mk = (fps: string[], repairAttempted: boolean): RunGoalConfig => ({
      cwd,
      dag: { conductorModel: 'c:m', leafModel: 'l:m' } as ExecutorDagConfig,
      _today: () => '2026-07-28',
      _runDag: dagRouter({}),
      _classify: cls('simple'),
      acceptance: { kind: 'executable', command: 'true', expectExit: 0 },
      tier: 'simple',
      writeSet: { _collectChangedFiles: () => ['src/Nav.tsx'] },
      designReview: {
        _runReview: async () => ({
          findings: fps.map((fp) => ({ where: 'src/Nav.tsx', severity: 'p2' as const, evidence: fp === fpOld ? '旧问题' : '新问题', suggestion: '改', uncertainty: '低', fingerprint: fp })),
          usage: { in: 10, out: 5 },
        }),
        repairAttempted,
      },
    });
    // 首轮: 落账旧指纹
    const r1 = await runGoal('修导航', mk([fpOld], false));
    expect(r1.designReview!.added).toBe(1);
    // 修复后: 报新指纹 → tickets (台账里没有 = 修复后的新发现物)
    const r2 = await runGoal('修导航', mk([fpNew], true));
    expect(r2.designReview!.added).toBe(0);
    expect(r2.designReview!.fused).toEqual([]);
    expect(r2.designReview!.tickets).toHaveLength(1);
    expect(r2.designReview!.tickets[0]!.fingerprint).toBe(fpNew);
  });

  test('D-7: 同批内重复指纹 → 首轮去重 (deduped≥1), 不产生多轮修复', async () => {
    const fp = fingerprintOf('src/Footer.tsx', '版权年份');
    const r = await runGoal('做个事', drCfg({
      changedFiles: ['src/Footer.tsx'],
      runReview: async () => ({
        findings: [
          { where: 'src/Footer.tsx', severity: 'p2', evidence: '版权年份', suggestion: '改 2026', uncertainty: '低', fingerprint: fp },
          { where: 'src/Footer.tsx', severity: 'p2', evidence: '版权年份', suggestion: '改 2026', uncertainty: '低', fingerprint: fp }, // 同指纹
        ],
        usage: { in: 10, out: 5 },
      }),
    }));
    expect(r.designReview!.added).toBe(1); // 只落一条
    expect(r.designReview!.deduped).toBeGreaterThanOrEqual(1); // 第二条被去重
    expect(r.designReview!.fused).toEqual([]);
    expect(r.designReview!.tickets).toEqual([]);
  });
});

// ── 实验臂 contract-distill (`.omd/experiments.json` 的 `contractFaninDistill`) ──────────────
//
// 只碰契约段 (`goal-contract`) 的 dagCfg.faninSummary.minFanout, 且只把它收紧到 1 —— 调用方原有
// faninSummary 字段透传不丢, execute 段一律不受影响。旗标 off/缺失/坏 JSON → readExperimentFlags
// 恒回 off, `dagCfg` 与 `baseDagCfg` 同一引用 → 两段 config 零字段增删 (INV-1)。

import { afterEach, beforeEach, spyOn } from 'bun:test';
import * as repoRoot from '../repo-root';

describe('实验臂 contract-distill — 契约段 fan-in 摘要扇出闸', () => {
  let flagRoot: string;

  beforeEach(() => {
    flagRoot = mkdtempSync(join(tmpdir(), 'omd-goal-distill-flag-'));
    mkdirSync(join(flagRoot, '.omd'), { recursive: true });
    spyOn(repoRoot, 'omdRepoRoot').mockReturnValue(flagRoot);
  });

  afterEach(() => {
    rmSync(flagRoot, { recursive: true, force: true });
  });

  const mkCaptured = (captured: { contract?: ExecutorDagConfig; execute?: ExecutorDagConfig }): RunGoalConfig => ({
    cwd: mkdtempSync(join(tmpdir(), 'omd-goal-distill-')),
    dag: {
      conductorModel: 'c:m',
      leafModel: 'l:m',
      agentRunner: (async () => ({ text: 'x', usage: { in: 1, out: 1 } })) as never,
      // 调用方原有 faninSummary — 用来证「其它字段透传不丢」, 不是引擎默认值。
      faninSummary: { minChars: 999, model: 'x:y' },
      continuity: { manager: {} as never, runId: 'run-distill' },
    } as ExecutorDagConfig,
    _today: () => '2026-08-14',
    _classify: cls('complex'),
    _runDag: (async (plan: ConductorPlan, dagCfg: ExecutorDagConfig) => {
      if (plan.name === 'goal-contract') {
        captured.contract = dagCfg;
        return contractDag({ specFile: 'docs/plan/2026-07-28-x.md', specText: '契约正文' });
      }
      captured.execute = dagCfg;
      return executeDag({ converged: true });
    }) as never,
  });

  // 证伪 (a): 若接线漏做了默认值改写 (如把缺席误写成显式 `{minFanout:2}`) → 下面两处
  // `toEqual({ minChars: 999, model: 'x:y' })` 会因多出 `minFanout` 键当场红 (INV-1)。
  // INV-2 实测已跑 (2026-08-14): 把 `readExperimentFlags()` 临时硬编码为恒回
  // `{ contractFaninDistill: true }`, 跑 `bun test src/harness/goal/run-goal.test.ts` ——
  // 本条当场变红 (`toEqual` 多出 `"minFanout": 1`), 其余 82 条不受影响; 还原后 `git diff` 为空,
  // 复跑全绿 (88 pass)。证明本条测试确实在验旗标接线, 不是虚闸。
  test('旗标 off (无 .omd/experiments.json) → 两段 config 与调用方原样逐字节等价', async () => {
    const captured: { contract?: ExecutorDagConfig; execute?: ExecutorDagConfig } = {};
    const config = mkCaptured(captured);
    await runGoal('目标 off', config);
    expect(captured.contract).toBeDefined();
    expect(captured.execute).toBeDefined();
    expect(captured.contract!.faninSummary).toEqual({ minChars: 999, model: 'x:y' });
    expect(captured.execute!.faninSummary).toEqual({ minChars: 999, model: 'x:y' });
    // execute 段整体也逐字节等价于「本改动之前」的既有推导 (D-I 冻结判据附加, 与本实验臂无关)
    expect(captured.execute).toEqual({
      ...config.dag,
      freezeCriterion: { command: 'bun test', expectExit: 0 },
    });
    // 契约段除 runId 后缀外逐字节等价
    expect(captured.contract).toEqual({
      ...config.dag,
      continuity: { ...config.dag.continuity!, runId: 'run-distill-contract' },
    });
  });

  // 证伪 (b): 若把 minFanout 接到了 execute 段而非契约段 → `captured.execute!.faninSummary` 的
  // `minFanout` 也会变 1, 最后一条断言当场红; 若接线丢了原有 `model` 字段 → 透传断言当场红。
  test('旗标 on → 契约段 minFanout 收紧到 1, 原字段透传, execute 段不受影响', async () => {
    writeFileSync(join(flagRoot, '.omd', 'experiments.json'), JSON.stringify({ contractFaninDistill: true }));
    const captured: { contract?: ExecutorDagConfig; execute?: ExecutorDagConfig } = {};
    const config = mkCaptured(captured);
    await runGoal('目标 on', config);
    expect(captured.contract!.faninSummary).toEqual({ minChars: 999, model: 'x:y', minFanout: 1 });
    expect(captured.execute!.faninSummary).toEqual({ minChars: 999, model: 'x:y' });
  });

  // 证伪 (c): 若旗标读了但没接到 spec stage 的 summary 拼接 → 这里的 `toContain` 当场红。
  test('旗标 on → spec stage summary 末尾带实验臂标记', async () => {
    writeFileSync(join(flagRoot, '.omd', 'experiments.json'), JSON.stringify({ contractFaninDistill: true }));
    const captured: { contract?: ExecutorDagConfig; execute?: ExecutorDagConfig } = {};
    const r = await runGoal('目标 on 标记', mkCaptured(captured));
    const specStage = r.stages.find((s) => s.stage === 'spec');
    expect(specStage!.summary).toContain(' · 实验臂: contract-distill');
  });
});

// ── #165① accept 被红级联压死 → 冻结判据收尾复验 (delivered-with-red) ──────────────
describe('#165① delivered-with-red: accept 没跑而判据复验绿', () => {
  // 证伪方式 (当场验过): 删掉 run-goal 里 oracleRecheckGreen 复验块 → 第一条红 (退回 not-converged); 恢复后绿。
  test('accept absent (级联压死) ∧ 复验 exit 0 → outcome=delivered-with-red, converged 仍 false (红节点不漂白)', async () => {
    const r = await runGoal('goal', {
      ...cfg({ commandRunner: cmdRunner(0) }),
      _classify: cls('complex'),
      _runDag: dagRouter({ execute: async () => executeDag({ converged: false, accept: 'absent', status: 'failed' }) }),
    });
    expect(r.outcome).toBe('delivered-with-red');
    expect(r.converged).toBe(false);
    const exec = r.stages.find((s) => s.stage === 'execute')!;
    expect(exec.status).toBe('failed');
    expect(exec.summary).toContain('交付达标但有节点红');
  });

  test('accept absent ∧ 复验 exit 1 → 维持原判 (not-converged), 不编绿', async () => {
    const r = await runGoal('goal', {
      ...cfg({ commandRunner: cmdRunner(1) }),
      _classify: cls('complex'),
      _runDag: dagRouter({ execute: async () => executeDag({ converged: false, accept: 'absent', status: 'failed' }) }),
    });
    expect(r.outcome).toBe('not-converged');
  });

  test('accept 真跑真红 → 不复验 (交付没达标如实报 oracle-failed, 抖动那半归 S-37)', async () => {
    // commandRunner 给 0: 若实现错把「真红」也拿去复验, 会误判 delivered-with-red —— 本断言即闸。
    const r = await runGoal('goal', {
      ...cfg({ commandRunner: cmdRunner(0) }),
      _classify: cls('complex'),
      _runDag: dagRouter({ execute: async () => executeDag({ converged: true, accept: 'failed' }) }),
    });
    expect(r.outcome).toBe('oracle-failed');
  });

  test('无 commandRunner → 不复验, 行为与今天一致', async () => {
    const r = await runGoal('goal', {
      ...cfg(),
      _classify: cls('complex'),
      _runDag: dagRouter({ execute: async () => executeDag({ converged: false, accept: 'absent', status: 'failed' }) }),
    });
    expect(r.outcome).toBe('not-converged');
  });
});
