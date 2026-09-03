/**
 * src/harness/goal/loop-run.test —— `run` 的任务入口走编排循环 (2026-09-03, v1 规划式 conductor 退役)。
 *
 * 反向自检 (证伪方式写在各 test 注释里): 每条闸配已知违规样本, 删掉对应机制该条当场红。
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ConductorPlan } from '../conductor-plan';
import type { ExecutorDagConfig, ExecutorDagResult } from '../dag/types';
import type { VerifierVerdict } from '../verifier';
import { conductorCtxOf, runLoopTask, runOrchestratingLoop, withLoopConfig, type LoopHost } from './loop-run';
import { CONDUCTOR_NODE_ID, ORCHESTRATING_LOOP_PLAN_NAME, REINJECT_ANCHOR_HEAD, compileOrchestratingLoop, loopDepthOf } from './orchestrating-loop';

type Seen = { plan: ConductorPlan; cfg: ExecutorDagConfig };

/** 假引擎: 记下每次 (plan, cfg); 有 verifier 就像真引擎一样跑完调一次它。 */
const fakeEngine = (seen: Seen[], opts: { conductor?: Partial<Record<string, unknown>>; verification?: ExecutorDagResult['verification'] } = {}) =>
  async (plan: ConductorPlan, cfg: ExecutorDagConfig): Promise<ExecutorDagResult> => {
    seen.push({ plan, cfg });
    const results = Object.fromEntries(
      Object.keys(plan.nodes).map((id) => [
        id,
        { id, status: 'done', kind: 'agent', output: `report of ${id}`, deps: [], usage: { in: 1, out: 1 }, filesTouched: [], ...(id === CONDUCTOR_NODE_ID ? opts.conductor ?? {} : {}) },
      ]),
    );
    let verification = opts.verification;
    if (cfg.verifier) {
      const v = await cfg.verifier({ task: '', plan, results: results as never } as never);
      verification = { pass: v.pass, reason: v.reason, attempts: 1, escalated: false, conductorModel: cfg.conductorModel };
    }
    return { plan, results, reusedNodes: [], observations: [], ...(verification ? { verification } : {}) } as unknown as ExecutorDagResult;
  };

const baseCfg = (over: Partial<ExecutorDagConfig> = {}): ExecutorDagConfig =>
  ({ conductorModel: 'c:sota', leafModel: 'w:1', ...over }) as ExecutorDagConfig;
const host = (cfg: ExecutorDagConfig): LoopHost => ({ cwd: '/tmp/x', dag: cfg });
const verdict = (pass: boolean, reason: string) =>
  (async (): Promise<VerifierVerdict> => ({ pass, reason, target: 'implementation', usage: { in: 0, out: 0 } })) as ExecutorDagConfig['verifier'];

describe('runLoopTask — 编译形状与引擎 config (D-1 / D-14 / D-17)', () => {
  test('任务 → 单 conductor 节点 (无 accept), 座位钉 conductorModel; config 带 maxEscalations 0 + 只对 conductor 的 leafFace; 无 verifier 恰跑一次', async () => {
    const seen: Seen[] = [];
    const cfg = baseCfg();
    await runLoopTask('修 add()', cfg, host(cfg), fakeEngine(seen));
    expect(seen).toHaveLength(1);
    const { plan, cfg: got } = seen[0]!;
    expect(plan.name).toBe(ORCHESTRATING_LOOP_PLAN_NAME);
    expect(Object.keys(plan.nodes)).toEqual([CONDUCTOR_NODE_ID]); // run 没有目标 ⇒ 没有 accept 节点
    expect(plan.nodes[CONDUCTOR_NODE_ID]).toMatchObject({ executor: 'agent', goal: '修 add()', model: 'c:sota' });
    // 证伪: withLoopConfig 去掉 `maxEscalations: 0` → 引擎会开 v1 升级重规划轮 (planAndExecute), 这条红。
    expect(got.maxEscalations).toBe(0);
    // 证伪: leafFace 对所有 id 都返回面 → 派发出去的子图叶子也会拿到七张卡, 这条红。
    expect(got.leafFace?.({ id: CONDUCTOR_NODE_ID } as never)).toBeDefined();
    expect(got.leafFace?.({ id: 'd1.impl' } as never)).toBeUndefined();
  });

  test('终审过 → 只跑一次, verification 原样带出', async () => {
    const seen: Seen[] = [];
    const cfg = baseCfg({ verifier: verdict(true, 'ok') });
    const r = await runLoopTask('修 add()', cfg, host(cfg), fakeEngine(seen));
    expect(seen).toHaveLength(1);
    expect(r.verification).toMatchObject({ pass: true, attempts: 1 });
  });

  test('D-14: 终审判红 → 第二跑带回灌锚且**无 verifier** (INV-7 恰一次); 回执 verification 留第一次判红 + attempts 2', async () => {
    const seen: Seen[] = [];
    const cfg = baseCfg({ verifier: verdict(false, 'missing test for edge case') });
    const r = await runLoopTask('修 add()', cfg, host(cfg), fakeEngine(seen));
    expect(seen).toHaveLength(2);
    const second = seen[1]!;
    // 证伪: 回灌不 append finding (直接重跑原图) → 这两条红。
    expect(second.plan.nodes[CONDUCTOR_NODE_ID]!.goal).toContain(REINJECT_ANCHOR_HEAD);
    expect(second.plan.nodes[CONDUCTOR_NODE_ID]!.goal).toContain('missing test for edge case');
    expect(second.plan.nodes[CONDUCTOR_NODE_ID]!.goal!.startsWith('修 add()')).toBe(true);
    // 证伪: 第二跑 config 不剥 verifier → 终审跑两次, 这条红。
    expect(second.cfg.verifier).toBeUndefined();
    expect(second.cfg.maxEscalations).toBe(0);
    // 诚实边界: 没人复审, 回执不许把第二跑说成"过了"。
    expect(r.verification).toMatchObject({ pass: false, attempts: 2, escalated: false });
    expect(r.verification!.reason).toContain('missing test for edge case');
    expect(r.verification!.reason).toContain('回灌');
  });

  test('D-14: conductor 死于基建 (timed-out) + 终审判红 → 不回灌 (再派只是再撞一次墙)', async () => {
    const seen: Seen[] = [];
    const cfg = baseCfg({ verifier: verdict(false, '产物为空') });
    const r = await runLoopTask('修 add()', cfg, host(cfg), fakeEngine(seen, { conductor: { status: 'failed', failureKind: 'timed-out', output: '' } }));
    // 证伪: 删掉 conductorInfraFailureOf 那道判断 → 跑两次, 这条红。
    expect(seen).toHaveLength(1);
    expect(r.verification).toMatchObject({ pass: false, attempts: 1 });
  });

  test('语义类败因 (assert-failed) 不算基建 → 照常回灌', async () => {
    const seen: Seen[] = [];
    const cfg = baseCfg({ verifier: verdict(false, '断言没过') });
    await runLoopTask('修 add()', cfg, host(cfg), fakeEngine(seen, { conductor: { status: 'failed', failureKind: 'assert-failed', output: '' } }));
    expect(seen).toHaveLength(2);
  });
});

describe('conductorCtxOf — run 入口的坐标 (无判据)', () => {
  test('writeRoot = host.cwd, 无 acceptance, worker 座 = agentLeafModel ?? leafModel, 并发从 config 透传', () => {
    const ctx = conductorCtxOf({ cwd: '/tmp/repo', dag: baseCfg({ leafModel: 'w:1', maxFanout: 3 }) }, null);
    expect(ctx.cwd).toBe('/tmp/repo');
    expect(ctx.writeRoot).toBe('/tmp/repo');
    expect(ctx.acceptance).toBeUndefined();
    expect(ctx.seats.worker).toBe('w:1');
    expect(ctx.maxFanout).toBe(3);
    expect(ctx.researchAvailable).toBe(false);
  });
});

describe('runOrchestratingLoop — 生产绑定的必填闸', () => {
  test('conductorModel / leafModel 缺一即 throw (编排节点坐 conductor 座, 子图叶子要 leafModel)', async () => {
    await expect(runOrchestratingLoop('t', { leafModel: 'w:1' } as ExecutorDagConfig)).rejects.toThrow(/conductorModel/);
    await expect(runOrchestratingLoop('t', { conductorModel: 'c:1' } as ExecutorDagConfig)).rejects.toThrow(/leafModel/);
  });
});

describe('assemble 接线绊线: 生产引擎接缝的任务入口是编排循环, 不是引擎里的 v1 规划式 conductor', () => {
  test('assemble.ts import runOrchestratingLoop 并钉进 PROD_ENGINE.runExecutorDag; 不再 import engine.runExecutorDag', () => {
    const src = readFileSync(join(import.meta.dir, '../../mcp/assemble.ts'), 'utf8');
    // 证伪: 把 PROD_ENGINE 改回 `{ runExecutorDag, runExecutorDagWithPlan }` → 这两条红。
    expect(src).toContain("import { runOrchestratingLoop } from '../harness/goal/loop-run';");
    expect(src).toContain('runExecutorDag: runOrchestratingLoop');
    expect(src).not.toMatch(/import \{[^}]*\brunExecutorDag\b[^}]*\} from '\.\.\/harness\/dag\/engine'/);
  });
});

describe('decompose 卡 → 嵌套编排循环 (2026-09-04, 替掉 v1 的 executor:conductor 展开)', () => {
  const callTool = async (cfg: ExecutorDagConfig, name: string, params: unknown) => {
    const face = cfg.leafFace!({ id: CONDUCTOR_NODE_ID } as never)!;
    const tool = face.customTools!.find((t) => t.name === name)!;
    return (await tool.execute('call-1', params)) as { content: { type: string; text: string }[]; details?: Record<string, unknown> };
  };

  test('顶层 conductor 派 decompose → 子 run 是循环 plan (前缀 d1.conductor, escalation 座), 子 config 带 leafFace + maxEscalations 0, 深度 1', async () => {
    const seen: Seen[] = [];
    const cfg = baseCfg({ conductorEscalationModel: 'e:sota' });
    const plan = compileOrchestratingLoop({ goal: '大活', ctx: conductorCtxOf(host(cfg), null) });
    const loopCfg = withLoopConfig(cfg, plan, { ...host(cfg), runDag: fakeEngine(seen) }, null, '大活');
    const res = await callTool(loopCfg, 'decompose', { goal: '这一步拆不出来' });
    expect(res.details?.ok).not.toBe(false);
    expect(seen).toHaveLength(1);
    const child = seen[0]!;
    expect(child.plan.name).toBe(ORCHESTRATING_LOOP_PLAN_NAME);
    expect(Object.keys(child.plan.nodes)).toEqual(['d1.conductor']);
    expect(child.plan.nodes['d1.conductor']).toMatchObject({ executor: 'agent', model: 'e:sota' });
    expect(loopDepthOf(child.plan)).toBe(1);
    // 证伪: runChild 不认循环 plan (去掉 isOrchestratingLoopPlan 分支) → 子 run 的 conductor 是裸 agent 叶, 没有卡, 这两条红。
    expect(child.cfg.maxEscalations).toBe(0);
    const childFace = child.cfg.leafFace?.({ id: 'd1.conductor' } as never);
    expect(childFace).toBeDefined();
    expect(child.cfg.verifier).toBeUndefined(); // 终审只在顶层 run 打
    // 嵌套 conductor 的面上不再有 decompose (深度闸在 compile 里拒, 卡还在面上, 调了就拒)。
    const nestedDecompose = childFace!.customTools!.find((t) => t.name === 'decompose')!;
    const rej = (await nestedDecompose.execute('call-2', { goal: '再拆' })) as { content: { text: string }[]; details?: { ok?: boolean } };
    expect(rej.details?.ok).toBe(false);
    expect(rej.content[0]!.text).toContain('深度上限');
  });
});
