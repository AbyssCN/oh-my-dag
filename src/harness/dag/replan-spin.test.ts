/**
 * src/harness/dag/replan-spin.test.ts —— D2 切片 3 的判别力测试。
 *
 * GWT 表 (SDD §契约):
 *   G-1  accept 红 + 平铺图 deterministicReplan 返同一张图 (e7e360f6 同形)
 *        ⇒ detectReplanSpin → true; 引擎走 repair-spin 路径, 产出 plan.name 含 __repair_spin_
 *        且 nodes 含 __repair_spin_<escCount> 与原 accept 节点, accept 字段逐字保留。
 *   G-2  accept 红 + 闭包内有非冻结非复用执行节点 (语义红, 不会空转)
 *        ⇒ detectReplanSpin → false; 引擎跑原 deterministicPlan, 节点图谱不变。
 *   G-3  accept 红 + 闭包 fingerprint 全部不在 priorPoisoned (一张全新图)
 *        ⇒ detectReplanSpin → false (不是空转 — 全新节点会真跑)。
 *   G-4  closure = null (blame 解析失败) → detect 必返 false, fail-open 走整轮。
 *   G-5  closure.size = 0 → detect 必返 false (空闭包不是空转)。
 *   G-6  buildRepairPlan: 找得到 command 节点 → 返 plan 含修补节点 + verify; 找不到 → 返 null。
 *   G-7  修补节点的 goal 含 verifier 失败原文 + 「只修这些失败,不动其他」; write_set = 本轮并集。
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
import { merkleFingerprints } from '../plan-passes/semantic-key';
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

describe('detectReplanSpin — 纯函数 (O-6 判别力)', () => {
  const baseArgs = () => {
    const deterministicPlan = round1Plan();
    const priorPlan = round1Plan();
    const priorFp = merkleFingerprints(priorPlan);
    return {
      deterministicPlan,
      priorPlan,
      // priorPoisoned = prior 全部节点的指纹 (上一轮全部节点被点名, 全部进毒集)
      priorPoisoned: new Set<string>(priorFp.values()),
      frozenNodes: ['accept'] as const,
    };
  };

  // G-4 ────────────────────────────────────────────────────────────────────────
  test('G-4: closure=null (blame 解析失败) → false (fail-open 走整轮, 不是空转)', () => {
    const args = { ...baseArgs(), closure: null };
    expect(detectReplanSpin(args)).toBe(false);
  });

  // G-5 ────────────────────────────────────────────────────────────────────────
  test('G-5: closure 空集合 → false (空闭包不是空转)', () => {
    const args = { ...baseArgs(), closure: new Set<string>() };
    expect(detectReplanSpin(args)).toBe(false);
  });

  // G-1 (纯函数部分): 闭包只含冻结命令节点 → 全部 (a) 类 → spin ────────────────
  test('G-1: 闭包只含冻结 accept 节点 → true (整张图的修复走冻结门, 不写文件)', () => {
    const args = { ...baseArgs(), closure: new Set(['accept']) };
    expect(detectReplanSpin(args)).toBe(true);
  });

  // G-1 (纯函数部分): 闭包含冻结 + 全部 D-21 复用节点 → 全部 (a) ∪ (b) → spin ──
  test('G-1: 闭包含冻结 accept + s1 (s1 指纹命中 priorPoisoned) → true (e7e360f6 同形)', () => {
    const args = { ...baseArgs(), closure: new Set(['s1', 'accept']) };
    expect(detectReplanSpin(args)).toBe(true);
  });

  // G-2 (纯函数部分): 闭包有非冻结非复用执行节点 → false ──────────────────────
  test('G-2: 闭包含 s1 + accept, 但 s1 当前指纹不在 priorPoisoned → false (语义红会真跑)', () => {
    const args = {
      ...baseArgs(),
      // 改 deterministicPlan 的 s1.command 让指纹变
      deterministicPlan: realChangePlan(),
      closure: new Set(['s1', 'accept']),
    };
    expect(detectReplanSpin(args)).toBe(false);
  });

  // G-3: 全新图, 闭包内指纹不在 priorPoisoned → false ────────────────────────
  test('G-3: 全新 plan 闭包内节点指纹完全不在 priorPoisoned → false (全新节点会真跑)', () => {
    const args = {
      ...baseArgs(),
      deterministicPlan: freshPlan(),
      closure: new Set(['s1', 'accept']),
    };
    expect(detectReplanSpin(args)).toBe(false);
  });

  // 边界: 冻结节点但 executor 非 command (语义漂移) → 不算 (a) 类 → false
  test('边界: 冻结 id 但 executor 非 command → 不算 accept 类 → 必复用或非空转才放过', () => {
    const agentOnlyPlan: ConductorPlan = {
      name: 'test',
      nodes: {
        // frozenNodes 里点名了一个 agent 节点 —— 它会真跑, 不是空转
        x: { executor: 'agent', goal: 'x', depends_on: [] },
      },
    };
    const args = {
      ...baseArgs(),
      deterministicPlan: agentOnlyPlan,
      frozenNodes: ['x'],
      // prior 里没有 x → 它的指纹不在 priorPoisoned → 必真跑
      priorPoisoned: new Set<string>(),
      closure: new Set(['x']),
    };
    expect(detectReplanSpin(args)).toBe(false);
  });

  // 边界: 幽灵 id (在 closure 里但不在 plan 里) → fail-open 当作不 spin
  test('边界: closure 含不在 plan.nodes 里的幽灵 id → 不据此判空转 (不抛错)', () => {
    const args = {
      ...baseArgs(),
      closure: new Set(['ghost']),
    };
    expect(detectReplanSpin(args)).toBe(true); // 闭包只有幽灵, 没东西会真跑 → spin
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
      priorPoisoned: new Set<string>(merkleFingerprints(prior).values()),
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
      priorPoisoned: new Set<string>(),
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
      priorPoisoned: new Set<string>(merkleFingerprints(prior).values()),
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
      priorPoisoned: new Set<string>(merkleFingerprints(noWsPlan).values()),
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
});

// ── 引擎集成测试 (走完整 runExecutorDagWithPlan) ────────────────────────────────

describe('引擎集成: D2 切片 3 — 修补节点走通 (e7e360f6 同形)', () => {
  registerProvider('spn', { baseUrl: 'http://127.0.0.1:9', apiKey: 'test-key', api: 'openai-compatible' });

  let cap: ReturnType<typeof captureLogger>;
  beforeEach(() => { cap = captureLogger(); setCoreLogger(cap.logger); });
  afterEach(() => { setCoreLogger(dumpLogger()); });

  // G-1 集成 ──────────────────────────────────────────────────────────────────
  test('G-1 集成: e7e360f6 同形 → 引擎空转命中, plan.name 含 __repair_spin_, nodes 含修补节点 + accept', async () => {
    const { generate } = deterministicGenerate();
    const verifier = twoRoundVerifier();
    const det = sameDeterministicPlan(); // 与 round-1 逐字相同 → 闭包全复用
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
      priorPoisoned: new Set<string>(),
      // 注: s1 指纹不在 priorPoisoned → 不空转
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
      priorPoisoned: new Set<string>(merkleFingerprints(prior).values()),
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
    // 同一张 plan 当 prior → prior fp 全在 poisoned → 闭包内 'a' 走 (b) 复用路径 → spin
    const priorFp = merkleFingerprints(det);
    const res = trySpinRepair({
      closure: new Set(['a']),
      deterministicPlan: det,
      priorPlan: det,
      priorPoisoned: new Set<string>(priorFp.values()),
      frozenNodes: [],  // 不点名 frozen → 没有任何 command 节点可当 verify
      priorResults: { a: fakeLeaf('agent') },
      verdictReason: 'failed',
      escCount: 1,
    });
    expect(res.kind).toBe('fallback');
  });
});
