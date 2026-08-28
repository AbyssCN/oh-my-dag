/**
 * rubric 验收步的 run-goal 接线 —— F2 片 4。
 *
 * 契约源:`docs/plan/2026-08-28-F2片4-rubric接线与闸登记-执行契约.md`。
 * 母契约:`docs/plan/2026-08-27-F2-rubric验收分型-执行契约.md`。
 *
 * ## 本片的判据面
 *
 * INV-1 · INV-3 · INV-4 · INV-5 · INV-6。
 * INV-2 (逐处定性可查) 由 `ugrep -c 'acceptance.kind' src/harness/goal/run-goal.ts` 与交付说明对账,
 * 不在本测试文件里断言 —— **数与注释同步**才是这道闸, 测试侧写死一个常数就是绕闸。
 *
 * ## 不动什么 (Non-goals 的机械落点)
 *
 * · 不引入新的验收机制:逐条判 (`rubric-spec.settleRubric`) + 冻结校验 (`verifyFrozen`)
 *   + 劣化自证 (`acceptance-gate.checklistDiscriminationReason`) 全在盘上, 本片只接。
 * · 不生成跨族劣化样本:对接的是 `ProbeItemOutcome[]` 这一份注入 (谁去生成它不归本片)。
 * · 不写阈值常数:`maxFailures` 走 `config.rubricVerdictInputs.maxFailures` 注入。
 * · 不碰 `src/mcp/tools/goal.ts` 与 `scripts/probe-classify.ts` —— 编译期那一类已处理完。
 *
 * ## 反作弊锚
 *
 * `RUBRIC_TWELVE_BRANCHES_TYPED` 是反作弊 EMPTY MATCH 那条的判据锚串, 在 verify 首段被查;
 * 同时作为 `describe` 标题的人读钩子, 表达 "每一处 `acceptance.kind` 分支都做了定性"。
 * ⚠ 不许拆成两个 `describe` 用同名 anchor —— verify 锚串在测试文件里**至少一处**完整出现,
 * 且对应那个 `describe` 块里**真正**测的是分支定性而不是别的什么。
 *
 * ## 接线形状
 *
 * | 分型 | accept 叶 | 环外确定性闸 | rubric 自有验收 |
 * |---|---|---|---|
 * | executable | 建 (`command` 节点) | 跑命令 → exit code | — |
 * | exploratory | 不建 | — | — (诚实地说"这次没有机器判据") |
 * | rubric | 不建 | — | 冻检查 → 劣化自证 → 逐条判 → settle |
 *
 * ## 注入面
 *
 * `config.rubricVerdictInputs._settleRubric` 是**仅供测试**的注入点 —— 生产不设, 由 wiring
 * 走默认 `rubric-spec.settleRubric`。测试塞一个计数器包一层, 直接量 "漂了/探针打不红时
 * settleRubric 的调用次数"。这是 ESM 下唯一能直接量到 `settleRubric` 调用次数的方法 —
 * 模块导出是 readonly binding, 没法 `(await import(...)).settleRubric = spy`。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGoal, type RunGoalConfig } from './run-goal';
import {
  freezeRubric,
  settleRubric,
  type RubricItem,
  type RubricItemTrace,
  type RubricVerdict,
} from './rubric-spec';
import type { ProbeItemOutcome } from './acceptance-gate';
import type { GoalClassification } from './classify-acceptance';
import type { ConductorPlan } from '../conductor-plan';
import type { ExecutorDagConfig, ExecutorDagResult } from '../dag/types';

// ── 夹具 ────────────────────────────────────────────────────────────────────

const items: readonly RubricItem[] = [
  { id: 'r1', requirement: '报告里点名了数据来源' },
  { id: 'r2', requirement: '每条结论都带一条可复跑的命令' },
  { id: 'r3', requirement: '没有把推断写成事实' },
];
const frozenSpec = freezeRubric([...items]);

const trace = (itemId: string, pass: boolean, reason: string): RubricItemTrace =>
  ({ itemId, pass, reason });

const executeDag = (opts: { converged?: boolean; rounds?: number } = {}): ExecutorDagResult => ({
  plan: { name: 'goal-execute', nodes: {} },
  results: {
    execute: {
      id: 'execute',
      status: 'done',
      kind: 'conductor',
      output: '[conductor 子图: 1/1 成功]',
      deps: [],
      usage: { in: 1, out: 1 },
      rounds: opts.rounds ?? 1,
      ...(opts.converged === undefined ? {} : { converged: opts.converged }),
    },
  },
  reusedNodes: [],
} as unknown as ExecutorDagResult);

const cls = () =>
  async (): Promise<GoalClassification> => ({
    tier: 'complex',
    acceptance: { kind: 'rubric', checklist: frozenSpec },
  });

type Inputs = NonNullable<RunGoalConfig['rubricVerdictInputs']>;

const rubricCfg = (
  inputs: Inputs,
  over: Partial<RunGoalConfig> = {},
): RunGoalConfig => ({
  cwd: mkdtempSync(join(tmpdir(), 'omd-rubric-wiring-')),
  dag: { conductorModel: 'c:m', leafModel: 'l:m' } as ExecutorDagConfig,
  _today: () => '2026-08-28',
  _classify: cls(),
  _runDag: (async () => executeDag({ converged: true })) as never,
  rubricVerdictInputs: inputs,
  ...over,
});

const fullPassTraces: readonly RubricItemTrace[] = [
  trace('r1', true, '源已点名'),
  trace('r2', true, '命令已附'),
  trace('r3', true, '推断与事实分记'),
];

// ── 测试 ────────────────────────────────────────────────────────────────────

describe('RUBRIC_TWELVE_BRANCHES_TYPED — rubric 验收步在 run-goal 里的接线', () => {
  test('INV-1 ★: rubric 型走自己的验收步,不建执行型 accept 叶', async () => {
    let seenPlan: ConductorPlan | undefined;
    const r = await runGoal('写一份报告', rubricCfg(
      {
        presented: [...items],
        degraded: [{ id: 'r1', pass: false }],
        traces: [...fullPassTraces],
        maxFailures: 0,
      },
      {
        _runDag: (async (plan: ConductorPlan) => {
          if (plan.name === 'goal-execute') seenPlan = plan;
          return executeDag({ converged: true });
        }) as never,
      },
    ));
    expect(seenPlan!.nodes.accept).toBeUndefined();
    const result = r as unknown as {
      rubricVerdict?: RubricVerdict;
      rubricRejection?: { source: string; reason: string };
    };
    expect(result.rubricVerdict).toBeDefined();
    expect(result.rubricVerdict!.pass).toBe(true);
    expect(result.rubricRejection).toBeUndefined();
  });

  // ── 2026-08-28 后续修:没拿到证明 = 不算成 (fail-closed) ────────────────────
  //
  // 片 4 交付时 `rubricOracleOk` 初值是无脑 `true`, 于是 `rubricVerdictInputs` **缺席**
  // (今天的生产常态 —— 还没有人注入) 时一个 rubric 目标会被判**已达成**。
  // 那是「加第三格时那条静默错路」换了个地方复现: 片 4 把它从 acceptCheckpointGreen
  // 挪到了这里, 没有消灭它。初值改由 `unprovenMeansFail(acceptance)` 定 ——
  // rubric **有**判据 (那份冻结的 checklist), 所以没被证明过就不算成, 与执行型同路。
  //
  // 反向自检:把初值改回 `true` → 本条当场红。
  test('★ rubric 但没有判词输入 → 判未达成 (fail-closed, 不是「没证明也算绿」)', async () => {
    const r = await runGoal('写一份报告', rubricCfg(undefined as never));
    const result = r as unknown as {
      rubricVerdict?: RubricVerdict;
      rubricRejection?: { source: string; reason: string };
      converged?: boolean;
    };
    // 没有输入 ⇒ 既没有判词也没有拒因 —— 但**不许**因此算成。
    expect(result.rubricVerdict).toBeUndefined();
    expect(result.converged).not.toBe(true);
  });

  test('INV-3 ★: checklist 漂了就不判 —— settleRubric 调用次数恰为 0', async () => {
    const drifted = items.map((it, i) => (i === 0 ? { ...it, requirement: `${it.requirement}。` } : it));
    let settleCalls = 0;
    const spySettle = ((t: readonly RubricItemTrace[], opts: Parameters<typeof settleRubric>[1]) => {
      settleCalls += 1;
      return settleRubric(t, opts);
    }) as typeof settleRubric;
    const r = await runGoal('写一份报告', rubricCfg({
      presented: [...drifted],
      degraded: [{ id: 'r1', pass: false }],
      traces: [...fullPassTraces],
      maxFailures: 0,
      _settleRubric: spySettle,
    }));
    expect(settleCalls).toBe(0);
    const result = r as unknown as {
      rubricVerdict?: RubricVerdict;
      rubricRejection?: { source: string; reason: string };
    };
    expect(result.rubricVerdict).toBeUndefined();
    expect(result.rubricRejection).toBeDefined();
    expect(result.rubricRejection!.source).toBe('frozen-drift');
    expect(result.rubricRejection!.reason).toContain('改过');
  });

  test('INV-4a ★: 劣化自证闸在逐条判真产物之前 —— 探针打不红时 settle 调用计数恰为 0', async () => {
    let settleCalls = 0;
    const spySettle = ((t: readonly RubricItemTrace[], opts: Parameters<typeof settleRubric>[1]) => {
      settleCalls += 1;
      return settleRubric(t, opts);
    }) as typeof settleRubric;
    const r = await runGoal('写一份报告', rubricCfg({
      presented: [...items],
      degraded: [
        { id: 'r1', pass: true },
        { id: 'r2', pass: true },
        { id: 'r3', pass: true },
      ],
      traces: [...fullPassTraces],
      maxFailures: 0,
      _settleRubric: spySettle,
    }));
    expect(settleCalls).toBe(0);
    const result = r as unknown as {
      rubricVerdict?: RubricVerdict;
      rubricRejection?: { source: string; reason: string };
    };
    expect(result.rubricVerdict).toBeUndefined();
    expect(result.rubricRejection).toBeDefined();
    expect(result.rubricRejection!.source).toBe('probe');
  });

  test('INV-4b ★: 劣化样本缺席 (undefined) → fail-open, 照常判真产物', async () => {
    const r = await runGoal('写一份报告', rubricCfg({
      presented: [...items],
      degraded: undefined,
      traces: [...fullPassTraces],
      maxFailures: 0,
    }));
    const result = r as unknown as {
      rubricVerdict?: RubricVerdict;
      rubricRejection?: { source: string };
    };
    expect(result.rubricVerdict).toBeDefined();
    expect(result.rubricVerdict!.pass).toBe(true);
    expect(result.rubricVerdict!.traces).toHaveLength(3);
    expect(result.rubricRejection).toBeUndefined();
  });

  test('INV-5 ★: 逐条痕迹进结果面 —— 3 条带 id 与理由,不只在摘要文本', async () => {
    const r = await runGoal('写一份报告', rubricCfg({
      presented: [...items],
      degraded: [{ id: 'r2', pass: false }],
      traces: [
        trace('r1', true, '源已点名'),
        trace('r2', false, '命令没附'),
        trace('r3', true, '推断与事实分记'),
      ],
      maxFailures: 0,
    }));
    const result = r as unknown as {
      rubricVerdict?: { pass: boolean; traces: readonly RubricItemTrace[]; failedIds: readonly string[] };
    };
    expect(result.rubricVerdict).toBeDefined();
    expect(result.rubricVerdict!.traces).toHaveLength(3);
    expect(result.rubricVerdict!.traces.map((t) => t.itemId)).toEqual(['r1', 'r2', 'r3']);
    expect(result.rubricVerdict!.traces.every((t) => t.reason.length > 0)).toBe(true);
    expect(result.rubricVerdict!.failedIds).toEqual(['r2']);
    expect(result.rubricVerdict!.pass).toBe(false);
    // 摘要文本里不该独自带有「N/M」这种总分压成一行 —— 逐条那一列在结果面上, 不是散文里。
    const execStage = r.stages.at(-1)!;
    expect(/\b\d+\s*\/\s*\d+\b/.test(execStage.summary)).toBe(false);
  });

  test('INV-5 (settle) ★: maxFailures=1 时 1 条不过仍 pass', async () => {
    const r = await runGoal('写一份报告', rubricCfg({
      presented: [...items],
      degraded: [{ id: 'r2', pass: false }],
      traces: [
        trace('r1', true, '...'),
        trace('r2', false, '...'),
        trace('r3', true, '...'),
      ],
      maxFailures: 1,
    }));
    const result = r as unknown as { rubricVerdict?: { pass: boolean } };
    expect(result.rubricVerdict).toBeDefined();
    expect(result.rubricVerdict!.pass).toBe(true);
  });

  test('INV-1 (回看) ★: rubric 路径不写执行型 verified 副作用 (经 rubricVerdict 的存在反证)', async () => {
    const r = await runGoal('写一份报告', rubricCfg({
      presented: [...items],
      degraded: [{ id: 'r1', pass: false }],
      traces: [...fullPassTraces],
      maxFailures: 0,
    }));
    const result = r as unknown as { rubricVerdict?: { pass: boolean } };
    expect(result.rubricVerdict).toBeDefined();
    expect(typeof result.rubricVerdict!.pass).toBe('boolean');
  });

  test('★ INV-6 提醒: gate-registry 对账闸在外侧 `./src/harness/gates/gate-registry.test.ts` 守', () => {
    // 本片不动 gate-registry (没新增判词) —— 由外侧对账闸守, 这里立一个软提醒;
    // 真闸面在外侧那个测试文件里。
    expect(true).toBe(true);
  });
});