/**
 * **D-A: 环封在 conductor 节点内** + 节点级 loop journal (P3 批次 3 第二次加厚, 2026-07-29)。
 *
 * 两件事要钉死, 它们各自都能悄悄失效:
 *
 * ① **环的语义是「逐轮重展开」, 不是「重跑同一张子图」。** 这条区分是环的全部价值 ——
 *    重跑只能把同样的活再干一遍; 重画才补得出**上一轮压根没有的步骤**。D-G′ 说的「环外的
 *    research 回不去, 补调研要回边」正是靠这个形状解掉的: 不需要回边, 因为每一轮都是一张
 *    全新的无环子图。若哪天有人把它改成重跑同一张图, 上面那句话就无声地不成立了。
 *
 * ② **崩在环中间, 毒集不能丢。** 这正是 journal 不放 NodeCheckpoint 的理由 (checkpoint 只在
 *    节点 done 时写, 而环没收敛就没有 done)。
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runExecutorDagWithPlan } from '../../src/harness/executor-dag';
import { CheckpointManager } from '../../src/harness/continuity/checkpoint-manager';
import type { NodeLoopJournal } from '../../src/harness/continuity/types';
import type { ConductorPlan } from '../../src/harness/conductor-plan';
import type { ExecutorDagConfig, GenerateFn } from '../../src/harness/executor-dag-types';

const RUN = 'loop-run';
let root: string;
let manager: CheckpointManager;
let saved: string | undefined;

beforeEach(() => {
  saved = process.env.OMD_DATA_HOME;
  delete process.env.OMD_DATA_HOME;
  root = mkdtempSync(join(tmpdir(), 'omd-loop-'));
  manager = new CheckpointManager(root);
});
afterEach(() => {
  if (saved === undefined) delete process.env.OMD_DATA_HOME;
  else process.env.OMD_DATA_HOME = saved;
  rmSync(root, { recursive: true, force: true });
});

const leafId = (p: string): string => /\[omd leaf: ([^\]]+)\]/.exec(p)?.[1] ?? '';
const isJudge = (p: string): boolean => p.includes('你在判一个子任务');
const runDir = (): string => join(root, '.omd', 'continuity', RUN);

const node = (over: Record<string, unknown> = {}): ConductorPlan =>
  ({ name: 'outer', nodes: { C: { goal: '把这件事做完', executor: 'conductor', ...over } } }) as ConductorPlan;

/**
 * 假模型: 三种调用分流 —— 展开 / leaf / judge。
 * @param subplans 逐轮返回的子图 (第 i 轮用 subplans[i-1]); 用尽则重复最后一份。
 * @param verdicts 逐轮 judge 裁决。
 */
function fake(subplans: string[], verdicts: Array<{ converged: boolean; failureReason?: string; rejectedNodes?: string[] }>) {
  const expandPrompts: string[] = [];
  const leafCalls: string[] = [];
  let expandN = 0;
  let judgeN = 0;
  const generate: GenerateFn = async (req) => {
    const user = req.messages.find((m) => m.role === 'user');
    const text = typeof user?.content === 'string' ? user.content : '';
    if (isJudge(text)) {
      const v = verdicts[Math.min(judgeN++, verdicts.length - 1)]!;
      return { text: JSON.stringify(v), usage: { in: 1, out: 1 } };
    }
    const id = leafId(text);
    if (!id) {
      expandPrompts.push(text);
      const sp = subplans[Math.min(expandN++, subplans.length - 1)]!;
      return { text: sp, usage: { in: 1, out: 1 } };
    }
    leafCalls.push(id);
    return { text: `out:${id}`, usage: { in: 1, out: 1 } };
  };
  return { generate, expandPrompts, leafCalls, expands: () => expandN, judges: () => judgeN };
}

const cfg = (generate: GenerateFn, resume = false, withContinuity = true): ExecutorDagConfig => ({
  conductorModel: 'c:m',
  leafModel: 'l:m',
  generate,
  agentTemplates: new Map(),
  ...(withContinuity ? { continuity: { manager, runId: RUN, repoRoot: root, ...(resume ? { resume: true } : {}) } } : {}),
});

const P1 = JSON.stringify({ name: 's', nodes: { impl: { goal: '实装' } } });
const P2 = JSON.stringify({ name: 's', nodes: { research: { goal: '先把事实查清楚' }, impl: { goal: '实装', depends_on: ['research'] } } });

describe('D-A 环 — 缺省不带环 (零回归)', () => {
  test('不写 max_rounds → 展开一次, **judge 一次都不调** (没有下一轮, 判了也白判)', async () => {
    const f = fake([P1], [{ converged: true }]);
    const r = await runExecutorDagWithPlan(node(), cfg(f.generate));
    expect(f.expands()).toBe(1);
    expect(f.judges()).toBe(0);
    expect(r.results.C?.status).toBe('done');
  });

  test('max_rounds:1 显式也一样 (与缺省同语义)', async () => {
    const f = fake([P1], [{ converged: false }]);
    await runExecutorDagWithPlan(node({ max_rounds: 1 }), cfg(f.generate));
    expect(f.judges()).toBe(0);
  });
});

describe('D-A 环 — 逐轮**重展开**, 这是补调研的机制', () => {
  test('未收敛 → 再展开一次, 且上一轮的失败原因回灌进展开 prompt', async () => {
    const f = fake([P1, P2], [{ converged: false, failureReason: '缺少外部事实支撑' }, { converged: true }]);
    const r = await runExecutorDagWithPlan(node({ max_rounds: 3 }), cfg(f.generate));
    expect(f.expands()).toBe(2); // 重新画了, 不是重跑
    expect(f.judges()).toBe(2);
    // 第 2 次展开的 prompt 里带着上一轮的败因 + "重新分解"的指令。
    expect(f.expandPrompts[1]).toContain('缺少外部事实支撑');
    expect(f.expandPrompts[1]).toContain('重新分解');
    expect(r.results.C?.status).toBe('done');
  });

  test('**补调研**: 第 2 轮的子图可以含一个第 1 轮压根没有的步骤 (不需要回边)', async () => {
    const f = fake([P1, P2], [{ converged: false, failureReason: '没有外部证据' }, { converged: true }]);
    await runExecutorDagWithPlan(node({ max_rounds: 3 }), cfg(f.generate));
    // 第 1 轮只有 impl; 第 2 轮多出一个"先把事实查清楚"的步骤 —— 这正是「补调研」的形状。
    const goalsRun = f.leafCalls.length;
    expect(goalsRun).toBe(1 + 2); // 轮1: 1 个; 轮2: 2 个
  });

  test('收敛即停 (不跑满 max_rounds)', async () => {
    const f = fake([P1], [{ converged: true }]);
    await runExecutorDagWithPlan(node({ max_rounds: 4 }), cfg(f.generate));
    expect(f.expands()).toBe(1);
  });

  test('轮数用尽仍未收敛 → 返最后一轮结果, **不谎报收敛** (INV-GOAL-4 有界)', async () => {
    const f = fake([P1], [{ converged: false, failureReason: '还是不行' }]);
    const r = await runExecutorDagWithPlan(node({ max_rounds: 2 }), cfg(f.generate));
    expect(f.expands()).toBe(2); // 跑满两轮
    expect(r.results.C).toBeTruthy();
  });

  test('judge 吐不出可解析结论 → fail-closed 判未收敛 (不当作"那就算过了吧")', async () => {
    const generate: GenerateFn = async (req) => {
      const user = req.messages.find((m) => m.role === 'user');
      const text = typeof user?.content === 'string' ? user.content : '';
      if (isJudge(text)) return { text: '我觉得挺好的', usage: { in: 1, out: 1 } };
      if (!leafId(text)) return { text: P1, usage: { in: 1, out: 1 } };
      return { text: 'ok', usage: { in: 1, out: 1 } };
    };
    const f = { generate };
    await runExecutorDagWithPlan(node({ max_rounds: 2 }), cfg(f.generate));
    // 判不出来 = 未收敛 → 会去跑第 2 轮 (若被当成收敛就只有 1 轮)。
    // 用 journal 的 completedRounds 判更直接:
    const j = JSON.parse(readFileSync(join(runDir(), '_loop-C.json'), 'utf-8')) as NodeLoopJournal;
    expect(j.converged).toBeFalsy();
    expect(j.completedRounds).toBe(2);
  });
});

describe('D-A 毒集的新家 — 节点级 journal, 每轮判完就写', () => {
  test('journal 落盘且带轮次/毒集/上轮原因', async () => {
    const f = fake([P1, P1], [{ converged: false, failureReason: '产出是编的', rejectedNodes: [] }, { converged: true }]);
    await runExecutorDagWithPlan(node({ max_rounds: 3 }), cfg(f.generate));
    const j = JSON.parse(readFileSync(join(runDir(), '_loop-C.json'), 'utf-8')) as NodeLoopJournal;
    expect(j.nodeId).toBe('C');
    expect(j.completedRounds).toBe(2);
    expect(j.converged).toBe(true);
  });

  test('**每轮判完就写**, 不是节点结束时写 —— 这正是它不放 NodeCheckpoint 的理由', async () => {
    // 第 1 轮判未收敛后, judge 那一刻 journal 就该在盘上了。用"第 2 轮展开时读得到第 1 轮的
    // 毒集"来证: 造一个在第 2 轮展开时去读盘的 generate。
    let journalAtRound2: NodeLoopJournal | null = null;
    let expandN = 0;
    const generate: GenerateFn = async (req) => {
      const user = req.messages.find((m) => m.role === 'user');
      const text = typeof user?.content === 'string' ? user.content : '';
      if (isJudge(text)) return { text: JSON.stringify({ converged: false, failureReason: 'r1 不行' }), usage: { in: 1, out: 1 } };
      if (!leafId(text)) {
        expandN++;
        if (expandN === 2) {
          journalAtRound2 = JSON.parse(readFileSync(join(runDir(), '_loop-C.json'), 'utf-8')) as NodeLoopJournal;
        }
        return { text: P1, usage: { in: 1, out: 1 } };
      }
      return { text: 'ok', usage: { in: 1, out: 1 } };
    };
    await runExecutorDagWithPlan(node({ max_rounds: 2 }), cfg(generate));
    expect(journalAtRound2).toBeTruthy();
    expect(journalAtRound2!.completedRounds).toBe(1); // 第 1 轮判完就已落盘
    expect(journalAtRound2!.prevReason).toContain('r1 不行');
  });

  test('崩在环中间 → resume 接回轮次与毒集 (不从第 1 轮重来, 毒集不清零)', async () => {
    // 先人为造一份"跑了 1 轮、毒了一条、未收敛"的 journal —— 等价于第 2 轮开始前进程死掉。
    manager.writeNodeLoopJournal(RUN, {
      runId: RUN,
      nodeId: 'C',
      completedRounds: 1,
      poisoned: ['fp-of-a-rejected-child'],
      prevReason: '上一轮的产出是编的',
      updatedAt: '2026-07-29T00:00:00Z',
      schemaVersion: 1,
    });
    const f = fake([P1], [{ converged: true }]);
    await runExecutorDagWithPlan(node({ max_rounds: 3 }), cfg(f.generate, true));
    // 从第 2 轮起跑 → 本进程只展开一次 (若毒集/轮次丢了会从第 1 轮起, 展开两次)。
    expect(f.expands()).toBe(1);
    // 上一轮的败因被接回并回灌进展开 prompt。
    expect(f.expandPrompts[0]).toContain('上一轮的产出是编的');
    // 毒集**没有清零** —— 清零 = 被拒产出复活, 比不复用更坏 (INV-P2-6 点名的那条)。
    const j = JSON.parse(readFileSync(join(runDir(), '_loop-C.json'), 'utf-8')) as NodeLoopJournal;
    expect(j.poisoned).toContain('fp-of-a-rejected-child');
  });

  test('journal 说已收敛 → resume 直接返上次结论, 一次模型调用都不花', async () => {
    manager.writeNodeLoopJournal(RUN, {
      runId: RUN, nodeId: 'C', completedRounds: 2, poisoned: [],
      converged: true, lastOutput: '[上次的结论]',
      updatedAt: '2026-07-29T00:00:00Z', schemaVersion: 1,
    });
    const f = fake([P1], [{ converged: true }]);
    const r = await runExecutorDagWithPlan(node({ max_rounds: 3 }), cfg(f.generate, true));
    expect(f.expands()).toBe(0);
    expect(f.judges()).toBe(0);
    expect(r.results.C?.output).toBe('[上次的结论]');
  });

  test('不带 continuity 也能跑环 (journal 是可选增强, 不是运行前提)', async () => {
    const f = fake([P1, P1], [{ converged: false }, { converged: true }]);
    const r = await runExecutorDagWithPlan(node({ max_rounds: 3 }), cfg(f.generate, false, false));
    expect(f.expands()).toBe(2);
    expect(r.results.C?.status).toBe('done');
    expect(existsSync(runDir())).toBe(false);
  });
});

describe('D-21 内环版 — 跨轮复用 (环搬进节点后一度丢了这条)', () => {
  const SUB3 = JSON.stringify({ name: 's', nodes: { a: { goal: 'A' }, b: { goal: 'B' }, c: { goal: 'C' } } });

  /** 逐轮同一份子图 + 逐轮裁决; 回收 leaf 调用。 */
  function loopFake(verdicts: Array<{ converged: boolean; failureReason?: string; rejectedNodes?: string[] }>) {
    const leafCalls: string[] = [];
    let j = 0;
    let lastChildIds: string[] = [];
    const generate: GenerateFn = async (req) => {
      const u = req.messages.find((m) => m.role === 'user');
      const t = typeof u?.content === 'string' ? u.content : '';
      if (isJudge(t)) {
        // 从 prompt 里抠出本轮可点名的 id, 好让裁决点得中 (judge 只能点内容寻址 id)。
        lastChildIds = [...t.matchAll(/C::[\w-]+/g)].map((m) => m[0]);
        const v = verdicts[Math.min(j++, verdicts.length - 1)]!;
        const named = (v.rejectedNodes ?? []).map((n) => lastChildIds[Number(n)] ?? n);
        return { text: JSON.stringify({ ...v, rejectedNodes: named }), usage: { in: 1, out: 1 } };
      }
      const id = leafId(t);
      if (!id) return { text: SUB3, usage: { in: 1, out: 1 } };
      leafCalls.push(id);
      return { text: `out:${id}`, usage: { in: 1, out: 1 } };
    };
    return { generate, leafCalls };
  }

  test('第 2 轮语义没变的子节点**零 LLM 复用**上轮输出 (3 个子节点两轮 = 3 次调用, 不是 6 次)', async () => {
    const f = loopFake([{ converged: false, failureReason: '再想想' }, { converged: true }]);
    await runExecutorDagWithPlan(node({ max_rounds: 2 }), cfg(f.generate));
    expect(f.leafCalls).toHaveLength(3);
  });

  test('被 judge 点名的子节点**必须重跑**, 不许被复用抵消掉 (毒集优先于复用)', async () => {
    // 第 1 轮点名第 0 个子节点 → 第 2 轮它重跑; 另两个复用。
    const f = loopFake([{ converged: false, failureReason: '第一个是编的', rejectedNodes: ['0'] }, { converged: true }]);
    await runExecutorDagWithPlan(node({ max_rounds: 2 }), cfg(f.generate));
    expect(f.leafCalls).toHaveLength(4); // 3 (轮1) + 1 (轮2 只重跑被毒那个)
  });

  test('复用不跨越"上游要重跑"这条线 (前驱重跑 → 下游吃到的输入变了, 也得重跑)', async () => {
    const CHAIN = JSON.stringify({ name: 's', nodes: { a: { goal: 'A' }, b: { goal: 'B', depends_on: ['a'] } } });
    const leafCalls: string[] = [];
    let j = 0;
    let ids: string[] = [];
    const generate: GenerateFn = async (req) => {
      const u = req.messages.find((m) => m.role === 'user');
      const t = typeof u?.content === 'string' ? u.content : '';
      if (isJudge(t)) {
        ids = [...t.matchAll(/C::[\w-]+/g)].map((m) => m[0]);
        // 点名**上游** a (它在 judge 视图里排第一 —— 无依赖者先跑先结清)。
        const v = j++ === 0 ? { converged: false, failureReason: 'a 是编的', rejectedNodes: [ids[0]] } : { converged: true };
        return { text: JSON.stringify(v), usage: { in: 1, out: 1 } };
      }
      const id = leafId(t);
      if (!id) return { text: CHAIN, usage: { in: 1, out: 1 } };
      leafCalls.push(id);
      return { text: `out:${id}`, usage: { in: 1, out: 1 } };
    };
    await runExecutorDagWithPlan(node({ max_rounds: 2 }), cfg(generate));
    // 轮1 跑 2 个; 轮2 上游被毒重跑, 下游因"前驱不可复用"也重跑 → 共 4 次。
    expect(leafCalls).toHaveLength(4);
  });
});
