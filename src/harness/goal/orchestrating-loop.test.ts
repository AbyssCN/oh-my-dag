/**
 * src/harness/goal/orchestrating-loop.test —— P3 S6b 编排循环默认路径的闸 (契约 D-1 / D-3 / D-14 / D-17 / D-20;
 * INV-3 / INV-7 / INV-8 / INV-12)。
 *
 * 反向自检 (本仓惯例, 证伪方式写在各 test 注释里): 每条闸配已知违规样本, 删掉对应机制该条当场红。
 *
 * 涵盖:
 *  · 编译形状: lead(agent, 只读哨兵写集) → accept(command, 冻结判据原文); 无判据时 accept 缺席; 过 parsePlan (格式闸)。
 *  · 回灌: finding 只 append 到 lead 节点 goal, 其它节点逐字不动, 返回新对象。
 *  · 派发前缀: 子图 id 与 depends_on 同步改名, 已带前缀的不重复加。
 *  · 运行期卡: zod 拒 / help → manual 走 tool result 且不派子图 (D-3); 合法 → runChild 拿到带前缀的编译产物,
 *    回 fan-in 摘要 (先机器事实后报告尾)。
 *  · lead 面: 只读四手 + 七张卡; 常驻 prompt ≤ 8000 且不含任何 manual 首行 (INV-8)。
 *  · runGoal 接线: 缺省走循环 (plan 名 / 节点 / leafFace 只对 lead / maxEscalations 0 / path); 显式关回 v1 (D-17);
 *    动手前 classify 恰一次 (INV-12)。
 *  · D-14: verifier 判红 → 第二次 `_runDag` 带回灌锚且**无 verifier** (INV-7 恰一次); 回灌后 oracle 绿 → success,
 *    仍红 → verifier-rejected, 无 oracle → verifier-rejected; verifier 过 → 只跑一次。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePlan, type ConductorPlan } from '../conductor-plan';
import type { ExecutorDagConfig, ExecutorDagResult } from '../dag/types';
import { LEAD_TOOL_NAMES } from '../lead/tools/index';
import { renderManual } from '../lead/render-manual';
import { briefHasRepro, createLeadCardLedger } from './loop-ledger';
import { LEAD_PROMPT_RESIDENT_MAX } from '../lead/lead-prompt';
import type { LeadCtx } from '../lead/types';
import type { GoalClassification } from './classify-acceptance';
import { runGoal, type RunGoalConfig } from './run-goal';
import {
  LEAD_HAND_TOOLS,
  LEAD_NODE_ID,
  LEAD_READONLY_SENTINEL,
  LOOP_ACCEPT_NODE_ID,
  ORCHESTRATING_LOOP_PLAN_NAME,
  REINJECT_ANCHOR_HEAD,
  buildLeadFace,
  compileOrchestratingLoop,
  createLeadRuntimeTools,
  orchestratingLoopEnabled,
  prefixPlanIds,
  withReinjectedFinding,
} from './orchestrating-loop';

const CTX: LeadCtx = {
  cwd: '/tmp/x',
  writeRoot: '/tmp/x',
  acceptance: { command: 'bun test src/a.test.ts', expect_exit: 0 },
  allowlist: ['bun', 'git'],
  maxFanout: 4,
  seats: { worker: 'w:1', escalation: 'e:1', verify: 'v:1' },
  researchAvailable: false,
};

const FACTS = {
  goal: 'fix the thing',
  writeRoot: '/tmp/x',
  acceptance: CTX.acceptance,
  minutesLeft: 30,
  tokensLeft: null,
  maxFanout: 4,
  researchAvailable: false,
};

/** 一个"已收敛"的假子 run 结果 (agent 节点 done + 报告)。 */
const fakeExec = (plan: ConductorPlan, overrides: Partial<ExecutorDagResult> = {}): ExecutorDagResult =>
  ({
    plan,
    sessionId: 's',
    levels: [Object.keys(plan.nodes)],
    results: Object.fromEntries(
      Object.keys(plan.nodes).map((id) => [
        id,
        { id, status: 'done', kind: 'agent', output: `report of ${id}\nline 2`, deps: plan.nodes[id]?.depends_on ?? [], usage: { in: 1, out: 1 }, filesTouched: ['src/a.ts'] },
      ]),
    ),
    usage: { conductor: { in: 0, out: 0 }, leavesIn: 1, leavesOut: 1, leavesCacheHit: 0 },
    reusedNodes: [],
    observations: [],
    ...overrides,
  }) as unknown as ExecutorDagResult;

describe('compileOrchestratingLoop — 形状 (D-1)', () => {
  test('lead(agent, 只读哨兵写集) → accept(command, 判据原文, depends_on lead); 过 parsePlan', () => {
    const plan = compileOrchestratingLoop({ goal: 'G', acceptance: CTX.acceptance, ctx: CTX });
    expect(plan.name).toBe(ORCHESTRATING_LOOP_PLAN_NAME);
    expect(Object.keys(plan.nodes)).toEqual([LEAD_NODE_ID, LOOP_ACCEPT_NODE_ID]);
    expect(plan.nodes[LEAD_NODE_ID]).toMatchObject({ executor: 'agent', goal: 'G', write_set: [LEAD_READONLY_SENTINEL] });
    // 证伪: 把 accept 的 depends_on 去掉 → 这条红 (oracle 会与 lead 并行跑, 判的是改前的树)。
    expect(plan.nodes[LOOP_ACCEPT_NODE_ID]).toMatchObject({ executor: 'command', command: 'bun test src/a.test.ts', expect_exit: 0, depends_on: [LEAD_NODE_ID] });
    // 格式闸: 编译产物必须过 parsePlan (D-5: parsePlan 是格式闸, 执行面只经 executePlan(applyPlanFilters))。
    expect(parsePlan(JSON.stringify(plan), { knownServers: new Set() }).ok).toBe(true);
  });

  test('无判据 → accept 缺席 (终审是唯一判官), 仍过 parsePlan', () => {
    const plan = compileOrchestratingLoop({ goal: 'explore', ctx: { ...CTX, acceptance: undefined } });
    expect(Object.keys(plan.nodes)).toEqual([LEAD_NODE_ID]);
    expect(parsePlan(JSON.stringify(plan), { knownServers: new Set() }).ok).toBe(true);
  });
});

describe('withReinjectedFinding / prefixPlanIds', () => {
  test('finding 只 append 到 lead 的 goal, accept 逐字不动, 原 plan 不被原地改', () => {
    const plan = compileOrchestratingLoop({ goal: 'G', acceptance: CTX.acceptance, ctx: CTX });
    const before = JSON.stringify(plan);
    const next = withReinjectedFinding(plan, 'missing test for edge case');
    expect(next.nodes[LEAD_NODE_ID]!.goal).toContain(REINJECT_ANCHOR_HEAD);
    expect(next.nodes[LEAD_NODE_ID]!.goal).toContain('missing test for edge case');
    expect(next.nodes[LEAD_NODE_ID]!.goal!.startsWith('G')).toBe(true);
    expect(next.nodes[LOOP_ACCEPT_NODE_ID]).toEqual(plan.nodes[LOOP_ACCEPT_NODE_ID]);
    // 证伪: 改成原地 `lead.goal += …` → 这条红 (与 engine.ts blameAnchor 同一条纪律)。
    expect(JSON.stringify(plan)).toBe(before);
  });

  test('前缀: id 与 depends_on 同步改名; 已带 d<n>. 前缀的 id 不重复加', () => {
    const plan = { name: 'p', nodes: { a: { executor: 'agent', goal: 'x' }, b: { executor: 'agent', goal: 'y', depends_on: ['a'] }, 'd1.c': { executor: 'agent', goal: 'z' } } } as ConductorPlan;
    const out = prefixPlanIds(plan, 'd2');
    expect(Object.keys(out.nodes)).toEqual(['d2.a', 'd2.b', 'd1.c']);
    expect(out.nodes['d2.b']!.depends_on).toEqual(['d2.a']);
  });
});

describe('createLeadRuntimeTools — 七张卡的运行期形态 (D-3)', () => {
  test('名字 = LEAD_TOOL_NAMES; zod 拒 → manual 首行在 tool result 里, runChild 零调用', async () => {
    const calls: ConductorPlan[] = [];
    const tools = createLeadRuntimeTools({ ctx: CTX, runChild: async (p) => { calls.push(p); return fakeExec(p); } });
    expect(tools.map((t) => t.name)).toEqual([...LEAD_TOOL_NAMES]);
    const work = tools.find((t) => t.name === 'work')!;
    const res = (await work.execute('t1', { goal: 'g' })) as { content: { text: string }[] };
    const text = res.content[0]!.text;
    // 证伪: 把 formatRejection 换成只返拒因 → manual 首行不在, 这条红。
    expect(text.startsWith(renderManual('work').split('\n')[0]!)).toBe(true);
    expect(text).toContain('--- rejected ---');
    expect(calls).toHaveLength(0);
  });

  test('help:true → 只返 manual, 不派子图', async () => {
    const calls: ConductorPlan[] = [];
    const tools = createLeadRuntimeTools({ ctx: CTX, runChild: async (p) => { calls.push(p); return fakeExec(p); } });
    const spawn = tools.find((t) => t.name === 'spawn')!;
    const res = (await spawn.execute('t1', { help: true })) as { content: { text: string }[] };
    expect(res.content[0]!.text).toContain(renderManual('spawn').split('\n')[0]!);
    expect(calls).toHaveLength(0);
  });

  test('合法 work → runChild 拿到带 d1. 前缀的编译产物 (含 self_check = 冻结判据), 回 fan-in 摘要', async () => {
    const calls: { plan: ConductorPlan; seq: number }[] = [];
    const tools = createLeadRuntimeTools({ ctx: CTX, runChild: async (p, seq) => { calls.push({ plan: p, seq }); return fakeExec(p); } });
    const work = tools.find((t) => t.name === 'work')!;
    const brief = 'repro: bun test src/a.test.ts → 1 fail (expected 2 got 3). scope: src/a.ts only. do not touch src/b.ts.';
    const res = (await work.execute('t1', { goal: 'fix add()', brief })) as { content: { text: string }[]; details: { ok: boolean; seq: number } };
    // 证伪: 删掉 adaptCard 里 runChild 那一跳 → calls 空, 这条红 (卡调用不再产生嵌套 run)。
    expect(calls).toHaveLength(1);
    expect(calls[0]!.seq).toBe(1);
    const ids = Object.keys(calls[0]!.plan.nodes);
    expect(ids).toHaveLength(1);
    expect(ids[0]!.startsWith('d1.')).toBe(true);
    expect(calls[0]!.plan.nodes[ids[0]!]).toMatchObject({ executor: 'agent', self_check: { command: 'bun test src/a.test.ts', expect_exit: 0 } });
    expect(res.details.ok).toBe(true);
    const text = res.content[0]!.text;
    expect(text).toContain('dispatch d1 (work)');
    expect(text).toContain('done 1 / failed 0 / skipped 0');
    expect(text).toContain('files: src/a.ts');
    expect(text).toContain('report of ');
    // 第二次派发序号递增 (事件面 / checkpoint 不撞)。
    await work.execute('t2', { goal: 'fix sub()', brief });
    expect(calls[1]!.seq).toBe(2);
    expect(Object.keys(calls[1]!.plan.nodes)[0]!.startsWith('d2.')).toBe(true);
  });

  test('runChild 抛错 → 原文回给 lead, 不吞', async () => {
    const tools = createLeadRuntimeTools({ ctx: CTX, runChild: async () => { throw new Error('leafModel 必填'); } });
    const explore = tools.find((t) => t.name === 'explore')!;
    const res = (await explore.execute('t1', { questions: ['where is add()?'] })) as { content: { text: string }[]; details: { ok: boolean } };
    expect(res.details.ok).toBe(false);
    expect(res.content[0]!.text).toContain('leafModel 必填');
  });
});

describe('buildLeadFace — INV-8 / D-20', () => {
  test('只读四手 + 七张卡; 常驻 prompt ≤ 8000 且不含任何 manual 首行', () => {
    const face = buildLeadFace(FACTS, { ctx: CTX, runChild: async (p) => fakeExec(p) });
    expect([...face.toolNames]).toEqual([...LEAD_HAND_TOOLS]);
    expect(face.toolNames).not.toContain('write');
    expect(face.toolNames).not.toContain('edit');
    expect(face.customTools!.map((t) => t.name)).toEqual([...LEAD_TOOL_NAMES]);
    expect(face.systemPrompt.length).toBeLessThanOrEqual(LEAD_PROMPT_RESIDENT_MAX);
    // 证伪: 把任一 manual 拼进 buildLeadSystemPrompt → 这条红 (D-3: manual 只走 tool result)。
    for (const name of LEAD_TOOL_NAMES) expect(face.systemPrompt).not.toContain(renderManual(name).split('\n')[0]!);
    expect(face.systemPrompt).toContain('bun test src/a.test.ts');
  });
});

describe('orchestratingLoopEnabled — 缺省开, env 0/false/off 关, config 布尔压过 env (D-17)', () => {
  test('矩阵', () => {
    expect(orchestratingLoopEnabled({}, {})).toBe(true);
    expect(orchestratingLoopEnabled({}, { OMD_ORCHESTRATING_LOOP: '0' })).toBe(false);
    expect(orchestratingLoopEnabled({}, { OMD_ORCHESTRATING_LOOP: 'false' })).toBe(false);
    expect(orchestratingLoopEnabled({}, { OMD_ORCHESTRATING_LOOP: 'off' })).toBe(false);
    expect(orchestratingLoopEnabled({}, { OMD_ORCHESTRATING_LOOP: '1' })).toBe(true);
    expect(orchestratingLoopEnabled({ orchestratingLoop: false }, { OMD_ORCHESTRATING_LOOP: '1' })).toBe(false);
    expect(orchestratingLoopEnabled({ orchestratingLoop: true }, { OMD_ORCHESTRATING_LOOP: '0' })).toBe(true);
  });
});

// ── runGoal 接线 ────────────────────────────────────────────────────────────────

interface Observed {
  plan: ConductorPlan;
  cfg: ExecutorDagConfig;
}

/**
 * 假引擎: 记下 plan + cfg; lead 节点 done; accept 按 opts 绿/红; 有 verifier 且 accept 绿时**调一次 verifier**
 * (模拟引擎的闸红短路: oracle 红时不请强模型)。
 */
const fakeEngine = (
  seen: Observed[],
  opts: { acceptRed?: (call: number) => boolean } = {},
): NonNullable<RunGoalConfig['_runDag']> => {
  return async (plan, cfg) => {
    const call = seen.length + 1;
    seen.push({ plan, cfg });
    const red = opts.acceptRed?.(call) ?? false;
    const results: ExecutorDagResult['results'] = {};
    for (const id of Object.keys(plan.nodes)) {
      const n = plan.nodes[id]!;
      results[id] =
        n.executor === 'command'
          ? ({ id, status: red ? 'failed' : 'done', kind: 'command', output: red ? '1 fail' : '0 fail', deps: n.depends_on ?? [], usage: { in: 0, out: 0 }, exitCode: red ? 1 : 0 } as never)
          : ({ id, status: 'done', kind: 'agent', output: 'lead report', deps: n.depends_on ?? [], usage: { in: 1, out: 1 } } as never);
    }
    let verification: ExecutorDagResult['verification'];
    if (cfg.verifier && !red) {
      const v = await cfg.verifier({ task: 't', plan, results });
      verification = { pass: v.pass, reason: v.reason, attempts: 1, escalated: false, conductorModel: 'c:m' };
    }
    return { plan, sessionId: 's', levels: [], results, usage: { conductor: { in: 0, out: 0 }, leavesIn: 1, leavesOut: 1, leavesCacheHit: 0 }, reusedNodes: [], observations: [], ...(verification ? { verification } : {}) } as unknown as ExecutorDagResult;
  };
};

const classify = (calls: { n: number }, acceptance: GoalClassification['acceptance']) => async (): Promise<GoalClassification> => {
  calls.n++;
  return { tier: 'complex', acceptance, route: { kind: 'none' } };
};

const EXEC_ACCEPT: GoalClassification['acceptance'] = { kind: 'executable', command: 'bun test src/a.test.ts', expectExit: 0 };
const EXPLORE_ACCEPT = { kind: 'exploratory', learningGoal: 'learn', acceptableLoss: 'none' } as unknown as GoalClassification['acceptance'];

const baseCfg = (cwd: string, extra: Partial<RunGoalConfig> = {}): RunGoalConfig =>
  ({
    cwd,
    dag: { conductorModel: 'c:m', leafModel: 'l:m', maxFanout: 3 } as ExecutorDagConfig,
    ...extra,
  }) as RunGoalConfig;

describe('runGoal — 缺省走编排循环 (D-17), 显式关回 v1', () => {
  test('★ 缺省: plan 名 / 节点 / leafFace 只对 lead / maxEscalations 0 / path; classify 恰 1 次 (INV-12)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-loop-default-'));
    const seen: Observed[] = [];
    const calls = { n: 0 };
    const r = await runGoal('修 add()', baseCfg(cwd, { orchestratingLoop: true, _classify: classify(calls, EXEC_ACCEPT), _runDag: fakeEngine(seen) }));
    expect(seen).toHaveLength(1);
    const { plan, cfg } = seen[0]!;
    expect(plan.name).toBe(ORCHESTRATING_LOOP_PLAN_NAME);
    expect(Object.keys(plan.nodes)).toEqual([LEAD_NODE_ID, LOOP_ACCEPT_NODE_ID]);
    expect(plan.nodes[LEAD_NODE_ID]!.goal).toContain('## 判卷标准');
    // 证伪: 把 withLoopConfig 里 leafFace 的 id 判断去掉 → 'other' 也拿到面, 第二条红。
    expect(cfg.leafFace?.({ id: LEAD_NODE_ID, executor: 'agent' })).toBeDefined();
    expect(cfg.leafFace?.({ id: 'other', executor: 'agent' })).toBeUndefined();
    expect(cfg.leafFace!({ id: LEAD_NODE_ID })!.customTools!.map((t) => t.name)).toEqual([...LEAD_TOOL_NAMES]);
    expect(cfg.maxEscalations).toBe(0);
    expect(calls.n).toBe(1);
    expect(r.path).toBe('orchestrating-loop');
    expect(r.outcome).toBe('success');
    expect(r.stages.find((s) => s.stage === 'execute')!.summary).toContain('编排循环');
  });

  test('缺省 (config 缺席, env 缺席) 也走循环 —— 这是 D-17 的默认档', async () => {
    const prev = process.env.OMD_ORCHESTRATING_LOOP;
    delete process.env.OMD_ORCHESTRATING_LOOP;
    try {
      const cwd = mkdtempSync(join(tmpdir(), 'omd-loop-env-default-'));
      const seen: Observed[] = [];
      await runGoal('修 add()', baseCfg(cwd, { _classify: classify({ n: 0 }, EXEC_ACCEPT), _runDag: fakeEngine(seen) }));
      expect(seen[0]!.plan.name).toBe(ORCHESTRATING_LOOP_PLAN_NAME);
    } finally {
      if (prev === undefined) delete process.env.OMD_ORCHESTRATING_LOOP;
      else process.env.OMD_ORCHESTRATING_LOOP = prev;
    }
  });

  test('显式关 → v1 conductor 图 (goal-execute), path=v1, 无 leafFace', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-loop-off-'));
    const seen: Observed[] = [];
    const r = await runGoal('修 add()', baseCfg(cwd, { orchestratingLoop: false, _classify: classify({ n: 0 }, EXEC_ACCEPT), _runDag: async (plan, cfg) => {
      seen.push({ plan, cfg });
      return { plan, sessionId: 's', levels: [], results: { execute: { id: 'execute', status: 'done', kind: 'conductor', output: 'ok', deps: [], usage: { in: 1, out: 1 }, rounds: 1, converged: true }, accept: { id: 'accept', status: 'done', kind: 'command', output: '', deps: ['execute'], usage: { in: 0, out: 0 } } }, usage: { conductor: { in: 0, out: 0 }, leavesIn: 0, leavesOut: 0, leavesCacheHit: 0 }, reusedNodes: [], observations: [] } as unknown as ExecutorDagResult;
    } }));
    expect(seen[0]!.plan.name).toBe('goal-execute');
    expect(seen[0]!.cfg.leafFace).toBeUndefined();
    expect(r.path).toBe('v1');
  });

  test('子图经同一个 _runDag 注入口跑 (D-5 唯一执行入口), 子 run 无 verifier / 无 leafFace / runId 派生', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-loop-child-'));
    const seen: Observed[] = [];
    const verifier = async () => ({ pass: true, reason: '', usage: { in: 0, out: 0 } });
    const manager = {} as never;
    await runGoal('修 add()', {
      ...baseCfg(cwd, { orchestratingLoop: true, _classify: classify({ n: 0 }, EXEC_ACCEPT), _runDag: fakeEngine(seen) }),
      dag: { conductorModel: 'c:m', leafModel: 'l:m', verifier, continuity: { manager, runId: 'R1', resume: true, repoRoot: cwd } } as ExecutorDagConfig,
    });
    const face = seen[0]!.cfg.leafFace!({ id: LEAD_NODE_ID })!;
    const work = face.customTools!.find((t) => t.name === 'work')!;
    await work.execute('t', { goal: 'g', brief: 'repro output: 1 fail in src/a.test.ts; scope src/a.ts; do not touch b.' });
    // 证伪: runChild 改成直接 import runExecutorDagWithPlan 而不走 config._runDag → seen 仍 1, 这条红。
    expect(seen).toHaveLength(2);
    const child = seen[1]!;
    expect(child.plan.name.startsWith('lead-work-')).toBe(true);
    expect(child.cfg.verifier).toBeUndefined();
    expect(child.cfg.leafFace).toBeUndefined();
    expect(child.cfg.maxEscalations).toBeUndefined();
    expect(child.cfg.continuity).toMatchObject({ runId: 'R1:d1', resume: false, repoRoot: cwd });
  });
});

describe('D-14 — 终审恰一次 + 单次回灌不复审 (INV-7)', () => {
  const failingVerifier = (calls: { n: number }) => async () => {
    calls.n++;
    return { pass: false, reason: 'edge case for empty input not covered', usage: { in: 1, out: 1 } };
  };

  test('★ 判红 → 第二次 _runDag: lead goal 带回灌锚 + finding, cfg **无 verifier**; verifier 总共 1 次; 回灌后 oracle 绿 → success', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-reinject-green-'));
    const seen: Observed[] = [];
    const vcalls = { n: 0 };
    const r = await runGoal('修 add()', {
      ...baseCfg(cwd, { orchestratingLoop: true, _classify: classify({ n: 0 }, EXEC_ACCEPT), _runDag: fakeEngine(seen) }),
      dag: { conductorModel: 'c:m', leafModel: 'l:m', verifier: failingVerifier(vcalls) } as ExecutorDagConfig,
    });
    expect(seen).toHaveLength(2);
    expect(seen[1]!.plan.nodes[LEAD_NODE_ID]!.goal).toContain(REINJECT_ANCHOR_HEAD);
    expect(seen[1]!.plan.nodes[LEAD_NODE_ID]!.goal).toContain('edge case for empty input not covered');
    // 证伪: 回灌那次不剥 verifier → fakeEngine 会再调一次, vcalls 变 2, 下面两条红。
    expect(seen[1]!.cfg.verifier).toBeUndefined();
    expect(vcalls.n).toBe(1);
    expect(r.outcome).toBe('success');
    expect(r.verifierDissent).toContain('edge case');
    expect(r.stages.find((s) => s.stage === 'execute')!.summary).toContain('finding 回灌 1 次');
  });

  test('回灌后 oracle 仍红 → verifier-rejected (不是 oracle-failed / not-converged)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-reinject-red-'));
    const seen: Observed[] = [];
    const r = await runGoal('修 add()', {
      ...baseCfg(cwd, { orchestratingLoop: true, _classify: classify({ n: 0 }, EXEC_ACCEPT), _runDag: fakeEngine(seen, { acceptRed: (call) => call === 2 }) }),
      dag: { conductorModel: 'c:m', leafModel: 'l:m', verifier: failingVerifier({ n: 0 }) } as ExecutorDagConfig,
    });
    expect(seen).toHaveLength(2);
    expect(r.outcome).toBe('verifier-rejected');
    expect(r.converged).toBe(false);
    expect(r.terminalLabel).toBe('verifier-rejected');
  });

  test('无机械判据 (探索型) + 判红 → 回灌一次, 终态 verifier-rejected (终审是唯一判官, 不复审就不许说成)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-reinject-noacc-'));
    const seen: Observed[] = [];
    const vcalls = { n: 0 };
    const r = await runGoal('研究一下 add()', {
      ...baseCfg(cwd, { orchestratingLoop: true, _classify: classify({ n: 0 }, EXPLORE_ACCEPT), _runDag: fakeEngine(seen) }),
      dag: { conductorModel: 'c:m', leafModel: 'l:m', verifier: failingVerifier(vcalls) } as ExecutorDagConfig,
    });
    expect(Object.keys(seen[0]!.plan.nodes)).toEqual([LEAD_NODE_ID]);
    expect(seen).toHaveLength(2);
    expect(vcalls.n).toBe(1);
    expect(r.outcome).toBe('verifier-rejected');
  });

  test('verifier 过 → 只跑一次, 不回灌', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-verifier-pass-'));
    const seen: Observed[] = [];
    const r = await runGoal('修 add()', {
      ...baseCfg(cwd, { orchestratingLoop: true, _classify: classify({ n: 0 }, EXEC_ACCEPT), _runDag: fakeEngine(seen) }),
      dag: { conductorModel: 'c:m', leafModel: 'l:m', verifier: async () => ({ pass: true, reason: 'ok', usage: { in: 0, out: 0 } }) } as ExecutorDagConfig,
    });
    expect(seen).toHaveLength(1);
    expect(r.outcome).toBe('success');
  });

  test('oracle 红 (闸红短路, verifier 没被调) → 不回灌, 终态走判据分支', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-oracle-red-'));
    const seen: Observed[] = [];
    const vcalls = { n: 0 };
    const r = await runGoal('修 add()', {
      ...baseCfg(cwd, { orchestratingLoop: true, _classify: classify({ n: 0 }, EXEC_ACCEPT), _runDag: fakeEngine(seen, { acceptRed: () => true }) }),
      dag: { conductorModel: 'c:m', leafModel: 'l:m', verifier: failingVerifier(vcalls) } as ExecutorDagConfig,
    });
    expect(seen).toHaveLength(1);
    expect(vcalls.n).toBe(0);
    expect(r.outcome).toBe('not-converged');
    expect(r.criteria?.oracle).toBe(false);
  });
});

describe('R-1 账本: 卡调用计数 / 派发台账 / 常驻字符数 / briefHasRepro', () => {
  test('★ zod 拒 + help + ok 各计一次; dispatches 带 briefHasRepro; residentPromptChars 由 buildLeadFace 写', async () => {
    const ledger = createLeadCardLedger();
    const face = buildLeadFace(FACTS, { ctx: CTX, runChild: async (p) => fakeExec(p), ledger });
    expect(ledger.residentPromptChars).toBe(face.systemPrompt.length);
    const work = face.customTools!.find((t) => t.name === 'work')!;
    await work.execute('t', { goal: 'g' }); // zod 拒 (brief 缺)
    await work.execute('t', { help: true });
    await work.execute('t', { goal: 'fix add()', brief: 'repro: pytest -q tests/x.py → 1 failed, exit 1. scope src/a.ts; do not touch b.' });
    await work.execute('t', { goal: 'polish docs', brief: 'please tidy the README wording and keep the headings as they are, nothing else.' });
    // 证伪: adaptCard 不计数 → calls 0, 红。
    expect(ledger.calls).toBe(4);
    expect(ledger.ok).toBe(2);
    expect(ledger.rejectedSchema).toBe(1);
    expect(ledger.help).toBe(1);
    expect(ledger.byCard).toEqual({ work: 2 });
    expect(ledger.dispatches.map((d) => d.briefHasRepro)).toEqual([true, false]);
    expect(ledger.dispatches[0]!.failed).toBe(0);
    const explore = face.customTools!.find((t) => t.name === 'explore')!;
    await explore.execute('t', { questions: ['where?'] });
    expect(ledger.dispatches.at(-1)!.briefHasRepro).toBeNull(); // 无 brief 槽 = null, 不是 false
    expect(ledger.readOnlyShellBlocked).toBe(0);
    face.onReadOnlyBlocked!();
    expect(ledger.readOnlyShellBlocked).toBe(1);
  });

  test('briefHasRepro 启发式矩阵', () => {
    for (const b of ['exit 1', 'Traceback (most recent call last)', '3 failed, 2 passed', 'AssertionError: x', '$ bun test\n1 fail', 'Expected: 2\nReceived: 3']) expect(briefHasRepro(b), b).toBe(true);
    for (const b of ['fix the bug in add()', 'run pytest first', '']) expect(briefHasRepro(b), b).toBe(false);
  });
});

describe('R-1 账本: runGoal 结果上的 loop', () => {
  test('★ 回灌绿的 run: verifier {calls 1, fail, reinjected, green}; v1 路径无 loop', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-loop-ledger-'));
    const seen: Observed[] = [];
    const vcalls = { n: 0 };
    const r = await runGoal('修 add()', {
      ...baseCfg(cwd, { orchestratingLoop: true, _classify: async () => ({ tier: 'complex', acceptance: EXEC_ACCEPT, route: { kind: 'none' }, llmCalls: 1 }), _runDag: fakeEngine(seen) }),
      dag: { conductorModel: 'c:m', leafModel: 'l:m', verifier: async () => { vcalls.n++; return { pass: false, reason: 'criterion not independent', target: 'criterion' as const, usage: { in: 0, out: 0 } }; } } as ExecutorDagConfig,
    });
    expect(r.loop).toMatchObject({
      path: 'orchestrating-loop',
      route: { kind: 'none', chainHit: false },
      preActionLlmCalls: 1,
      verifier: { calls: 1, firstVerdict: 'fail', target: 'criterion', reinjected: true, afterReinject: 'green' },
    });
    expect(r.loop!.residentPromptChars).toBeGreaterThan(1000);
    expect(r.loop!.cards.calls).toBe(0);
    const v1 = await runGoal('修 add()', baseCfg(cwd, { orchestratingLoop: false, _classify: classify({ n: 0 }, EXEC_ACCEPT), _runDag: async (plan) => ({ plan, sessionId: 's', levels: [], results: { execute: { id: 'execute', status: 'done', kind: 'conductor', output: 'ok', deps: [], usage: { in: 1, out: 1 }, rounds: 1, converged: true }, accept: { id: 'accept', status: 'done', kind: 'command', output: '', deps: ['execute'], usage: { in: 0, out: 0 } } }, usage: { conductor: { in: 0, out: 0 }, leavesIn: 0, leavesOut: 0, leavesCacheHit: 0 }, reusedNodes: [], observations: [] }) as unknown as ExecutorDagResult }));
    expect(v1.loop).toBeUndefined();
  });

  test('没回灌 (verifier 过) ⇒ afterReinject skipped, firstVerdict pass; 注入式分类器无 llmCalls ⇒ null', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-loop-ledger2-'));
    const r = await runGoal('修 add()', {
      ...baseCfg(cwd, { orchestratingLoop: true, _classify: classify({ n: 0 }, EXEC_ACCEPT), _runDag: fakeEngine([]) }),
      dag: { conductorModel: 'c:m', leafModel: 'l:m', verifier: async () => ({ pass: true, reason: 'ok', usage: { in: 0, out: 0 } }) } as ExecutorDagConfig,
    });
    expect(r.loop!.verifier).toEqual({ calls: 1, firstVerdict: 'pass', target: null, reinjected: false, afterReinject: 'skipped' });
    expect(r.loop!.preActionLlmCalls).toBeNull();
  });
});
