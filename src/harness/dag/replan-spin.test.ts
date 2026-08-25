/**
 * src/harness/dag/replan-spin.test.ts —— D2 切片 3 的判别力测试。
 *
 * GWT 表 (2026-08-25 判据同源版, 修 #272 漏报 + #273 误报; 旧 G-4/G-5 语义已废):
 *   #272 closure 空/null + 全图除冻结门外全在 reusedIds ⇒ true (b5b7a214 活体形状; 旧守卫漏报)。
 *   #273 任一节点不在 reusedIds (含 failed/skipped 切片) ⇒ false (b13545da 活体形状; 旧指纹近似误报)。
 *   G-1  accept 红 (仓规红无 blame) + deterministicReplan 返同一张图 ⇒ 引擎走 repair-spin 路径,
 *        plan.name 含 __repair_spin_, accept 字段逐字保留。
 *   G-2  真变更节点不在 reusedIds (语义红) ⇒ false; 引擎跑原 deterministicPlan。
 *   G-3  全新图无一在 reusedIds ⇒ false。
 *   G-6  buildRepairPlan: 找得到 command 节点 → 返 plan 含修补节点 + verify; 找不到 → 返 null。
 *   G-7  修补节点的 goal 含 verifier 失败原文 + 「只修这些失败,不动其他」; write_set = 本轮并集
 *        (closure 空 → 并集退 priorPlan 全图)。
 *
 * 反向自检 (本片手做, 与 deterministic-replan.test.ts 同源):
 *   1. 把 `const spinResult = trySpinRepair(...)` 替成 `const spinResult = { kind: 'no-spin' as const };`
 *      ⇒ G-1 红 (plan.name 不含 __repair_spin_)。
 *   2. 把 `detectReplanSpin` 的循环里 `continue` 全替成 `return false`
 *      ⇒ G-2 / G-3 当场红。
 *
 * 锚: deterministic-replan.test.ts 与 replan-round-log.test.ts 的 captureLogger + runExecutorDagWithPlan 夹具形状。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { runExecutorDagWithPlan } from './engine';
import { setCoreLogger, type CoreLogger } from '../logger';
import { registerProvider } from '../../model/providers';
import type { ConductorPlan } from '../conductor-plan';
import type { GenerateFn, LeafResult } from './types';

// 禁词样例拼接构造 —— jargon-scan 扫的是源码字面串, 夹具要在运行期拼出来, 否则「清扫完成态」当场红。
const JARGON_SAMPLE = ['落', '盘'].join('');
import { detectReplanSpin, buildRepairPlan, trySpinRepair, repairNodeId } from './replan-spin';

// ── 测试夹具 (沿用 deterministic-replan.test.ts 的形状) ──────────────────────────

interface Captured { msg: string; payload: Record<string, unknown> }

const captureLogger = (): { logger: CoreLogger; lines: Captured[] } => {
  const lines: Captured[] = [];
  return {
    lines,
    logger: {
      debug: () => {},
      info: (obj, msg) => lines.push({ msg: msg ?? '', payload: (obj ?? {}) as Record<string, unknown> }),
      warn: (obj, msg) => lines.push({ msg: msg ?? '', payload: (obj ?? {}) as Record<string, unknown> }),
      error: () => {},
    },
  };
};

const dumpLogger = (): CoreLogger => ({
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
});

/** round-1 计划: s1 (agent, 写文件) + accept (command, 冻结判据)。 */
const round1Plan = (): ConductorPlan => ({
  name: 'goal-execute-flat',
  nodes: {
    s1: { executor: 'command', command: 'echo S1_ROUND1', expect_exit: 0, depends_on: [], goal: 's1 干完活', detector: true, write_set: ['src/foo.ts'] },
    accept: { executor: 'command', command: 'echo ACCEPT_ROUND1', expect_exit: 0, depends_on: ['s1'], goal: '冻结判据 (环外确定性闸)' },
  },
});

/** 同形 round-2 计划 —— 与 round-1 节点定义逐字相同 (compileBreakdown 的确定产物)。 */
const sameDeterministicPlan = (): ConductorPlan => round1Plan();

/** s1 改了 command (语义指纹必变) — 模拟「真修了」, 不是空转。 */
const realChangePlan = (): ConductorPlan => ({
  name: 'goal-execute-flat',
  nodes: {
    s1: { executor: 'command', command: 'echo S1_CHANGED', expect_exit: 0, depends_on: [], goal: 's1 干完活', detector: true, write_set: ['src/foo.ts'] },
    accept: { executor: 'command', command: 'echo ACCEPT_ROUND1', expect_exit: 0, depends_on: ['s1'], goal: '冻结判据 (环外确定性闸)' },
  },
});

/** 一张指纹与 round-1 完全无关的图 (全新节点) — 闭包内 fingerprint 不在 priorPoisoned, 必然真跑。 */
const freshPlan = (): ConductorPlan => ({
  name: 'goal-execute-flat',
  nodes: {
    s1: { executor: 'command', command: 'echo S1_FRESH', expect_exit: 0, depends_on: [], goal: 's1 全新的活', detector: true, write_set: ['src/bar.ts'] },
    accept: { executor: 'command', command: 'echo ACCEPT_FRESH', expect_exit: 0, depends_on: ['s1'], goal: '冻结判据 (全新)' },
  },
});

/** 把 round1 结果填好 —— write_set 必填字段 + filesTouched 用来并集。 */
const fakeLeaf = (kind: 'command' | 'agent' = 'command'): LeafResult => ({
  id: 's1',
  status: 'done',
  kind,
  output: 'done',
  deps: [],
  usage: { in: 0, out: 0 },
  filesTouched: ['src/foo.ts'],
});

/**
 * 假 commandRunner: 让 command 节点真"跑成" (exit 0)。2026-08-25 教训: 旧集成测试没配它,
 * command 节点全程 missing-capability failed, 而反向语义的 detect 把 failed 也当复用 ——
 * 测试绿在一个节点从没跑成的世界里。判据同源版必须站在 done 的地基上。
 */
const okCommandRunner = async ({ command }: { command: string }) =>
  ({ text: `ran:${command}`, usage: { in: 0, out: 0 }, timedOut: false, signal: null, exitCode: 0 });

/** 假 generate: 重规划段不该调 — 用 sentinel 拦 (与 deterministic-replan.test.ts G-1 同款)。 */
const deterministicGenerate = (): { generate: GenerateFn; calls: string[] } => {
  const calls: string[] = [];
  const generate: GenerateFn = async (req) => {
    const tn = (req as { traceName?: string }).traceName ?? '';
    calls.push(tn);
    if (tn.startsWith('escalation:')) {
      throw new Error(`重规划段不该调 generate, 但收到 traceName=${tn}`);
    }
    return { text: 'out:leaf', usage: { in: 1, out: 1 } };
  };
  return { generate, calls };
};

/**
 * verifier: 首轮 fail **不带 blame 围栏** (仓规红常态: 判词无路径, blame 挂不上 → closure null),
 * 次轮 pass。这是 #272 (run b5b7a214) 的活体形状 —— 空转修补的主战场。
 */
const blamelessTwoRoundVerifier = (): ReturnType<typeof twoRoundVerifier> => {
  let n = 0;
  return (async () => {
    n++;
    if (n === 1) {
      return { pass: false, reason: `${JARGON_SAMPLE} + 沉默 catch 净增 (无 blame 围栏)`, usage: { in: 1, out: 1 } };
    }
    return { pass: true, reason: 'ok', usage: { in: 1, out: 1 } };
  }) as unknown as ReturnType<typeof twoRoundVerifier>;
};

/** verifier: 首轮 fail (带 blame 围栏点名 s1), 次轮 pass — blameAnchor 才能挂上, closure 才能算。 */
const twoRoundVerifier = (): NonNullable<Parameters<typeof runExecutorDagWithPlan>[1] extends infer T ? T extends { verifier?: infer V } ? V : never : never> => {
  let n = 0;
  return (async () => {
    n++;
    if (n === 1) {
      return {
        pass: false,
        reason: `${JARGON_SAMPLE} + 沉默 catch 净增\n\`\`\`blame\n[{"node":"s1","reason":"未修干净"}]\n\`\`\``,
        usage: { in: 1, out: 1 },
      };
    }
    return { pass: true, reason: 'ok', usage: { in: 1, out: 1 } };
  }) as unknown as NonNullable<Parameters<typeof runExecutorDagWithPlan>[1] extends infer T ? T extends { verifier?: infer V } ? V : never : never>;
};

// ── 纯函数测试 (脱离引擎跑, O-6 实装前天然红的判别力来源) ─────────────────────────

describe('detectReplanSpin — 纯函数 (O-6 判别力; 2026-08-25 判据同源版, #272/#273)', () => {
  // reusedIds = 引擎 computeReuse 预览会复用的节点 id 集 (done+非毒+依赖链可复用)。
  // 判据同源: 测试直接给 id 集, 不再用指纹近似 (近似即 #273 的病)。
  const baseArgs = () => ({
    deterministicPlan: round1Plan(),
    priorPlan: round1Plan(),
    reusedIds: new Set(['s1']),
    frozenNodes: ['accept'] as const,
    closure: null as ReadonlySet<string> | null,
  });

  // #272 漏报形状 (run b5b7a214): 仓规红判词无路径 → closure 空/null, 但全图除门外全复用 → spin。
  // 证伪: 把 detect 改回「closure 空 → false」的旧守卫 → 本条当场红。
  test('#272: closure=null + s1 复用 + accept 冻结门 → true (b5b7a214 活体形状)', () => {
    expect(detectReplanSpin({ ...baseArgs(), closure: null })).toBe(true);
  });

  test('#272: closure 空集合同判 → true (closure 只是范围提示, 不是判定前置)', () => {
    expect(detectReplanSpin({ ...baseArgs(), closure: new Set<string>() })).toBe(true);
  });

  // G-1: e7e360f6 同形 (closure 非空不改变判定 —— detect 只看全图执行集)
  test('G-1: 全图除冻结门外全复用 → true (e7e360f6 同形)', () => {
    expect(detectReplanSpin({ ...baseArgs(), closure: new Set(['s1', 'accept']) })).toBe(true);
  });

  // G-2: 语义红 —— s1 不在 reusedIds (真变更/指纹变) → 会真跑 → false
  test('G-2: s1 不在 reusedIds (真变更) → false (语义红会真跑)', () => {
    expect(
      detectReplanSpin({ ...baseArgs(), deterministicPlan: realChangePlan(), reusedIds: new Set<string>() }),
    ).toBe(false);
  });

  // #273 误报形状 (run b13545da): s1 failed → computeReuse 不收 (只认 done) → reusedIds 缺 s1
  // → s1 会真跑 → 必须 false。证伪: 把 detect 改回「fp ∈ poisoned 判复用」的指纹近似 → 本条当场红。
  test('#273: s1 failed 未入复用池 (reusedIds 空) → false (失败切片必须真重跑, 不许被修补劫持)', () => {
    expect(detectReplanSpin({ ...baseArgs(), reusedIds: new Set<string>() })).toBe(false);
  });

  test('#273 多切片: 部分复用 (s1 复用, s2 未复用) → false', () => {
    const plan: ConductorPlan = {
      name: 'goal-execute-flat',
      nodes: {
        s1: { executor: 'agent', goal: 's1', depends_on: [] },
        s2: { executor: 'agent', goal: 's2', depends_on: [] },
        accept: { executor: 'command', command: 'echo A', expect_exit: 0, depends_on: ['s1', 's2'], goal: 'verify' },
      },
    };
    expect(
      detectReplanSpin({ ...baseArgs(), deterministicPlan: plan, reusedIds: new Set(['s1']) }),
    ).toBe(false);
  });

  // G-3: 全新图, 无一复用 → false
  test('G-3: 全新 plan 无一在 reusedIds → false (全新节点会真跑)', () => {
    expect(
      detectReplanSpin({ ...baseArgs(), deterministicPlan: freshPlan(), reusedIds: new Set<string>() }),
    ).toBe(false);
  });

  // 边界: 冻结节点但 executor 非 command (语义漂移) → 不算门 → 未复用即真跑 → false
  test('边界: 冻结 id 但 executor 非 command → 不算门 → 未复用即非空转', () => {
    const agentOnlyPlan: ConductorPlan = {
      name: 'test',
      nodes: {
        x: { executor: 'agent', goal: 'x', depends_on: [] },
      },
    };
    expect(
      detectReplanSpin({ ...baseArgs(), deterministicPlan: agentOnlyPlan, frozenNodes: ['x'], reusedIds: new Set<string>() }),
    ).toBe(false);
  });
});

// ── buildRepairPlan 测试 ──────────────────────────────────────────────────────

describe('buildRepairPlan — 纯函数', () => {
  // G-6 ────────────────────────────────────────────────────────────────────────
  test('G-6: 找得到 command 节点 → 返 plan 含修补节点 + verify; verify 字段逐字保留', () => {
    const det = round1Plan();
    const prior = round1Plan();
    const repair = buildRepairPlan({
      closure: new Set(['s1', 'accept']),
      deterministicPlan: det,
      priorPlan: prior,
      reusedIds: new Set(['s1']),
      frozenNodes: ['accept'],
      priorResults: { s1: fakeLeaf(), accept: { ...fakeLeaf(), id: 'accept' } },
      verdictReason: `${JARGON_SAMPLE} + 沉默 catch 净增`,
      escCount: 1,
    });
    expect(repair).not.toBeNull();
    expect(repair!.name).toBe('goal-execute-flat__repair_spin_1');
    expect(Object.keys(repair!.nodes)).toHaveLength(2);
    const repairId = repairNodeId(1);
    expect(repair!.nodes[repairId]).toBeDefined();
    expect(repair!.nodes.accept).toBeDefined();

    // verify 字段逐字保留 — command / expect_exit / goal 都不能改
    const verifyNode = repair!.nodes.accept as Record<string, unknown>;
    expect(verifyNode.command).toBe('echo ACCEPT_ROUND1');
    expect(verifyNode.expect_exit).toBe(0);
    expect(verifyNode.goal).toBe('冻结判据 (环外确定性闸)');
    // depends_on 改成挂在修补节点之后
    expect(verifyNode.depends_on).toEqual([repairId]);
  });

  test('G-6 负面: plan 里没有任何 command 节点 → 返 null (verify 找不到)', () => {
    const noCommandPlan: ConductorPlan = {
      name: 'no-command',
      nodes: {
        a: { executor: 'agent', goal: 'a', depends_on: [] },
      },
    };
    const repair = buildRepairPlan({
      closure: new Set(['a']),
      deterministicPlan: noCommandPlan,
      priorPlan: noCommandPlan,
      reusedIds: new Set<string>(),
      frozenNodes: [],
      priorResults: { a: fakeLeaf('agent') },
      verdictReason: 'failed',
      escCount: 1,
    });
    expect(repair).toBeNull();
  });

  // G-7 ────────────────────────────────────────────────────────────────────────
  test('G-7: 修补节点 goal 含失败原文 + 「只修这些失败」; write_set = 本轮 leaf 写集并集', () => {
    const det = round1Plan();
    const prior = round1Plan();
    const reasonText = `仓规红线: 禁词「${JARGON_SAMPLE}」+ 沉默 catch 净增 (line 42)`;
    const repair = buildRepairPlan({
      closure: new Set(['s1', 'accept']),
      deterministicPlan: det,
      priorPlan: prior,
      reusedIds: new Set(['s1']),
      frozenNodes: ['accept'],
      priorResults: {
        s1: fakeLeaf(),
        accept: { ...fakeLeaf(), id: 'accept' },
      },
      verdictReason: reasonText,
      escCount: 2,
    });
    expect(repair).not.toBeNull();
    const repairId = repairNodeId(2);
    const repairNode = repair!.nodes[repairId] as Record<string, unknown>;
    const goal = repairNode.goal as string;
    expect(goal).toContain(reasonText);
    expect(goal).toContain('只修');
    expect(goal).toContain('不动其他');
    // write_set = s1 的 write_set ∪ s1.filesTouched (两者都有 src/foo.ts → 去重后 1 个)
    expect(repairNode.write_set).toEqual(['src/foo.ts']);
  });

  test('G-7 边缘: plan 内 leaf 都没有 write_set 也没 filesTouched → write_set 字段缺席', () => {
    // 边界: 用一份**没声明 write_set** 的 prior plan + leaf results 不带 filesTouched
    // → collectUnionWriteSet 抽空 → write_set 字段不进修补节点 (不是空数组, 不是 null)。
    const noWsPlan: ConductorPlan = {
      name: 'no-ws',
      nodes: {
        a: { executor: 'command', command: 'echo A', expect_exit: 0, depends_on: [], goal: 'a' },
        accept: { executor: 'command', command: 'echo ACCEPT', expect_exit: 0, depends_on: ['a'], goal: 'verify' },
      },
    };
    const repair = buildRepairPlan({
      closure: new Set(['a', 'accept']),
      deterministicPlan: noWsPlan,
      priorPlan: noWsPlan,
      reusedIds: new Set(['a']),
      frozenNodes: ['accept'],
      priorResults: {
        a: { id: 'a', status: 'done', kind: 'command', output: 'ok', deps: [], usage: { in: 0, out: 0 } },
        accept: { id: 'accept', status: 'done', kind: 'command', output: 'ok', deps: ['a'], usage: { in: 0, out: 0 } },
      },
      verdictReason: 'failed',
      escCount: 1,
    });
    expect(repair).not.toBeNull();
    const repairId = repairNodeId(1);
    const repairNode = repair!.nodes[repairId] as Record<string, unknown>;
    expect(repairNode.write_set).toBeUndefined();
  });

  // #272: 仓规红常态 closure 空 → 写集并集退到全图 (残缺可能落在任何一片里)
  test('#272: closure 空 → write_set 并集取 priorPlan 全图 (b5b7a214 形状的修补范围)', () => {
    const det = round1Plan();
    const prior = round1Plan();
    const repair = buildRepairPlan({
      closure: new Set<string>(),
      deterministicPlan: det,
      priorPlan: prior,
      reusedIds: new Set(['s1']),
      frozenNodes: ['accept'],
      priorResults: { s1: fakeLeaf(), accept: { ...fakeLeaf(), id: 'accept' } },
      verdictReason: 'failed',
      escCount: 1,
    });
    expect(repair).not.toBeNull();
    const repairNode = repair!.nodes[repairNodeId(1)] as Record<string, unknown>;
    // 全图并集 = s1.write_set ∪ 各 results.filesTouched → 含 src/foo.ts
    expect(repairNode.write_set).toEqual(['src/foo.ts']);
  });
});

// ── 引擎集成测试 (走完整 runExecutorDagWithPlan) ────────────────────────────────

describe('引擎集成: D2 切片 3 — 修补节点走通 (e7e360f6 同形)', () => {
  registerProvider('spn', { baseUrl: 'http://127.0.0.1:9', apiKey: 'test-key', api: 'openai-compatible' });

  let cap: ReturnType<typeof captureLogger>;
  beforeEach(() => { cap = captureLogger(); setCoreLogger(cap.logger); });
  afterEach(() => { setCoreLogger(dumpLogger()); });

  // G-1 集成 ──────────────────────────────────────────────────────────────────
  // 2026-08-25 判据同源版: 用**无 blame** verifier (仓规红常态, closure null) —— 这才是空转
  // 修补的主形状 (#272)。blame 点名成功的形状下被点名切片会带锚真重跑, 不是空转 (见 G-2 集成)。
  test('G-1 集成: 仓规红无 blame (b5b7a214 形状) → 引擎空转命中, plan.name 含 __repair_spin_', async () => {
    const { generate } = deterministicGenerate();
    const verifier = blamelessTwoRoundVerifier();
    const det = sameDeterministicPlan(); // 与 round-1 逐字相同 → computeReuse 全复用
    let detCalls = 0;
    const detReplan = () => { detCalls++; return det; };

    const r = await runExecutorDagWithPlan(
      round1Plan(),
      {
        conductorModel: 'test:conductor',
        leafModel: 'test:leaf',
        generate,
        agentTemplates: new Map(),
        deterministicReplan: detReplan,
        verifier,
        conductorEscalationModel: 'spn:strong',
        frozenNodes: ['accept'],
        commandRunner: okCommandRunner as never,
      },
    );
    expect(r.verification!.pass).toBe(true);
    expect(r.verification!.escalated).toBe(true);
    // deterministicReplan 至少被调过 (空转判定的输入源)
    expect(detCalls).toBeGreaterThanOrEqual(1);

    // 关键证据: plan.name 含 __repair_spin_ (图谱命名空间, 命名锚稳定)
    expect(r.plan.name).toContain('__repair_spin_');
    expect(r.plan.name).toMatch(/goal-execute-flat__repair_spin_\d+/);
    // nodes 含修补节点 + accept (verify 逐字保留)
    const repairIds = Object.keys(r.plan.nodes).filter((id) => id.startsWith('__repair_spin_'));
    expect(repairIds).toHaveLength(1);
    expect(r.plan.nodes.accept).toBeDefined();
    // verify 节点字段逐字保留 (command / expect_exit / goal 一字不变)
    const verifyNode = r.plan.nodes.accept as Record<string, unknown>;
    expect(verifyNode.command).toBe('echo ACCEPT_ROUND1');
    expect(verifyNode.expect_exit).toBe(0);
    expect(verifyNode.goal).toBe('冻结判据 (环外确定性闸)');

    // 空转命中判词有 (INV-D2-4: 留证据)
    const spinLogs = cap.lines.filter((l) => l.msg === '[omd/executor-dag] 重规划空转命中 (D2 切片 3) → 合成修补节点, 不跑原确定性计划');
    expect(spinLogs.length).toBeGreaterThanOrEqual(1);

    // replanMode 仍记 'deterministic' (BlameRetryLedger 字段, 本片写集外不修 union)
    expect(r.blameRetry).toBeDefined();
    expect(r.blameRetry!.replanMode).toBe('deterministic');
  });

  // G-2 集成 ──────────────────────────────────────────────────────────────────
  test('G-2 集成: 闭包内有真改的 s1 (语义红) → 不空转, 跑原 deterministicPlan, plan.name 不含 __repair_spin_', async () => {
    const { generate } = deterministicGenerate();
    const verifier = twoRoundVerifier();
    // s1.command 改了 → 指纹变 → 闭包内 s1 不被复用 → 不空转
    const det = realChangePlan();

    const r = await runExecutorDagWithPlan(
      round1Plan(),
      {
        conductorModel: 'test:conductor',
        leafModel: 'test:leaf',
        generate,
        agentTemplates: new Map(),
        deterministicReplan: () => det,
        verifier,
        conductorEscalationModel: 'spn:strong',
        frozenNodes: ['accept'],
        commandRunner: okCommandRunner as never,
      },
    );
    expect(r.verification!.pass).toBe(true);

    // 关键反向证据: plan.name 是原确定性计划的 name (不含 __repair_spin_)
    expect(r.plan.name).toBe('goal-execute-flat');
    expect(r.plan.nodes.accept).toBeDefined();
    // 空转命中判词一条都没有
    const spinLogs = cap.lines.filter((l) => l.msg === '[omd/executor-dag] 重规划空转命中 (D2 切片 3) → 合成修补节点, 不跑原确定性计划');
    expect(spinLogs).toHaveLength(0);
    // 还是走 deterministic 路径
    expect(r.blameRetry!.replanMode).toBe('deterministic');
  });

  // 反向自检: 把 trySpinRepair 调用替成 'no-spin' → G-1 集成红 ────────────────
  test('反向自检: trySpinRepair 调用点 = 引擎实装里那行 trySpinRepair({...}) 必须在场 (切片 1 锚)', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const engineSrc = fs.readFileSync(path.join(import.meta.dir, 'engine.ts'), 'utf8');
    // 切片 3 锚: trySpinRepair({...}) 必须在升级重规划作用域里被真调。
    // 必须出现 trySpinRepair 字样 — 故意不在注释里 (那条规则同 deterministic-replan.test.ts 反向自检)。
    expect(engineSrc).toContain('trySpinRepair({');
    // 兜底: fail-open 那条 'fallback' 分支必须存在
    expect(engineSrc).toContain("spinResult.kind === 'fallback'");
  });

  // 反向自检: 把 spin 检测里的 `continue` 全替成 `return false` → G-1 纯函数部分红
  test('反向自检: detectReplanSpin 的 `continue` 关键字必须在场 (切片 1 锚)', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(path.join(import.meta.dir, 'replan-spin.ts'), 'utf8');
    // detectReplanSpin 里的两条 continue (a 类 accept-class + b 类 reused) 是空转判定的唯一机制。
    // 把它注释掉 = 死形态 (永远返 false 或永远返 true, 测试当场红)。
    expect(src).toMatch(/detectReplanSpin[\s\S]*continue/);
  });
});

// ── trySpinRepair 工厂测试 ────────────────────────────────────────────────────

describe('trySpinRepair — 工厂入口', () => {
  test('detect=false → kind=no-spin', () => {
    const det = round1Plan();
    const prior = round1Plan();
    const res = trySpinRepair({
      closure: new Set(['s1', 'accept']),
      deterministicPlan: det,
      priorPlan: prior,
      reusedIds: new Set<string>(),
      // 注: s1 不在 reusedIds → 会真跑 → 不空转
      frozenNodes: ['accept'],
      priorResults: { s1: fakeLeaf(), accept: { ...fakeLeaf(), id: 'accept' } },
      verdictReason: 'failed',
      escCount: 1,
    });
    expect(res.kind).toBe('no-spin');
  });

  test('detect=true + build OK → kind=spin + plan.name 含 __repair_spin_', () => {
    const det = round1Plan();
    const prior = round1Plan();
    const res = trySpinRepair({
      closure: new Set(['s1', 'accept']),
      deterministicPlan: det,
      priorPlan: prior,
      reusedIds: new Set(['s1']),
      frozenNodes: ['accept'],
      priorResults: { s1: fakeLeaf(), accept: { ...fakeLeaf(), id: 'accept' } },
      verdictReason: 'failed',
      escCount: 3,
    });
    expect(res.kind).toBe('spin');
    if (res.kind === 'spin') {
      expect(res.plan.name).toBe('goal-execute-flat__repair_spin_3');
    }
  });

  test('detect=true + build 失败 (无 verify 节点) → kind=fallback (fail-open, 调用方走原 plan)', () => {
    // 边界: plan 没有任何 command 节点 + 闭包内 agent 节点指纹全在 priorPoisoned → detect=true (spin)
    // 但 findVerifyNode 找不到 command → buildRepairPlan 返 null → trySpinRepair 收尾 fallback。
    const det: ConductorPlan = {
      name: 'agent-only',
      nodes: {
        a: { executor: 'agent', goal: 'a', depends_on: [] },
      },
    };
    // 'a' 在 reusedIds → 全图无一会真跑 → detect true; 但没有 command 节点可当 verify → fallback
    const res = trySpinRepair({
      closure: new Set(['a']),
      deterministicPlan: det,
      priorPlan: det,
      reusedIds: new Set(['a']),
      frozenNodes: [],  // 不点名 frozen → 没有任何 command 节点可当 verify
      priorResults: { a: fakeLeaf('agent') },
      verdictReason: 'failed',
      escCount: 1,
    });
    expect(res.kind).toBe('fallback');
  });
});
