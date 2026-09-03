/**
 * N5 run/goal 级终止原因词表 (2026-07-31) 的行为网。
 *
 * 与 P1 那张网 (`node-failure-kind.test.ts`) 同一条纪律:证的**不是**"我加的字段传对了"
 * (旋钮测试),而是那个真正要紧的性质 ——
 *
 *   **两个后续动作相反的收尾,在结果上必须分得开。**
 *
 * ★ 这张网的原型对**来自一次真跑**,不是想出来的:2026-07-31 第二跑 live 里 §8.4 熔断正确命中
 *   → BLOCKED 出口,而 goal 摘要印的是 `[failed] execute — 2 轮阻塞: …`。
 *   一次判定正确的阻塞被念成失败,同一份摘要底下另一行却写着"阻塞(需外部输入)"。
 *   所以第一组用例钉的就是这一对:**status 相同、outcome 不同、下一步相反**。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGoal, type RunGoalConfig } from '../../src/harness/goal/run-goal';
import { summarizeGoal } from '../../src/mcp/tools/goal';
import { createDagRecorder } from '../../src/harness/dag/dag-record';
import { RUN_OUTCOME_INFO, RUN_OUTCOME_ORDER, deriveRunOutcome, type RunOutcomeKind } from '../../src/harness/run-outcome';
import type { ExecutorDagResult } from '../../src/harness/dag/types';

// ── goal 侧夹具: simple 档 (不走契约段) + 注入式 _runDag, 编排循环的 conductor 节点定生死 ──────
// (探索型没有环外判据, run-goal 的环结论 = conductor 节点 status; v1 内环的 converged/rounds 已随 v1 退役。)
const leaf = (over: Record<string, unknown>) => ({ id: 'conductor', kind: 'agent', deps: [], output: '', usage: { in: 1, out: 1 }, filesTouched: [], ...over });
const goalCfg = (execute: Record<string, unknown>, extra: Partial<ExecutorDagResult> = {}): RunGoalConfig =>
  ({
    cwd: '/tmp',
    dag: { conductorModel: 'm', leafModel: 'l' },
    tier: 'simple',
    // 探索型 = 没有环外冻结判据节点, 于是这组用例只由 conductor 那个节点的收尾决定 outcome。
    acceptance: { kind: 'exploratory', learningGoal: 'x', affordableLoss: 'y' },
    _classify: async () => ({ tier: 'simple', acceptance: { kind: 'exploratory', learningGoal: 'x', affordableLoss: 'y' } }),
    _runDag: async () =>
      ({ plan: { name: 'goal-orchestrating-loop', nodes: {} }, sessionId: 's', levels: [['conductor']], results: { conductor: leaf(execute) }, usage: { conductor: { in: 1, out: 1 }, leavesIn: 1, leavesOut: 1, leavesCacheHit: 0 }, ...extra }) as unknown as ExecutorDagResult,
  }) as unknown as RunGoalConfig;

describe('N5 · 阻塞 vs 未收敛 (整张表的原型对 —— 来自 2026-07-31 第二跑 live)', () => {
  test('环判定推不动 → blocked (BLOCKED: 加轮数没用)', async () => {
    const r = await runGoal('g', goalCfg({ status: 'failed', blocked: '同一条命令逐字相同地失败 2 次' }));
    expect(r.outcome).toBe('blocked');
    expect(RUN_OUTCOME_INFO.blocked.resumable).toBe(false);
  });

  test('轮数用尽而 judge 说没达标 → not-converged (STALLED: 再给几轮可能就成)', async () => {
    const r = await runGoal('g', goalCfg({ status: 'failed' }));
    expect(r.outcome).toBe('not-converged');
    expect(RUN_OUTCOME_INFO['not-converged'].resumable).toBe(true);
  });

  test('★ 两者的 status 一模一样 —— 靠 status 分不开, 靠 outcome 分得开', async () => {
    const blocked = await runGoal('g', goalCfg({ status: 'failed', blocked: '材料自相矛盾, 再转多少轮都一样' }));
    const stalled = await runGoal('g', goalCfg({ status: 'failed' }));
    const stageOf = (r: Awaited<ReturnType<typeof runGoal>>) => r.stages.find((s) => s.stage === 'execute')!;
    // ← 此前唯一能读到的那一位: 相同 (两者都是 failed, 而其中一次判定完全正确)
    expect(stageOf(blocked).status).toBe(stageOf(stalled).status);
    expect(stageOf(blocked).status).toBe('failed'); // 粗态零回归: BLOCKED 在这一位上仍是 failed
    // ← 细化买到的东西, 而且两者的下一步**相反**
    expect(stageOf(blocked).outcome).not.toBe(stageOf(stalled).outcome);
    expect(RUN_OUTCOME_INFO[stageOf(blocked).outcome].resumable).toBe(false);
    expect(RUN_OUTCOME_INFO[stageOf(stalled).outcome].resumable).toBe(true);
  });

  test('预算停 ≠ 阻塞: 前者加预算就能续, 后者加多少轮都一样', async () => {
    const r = await runGoal('g', goalCfg({ status: 'failed', budgetStopped: '预算触顶' }));
    expect(r.outcome).toBe('budget-exhausted');
    expect(RUN_OUTCOME_INFO['budget-exhausted'].loopState).toBe('EXHAUSTED');
    // 两格的 resumable 都是 false, 但**理由不同** —— 所以下一句话必须不同, 否则该合并
    expect(RUN_OUTCOME_INFO['budget-exhausted'].nextAction).not.toBe(RUN_OUTCOME_INFO.blocked.nextAction);
  });

  test('被叫停 → cancelled: 唯一"原样 resume 就接着跑"的格', async () => {
    const r = await runGoal('g', goalCfg({ status: 'failed' }, { cancelled: { reason: 'owner 叫停', at: 'n', notRun: [] } }));
    expect(r.outcome).toBe('cancelled');
    expect(RUN_OUTCOME_INFO.cancelled.resumable).toBe(true);
  });

  test('conductor 说成了 + 冻结判据没过 → not-converged (循环路径: 有可执行判据时停止规则唯一 = 判据); oracle-failed 词条仍在表里', async () => {
    const cfg = {
      ...goalCfg({ status: 'done' }),
      acceptance: { kind: 'executable' as const, command: 'grep -q x f', expectExit: 0 },
      _classify: async () => ({ tier: 'simple' as const, acceptance: { kind: 'executable' as const, command: 'grep -q x f', expectExit: 0 } }),
      _runDag: async () =>
        ({
          plan: { name: 'goal-orchestrating-loop', nodes: {} },
          sessionId: 's',
          levels: [['conductor'], ['accept']],
          results: { conductor: leaf({ status: 'done' }), accept: { id: 'accept', kind: 'command', deps: ['conductor'], status: 'failed', output: '', usage: { in: 0, out: 0 } } },
          usage: { conductor: { in: 1, out: 1 }, leavesIn: 1, leavesOut: 1, leavesCacheHit: 0 },
        }) as unknown as ExecutorDagResult,
    } as unknown as RunGoalConfig;
    const r = await runGoal('g', cfg);
    expect(r.converged).toBe(false);
    expect(r.outcome).toBe('not-converged');
    expect(r.criteria?.oracle).toBe(false);
    // oracle-failed 这一格在循环路径上只剩 rubric 分型可达; 词条本身留着 —— 「不知道该归哪边」是真的不知道
    expect(RUN_OUTCOME_INFO['oracle-failed'].resumable).toBeNull();
  });

  test('收敛 → success, 且它是唯一一个 status=done 的格', async () => {
    const r = await runGoal('g', goalCfg({ status: 'done' }));
    expect(r.outcome).toBe('success');
    expect(r.stages.find((s) => s.stage === 'execute')!.status).toBe('done');
  });
});

describe('N5 · 「不需要」vs「跑了空手而归」(stage 级此前被 skipped|failed 压扁的那一对)', () => {
  const contractCfg = (kids: Record<string, unknown>): RunGoalConfig =>
    ({
      cwd: '/tmp',
      dag: { conductorModel: 'm', leafModel: 'l', agentRunner: async () => ({ text: '', usage: { in: 0, out: 0 } }) },
      tier: 'complex',
      acceptance: { kind: 'exploratory', learningGoal: 'x', affordableLoss: 'y' },
      _classify: async () => ({ tier: 'complex', acceptance: { kind: 'exploratory', learningGoal: 'x', affordableLoss: 'y' } }),
      _runDag: async (plan: { name: string }) =>
        (plan.name === 'goal-contract'
          ? { plan, sessionId: 's', levels: [['contract']], results: { contract: { id: 'contract', kind: 'conductor', deps: [], status: 'done', output: '正文', usage: { in: 1, out: 1 } }, ...kids }, usage: { conductor: { in: 1, out: 1 }, leavesIn: 1, leavesOut: 1, leavesCacheHit: 0 } }
          : { plan, sessionId: 's', levels: [['conductor']], results: { conductor: leaf({ status: 'done' }) }, usage: { conductor: { in: 1, out: 1 }, leavesIn: 1, leavesOut: 1, leavesCacheHit: 0 } }) as unknown as ExecutorDagResult,
    }) as unknown as RunGoalConfig;

  test('conductor 没分解出调研步 → not-needed (什么都不用做)', async () => {
    const r = await runGoal('g', contractCfg({}));
    const research = r.stages.find((s) => s.stage === 'research')!;
    expect(research.status).toBe('skipped');
    expect(research.outcome).toBe('not-needed');
  });

  // D-26/D-27 (2026-09-02): 下面两条原来钉的是「契约段自动展开 (tier='complex' 且无 sddPath
  // 时的 conductor 子图)」里 research 子节点 / agentRunner 缺件的两种细分降级 —— 该子图已撤销
  // (INV-11: 契约段唯一触发换成 sddPath), 无 sddPath 时 research/spec 恒 skipped/not-needed,
  // 不再有 empty-result / missing-capability 这两个中间态可留痕 (它们的产生条件已不存在)。
});

describe('N5 · run 级聚合 (deriveRunOutcome): 止损动作最强的那一格赢', () => {
  const node = (over: Record<string, unknown>) => ({ id: String(over.id ?? 'n'), kind: 'command', deps: [], status: 'failed', ...over });
  const res = (results: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    ({ results, ...extra }) as unknown as Parameters<typeof deriveRunOutcome>[0];

  test('全 done → success', () => {
    expect(deriveRunOutcome(res({ a: node({ id: 'a', status: 'done' }) }))).toBe('success');
  });

  test('空图不编 success —— "什么都没跑"与"全跑过了"不是一回事', () => {
    expect(deriveRunOutcome(res({}))).toBe('unclassified');
  });

  test('取消优先于图内发生了什么 (否则一次被叫停的 run 会被记成 not-converged)', () => {
    expect(deriveRunOutcome(res({ a: node({ id: 'a', failureKind: 'assert-failed' }) }, { cancelled: { reason: 'x', at: 'y', notRun: [] } }))).toBe('cancelled');
  });

  test('infra-error 压过 assert-failed —— 读的人下一步该看栈, 不是改断言', () => {
    expect(deriveRunOutcome(res({ a: node({ id: 'a', failureKind: 'assert-failed' }), b: node({ id: 'b', failureKind: 'infra-error' }) }))).toBe('infra-error');
  });

  test('闸拒 → blocked (节点级 gate-rejected 在 run 级的名字)', () => {
    expect(deriveRunOutcome(res({ a: node({ id: 'a', failureKind: 'gate-rejected' }) }))).toBe('blocked');
  });

  test('★ dep-skip / subgraph-failed 不参与聚合 —— 它们的真因在别处', () => {
    // 只有级联跳过 → 没有任何一格归得上, 老实说不知道, 而不是编一个 not-converged
    expect(deriveRunOutcome(res({ a: node({ id: 'a', status: 'skipped', failureKind: 'dep-skip' }) }))).toBe('unclassified');
    // 有真因时, 级联那些不许把分布带偏 (一失败一串跟着失败 → 分布会被级联量整体拉偏)
    expect(
      deriveRunOutcome(
        res({
          a: node({ id: 'a', failureKind: 'gate-rejected' }),
          b: node({ id: 'b', status: 'skipped', failureKind: 'dep-skip' }),
          c: node({ id: 'c', status: 'skipped', failureKind: 'dep-skip' }),
        }),
      ),
    ).toBe('blocked');
  });

  test('没标成因的失败 → unclassified, 且它垫底 (一个漏标不许盖掉整跑的成因)', () => {
    expect(deriveRunOutcome(res({ a: node({ id: 'a' }) }))).toBe('unclassified');
    expect(deriveRunOutcome(res({ a: node({ id: 'a' }), b: node({ id: 'b', failureKind: 'assert-failed' }) }))).toBe('not-converged');
  });
});

describe('N5 · 词表结构性守卫', () => {
  test('每一格的 nextAction 互不相同 (相同 = 它们该合并)', () => {
    const actions = RUN_OUTCOME_ORDER.map((k) => RUN_OUTCOME_INFO[k].nextAction);
    expect(new Set(actions).size).toBe(actions.length);
  });

  test('resumable=null 是**白名单**不是默认值 —— 只给"这一层答不了"的那一格', () => {
    // 与 P1 的 retryable 同一条纪律: null 的全部价值在于它稀有。一旦成了偷懒的默认值,
    // 读的人就再也用不上这一位。今天只有 oracle-failed: 归哪边取决于人看一眼是判据虚还是产物假。
    const nulls = RUN_OUTCOME_ORDER.filter((k) => RUN_OUTCOME_INFO[k].resumable === null);
    expect(new Set(nulls)).toEqual(new Set(['oracle-failed', 'unclassified']));
    for (const k of RUN_OUTCOME_ORDER) {
      if (nulls.includes(k)) continue;
      expect(typeof RUN_OUTCOME_INFO[k].resumable).toBe('boolean');
    }
  });

  test('SUCCESS 只有一格 —— "成了"不许有两种说法', () => {
    expect(RUN_OUTCOME_ORDER.filter((k) => RUN_OUTCOME_INFO[k].loopState === 'SUCCESS')).toEqual(['success']);
  });

  test('ERROR 那一格在上层真的存在了 (N5 的收尾判据本身)', () => {
    expect(RUN_OUTCOME_ORDER.some((k) => RUN_OUTCOME_INFO[k].loopState === 'ERROR')).toBe(true);
  });
});

describe('N5 · 摘要念对了没有 (G5「触发**并被正确读**」的后半句)', () => {
  test('★ 一次正确的 BLOCKED 不再被念成 failed', async () => {
    const r = await runGoal('g', goalCfg({ status: 'failed', blocked: '同一条命令逐字相同地失败 2 次' }));
    const text = summarizeGoal(r);
    // 上一跑 live 印的原文是 `[failed] execute — 2 轮阻塞: …`
    expect(text).not.toContain('[failed] execute');
    expect(text).toContain('[blocked/failed] execute');
    // 下一步也在同一份摘要里 —— 分类不落到动作上就白分
    expect(text).toContain('别加轮数');
  });

  test('未收敛与阻塞在摘要上分得开 (两者的下一步相反)', async () => {
    const stalled = summarizeGoal(await runGoal('g', goalCfg({ status: 'failed' })));
    expect(stalled).toContain('[not-converged/failed] execute');
    expect(stalled).toContain('加 maxRounds');
  });

  test('成了的时候不印"下一步" (成了就没有下一步这回事)', async () => {
    expect(summarizeGoal(await runGoal('g', goalCfg({ status: 'done' })))).not.toContain('终止原因');
  });
});

describe('N5 · 终止原因出得了图 (留痕 + 读数板)', () => {
  const seed = (dbPath: string) => {
    const recorder = createDagRecorder({ path: dbPath });
    const n = (id: string, extra: Record<string, unknown>) => ({ id, kind: 'command', deps: [], output: '', usage: { in: 0, out: 0 }, ...extra });
    const rec = (name: string, results: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
      recorder.record(
        { plan: { name, nodes: {} }, sessionId: 's', levels: [Object.keys(results)], results, usage: { conductor: { in: 1, out: 1 }, leavesIn: 10, leavesOut: 5, leavesCacheHit: 0 }, ...extra } as unknown as Parameters<typeof recorder.record>[0],
        { runId: name },
      );
    rec('all-good', { a: n('a', { status: 'done' }) });
    rec('gate', { a: n('a', { status: 'failed', failureKind: 'gate-rejected' }) });
    rec('boom', { a: n('a', { status: 'failed', failureKind: 'infra-error' }) });
    recorder.close();
  };

  test('留痕层记下 run 级终止原因 —— 聚合规则是个判断, 事后重发明必漂', () => {
    const recorder = createDagRecorder({ path: ':memory:' });
    const id = recorder.record(
      { plan: { name: 'p', nodes: {} }, sessionId: 's', levels: [['a']], results: { a: { id: 'a', kind: 'command', deps: [], status: 'failed', failureKind: 'gate-rejected', output: '', usage: { in: 0, out: 0 } } }, usage: { conductor: { in: 1, out: 1 }, leavesIn: 1, leavesOut: 1, leavesCacheHit: 0 } } as unknown as Parameters<typeof recorder.record>[0],
      { runId: 'r1' },
    );
    expect(recorder.get(id)!.outcome).toBe('blocked');
    recorder.close();
  });

  test('--json 按词表出 run 级分布, 且"没记"单独一个计数器', async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'n5-readout-')), 'runs.db');
    seed(dbPath);
    // spawnSync: 这类一次性 CLI 调用不需要异步子进程通道, 而那条通道在满负载下会
    // 掉 EBADF/epoll_ctl (2026-08-14 实测: 8 次全量中 4 次, 见 src/harness/proc/await-exit.ts)。
    const p = Bun.spawnSync(['bun', 'run', 'scripts/omd-readout.ts', '--db', dbPath, '--json']);
    const out = JSON.parse(p.stdout.toString()) as {
      outcomeCount: Record<RunOutcomeKind, number>;
      runsUnrecordedOutcome: number;
    };
    expect(p.exitCode).toBe(0);
    expect(out.outcomeCount.success).toBe(1);
    expect(out.outcomeCount.blocked).toBe(1); // ← 与下一行分得开, 这就是这一层细化买到的东西
    expect(out.outcomeCount['infra-error']).toBe(1);
    expect(out.runsUnrecordedOutcome).toBe(0);
  });

  test('文本板把每格的下一步一起印 (同 ⑦ 段的验收方式)', async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'n5-readout-txt-')), 'runs.db');
    seed(dbPath);
    // spawnSync: 这类一次性 CLI 调用不需要异步子进程通道, 而那条通道在满负载下会
    // 掉 EBADF/epoll_ctl (2026-08-14 实测: 8 次全量中 4 次, 见 src/harness/proc/await-exit.ts)。
    const p = Bun.spawnSync(['bun', 'run', 'scripts/omd-readout.ts', '--db', dbPath]);
    const text = p.stdout.toString();
    expect(p.exitCode).toBe(0);
    expect(text).toContain('⑨ run 级终止原因');
    expect(text).toContain('看栈'); // ERROR 那格的下一步 —— 五态里此前上层空着的格
    expect(text).toContain('别加轮数'); // BLOCKED 那格的下一步
  });
});
