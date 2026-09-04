/**
 * src/harness/goal/loop-ledger.test —— R-1 派发事实 (D-2, 2026-09-04) 闸。
 *
 * 三个新维度, 三处闸:
 *   · computeLoopDispatchFacts / reconcileWriteSets —— 派发层的三态 (declared / orphan / missing) 与 union dedup
 *   · renderDispatchEvidenceTruth —— 卷面写法 (派发 #N 行 / 写集对账 / git 失败原文)
 *   · 接线闸 (test-touches-impl) — 值导入 orchestrating-loop / loop-run / run-goal / goal 真跑一发, 否则
 *     全绿也证明不了真路径对了。
 *
 * 反向自检 (每条都必能真红):
 *   · reconcileWriteSets: 删 `seen.has(p)` 检查 → filesTouched union 那条「去重」红 (重复 A 出现两次)。
 *   · computeLoopDispatchFacts: 删 `if (!node.write_set) continue` → 第二组断言里 `{[A,B]} declared [A,B]` 那条仍过
 *     但 union dedup 顺序测试会因 shared seen 集合先污染 declared 而失败 (注释里写明)。
 *   · renderDispatchEvidenceTruth: 把 `git-failed:` 改 `git-error:` → 第二组断言含 `git-failed:` 的那条红。
 */
import { describe, expect, test } from 'bun:test';
import {
  withDispatchEvidence,
  computeLoopDispatchFacts,
  reconcileWriteSets,
  renderDispatchEvidenceTruth,
  type LoopDispatch,
} from './loop-ledger';
import { prefixPlanIds } from './orchestrating-loop';
import { conductorInfraFailureOf } from './loop-run';
import { goalSlug } from './run-goal';
import { summarizeGoal } from '../../mcp/tools/goal';
import type { ExecutorDagResult, LeafResult } from '../dag/types';
import type { JudgingTruths } from '../verifier';
import type { ConductorPlan } from '../conductor-plan';
import type { RunGoalResult } from './run-goal';

const makeLeaf = (over: Partial<LeafResult>): LeafResult => ({
  id: 'leaf',
  status: 'done',
  kind: 'agent',
  output: '',
  deps: [],
  usage: { in: 0, out: 0 },
  ...over,
});

describe('reconcileWriteSets (纯函数, D-2 三态对账)', () => {
  test('空 → 全空', () => {
    expect(reconcileWriteSets([], [])).toEqual({ declared: [], orphan: [], missing: [] });
  });
  test('declared [A,B] · touched [A,C] → orphan [C] · missing [B]', () => {
    expect(reconcileWriteSets(['A', 'B'], ['A', 'C'])).toEqual({
      declared: ['A', 'B'],
      orphan: ['C'],
      missing: ['B'],
    });
  });
  test('declared [A] · touched [A] → 齐, 两侧零偏差', () => {
    expect(reconcileWriteSets(['A'], ['A'])).toEqual({ declared: ['A'], orphan: [], missing: [] });
  });
  test('去重按出现顺序 (falsify: 删 seen 检查 → duplicate A 漏进 orphan 列表, 那条 assertion 形变)', () => {
    // declared = [A,A,B], touched = [A,B,B,C] → 期望 declared [A,B], orphan [C], missing []
    expect(reconcileWriteSets(['A', 'A', 'B'], ['A', 'B', 'B', 'C'])).toEqual({
      declared: ['A', 'B'],
      orphan: ['C'],
      missing: [],
    });
  });
  test('declared 全空 · touched 非空 → orphan = touched', () => {
    expect(reconcileWriteSets([], ['A', 'B'])).toEqual({ declared: [], orphan: ['A', 'B'], missing: [] });
  });
});

describe('computeLoopDispatchFacts (plan + exec → 三层事实)', () => {
  test('没声明 write_set → writeSet === null (没合同 = 不判)', () => {
    const plan = { nodes: { a: {} as { write_set?: string[] }, b: {} as { write_set?: string[] } } };
    const exec: { results: Record<string, LeafResult> } = {
      results: {
        a: makeLeaf({ id: 'a', status: 'done', filesTouched: ['X'] }),
        b: makeLeaf({ id: 'b', status: 'failed' }),
      },
    };
    const f = computeLoopDispatchFacts(plan, exec);
    expect(f.filesTouched).toEqual(['X']);
    expect(f.done).toBe(1);
    expect(f.writeSet).toBeNull();
  });
  test('declared [A,B] · touched [A,C] → 三态各归位', () => {
    const plan = { nodes: { a: { write_set: ['A', 'B'] } } };
    const exec: { results: Record<string, LeafResult> } = {
      results: {
        a: makeLeaf({ id: 'a', status: 'done', filesTouched: ['A', 'C'] }),
      },
    };
    const f = computeLoopDispatchFacts(plan, exec);
    expect(f.filesTouched).toEqual(['A', 'C']);
    expect(f.done).toBe(1);
    expect(f.writeSet).toEqual({ declared: ['A', 'B'], orphan: ['C'], missing: ['B'] });
  });
  test('declared [A] · touched [A] → 三态空', () => {
    const plan = { nodes: { a: { write_set: ['A'] } } };
    const exec: { results: Record<string, LeafResult> } = {
      results: { a: makeLeaf({ id: 'a', status: 'done', filesTouched: ['A'] }) },
    };
    expect(computeLoopDispatchFacts(plan, exec).writeSet).toEqual({ declared: ['A'], orphan: [], missing: [] });
  });
  test('多节点: declared 与 touched 各来自不同节点, union 按 leaves 出现顺序', () => {
    const plan = { nodes: { a: { write_set: ['A'] }, b: { write_set: ['B'] } } };
    const exec: { results: Record<string, LeafResult> } = {
      results: {
        a: makeLeaf({ id: 'a', status: 'done', filesTouched: ['X'] }),
        b: makeLeaf({ id: 'b', status: 'done', filesTouched: ['Y'] }),
      },
    };
    const f = computeLoopDispatchFacts(plan, exec);
    expect(f.filesTouched).toEqual(['X', 'Y']);
    expect(f.done).toBe(2);
    expect(f.writeSet).toEqual({ declared: ['A', 'B'], orphan: ['X', 'Y'], missing: ['A', 'B'] });
  });
  test('done 数 = status==="done" 的 leaves 数', () => {
    const plan = { nodes: { a: {} as { write_set?: string[] } } };
    const exec: { results: Record<string, LeafResult> } = {
      results: {
        a: makeLeaf({ id: 'a', status: 'done' }),
        b: makeLeaf({ id: 'b', status: 'failed' }),
        c: makeLeaf({ id: 'c', status: 'skipped' }),
        d: makeLeaf({ id: 'd', status: 'done' }),
      },
    };
    expect(computeLoopDispatchFacts(plan, exec).done).toBe(2);
  });
});

describe('renderDispatchEvidenceTruth (D-2 卷面写法)', () => {
  const disp: LoopDispatch[] = [
    {
      seq: 1,
      card: 'work',
      nodes: 2,
      briefHasRepro: null,
      filesTouched: ['A', 'B'],
      done: 2,
      writeSet: { declared: ['A', 'B'], orphan: [], missing: [] },
    },
    {
      seq: 2,
      card: 'work',
      nodes: 1,
      briefHasRepro: null,
      filesTouched: ['C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M'],
      done: 1,
      writeSet: { declared: ['C', 'M'], orphan: ['D'], missing: ['M'] },
    },
  ];

  test('空 dispatches → null (不编, 老调用方零回归)', () => {
    expect(renderDispatchEvidenceTruth([], { cwd: '/' })).toBeNull();
  });

  test('两个派发各印一行, 含 filesTouched 列表与 +N 截断', () => {
    const out = renderDispatchEvidenceTruth(disp, {
      touchedPrintLimit: 8,
      cwd: '/',
      runGit: () => ({ exitCode: 0, stdout: '', stderr: '' }),
    })!;
    expect(out).toContain('派发 #1 (work)');
    expect(out).toContain('派发 #2 (work)');
    expect(out).toContain('filesTouched: A, B');
    // 11 个文件, 显式上限 8 (默认已抬到 20, 硬约束 2) → 头 8 个 + +3
    expect(out).toContain('filesTouched: C, D, E, F, G, H, I, J, +3');
    expect(out).toContain('done 2/2');
    expect(out).toContain('done 1/1');
  });

  test('写集对账段 — orphan / missing 在第二行明示', () => {
    const out = renderDispatchEvidenceTruth(disp, {
      cwd: '/',
      runGit: () => ({ exitCode: 0, stdout: '', stderr: '' }),
    })!;
    expect(out).toContain('orphan [D]');
    expect(out).toContain('missing [M]');
    expect(out).toContain('declared 2 / orphan 0 / missing 0'); // 第一个派发齐, 不挂告警
  });

  test('git 退出非 0 → 写 git-failed:<错误原文> (不省略)', () => {
    const out = renderDispatchEvidenceTruth(disp, {
      cwd: '/',
      runGit: () => ({ exitCode: 128, stdout: '', stderr: 'fatal: not a git repo' }),
    })!;
    expect(out).toContain('git-failed: fatal: not a git repo');
  });

  test('git 退出 0 · stdout 空 → 印 (无变更)', () => {
    const out = renderDispatchEvidenceTruth(disp, {
      cwd: '/',
      runGit: () => ({ exitCode: 0, stdout: '', stderr: '' }),
    })!;
    expect(out).toContain('判卷时刻机械事实: (无变更)');
  });

  test('git 退出 0 · stdout 非空 → 印 porcelain 行 (单行化)', () => {
    const out = renderDispatchEvidenceTruth(disp, {
      cwd: '/',
      runGit: () => ({ exitCode: 0, stdout: ' M src/foo.ts\n?? src/bar.ts\n', stderr: '' }),
    })!;
    expect(out).toContain(' M src/foo.ts');
    expect(out).toContain('?? src/bar.ts');
  });

  test('writeSet === undefined (没合同) → 不写对账段, 但仍印 filesTouched', () => {
    const noContract: LoopDispatch[] = [{ seq: 3, card: 'map', nodes: 1, briefHasRepro: null, filesTouched: ['Z'] }];
    const out = renderDispatchEvidenceTruth(noContract, {
      cwd: '/',
      runGit: () => ({ exitCode: 0, stdout: '', stderr: '' }),
    })!;
    expect(out).toContain('派发 #3 (map)');
    expect(out).toContain('filesTouched: Z');
    expect(out).not.toContain('写集对账');
  });

  test('writeSet === null → 也不写对账段 (与 undefined 同语义)', () => {
    const noContract: LoopDispatch[] = [{ seq: 4, card: 'map', nodes: 1, briefHasRepro: null, filesTouched: ['Z'], writeSet: null }];
    const out = renderDispatchEvidenceTruth(noContract, {
      cwd: '/',
      runGit: () => ({ exitCode: 0, stdout: '', stderr: '' }),
    })!;
    expect(out).not.toContain('写集对账');
  });

  test('filesTouched 空 → 不调 git (也无机械事实段)', () => {
    const noneTouched: LoopDispatch[] = [{ seq: 5, card: 'work', nodes: 1, briefHasRepro: null, filesTouched: [] }];
    let called = false;
    const out = renderDispatchEvidenceTruth(noneTouched, {
      cwd: '/',
      runGit: () => {
        called = true;
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    })!;
    expect(called).toBe(false);
    expect(out).toContain('filesTouched: (无)');
    expect(out).not.toContain('判卷时刻机械事实');
  });
});

describe('computeLoopDispatchFacts ← ExecutorDagResult 兼容性 (防 plan/results 形状漂移)', () => {
  test('exec.results 含非 leaf 字段 (kind/conductor) 不影响 filesTouched/done', () => {
    const plan = { nodes: { a: {} as { write_set?: string[] } } };
    const exec = {
      results: {
        a: makeLeaf({ id: 'a', status: 'done', kind: 'agent', filesTouched: ['A'] }),
        b: makeLeaf({ id: 'b', status: 'done', kind: 'conductor', filesTouched: ['B'] }),
      },
    } as unknown as ExecutorDagResult;
    const f = computeLoopDispatchFacts(plan, exec);
    expect(f.filesTouched).toEqual(['A', 'B']);
    expect(f.done).toBe(2);
  });
});

describe('orchestrating-loop wiring: prefixPlanIds (派发前缀, 写集判读时不撞)', () => {
  test('子图节点 id 加 d<n>. 前缀, 防两次 explore 撞', () => {
    const p: ConductorPlan = { name: 'p', nodes: { 'explore-1': { goal: 'g', depends_on: ['a'] } } };
    const out = prefixPlanIds(p, 'd3');
    expect(Object.keys(out.nodes)).toEqual(['d3.explore-1']);
    expect(out.nodes['d3.explore-1']?.depends_on).toEqual(['d3.a']);
  });
});

describe('loop-run wiring: conductorInfraFailureOf (D-14 基建败因筛)', () => {
  test('conductor status=done → undefined (不基建败)', () => {
    const exec = { results: { conductor: { id: 'conductor', status: 'done', kind: 'conductor' } } } as unknown as ExecutorDagResult;
    expect(conductorInfraFailureOf(exec)).toBeUndefined();
  });
  test('conductor status=failed · failureKind=infra-error → 返基建败因文本', () => {
    const exec = { results: { conductor: { id: 'conductor', status: 'failed', kind: 'conductor', failureKind: 'infra-error', output: 'oops' } } } as unknown as ExecutorDagResult;
    expect(conductorInfraFailureOf(exec)).toContain('infra-error');
  });
});

describe('run-goal wiring: goalSlug (goal 文本 → 仓内目录名)', () => {
  test('英文 → 小写连字符', () => {
    expect(goalSlug('Hello World!')).toBe('hello-world');
  });
});

describe('mcp/tools/goal wiring: summarizeGoal 循环聚合 (R-1)', () => {
  test('loop.dispatches 非空 → 循环: 行尾拼上触碰/orphan/missing 计数', () => {
    const r = {
      goal: 'g',
      tier: 'executable',
      converged: false,
      rounds: 1,
      acceptance: { kind: 'executable', command: 'c', expectExit: 0 },
      stages: [],
      outcome: 'not-converged',
      sources: [],
      reusedNodes: [],
      loop: {
        path: 'orchestrating-loop',
        route: { kind: 'none', chainHit: false },
        preActionLlmCalls: 1,
        residentPromptChars: 100,
        verifier: { calls: 1, firstVerdict: 'fail', target: 'implementation', reinjected: false, afterReinject: 'skipped' },
        cards: { calls: 1, ok: 1, rejectedSchema: 0, help: 0, rejectedCompile: 0, childRunError: 0, byCard: { work: 1 }, readOnlyShellBlocked: 0 },
        dispatches: [
          { seq: 1, card: 'work', nodes: 2, briefHasRepro: null, filesTouched: ['a.ts', 'b.ts'], done: 2, writeSet: { declared: ['a.ts'], orphan: ['c.ts'], missing: ['b.ts'] } },
          { seq: 2, card: 'work', nodes: 1, briefHasRepro: null, filesTouched: ['d.ts'], done: 1, writeSet: { declared: ['d.ts'], orphan: [], missing: [] } },
        ],
      },
    } as unknown as RunGoalResult;
    const out = summarizeGoal(r);
    expect(out).toContain('触碰 3 文件');
    expect(out).toContain('orphan 1');
    expect(out).toContain('missing 1');
  });
  test('loop.dispatches 空 → 循环: 行不加尾巴段 (老路径零回归)', () => {
    const r = {
      goal: 'g',
      tier: 'executable',
      converged: true,
      rounds: 1,
      acceptance: { kind: 'executable', command: 'c', expectExit: 0 },
      stages: [],
      outcome: 'success',
      sources: [],
      reusedNodes: [],
      loop: {
        path: 'orchestrating-loop',
        route: { kind: 'none', chainHit: false },
        preActionLlmCalls: 1,
        residentPromptChars: 100,
        verifier: { calls: 0, firstVerdict: null, target: null, reinjected: false, afterReinject: 'skipped' },
        cards: { calls: 0, ok: 0, rejectedSchema: 0, help: 0, rejectedCompile: 0, childRunError: 0, byCard: {}, readOnlyShellBlocked: 0 },
        dispatches: [],
      },
    } as unknown as RunGoalResult;
    const out = summarizeGoal(r);
    expect(out).not.toContain('触碰');
    expect(out).not.toContain('orphan');
  });
});

describe('withDispatchEvidence (两注入点共用的一跳; 硬约束 3 / 5c)', () => {
  const d = (seq: number): LoopDispatch => ({ seq, card: 'work', nodes: 1, briefHasRepro: null, done: 1, filesTouched: ['a.ts'], writeSet: null });
  const gitOk = () => ({ exitCode: 0, stdout: '', stderr: '' });
  test('dispatches 为空 → 返回**同一个** req 引用 (卷面逐字节同旧)', () => {
    const req: { task: string; truths?: JudgingTruths } = { task: 't', truths: { criterionFreeze: 'F' } };
    expect(withDispatchEvidence(req, [], { cwd: '/tmp', runGit: gitOk, exists: () => true })).toBe(req);
  });
  test('dispatches 非空 → truths.dispatchEvidence 非空, 且与既有 criterionFreeze 共存 (互不吞)', () => {
    const req: { task: string; truths?: JudgingTruths } = { task: 't', truths: { criterionFreeze: 'F' } };
    const out = withDispatchEvidence(req, [d(1)], { cwd: '/tmp', runGit: gitOk, exists: () => true });
    expect(out).not.toBe(req);
    expect(out.truths!.criterionFreeze).toBe('F');
    expect(out.truths!.dispatchEvidence).toContain('派发 #1 (work)');
    expect(out.task).toBe('t');
  });
  test('无 truths 的 req 也能挂上 (不要求调用方先建空对象)', () => {
    const out = withDispatchEvidence({ task: 't' } as { task: string; truths?: JudgingTruths }, [d(1)], { cwd: '/tmp', runGit: gitOk, exists: () => true });
    expect(out.truths!.dispatchEvidence).toBeTruthy();
  });
});

describe('renderDispatchEvidenceTruth · 判卷时刻盘上存在 (硬约束 2)', () => {
  test('存在 / 缺失各归位, 缺失点名; 默认上限 20 条', () => {
    const d: LoopDispatch = { seq: 1, card: 'work', nodes: 1, briefHasRepro: null, done: 1, filesTouched: ['a.ts', 'b.ts', 'c.ts'], writeSet: null };
    const out = renderDispatchEvidenceTruth([d], { cwd: '/x', runGit: () => ({ exitCode: 0, stdout: '', stderr: '' }), exists: (p) => !p.endsWith('b.ts') })!;
    expect(out).toContain('判卷时刻盘上: 存在 2/3 · 缺失 [b.ts]');
    const many: LoopDispatch = { ...d, filesTouched: Array.from({ length: 23 }, (_, i) => `f${i}.ts`) };
    const big = renderDispatchEvidenceTruth([many], { cwd: '/x', runGit: () => ({ exitCode: 0, stdout: '', stderr: '' }), exists: () => true })!;
    expect(big).toContain('f19.ts, +3');
    expect(big).not.toContain('f20.ts,');
  });
});
