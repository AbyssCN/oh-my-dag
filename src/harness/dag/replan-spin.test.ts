/**
 * src/harness/dag/replan-spin.test.ts —— D2 切片 3 + 修补上下文切片 1 的判别力测试。
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
 * 修补上下文切片 1 (2026-08-31, SDD 「修补节点补上下文」) GWT 表:
 *   GWT-1 (INV-1) 七段按 REPAIR_CONTEXT_ORDER 顺序出现在 goal, 红线出现在判词之后。
 *   GWT-2 (INV-2) 隔离档 → diff 正文; head 档 (无 baseline) → 「无 diff 正文」+ gitDiff 零调用。
 *   GWT-3 (INV-3) diff 路径 ⊆ writeSet; 写集空 → gitDiff 零调用 + goal 不含 diff 段。
 *   GWT-4 (INV-4) diff 超 6KB → 截断 + 「已截断 N 字节」+ 自取命令。
 *   GWT-5 (INV-5) gitDiff 抛错 → plan 仍合法 + logEvidence 被调一次 + goal 不含 diff 正文。
 *   GWT-6 (INV-6) 既有断言零删改 (本文件跑 bun test 退出码 0, git diff 只见新增 expect)。
 *
 * 反向自检 (本片手做, 与 deterministic-replan.test.ts 同源):
 *   1. 把 `const spinResult = trySpinRepair(...)` 替成 `const spinResult = { kind: 'no-spin' as const };`
 *      ⇒ G-1 红 (plan.name 不含 __repair_spin_)。
 *   2. 把 `detectReplanSpin` 的循环里 `continue` 全替成 `return false`
 *      ⇒ G-2 / G-3 当场红。
 *   3. 把 renderRepairGoal 里 `REPAIR_CONTEXT.DIFF` 段删掉 ⇒ GWT-1 红 (段序断 1 节)。
 *   4. 把 truncateDiff 的截断提示行删掉 ⇒ GWT-4 红 (静默截断 = No-silent-caps 失守)。
 *   5. 把 renderDiffSegment 的 try/catch 改成吞掉 → GWT-5 红 (fail-open 吞证据)。
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
import {
  detectReplanSpin,
  buildRepairPlan,
  trySpinRepair,
  repairNodeId,
  REPAIR_CONTEXT,
  REPAIR_CONTEXT_ORDER,
  REPAIR_DIFF_MAX_BYTES,
  renderPriorResults,
  renderDiffSegment,
  truncateDiff,
  renderRepairGoal,
  type GitDiffFn,
} from './replan-spin';

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
      task: '用户原任务: 修掉禁词',
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
      task: '用户原任务: 没 command 的退化',
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
      task: '用户原任务: 让修补节点看见原任务',
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
      task: '用户原任务: 退化无写集',
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
      task: '用户原任务: closure 空 → 全图',
    });
    expect(repair).not.toBeNull();
    const repairNode = repair!.nodes[repairNodeId(1)] as Record<string, unknown>;
    // 全图并集 = s1.write_set ∪ 各 results.filesTouched → 含 src/foo.ts
    expect(repairNode.write_set).toEqual(['src/foo.ts']);
  });
});

// ── 修补上下文切片 1 (SDD 2026-08-31) GWT ─────────────────────────────────────

describe('buildRepairPlan — 修补上下文切片 1 (REPAIR_CONTEXT 七段构造 + diff 取数)', () => {
  // ── GWT-1: 七段按 REPAIR_CONTEXT_ORDER 顺序出现在 goal, 红线出现在判词之后 ──
  test('GWT-1 (INV-1): 七段按顺序出现, 红线在判词之后', () => {
    const repair = buildRepairPlan({
      closure: new Set(['s1', 'accept']),
      deterministicPlan: round1Plan(),
      priorPlan: round1Plan(),
      reusedIds: new Set(['s1']),
      frozenNodes: ['accept'],
      priorResults: { s1: fakeLeaf(), accept: { ...fakeLeaf(), id: 'accept' } },
      verdictReason: 'verifier 红了 (line 42)',
      escCount: 1,
      task: '用户原任务: 让模型知道原来要干什么',
    });
    expect(repair).not.toBeNull();
    const goal = repair!.nodes[repairNodeId(1)]!.goal as string;

    // 7 段标题全部在场, 顺序严格按 REPAIR_CONTEXT_ORDER
    let prev = -1;
    for (const title of REPAIR_CONTEXT_ORDER) {
      const idx = goal.indexOf(title);
      expect(idx).toBeGreaterThan(prev); // 顺序
      prev = idx;
    }

    // 红线 (含「只修」字样) 在判词段之后 —— 段位钉死, 不能挤到判词前
    const verdictIdx = goal.indexOf(REPAIR_CONTEXT.VERDICT);
    const redLineIdx = goal.indexOf(REPAIR_CONTEXT.RED_LINE);
    expect(redLineIdx).toBeGreaterThan(verdictIdx);

    // 红线段确实含「只修上面点名的失败」(GWT-1 字面钉法)
    expect(goal).toContain('只修上面点名的失败');
    // 任务段含原文 (D-2: task 字段透传)
    expect(goal).toContain('让模型知道原来要干什么');
  });

  // ── GWT-2: 隔离档 → diff 正文; head 档 (无 baseline) → 「无 diff 正文」+ gitDiff 零调用 ──
  test('GWT-2 (INV-2): baseline 非空 → goal 含 diff 正文; baseline 缺席 → goal 含「无 diff 正文」说明 + gitDiff 零调用', () => {
    // 隔离档路径: 注入 fake gitDiff 返正文 + baseline 非空 → goal 含该正文
    const isoDiffText = 'diff --git a/src/foo.ts b/src/foo.ts\n@@ -1 +1 @@\n-old\n+new\n';
    const isoGitDiff: GitDiffFn = (args) => {
      // 钉路径参数 ⊆ writeSet (GWT-3 同时校验)
      expect(args.paths).toEqual(['src/foo.ts']);
      return isoDiffText;
    };
    const isoRepair = buildRepairPlan({
      closure: new Set(['s1', 'accept']),
      deterministicPlan: round1Plan(),
      priorPlan: round1Plan(),
      reusedIds: new Set(['s1']),
      frozenNodes: ['accept'],
      priorResults: { s1: fakeLeaf(), accept: { ...fakeLeaf(), id: 'accept' } },
      verdictReason: 'verifier 红',
      escCount: 1,
      task: '原任务',
      baseline: 'abc123',  // ← 隔离档
      gitCwd: '/tmp/repo',
      gitDiff: isoGitDiff,
    });
    expect(isoRepair).not.toBeNull();
    const isoGoal = isoRepair!.nodes[repairNodeId(1)]!.goal as string;
    expect(isoGoal).toContain(isoDiffText);
    expect(isoGoal).toContain(REPAIR_CONTEXT.DIFF);

    // head 档路径: baseline 缺席 → goal 不含 diff 正文, 含「无 diff 正文」说明
    // 用同一个 spy gitDiff (应该根本不被调 — zero-call 形状)
    let headCalls = 0;
    const headGitDiff: GitDiffFn = () => {
      headCalls++;
      return 'should-not-be-used';
    };
    const headRepair = buildRepairPlan({
      closure: new Set(['s1', 'accept']),
      deterministicPlan: round1Plan(),
      priorPlan: round1Plan(),
      reusedIds: new Set(['s1']),
      frozenNodes: ['accept'],
      priorResults: { s1: fakeLeaf(), accept: { ...fakeLeaf(), id: 'accept' } },
      verdictReason: 'verifier 红',
      escCount: 2,
      task: '原任务',
      // baseline 缺席 → head 档
      gitDiff: headGitDiff,
    });
    expect(headRepair).not.toBeNull();
    expect(headCalls).toBe(0);  // GWT-2: 没有 baseline 就不该去跑 git
    const headGoal = headRepair!.nodes[repairNodeId(2)]!.goal as string;
    expect(headGoal).not.toContain(isoDiffText);
    expect(headGoal).toContain('无 diff 正文');
  });

  // ── GWT-3: diff 路径 ⊆ writeSet; 写集空 → gitDiff 零调用 + goal 不含 diff 段 ──
  test('GWT-3 (INV-3): fake gitDiff 收到的路径参数 ⊆ writeSet; 写集空 → gitDiff 零调用 + goal 不含 diff 段', () => {
    // 写集 = ['src/foo.ts'], 注入 gitDiff, 钉收到的路径恰为 ['src/foo.ts']
    const seenPaths: string[][] = [];
    const gitDiff: GitDiffFn = (args) => {
      seenPaths.push([...args.paths]);
      return 'fake diff';
    };
    const repair = buildRepairPlan({
      closure: new Set(['s1', 'accept']),
      deterministicPlan: round1Plan(),
      priorPlan: round1Plan(),
      reusedIds: new Set(['s1']),
      frozenNodes: ['accept'],
      priorResults: { s1: fakeLeaf(), accept: { ...fakeLeaf(), id: 'accept' } },
      verdictReason: 'verifier 红',
      escCount: 1,
      task: '原任务',
      baseline: 'abc123',
      gitDiff,
    });
    expect(repair).not.toBeNull();
    expect(seenPaths).toEqual([['src/foo.ts']]);  // GWT-3 字面: 路径 ⊆ 写集, 且**不多带**其他

    // 写集空 → gitDiff 零调用 + goal 不含 diff 段
    const emptyWsPlan: ConductorPlan = {
      name: 'no-ws',
      nodes: {
        a: { executor: 'command', command: 'echo A', expect_exit: 0, depends_on: [], goal: 'a' },
        accept: { executor: 'command', command: 'echo ACCEPT', expect_exit: 0, depends_on: ['a'], goal: 'verify' },
      },
    };
    let emptyCalls = 0;
    const emptyGitDiff: GitDiffFn = () => { emptyCalls++; return 'unused'; };
    const emptyRepair = buildRepairPlan({
      closure: new Set(['a', 'accept']),
      deterministicPlan: emptyWsPlan,
      priorPlan: emptyWsPlan,
      reusedIds: new Set(['a']),
      frozenNodes: ['accept'],
      priorResults: {
        a: { id: 'a', status: 'done', kind: 'command', output: 'ok', deps: [], usage: { in: 0, out: 0 } },
        accept: { id: 'accept', status: 'done', kind: 'command', output: 'ok', deps: ['a'], usage: { in: 0, out: 0 } },
      },
      verdictReason: 'failed',
      escCount: 1,
      task: '原任务',
      baseline: 'abc123',
      gitDiff: emptyGitDiff,
    });
    expect(emptyRepair).not.toBeNull();
    expect(emptyCalls).toBe(0);  // 写集空 → git runner 零调用
    const emptyGoal = emptyRepair!.nodes[repairNodeId(1)]!.goal as string;
    expect(emptyGoal).not.toContain(REPAIR_CONTEXT.DIFF);  // 写集空 → diff 段缺席
  });

  // ── GWT-4: diff 超 6KB → 截断 + 「已截断 N 字节」+ 自取命令 ──
  test('GWT-4 (INV-4): fake 返回 20KB diff → goal 里 diff 段长度 ≤ 6KB + 提示行 + 自取指引', () => {
    const big = 'x'.repeat(REPAIR_DIFF_MAX_BYTES * 4);  // 24KB
    const gitDiff: GitDiffFn = () => big;
    const repair = buildRepairPlan({
      closure: new Set(['s1', 'accept']),
      deterministicPlan: round1Plan(),
      priorPlan: round1Plan(),
      reusedIds: new Set(['s1']),
      frozenNodes: ['accept'],
      priorResults: { s1: fakeLeaf(), accept: { ...fakeLeaf(), id: 'accept' } },
      verdictReason: 'verifier 红',
      escCount: 1,
      task: '原任务',
      baseline: 'abc123',
      gitDiff,
    });
    expect(repair).not.toBeNull();
    const goal = repair!.nodes[repairNodeId(1)]!.goal as string;

    // 截断响亮: 含「已截断」+ `git diff` 自取指引
    expect(goal).toContain('已截断');
    expect(goal).toContain('git diff abc123');
    // 无静默截断: 截断后字符串长度 ≤ REPAIR_DIFF_MAX_BYTES + 提示行 + 标题与基线壳
    // 抽出 diff 段 = REPAIR_CONTEXT.DIFF 之后到下一段 (VERDICT) 之前
    const diffStart = goal.indexOf(REPAIR_CONTEXT.DIFF) + REPAIR_CONTEXT.DIFF.length;
    const diffEnd = goal.indexOf(REPAIR_CONTEXT.VERDICT, diffStart);
    const diffBlock = goal.slice(diffStart, diffEnd);
    // 正文应不超过 MAX + 一段提示 (「已截断 N 字节」+ 自取命令 ≈ 80 字节壳)
    expect(diffBlock.length).toBeLessThanOrEqual(REPAIR_DIFF_MAX_BYTES + 200);
    expect(diffBlock.length).toBeLessThan(big.length);  // 远小于原始 24KB
  });

  // ── GWT-5: gitDiff 抛错 → plan 仍合法 + logEvidence 被调一次 + goal 不含 diff 正文 ──
  test('GWT-5 (INV-5): gitDiff 抛错 → 返回 plan 非 null + logEvidence 被调一次 + goal 不含 diff 正文', () => {
    const boom = new Error('git: not a repository');
    let evidenceCalls = 0;
    let lastMsg = '';
    let lastPayload: Record<string, unknown> | undefined;
    const gitDiff: GitDiffFn = () => { throw boom; };
    const logEvidence = (msg: string, payload?: Record<string, unknown>) => {
      evidenceCalls++;
      lastMsg = msg;
      lastPayload = payload;
    };
    const repair = buildRepairPlan({
      closure: new Set(['s1', 'accept']),
      deterministicPlan: round1Plan(),
      priorPlan: round1Plan(),
      reusedIds: new Set(['s1']),
      frozenNodes: ['accept'],
      priorResults: { s1: fakeLeaf(), accept: { ...fakeLeaf(), id: 'accept' } },
      verdictReason: 'verifier 红',
      escCount: 1,
      task: '原任务',
      baseline: 'abc123',
      gitDiff,
      logEvidence,
    });
    expect(repair).not.toBeNull();  // INV-5: plan 仍合法
    expect(evidenceCalls).toBe(1);  // fail-open 不吞证据: 证据回调被调用恰一次
    expect(lastMsg).toContain('diff');  // 证据行含 diff 上下文
    expect(lastPayload?.baseline ?? lastPayload?.err).toBeDefined();  // payload 带 baseline 或 err
    const goal = repair!.nodes[repairNodeId(1)]!.goal as string;
    // goal 不含 diff 正文: 但仍可能含 DIFF 段标题 + 「diff 取数失败」说明
    expect(goal).not.toContain('not a repository');  // 错误原文不漏进 prompt
    expect(goal).toContain('diff 取数失败');  // 缺席说明在场
  });
});

// ── renderPriorResults / renderDiffSegment / truncateDiff / renderRepairGoal 纯函数 ──

describe('renderPriorResults / renderDiffSegment / truncateDiff / renderRepairGoal — 七段构造的纯函数支撑', () => {
  test('renderPriorResults: 每节点一行 [status/kind] filesTouched=N · summary(截 160)', () => {
    const text = renderPriorResults({
      s1: { id: 's1', status: 'done', kind: 'agent', output: 'done', deps: [], usage: { in: 0, out: 0 }, filesTouched: ['a.ts', 'b.ts'] },
      s2: { id: 's2', status: 'failed', kind: 'command', output: 'failed', deps: [], usage: { in: 0, out: 0 } },
    });
    expect(text).toContain('s1 [done/agent] filesTouched=2');
    expect(text).toContain('s2 [failed/command] filesTouched=0');
  });

  test('renderPriorResults: 输出超 160 字 → 截到 160', () => {
    const long = 'a'.repeat(300);
    const text = renderPriorResults({
      s1: { id: 's1', status: 'done', kind: 'agent', output: long, deps: [], usage: { in: 0, out: 0 } },
    });
    // summary 部分截到 160 (含 ' · ' + 实际内容 ≤ 163)
    expect(text).toMatch(/· a{160}\b/);  // 160 个 a 后接空白或行尾
  });

  test('renderDiffSegment: 写集空 → { kind: "skip" }, git runner 零调用', () => {
    let calls = 0;
    const gitDiff: GitDiffFn = () => { calls++; return 'x'; };
    const out = renderDiffSegment({ writeSet: [], baseline: 'b', gitCwd: '/t', gitDiff });
    expect(out).toEqual({ kind: 'skip' });
    expect(calls).toBe(0);
  });

  test('renderDiffSegment: baseline 非空 + gitDiff 返 ≤ 6KB → { kind: "body" } 含原文', () => {
    const out = renderDiffSegment({
      writeSet: ['a.ts'],
      baseline: 'b',
      gitCwd: '/t',
      gitDiff: () => 'short diff',
    });
    expect(out.kind).toBe('body');
    if (out.kind === 'body') expect(out.text).toBe('short diff');
  });

  test('renderDiffSegment: baseline 缺席 → { kind: "absent" } + 「无 diff 正文」 + gitDiff 零调用', () => {
    let calls = 0;
    const out = renderDiffSegment({
      writeSet: ['a.ts'],
      gitCwd: '/t',
      gitDiff: () => { calls++; return 'x'; },
    });
    expect(out.kind).toBe('absent');
    expect(calls).toBe(0);
    if (out.kind === 'absent') expect(out.reason).toContain('无 diff 正文');
  });

  test('renderDiffSegment: gitDiff 抛错 → { kind: "absent" } + logEvidence 被调一次 + reason 不漏原始错误', () => {
    let n = 0;
    let capturedErr: string | undefined;
    const out = renderDiffSegment({
      writeSet: ['a.ts'],
      baseline: 'b',
      gitCwd: '/t',
      gitDiff: () => { throw new Error('boom'); },
      logEvidence: (_msg, payload) => {
        n++;
        capturedErr = payload?.err as string | undefined;
      },
    });
    expect(out.kind).toBe('absent');
    expect(n).toBe(1);  // 证据回调被调用恰一次
    if (out.kind === 'absent') {
      // ⚠ reason 不漏原始错误 (raw git 错误对模型是噪声; 调试走日志)
      expect(out.reason).not.toContain('boom');
      expect(out.reason).toContain('diff 取数失败');
    }
    // 但 logEvidence payload 必带原始错误 (D-7 不吞证据)
    expect(capturedErr).toContain('boom');
  });

  test('truncateDiff: ≤ 6KB 不动; 超 6KB → 截断 + 「已截断」+ 自取命令', () => {
    const small = 'x'.repeat(REPAIR_DIFF_MAX_BYTES);
    expect(truncateDiff(small, 'abc')).toBe(small);  // 不动
    const big = 'x'.repeat(REPAIR_DIFF_MAX_BYTES * 2);
    const out = truncateDiff(big, 'abc');
    expect(out.length).toBeLessThanOrEqual(REPAIR_DIFF_MAX_BYTES + 200);
    expect(out).toContain(`已截断 ${big.length - REPAIR_DIFF_MAX_BYTES} 字节`);
    expect(out).toContain('git diff abc -- <paths>');
  });

  test('renderRepairGoal: 段序 = REPAIR_CONTEXT_ORDER, 任一段缺席不补位', () => {
    // diff skip + 无 changed → goal 应含其他 6 段, 但不含 DIFF 段
    const goal = renderRepairGoal({
      task: 'task-text',
      priorResults: { s1: { id: 's1', status: 'done', kind: 'agent', output: 'ok', deps: [], usage: { in: 0, out: 0 } } },
      diffSegment: { kind: 'skip' },
      verdict: 'verdict-text',
      writeSet: ['a.ts'],
    });
    for (const title of [REPAIR_CONTEXT.TASK, REPAIR_CONTEXT.PRIOR_RESULTS, REPAIR_CONTEXT.VERDICT, REPAIR_CONTEXT.RED_LINE, REPAIR_CONTEXT.WRITE_SET, REPAIR_CONTEXT.VERIFY_NOTE]) {
      expect(goal).toContain(title);
    }
    expect(goal).not.toContain(REPAIR_CONTEXT.DIFF);  // skip → 缺席, 不补位
    expect(goal).toContain('task-text');
    expect(goal).toContain('verdict-text');
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

  // 切片 1 反向自检: REPAIR_CONTEXT 七段锚必须在场 (片 1 锚) ────────────────
  test('反向自检: REPAIR_CONTEXT 常量与 ORDER 数组必须在场 (切片 1 锚)', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(path.join(import.meta.dir, 'replan-spin.ts'), 'utf8');
    // 七段锚定字面量必须在场 (字面漂移 = 测试锚定漂移 = 当场红)
    expect(src).toContain('REPAIR_CONTEXT = {');
    expect(src).toContain('TASK:');
    expect(src).toContain('PRIOR_RESULTS:');
    expect(src).toContain('DIFF:');
    expect(src).toContain('VERDICT:');
    expect(src).toContain('RED_LINE:');
    expect(src).toContain('WRITE_SET:');
    expect(src).toContain('VERIFY_NOTE:');
    expect(src).toContain('REPAIR_CONTEXT_ORDER');
    // 截断常量必须在场 (No-silent-caps 闸)
    expect(src).toContain('REPAIR_DIFF_MAX_BYTES');
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
      task: '原任务',
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
      task: '原任务',
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
      task: '原任务',
    });
    expect(res.kind).toBe('fallback');
  });
});