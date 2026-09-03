/**
 * src/harness/dag/engine-self-check-wiring.test.ts —— S-1: 引擎 ↔ leaf 的 self_check 接线
 * (2026-08-30, 设计依据 `docs/plan/2026-08-30-sdk-selfcheck-recon.md` §0 与 §「验收判据」G-1/G-2)。
 *
 * ## 这一片在钉的两跳
 *
 * | 跳 | 断言 | 实装前为什么红 |
 * |---|---|---|
 * | G-1 引擎 → leaf | fake `agentRunner` 收到的 `input.self_check` 深等于节点上的 spec | `engine.ts` 唯一 agent 派发点的 15 个展开字段里**没有** `self_check` 这一项 → fake 收到 `undefined` |
 * | G-2 leaf → 落账 | `LeafResult.selfRepair` 三态 (缺席 / null / 对象) 各归各位 | `ugrep -n 'selfRepair' src/harness/dag/engine.ts` 曾 **0 命中** → 这个键永远不出现 |
 *
 * ## 反向自检 (当场证伪过, 逐条写法)
 *
 *  - G-1: 删掉派发点那行 `...(dispatchSelfCheck ? { self_check: dispatchSelfCheck } : {})`
 *    → G-1 的三条 (无 runner / vet 放行 / 深等) 全红。
 *  - G-1c (判据自证闸真的在跑): 把 `vetSelfCheck` 那整段删掉、改成无条件 `dispatchSelfCheck = node.self_check`
 *    → 「干活前就绿的判据被闸拒」那条红 (判据被原样派发)。
 *    ⚠ 这一条**实装前是绿的** (那时 self_check 恒不派, 恰好也满足"缺席") —— 它守的是闸别被删,
 *    不是接线; 所以它不算 G-1 的红读数, 单列。
 *  - G-2: 把 `...(selfRepair !== undefined ? { selfRepair } : {})` 删掉 → 三态全红;
 *    把它改成 `selfRepair: r.selfRepair ?? null` → 「没派 self_check 的节点该键缺席」红
 *    (「不适用」被抹成「截断」, 仓规 §静默坑 1)。
 *  - G-2c: 把「派了但 leaf 没报 → 保持缺席」那段改成 `selfRepair = r.selfRepair ?? null`
 *    → 「没记」被读成「SDK 截断」→ 该条红。
 *
 * ## 实装前的真实读数 (在 HEAD c531dd56 的干净 worktree 上跑同一份测试, 2026-08-30)
 *
 * `9 tests · 3 pass · 6 fail` —— 红的 6 条 = G-1a / G-1b / G-1e / G-2a / G-2b / G-2d,
 * 即「派发」与「落账」两跳的全部正向断言。
 *
 * 绿的 3 条**不是**接线的读数, 各自的证伪方向另有一条 (写在这, 免得被当成凑数):
 *   · G-1c 自证闸拒 —— 实装前 self_check 恒不派, 恰好也满足"缺席"; 它守的是闸别被删;
 *   · G-1d 无判据节点 —— 零回归护栏, 证伪方向 = 无条件派发;
 *   · G-2c 派了没报 —— 证伪方向 = `?? null` 顶替。
 */
import { describe, expect, test } from 'bun:test';
import { runExecutorDagWithPlan } from './engine';
import type { ConductorPlan } from '../conductor-plan';
import type { ExecutorDagConfig, GenerateFn } from './types';
import type { AgentLeafInput, AgentLeafResult } from '../leaf-runners';

const SPEC = { command: 'exit 3', expect_exit: 0 } as const;

/** leaf generate 桩: 本片所有节点都走 agentRunner, 这条只为满足必填字段。 */
const generate: GenerateFn = async () => ({ text: 'unused', usage: { in: 0, out: 0 } });

const mkCfg = (
  runner: (input: AgentLeafInput) => Promise<AgentLeafResult>,
  extra: Partial<ExecutorDagConfig> = {},
): ExecutorDagConfig => ({
  conductorModel: 't:cond',
  leafModel: 't:leaf',
  agentLeafModel: 't:leaf',
  generate,
  agentRunner: runner,
  ...extra,
});

/** 单 agent 节点 + self_check 的最小图。 */
const planWithSelfCheck = (): ConductorPlan => ({
  name: 'sc-wiring',
  nodes: {
    a: { executor: 'agent', goal: '干活', self_check: { ...SPEC } },
  },
});

/** 一个带判据、一个不带 —— 三态里的「缺席」那一格要靠这张图才量得到。 */
const planMixed = (): ConductorPlan => ({
  name: 'sc-mixed',
  nodes: {
    a: { executor: 'agent', goal: '带判据', self_check: { ...SPEC } },
    b: { executor: 'agent', goal: '不带判据' },
  },
});

/** 一个只记入参、返最小结果的 fake runner。 */
const captureRunner = (
  sink: Map<string, AgentLeafInput>,
  result: (input: AgentLeafInput) => Partial<AgentLeafResult> = () => ({}),
) => {
  return async (input: AgentLeafInput): Promise<AgentLeafResult> => {
    // 节点 id 在 prompt 头部 (`[omd leaf: <id>]`), 与 s3-wiring 那份桩同源。
    const id = /\[omd leaf: ([^\]]+)\]/.exec(input.prompt)?.[1] ?? '?';
    sink.set(id, input);
    return { text: `out:${id}`, usage: { in: 1, out: 1 }, ...result(input) };
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// G-1 — 引擎把 node.self_check 派发给 leaf
// ─────────────────────────────────────────────────────────────────────────────
describe('G-1 · 引擎 → leaf: node.self_check 真的进了 agentRunner 入参', () => {
  test('★G-1a: 没配 commandRunner (判据自证跑不起来, fail-open) → 判据原样派发, 深等于 spec', async () => {
    const seen = new Map<string, AgentLeafInput>();
    const r = await runExecutorDagWithPlan(planWithSelfCheck(), mkCfg(captureRunner(seen)));
    expect(r.results.a!.status).toBe('done');
    // ★ 实装前这里是 undefined —— 派发点入参表里根本没有这一项。
    expect(seen.get('a')!.self_check).toEqual({ command: 'exit 3', expect_exit: 0 });
  });

  test('★G-1b: 配了 commandRunner 且判据在「活还没干之前」是红的 (exit 1) → 自证闸放行 → 照样派发', async () => {
    const seen = new Map<string, AgentLeafInput>();
    let probed = 0;
    const r = await runExecutorDagWithPlan(
      planWithSelfCheck(),
      mkCfg(captureRunner(seen), {
        commandRunner: async () => {
          probed++;
          return { text: 'red', usage: { in: 0, out: 0 }, timedOut: false, signal: null, exitCode: 1 };
        },
      }),
    );
    expect(r.results.a!.status).toBe('done');
    // 自证探针真跑过一次 (「干活前它红不红」的读数不是推出来的)。
    expect(probed).toBe(1);
    expect(seen.get('a')!.self_check).toEqual({ command: 'exit 3', expect_exit: 0 });
  });

  test('★G-1c (守闸, 非接线): 判据在干活前就已经绿 (exit 0 = 期望值) → 自证闸拒 → leaf 收不到判据', async () => {
    const seen = new Map<string, AgentLeafInput>();
    await runExecutorDagWithPlan(
      planWithSelfCheck(),
      mkCfg(captureRunner(seen), {
        commandRunner: async () => ({ text: 'green', usage: { in: 0, out: 0 }, timedOut: false, signal: null, exitCode: 0 }),
      }),
    );
    // 空世界自检 ring ⇒ 退回旁路 (INV-1-2, 不判红): 节点照常跑完, 只是判据不下发。
    expect(seen.get('a')!.self_check).toBeUndefined();
  });

  test('★G-1d: 节点上没写 self_check → 入参该键缺席 (零回归: 不给所有节点凭空造一条判据)', async () => {
    const seen = new Map<string, AgentLeafInput>();
    await runExecutorDagWithPlan(planMixed(), mkCfg(captureRunner(seen)));
    expect(seen.get('b')!.self_check).toBeUndefined();
    expect('self_check' in seen.get('b')!).toBe(false);
  });

  test('★G-1e: expect_output 不被自证闸吃掉 (vetSelfCheck.kept 只带 command/expect_exit)', async () => {
    const seen = new Map<string, AgentLeafInput>();
    await runExecutorDagWithPlan(
      {
        name: 'sc-eo',
        nodes: { a: { executor: 'agent', goal: '干活', self_check: { command: 'exit 3', expect_exit: 0, expect_output: 'PASS' } } },
      },
      mkCfg(captureRunner(seen), {
        commandRunner: async () => ({ text: 'red', usage: { in: 0, out: 0 }, timedOut: false, signal: null, exitCode: 1 }),
      }),
    );
    // agent-leaf.ts:900 真消费 expect_output —— 经 vet 丢掉它 = 悄悄把判据放松一档。
    expect(seen.get('a')!.self_check).toEqual({ command: 'exit 3', expect_exit: 0, expect_output: 'PASS' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// G-2 — leaf 报的 selfRepair 被读回 LeafResult, 三态不压平
// ─────────────────────────────────────────────────────────────────────────────
describe('G-2 · leaf → 引擎: selfRepair 三态落账 (缺席 / null / 对象)', () => {
  test('★G-2a: leaf 报对象 → LeafResult.selfRepair 深等于该对象; 没判据的节点该键**缺席**', async () => {
    const seen = new Map<string, AgentLeafInput>();
    const ledger = { rounds: 1, oracleExit: [3, 0], convergedAt: 1 };
    const r = await runExecutorDagWithPlan(
      planMixed(),
      mkCfg(
        captureRunner(seen, (input) =>
          // 只有真收到判据的那个节点才报账 —— 与 agent-leaf.ts:2663 同构。
          input.self_check ? { selfRepair: { ...ledger } } : { selfRepair: null },
        ),
      ),
    );
    // ★ 实装前红: 引擎全文 0 处 selfRepair, 这个键永远不出现。
    expect(r.results.a!.selfRepair).toEqual(ledger);
    // ★ 三态的另一半: 没派判据的节点该键**缺席**, 不是 null —— 哪怕 leaf 自己报了 null。
    // (leaf 侧 null = 「没 self_check」, 引擎侧 null = 「SDK 截断」, 两格错开一位, 不许直搬。)
    expect('selfRepair' in r.results.b!).toBe(false);
    expect(r.results.b!.selfRepair).toBeUndefined();
  });

  test('★G-2b: 派了判据但 leaf 报 null (SDK 通道截断, INV-2-1) → 键在场且为 null, 不塌成缺席', async () => {
    const seen = new Map<string, AgentLeafInput>();
    const r = await runExecutorDagWithPlan(
      planWithSelfCheck(),
      mkCfg(captureRunner(seen, () => ({ selfRepair: null }))),
    );
    expect('selfRepair' in r.results.a!).toBe(true);
    expect(r.results.a!.selfRepair).toBeNull();
  });

  test('★G-2c: 派了判据而 leaf 一个字没报 (旧 runner / 替身) → 键缺席, **不编 null**', async () => {
    const seen = new Map<string, AgentLeafInput>();
    const r = await runExecutorDagWithPlan(planWithSelfCheck(), mkCfg(captureRunner(seen)));
    // 「没记」不许伪装成「截断」: null 那一格有它自己的下一步 (去看 SDK 通道该不该重开)。
    expect('selfRepair' in r.results.a!).toBe(false);
    expect(r.results.a!.selfRepair).toBeUndefined();
  });

  test('★G-2d: 判据一次就绿的账 {rounds:0,…} 原样落, 不与 null 互换 (INV-4-1)', async () => {
    const seen = new Map<string, AgentLeafInput>();
    const r = await runExecutorDagWithPlan(
      planWithSelfCheck(),
      mkCfg(captureRunner(seen, () => ({ selfRepair: { rounds: 0, oracleExit: [0], convergedAt: 0 } }))),
    );
    expect(r.results.a!.selfRepair).toEqual({ rounds: 0, oracleExit: [0], convergedAt: 0 });
    expect(r.results.a!.selfRepair).not.toBeNull();
  });
});
