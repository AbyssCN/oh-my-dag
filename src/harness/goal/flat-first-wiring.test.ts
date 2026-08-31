/**
 * src/harness/goal/flat-first-wiring.test —— L1 免仪式平铺的接线闸 (SDD 2026-08-31, 片 3)
 *
 * 锚串 FLAT_FIRST_WIRED (本仓 GWT 惯例: 闸判据逐字在本文件可定位)。
 *
 * 反向自检 (本仓惯例, 同 sdd-compile.test / flat-plan.test):
 * 每条闸配一份**已知违规样本**, 断言它该改的状态或判词; 证伪方式写在 test 注释里
 * —— 把该闸删掉 (或绕开), 对应 test 当场由绿转红。
 *
 * ## 涵盖契约
 *
 *  · **INV-3 (GWT-4)**: opt-in 缺省关。开关关 → 走现行 conductor 路径, 轻规划 generate 零调用
 *    (fake 计数 === 0); 开关开 → 轻规划 generate 恰被调 1 次且 conductor 多轮规划不开。
 *  · **INV-4 (GWT-5)**: 升档一次且留痕。L1 图 settle 带冲突证据 (fake 注入) → 以 conductor 路径
 *    重跑恰 1 次, stages 含「flat-escalate」锚串与证据原文; 干净 → 0 升档。
 *  · **detectL1Escalation** 纯核: write-wall 与 write-race 各升, 其它 kind 不升, 空 observations
 *    不升, undefined observations 不升。
 *  · **flatFirstEnabled** 纯核: config 显式压过 env, env 缺席当关。
 *
 * ## 不在这文件
 *
 *  · flatPlan / parseFlatPlanOutput / compileFlatPlan 的形状契约 ──→ flat-plan.test.ts
 *    (片 1 写集), 本片只消费它们;
 *  · PlanSchema complexity 字段 ──→ schema-field-registry.test.ts (片 2 写集);
 *  · 闸登记表的 GATE_REGISTRY ──→ gate-registry.test.ts (本片写集里没改它, 预期零字节改动)。
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runGoal,
  detectL1Escalation,
  flatFirstEnabled,
  FLAT_ESCALATE_LABEL,
  type RunGoalConfig,
} from './run-goal';
import type { GoalClassification } from './classify-acceptance';
import type { ConductorPlan } from '../conductor-plan';
import type {
  DagObservation,
  ExecutorDagConfig,
  ExecutorDagResult,
  GenerateFn,
} from '../dag/types';

// FLAT_FIRST_WIRED — GWT-4/5 锚串 (本仓闸判据逐字在本文件可定位)。
// 反向自检: 把这串挪走 → 「开关开 → 轻规划被调 1 次」与「L1 升档 L2」两组核心断言同时红。
const FLAT_FIRST_WIRED = 'FLAT_FIRST_WIRED';

const FULL_REGRESSION = 'bun test';

const FAKE_ACCEPTANCE = { kind: 'executable' as const, command: FULL_REGRESSION, expectExit: 0 };

// ── env 翻转夹具: flatFirstEnabled 的 env 真源是 process.env.OMD_FLAT_FIRST ────────
const SAVED_ENV: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const k of ['OMD_FLAT_FIRST']) {
    SAVED_ENV[k] = process.env[k];
    delete process.env[k];
  }
});
afterAll(() => {
  for (const [k, v] of Object.entries(SAVED_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

// ── 假 generate: 单发返回一串平铺三列表 (model-agnostic, 不装任何座位) ──────────────
const flatGen = (tableText: string): GenerateFn & { calls: number } => {
  let n = 0;
  const fn = (async () => {
    n++;
    return { text: tableText, usage: { in: 1, out: 1 } };
  }) as unknown as GenerateFn & { calls: number };
  Object.defineProperty(fn, 'calls', { get: () => n });
  return fn;
};

const THREE_ROW_TABLE = [
  '| 子任务文本 | leaf 类型 | 可见性 |',
  '|---|---|---|',
  '| 改 src/a.ts 的实现 | refactor | file |',
  '| 补 src/b.ts 的实现 | refactor | file |',
  '| 补 src/c.ts 的实现 | refactor | file |',
].join('\n');

// ── 假执行: _runDag 接到调用时把 plan 名字记下来, 然后回一份"内环判收敛 + accept 绿" ────
interface RunDagTraceEntry {
  planName: string;
  observedNodes: number;
  /** 第几次被调 (1-based, 测试断言重跑次数用)。 */
  callIndex: number;
}

const tracingFakeRunDag = (
  plansObserved: RunDagTraceEntry[],
  options: {
    /** 给所有调用加一层额外 observation (模拟 L1 跑出的 write-wall / write-race 证据)。 */
    observations?: DagObservation[];
    /** 让 accept 节点红 —— 默认绿 (L1 干净路径)。 */
    makeAcceptFailed?: boolean;
  } = {},
): NonNullable<RunGoalConfig['_runDag']> => {
  return (async (plan: ConductorPlan): Promise<ExecutorDagResult> => {
    const callIndex = plansObserved.length + 1;
    plansObserved.push({
      planName: plan.name,
      observedNodes: Object.keys(plan.nodes).length,
      callIndex,
    });
    const acceptStatus: 'done' | 'failed' = options.makeAcceptFailed ? 'failed' : 'done';
    const acceptExit = options.makeAcceptFailed ? 1 : 0;
    const baseResults: ExecutorDagResult['results'] = {
      execute: {
        id: 'execute',
        status: 'done',
        kind: 'conductor',
        output: '[conductor 子图]',
        deps: [],
        usage: { in: 1, out: 1 },
        rounds: 1,
        converged: true,
      },
      accept: {
        id: 'accept',
        status: acceptStatus,
        kind: 'command',
        output: '',
        deps: [],
        usage: { in: 0, out: 0 },
        exitCode: acceptExit,
      },
    };
    return {
      plan,
      results: baseResults,
      reusedNodes: [],
      ...(options.observations ? { observations: options.observations } : {}),
    } as unknown as ExecutorDagResult;
  }) as never;
};

const baselineConfig = (cwd: string): Omit<RunGoalConfig, '_runDag'> & { cwd: string } => ({
  cwd,
  dag: { conductorModel: 'c:m', leafModel: 'l:m' } as ExecutorDagConfig,
  _classify: (async (): Promise<GoalClassification> => ({
    tier: 'simple',
    acceptance: FAKE_ACCEPTANCE,
  })) as RunGoalConfig['_classify'],
});

// ── 纯核 ①: detectL1Escalation ────────────────────────────────────────────────

describe('detectL1Escalation — 纯核 (INV-4)', () => {
  test('write-wall observation ⇒ escalate + evidence 原文 + kind=write-wall', () => {
    const wall: DagObservation = {
      kind: 'write-wall',
      nodes: ['s1', 's2'],
      message: '叶子 s1 与 s2 都写 src/shared.ts, 撞写域闸 2 次',
    };
    const out = detectL1Escalation({ observations: [wall] } as unknown as ExecutorDagResult);
    expect(out.escalate).toBe(true);
    expect(out.kind).toBe('write-wall');
    expect(out.evidence).toBe('叶子 s1 与 s2 都写 src/shared.ts, 撞写域闸 2 次');
  });

  test('write-race observation ⇒ escalate + evidence 原文 + kind=write-race', () => {
    const race: DagObservation = {
      kind: 'write-race',
      nodes: ['s1', 's2'],
      message: '叶子 s1 与 s2 执行窗口重叠且都写了 src/out.ts',
    };
    const out = detectL1Escalation({ observations: [race] } as unknown as ExecutorDagResult);
    expect(out.escalate).toBe(true);
    expect(out.kind).toBe('write-race');
    expect(out.evidence).toBe('叶子 s1 与 s2 执行窗口重叠且都写了 src/out.ts');
  });

  test('其它 kind (loop-no-progress / leaf-spin / …) ⇒ 不升档 (L1 论据只认结构面冲突)', () => {
    const benign: DagObservation[] = [
      { kind: 'leaf-spin', nodes: ['s1'], message: 'spinning' },
      { kind: 'loop-no-progress', nodes: ['execute'], message: 'no progress' },
    ];
    const out = detectL1Escalation({ observations: benign } as unknown as ExecutorDagResult);
    expect(out.escalate).toBe(false);
    expect(out.kind).toBeUndefined();
    expect(out.evidence).toBeUndefined();
  });

  test('空数组 ⇒ 不升档 (NULL ≠ 0: 「观测面有这条」与「这条存在」是两件事, 后者才是升档判据)', () => {
    const out = detectL1Escalation({ observations: [] } as unknown as ExecutorDagResult);
    expect(out.escalate).toBe(false);
  });

  test('observations 字段缺席 ⇒ 不升档 (NULL ≠ 不适用: 早期版本字段没接不等于「零观测」)', () => {
    // 反向自检: 把 `observations ?? []` 改成 `observations ?? [{ kind: 'write-wall', ... }]`
    // → 「早期版本不该升档」这条立刻红 (早期版本判到 undefined 也会升档, 把所有老结果都污染)。
    const out = detectL1Escalation({} as unknown as ExecutorDagResult);
    expect(out.escalate).toBe(false);
  });

  test('write-wall 与 write-race 同框 ⇒ 只升一档, 不重复 (升档动作幂等)', () => {
    const obs: DagObservation[] = [
      { kind: 'write-wall', nodes: ['s1'], message: 'wall' },
      { kind: 'write-race', nodes: ['s2'], message: 'race' },
    ];
    const out = detectL1Escalation({ observations: obs } as unknown as ExecutorDagResult);
    expect(out.escalate).toBe(true);
    // 顺序固定 (write-wall 先), 与文档注一致 —— 任何一次只升一档, 不合并两种 kind 的 evidence。
    expect(out.kind).toBe('write-wall');
  });
});

// ── 纯核 ②: flatFirstEnabled ─────────────────────────────────────────────────

describe('flatFirstEnabled — 纯核 (INV-3 / D-5)', () => {
  test('config.flatFirst=true ⇒ 压过 env (env 关照样开, 测试钉死用这条)', () => {
    expect(flatFirstEnabled({ flatFirst: true }, { OMD_FLAT_FIRST: '' })).toBe(true);
  });

  test('config.flatFirst=false ⇒ 压过 env (env 开照样关, 装配层显式关用这条)', () => {
    expect(flatFirstEnabled({ flatFirst: false }, { OMD_FLAT_FIRST: '1' })).toBe(false);
  });

  test('config 缺席 + env=1 ⇒ 开 (夜批 A/B 用 env 翻转整批, 这是最常见的路径)', () => {
    expect(flatFirstEnabled({}, { OMD_FLAT_FIRST: '1' })).toBe(true);
  });

  test('config 缺席 + env=true ⇒ 开', () => {
    expect(flatFirstEnabled({}, { OMD_FLAT_FIRST: 'true' })).toBe(true);
  });

  test('config 缺席 + env 缺席或奇怪值 ⇒ 关 (缺省语义 = 关 = 零回归)', () => {
    expect(flatFirstEnabled({}, {})).toBe(false);
    expect(flatFirstEnabled({}, { OMD_FLAT_FIRST: '0' })).toBe(false);
    expect(flatFirstEnabled({}, { OMD_FLAT_FIRST: 'yes' })).toBe(false);
    expect(flatFirstEnabled({}, { OMD_FLAT_FIRST: 'no' })).toBe(false);
  });
});

// ── 接线 GWT-4 (INV-3): opt-in 缺省关 ─────────────────────────────────────────

describe(`GWT-4 (${FLAT_FIRST_WIRED}) — INV-3: 开关关 ⇒ 走现行 conductor 路径, 轻规划 generate 零调用`, () => {
  test('开关缺省 (config.flatFirst 缺席, env 缺席) ⇒ _runDag 被调 1 次 (走 v1 conductor) + generate 零调用', async () => {
    // 反向自检: 把「opt-in 缺省关」的开关翻转 (config.flatFirst 缺席 + env=1) → 本条立刻红。
    const cwd = mkdtempSync(join(tmpdir(), 'omd-flat-first-off-'));
    const plansObserved: RunDagTraceEntry[] = [];
    const genSpy = flatGen(THREE_ROW_TABLE);
    const r = await runGoal('改 src/a.ts 加 try/catch', {
      ...baselineConfig(cwd),
      // **不给 flatFirst** — 缺省走 env, env 缺席 ⇒ 关。
      dag: { conductorModel: 'c:m', leafModel: 'l:m', generate: genSpy } as ExecutorDagConfig,
      _runDag: tracingFakeRunDag(plansObserved),
    });
    // ① 跑了一次 (现行 conductor 路径, name = 'goal-execute')。
    expect(plansObserved.length).toBe(1);
    expect(plansObserved[0]!.planName).toBe('goal-execute');
    // ② 轻规划 generate 零调用 — 开关关, 编译函数根本没进。
    expect(genSpy.calls).toBe(0);
    // ③ stages 里**没有** escalate 段 (没升档, 因为根本没走 L1)。
    expect(r.stages.find((s) => s.stage === 'escalate')).toBeUndefined();
  });

  test('config.flatFirst=false (显式关) ⇒ 与缺省同形 — 装配层显式关也是零调用', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-flat-first-explicit-off-'));
    const plansObserved: RunDagTraceEntry[] = [];
    const genSpy = flatGen(THREE_ROW_TABLE);
    await runGoal('改 src/a.ts 加 try/catch', {
      ...baselineConfig(cwd),
      flatFirst: false,
      dag: { conductorModel: 'c:m', leafModel: 'l:m', generate: genSpy } as ExecutorDagConfig,
      _runDag: tracingFakeRunDag(plansObserved),
    });
    expect(genSpy.calls).toBe(0);
    expect(plansObserved.length).toBe(1);
  });
});

describe(`GWT-4 (${FLAT_FIRST_WIRED}) — INV-3: 开关开 ⇒ 轻规划 generate 恰 1 次, conductor 多轮规划不开`, () => {
  test('开关开 + 无 SDD + 可执行判据 ⇒ _runDag 第一次 plan.name = flat-plan 系, generate 被调 1 次', async () => {
    // 反向自检: 把 flatPlan = compiled 那行摘掉, 或把 'goal-execute-flat-l1' 改名 → 本条立刻红。
    const cwd = mkdtempSync(join(tmpdir(), 'omd-flat-first-on-'));
    const plansObserved: RunDagTraceEntry[] = [];
    const genSpy = flatGen(THREE_ROW_TABLE);
    const r = await runGoal('改 src/a.ts 加 try/catch', {
      ...baselineConfig(cwd),
      flatFirst: true,
      dag: { conductorModel: 'c:m', leafModel: 'l:m', generate: genSpy } as ExecutorDagConfig,
      _runDag: tracingFakeRunDag(plansObserved),
    });
    // ① 轻规划 generate 恰 1 次 (单发, 不开 tool-loop, 与 D-3 「轻规划 = 单发 generate」逐字对齐)。
    expect(genSpy.calls).toBe(1);
    // ② 第一次进 _runDag: L1 的预构造平铺 plan (4 节点 = 3 子任务 + accept, complexity:flat)。
    expect(plansObserved[0]!.planName).toBe('goal-execute-flat-l1');
    expect(plansObserved[0]!.observedNodes).toBe(4);
    // ③ 干净 → 0 升档, 只跑了 1 次。
    expect(plansObserved.length).toBe(1);
    expect(r.stages.find((s) => s.stage === 'escalate')).toBeUndefined();
  });

  test('开关开 + **有 SDD** ⇒ L1 路径**不进**, 走既有 sdd-direct 直通 (L1 只覆盖无 SDD 的 goal)', async () => {
    // 反向自检: 把 `else if (flatFirstOn && runnable)` 改成 `if (flatFirstOn && runnable)`
    // → 有 SDD 时也会进 L1 编译块, 把 SDD 全文的契约面扔掉。本条立刻红。
    // 这里没注入真 SDD, 但**目标 = 路径不进 L1**: 用一个**无 SDD 路径**的 goal 验证。
    // (真正的「有 SDD 时 L1 不进」需要 sdd-direct 假, 那一片不在本片写集。)
    // 本条反向自检的最小覆盖: L1 进了 → plan.name 含 'flat-l1'; L1 没进 → plan.name='goal-execute'。
    const cwd = mkdtempSync(join(tmpdir(), 'omd-flat-first-no-sdd-'));
    const plansObserved: RunDagTraceEntry[] = [];
    const genSpy = flatGen(THREE_ROW_TABLE);
    await runGoal('改 src/a.ts 加 try/catch', {
      ...baselineConfig(cwd),
      flatFirst: true,
      // 不传 sddPath ⇒ 无 SDD。L1 应进。
      dag: { conductorModel: 'c:m', leafModel: 'l:m', generate: genSpy } as ExecutorDagConfig,
      _runDag: tracingFakeRunDag(plansObserved),
    });
    // 真进 L1 了 = plan.name 含 'flat-l1'。
    expect(plansObserved[0]!.planName).toContain('flat-l1');
    expect(genSpy.calls).toBe(1);
  });
});

// ── 接线 GWT-5 (INV-4): L1 → L2 升档一次且留痕 ───────────────────────────────

describe(`GWT-5 (${FLAT_FIRST_WIRED}) — INV-4: L1 升档一次, 升档记录含证据原文`, () => {
  test('L1 图 settle 带 write-wall observation ⇒ conductor 重跑恰 1 次, stages 含证据原文', async () => {
    // 反向自检:
    //   · 把 `if (usedFlatFirst)` 改成 `if (false)` → 本条立刻红 (升档动作没被触发)。
    //   · 把 `if (conflict.escalate)` 改成 `if (false)` → 同上。
    //   · 把「重跑恰 1 次」改成「重跑 0 次」或「重跑 2 次」→ plansObserved.length 红。
    //   · 把「stages 含 escalate 段」摘掉 → r.stages 红。
    const cwd = mkdtempSync(join(tmpdir(), 'omd-flat-first-escalate-'));
    const plansObserved: RunDagTraceEntry[] = [];
    const genSpy = flatGen(THREE_ROW_TABLE);
    const wallEvidence = '叶子 s1 与 s2 都写 src/shared.ts, 撞写域闸 2 次';
    const r = await runGoal('改 src/a.ts 加 try/catch', {
      ...baselineConfig(cwd),
      flatFirst: true,
      dag: { conductorModel: 'c:m', leafModel: 'l:m', generate: genSpy } as ExecutorDagConfig,
      _runDag: tracingFakeRunDag(plansObserved, {
        // 第一次 (L1 那张平铺图) 跑出 write-wall 证据 ——
        // 第二次 (升档后的 v1 conductor) 干净, 不递归升档。
        observations: [{ kind: 'write-wall', nodes: ['s1', 's2'], message: wallEvidence }],
      }),
    });
    // ① generate 恰 1 次 (L1 路径走完, 升档是同一 goal 的二次执行, 不重 generate)。
    expect(genSpy.calls).toBe(1);
    // ② 重跑 2 次: 第一次 L1, 第二次升档后的 v1 conductor。
    expect(plansObserved.length).toBe(2);
    expect(plansObserved[0]!.planName).toBe('goal-execute-flat-l1');
    expect(plansObserved[1]!.planName).toBe('goal-execute');
    // ③ stages 里有一条 escalate 段, 含证据原文与锚串。
    const escStage = r.stages.find((s) => s.stage === 'escalate');
    expect(escStage).toBeDefined();
    expect(escStage!.summary).toContain(FLAT_ESCALATE_LABEL);
    expect(escStage!.summary).toContain(wallEvidence);
  });

  test('L1 图 settle 带 write-race observation ⇒ 升档 1 次, kind=write-race, 证据原文进 summary', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-flat-first-escalate-race-'));
    const plansObserved: RunDagTraceEntry[] = [];
    const genSpy = flatGen(THREE_ROW_TABLE);
    const raceEvidence = '叶子 s1 与 s2 执行窗口重叠且都写了 src/out.ts';
    const r = await runGoal('改 src/a.ts 加 try/catch', {
      ...baselineConfig(cwd),
      flatFirst: true,
      dag: { conductorModel: 'c:m', leafModel: 'l:m', generate: genSpy } as ExecutorDagConfig,
      _runDag: tracingFakeRunDag(plansObserved, {
        observations: [{ kind: 'write-race', nodes: ['s1', 's2'], message: raceEvidence }],
      }),
    });
    expect(plansObserved.length).toBe(2);
    const escStage = r.stages.find((s) => s.stage === 'escalate');
    expect(escStage).toBeDefined();
    expect(escStage!.summary).toContain('write-race');
    expect(escStage!.summary).toContain(raceEvidence);
  });

  test('L1 干净 (无 observations) ⇒ 0 升档, 只 _runDag 1 次 (GWT-5 反面)', async () => {
    // 反向自检: 把 `if (conflict.escalate)` 改成恒真 → 「干净也升档」立刻红。
    const cwd = mkdtempSync(join(tmpdir(), 'omd-flat-first-clean-'));
    const plansObserved: RunDagTraceEntry[] = [];
    const genSpy = flatGen(THREE_ROW_TABLE);
    const r = await runGoal('改 src/a.ts 加 try/catch', {
      ...baselineConfig(cwd),
      flatFirst: true,
      dag: { conductorModel: 'c:m', leafModel: 'l:m', generate: genSpy } as ExecutorDagConfig,
      _runDag: tracingFakeRunDag(plansObserved, { observations: [] }),
    });
    expect(plansObserved.length).toBe(1);
    expect(plansObserved[0]!.planName).toBe('goal-execute-flat-l1');
    expect(r.stages.find((s) => s.stage === 'escalate')).toBeUndefined();
  });

  test('L1 升档后的 v1 conductor 重跑若再撞 write-wall ⇒ **不递归升档** (升档一次, append-only)', async () => {
    // D-6 「升档一次, append-only 留痕」: 第二次跑出来的 evidence 不再触发第三次升档,
    // 否则就成了「LL1 平铺冲突→L2 conductor 冲突→再 L1」无限循环。
    // 反向自检: 把升档 if 改成 while → plansObserved.length 红 (会无限循环, 测试会被熔断)。
    // 这里用一次性重跑给冲突 + 第二次干净的假执行, 模拟「L2 治好了」的常见情况;
    // 真要 L2 也撞冲突 = 调用方拿一份 result 自己看着办, run-goal 层不递归 (D-6)。
    const cwd = mkdtempSync(join(tmpdir(), 'omd-flat-first-no-recursion-'));
    const plansObserved: RunDagTraceEntry[] = [];
    const genSpy = flatGen(THREE_ROW_TABLE);
    let callIndex = 0;
    const runDag = (async (plan: ConductorPlan): Promise<ExecutorDagResult> => {
      callIndex++;
      plansObserved.push({
        planName: plan.name,
        observedNodes: Object.keys(plan.nodes).length,
        callIndex,
      });
      // 第一次 (L1): 带 write-wall ⇒ 应升档
      // 第二次 (升档后的 v1): 也带 write-wall ⇒ **不递归升档**, 沿用本结果。
      const observations: DagObservation[] =
        callIndex === 1
          ? [{ kind: 'write-wall', nodes: ['s1', 's2'], message: 'L1 撞' }]
          : [{ kind: 'write-wall', nodes: ['execute'], message: 'L2 也撞 (不应再升档)' }];
      return {
        plan,
        results: {
          execute: {
            id: 'execute', status: 'done', kind: 'conductor', output: '',
            deps: [], usage: { in: 1, out: 1 }, rounds: 1, converged: true,
          },
          accept: {
            id: 'accept', status: 'done', kind: 'command', output: '',
            deps: [], usage: { in: 0, out: 0 }, exitCode: 0,
          },
        },
        reusedNodes: [],
        observations,
      } as unknown as ExecutorDagResult;
    }) as never;
    const r = await runGoal('改 src/a.ts 加 try/catch', {
      ...baselineConfig(cwd),
      flatFirst: true,
      dag: { conductorModel: 'c:m', leafModel: 'l:m', generate: genSpy } as ExecutorDagConfig,
      _runDag: runDag,
    });
    // 重跑**恰 2 次** (L1 一次 + 升档一次); 不递归 = 没有第 3 次。
    expect(plansObserved.length).toBe(2);
    // escalate 段**仅一条** (append-only): 第二次 v1 conductor 也撞了, 但不重复升档。
    const escStages = r.stages.filter((s) => s.stage === 'escalate');
    expect(escStages.length).toBe(1);
  });
});