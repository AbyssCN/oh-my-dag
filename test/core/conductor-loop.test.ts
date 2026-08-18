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
import { runExecutorDagWithPlan } from '../../src/harness/dag/engine';
import { CheckpointManager } from '../../src/harness/continuity/checkpoint-manager';
import { registerProvider } from '../../src/model/providers';
import { ModelError } from '../../src/model';
import { _peekLangfuseQueue, _resetLangfuseForTest } from '../../src/model/langfuse';
import type { NodeLoopJournal } from '../../src/harness/continuity/types';
import type { ConductorPlan } from '../../src/harness/conductor-plan';
import type { ExecutorDagConfig, GenerateFn } from '../../src/harness/dag/types';

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
const runDir = (): string => join(root, '.omd', 'continuity', RUN);

/** judge 走 `judgeSend` (responseSchema 通道), 不再经 generate —— 内环自 2026-07-29 复用外层判词。 */
type Verdict = { converged: boolean; failureReason?: string; rejectedNodes?: string[] };
const judgeSendOf = (
  verdicts: readonly Verdict[],
  onCall?: (prompt: string, n: number) => void,
): NonNullable<ExecutorDagConfig['judgeSend']> => {
  let n = 0;
  return (async (req: { messages: { content: string }[] }) => {
    const v = verdicts[Math.min(n, verdicts.length - 1)]!;
    // ⚠ 计数器**必须在可选调用之外**自增: 写成 `onCall?.(x, n++)` 时, 不传 onCall 就整个短路,
    // 连实参都不求值 → n 永远是 0 → 逐轮裁决静默退化成"第一条重复到底"。
    onCall?.(String(req.messages[0]?.content ?? ''), n);
    n++;
    return { text: JSON.stringify(v), parsed: { score: v.converged ? 1 : 0, ...v }, usage: { in: 1, out: 1 } };
  }) as never;
};

const node = (over: Record<string, unknown> = {}): ConductorPlan =>
  ({ name: 'outer', nodes: { C: { goal: '把这件事做完', executor: 'conductor', ...over } } }) as ConductorPlan;

/**
 * 假模型: 三种调用分流 —— 展开 / leaf / judge。
 * @param subplans 逐轮返回的子图 (第 i 轮用 subplans[i-1]); 用尽则重复最后一份。
 * @param verdicts 逐轮 judge 裁决。
 */
function fake(subplans: string[], verdicts: Array<{ converged: boolean; failureReason?: string; rejectedNodes?: string[] }>) {
  const expandPrompts: string[] = [];
  const judgePrompts: string[] = [];
  const leafCalls: string[] = [];
  let expandN = 0;
  let judgeN = 0;
  const generate: GenerateFn = async (req) => {
    const user = req.messages.find((m) => m.role === 'user');
    const text = typeof user?.content === 'string' ? user.content : '';
    const id = leafId(text);
    if (!id) {
      expandPrompts.push(text);
      const sp = subplans[Math.min(expandN++, subplans.length - 1)]!;
      return { text: sp, usage: { in: 1, out: 1 } };
    }
    leafCalls.push(id);
    return { text: `out:${id}`, usage: { in: 1, out: 1 } };
  };
  const judgeSend = judgeSendOf(verdicts, (p) => {
    judgePrompts.push(p);
    judgeN++;
  });
  return { generate, judgeSend, expandPrompts, judgePrompts, leafCalls, expands: () => expandN, judges: () => judgeN };
}

const cfg = (
  generate: GenerateFn,
  resume = false,
  withContinuity = true,
  judgeSend?: ExecutorDagConfig['judgeSend'],
): ExecutorDagConfig => ({
  conductorModel: 'c:m',
  leafModel: 'l:m',
  generate,
  agentTemplates: new Map(),
  ...(judgeSend ? { judgeSend } : {}),
  ...(withContinuity ? { continuity: { manager, runId: RUN, repoRoot: root, ...(resume ? { resume: true } : {}) } } : {}),
});

const P1 = JSON.stringify({ name: 's', nodes: { impl: { goal: '实装' } } });
const P2 = JSON.stringify({ name: 's', nodes: { research: { goal: '先把事实查清楚' }, impl: { goal: '实装', depends_on: ['research'] } } });

describe('D-A 环 — 缺省不带环 (零回归)', () => {
  test('不写 max_rounds → 展开一次, **judge 一次都不调** (没有下一轮, 判了也白判)', async () => {
    const f = fake([P1], [{ converged: true }]);
    const r = await runExecutorDagWithPlan(node(), cfg(f.generate, false, true, f.judgeSend));
    expect(f.expands()).toBe(1);
    expect(f.judges()).toBe(0);
    expect(r.results.C?.status).toBe('done');
  });

  test('max_rounds:1 显式也一样 (与缺省同语义)', async () => {
    const f = fake([P1], [{ converged: false }]);
    await runExecutorDagWithPlan(node({ max_rounds: 1 }), cfg(f.generate, false, true, f.judgeSend));
    expect(f.judges()).toBe(0);
  });
});

describe('D-A 环 — 逐轮**重展开**, 这是补调研的机制', () => {
  test('未收敛 → 再展开一次, 且上一轮的失败原因回灌进展开 prompt', async () => {
    const f = fake([P1, P2], [{ converged: false, failureReason: '缺少外部事实支撑' }, { converged: true }]);
    const r = await runExecutorDagWithPlan(node({ max_rounds: 3 }), cfg(f.generate, false, true, f.judgeSend));
    expect(f.expands()).toBe(2); // 重新画了, 不是重跑
    expect(f.judges()).toBe(2);
    // 第 2 次展开的 prompt 里带着上一轮的败因 + "重新分解"的指令。
    expect(f.expandPrompts[1]).toContain('缺少外部事实支撑');
    expect(f.expandPrompts[1]).toContain('重新分解');
    expect(r.results.C?.status).toBe('done');
  });

  test('**补调研**: 第 2 轮的子图可以含一个第 1 轮压根没有的步骤 (不需要回边)', async () => {
    const f = fake([P1, P2], [{ converged: false, failureReason: '没有外部证据' }, { converged: true }]);
    await runExecutorDagWithPlan(node({ max_rounds: 3 }), cfg(f.generate, false, true, f.judgeSend));
    // 第 1 轮只有 impl; 第 2 轮多出一个"先把事实查清楚"的步骤 —— 这正是「补调研」的形状。
    const goalsRun = f.leafCalls.length;
    expect(goalsRun).toBe(1 + 2); // 轮1: 1 个; 轮2: 2 个
  });

  test('收敛即停 (不跑满 max_rounds)', async () => {
    const f = fake([P1], [{ converged: true }]);
    await runExecutorDagWithPlan(node({ max_rounds: 4 }), cfg(f.generate, false, true, f.judgeSend));
    expect(f.expands()).toBe(1);
  });

  test('轮数用尽仍未收敛 → 返最后一轮结果, **不谎报收敛** (INV-GOAL-4 有界)', async () => {
    const f = fake([P1], [{ converged: false, failureReason: '还是不行' }]);
    const r = await runExecutorDagWithPlan(node({ max_rounds: 2 }), cfg(f.generate, false, true, f.judgeSend));
    expect(f.expands()).toBe(2); // 跑满两轮
    expect(r.results.C).toBeTruthy();
  });

  test('judge 吐不出结构化裁决 → fail-closed 判未收敛 (不当作"那就算过了吧")', async () => {
    const generate: GenerateFn = async (req) => {
      const user = req.messages.find((m) => m.role === 'user');
      const text = typeof user?.content === 'string' ? user.content : '';
      if (!leafId(text)) return { text: P1, usage: { in: 1, out: 1 } };
      return { text: 'ok', usage: { in: 1, out: 1 } };
    };
    // schema 没解析出东西 (parsed 缺席) —— 外层判官对这种回 `judge 未结构化输出` 的未收敛。
    const judgeSend = (async () => ({ text: '我觉得挺好的', usage: { in: 1, out: 1 } })) as never;
    await runExecutorDagWithPlan(node({ max_rounds: 2 }), cfg(generate, false, true, judgeSend));
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
    await runExecutorDagWithPlan(node({ max_rounds: 3 }), cfg(f.generate, false, true, f.judgeSend));
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
      if (!leafId(text)) {
        expandN++;
        if (expandN === 2) {
          journalAtRound2 = JSON.parse(readFileSync(join(runDir(), '_loop-C.json'), 'utf-8')) as NodeLoopJournal;
        }
        return { text: P1, usage: { in: 1, out: 1 } };
      }
      return { text: 'ok', usage: { in: 1, out: 1 } };
    };
    await runExecutorDagWithPlan(
      node({ max_rounds: 2 }),
      cfg(generate, false, true, judgeSendOf([{ converged: false, failureReason: 'r1 不行' }])),
    );
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
    await runExecutorDagWithPlan(node({ max_rounds: 3 }), cfg(f.generate, true, true, f.judgeSend));
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
    const r = await runExecutorDagWithPlan(node({ max_rounds: 3 }), cfg(f.generate, true, true, f.judgeSend));
    expect(f.expands()).toBe(0);
    expect(f.judges()).toBe(0);
    expect(r.results.C?.output).toBe('[上次的结论]');
  });

  test('不带 continuity 也能跑环 (journal 是可选增强, 不是运行前提)', async () => {
    const f = fake([P1, P1], [{ converged: false }, { converged: true }]);
    const r = await runExecutorDagWithPlan(node({ max_rounds: 3 }), cfg(f.generate, false, false, f.judgeSend));
    expect(f.expands()).toBe(2);
    expect(r.results.C?.status).toBe('done');
    expect(existsSync(runDir())).toBe(false);
  });
});

describe('D-21 内环版 — 跨轮复用 (环搬进节点后一度丢了这条)', () => {
  const SUB3 = JSON.stringify({ name: 's', nodes: { a: { goal: 'A' }, b: { goal: 'B' }, c: { goal: 'C' } } });

  /** 逐轮同一份子图 + 逐轮裁决; 回收 leaf 调用。裁决里的 rejectedNodes 用**下标**, 跑时翻成真 id。 */
  function loopFake(verdicts: Array<{ converged: boolean; failureReason?: string; rejectedNodes?: number[] }>, sub = SUB3) {
    const leafCalls: string[] = [];
    const generate: GenerateFn = async (req) => {
      const u = req.messages.find((m) => m.role === 'user');
      const t = typeof u?.content === 'string' ? u.content : '';
      const id = leafId(t);
      if (!id) return { text: sub, usage: { in: 1, out: 1 } };
      leafCalls.push(id);
      return { text: `out:${id}`, usage: { in: 1, out: 1 } };
    };
    let n = 0;
    const judgeSend = (async (req: { messages: { content: string }[] }) => {
      // 从 judge 视图里抠出本轮可点名的 id (`### C::xxx [状态]`), 好让下标裁决点得中。
      const ids = [...String(req.messages[0]?.content ?? '').matchAll(/### (C::[\w-]+)/g)].map((m) => m[1]!);
      const v = verdicts[Math.min(n++, verdicts.length - 1)]!;
      const parsed = {
        converged: v.converged,
        score: v.converged ? 1 : 0,
        failureReason: v.failureReason,
        rejectedNodes: (v.rejectedNodes ?? []).map((i) => ids[i]!).filter(Boolean),
      };
      return { text: JSON.stringify(parsed), parsed, usage: { in: 1, out: 1 } };
    }) as never;
    return { generate, judgeSend, leafCalls };
  }

  test('第 2 轮语义没变的子节点**零 LLM 复用**上轮输出 (3 个子节点两轮 = 3 次调用, 不是 6 次)', async () => {
    const f = loopFake([{ converged: false, failureReason: '再想想' }, { converged: true }]);
    await runExecutorDagWithPlan(node({ max_rounds: 2 }), cfg(f.generate, false, true, f.judgeSend));
    expect(f.leafCalls).toHaveLength(3);
  });

  test('被 judge 点名的子节点**必须重跑**, 不许被复用抵消掉 (毒集优先于复用)', async () => {
    const f = loopFake([{ converged: false, failureReason: '第一个是编的', rejectedNodes: [0] }, { converged: true }]);
    await runExecutorDagWithPlan(node({ max_rounds: 2 }), cfg(f.generate, false, true, f.judgeSend));
    expect(f.leafCalls).toHaveLength(4); // 3 (轮1) + 1 (轮2 只重跑被毒那个)
  });

  test('复用不跨越"上游要重跑"这条线 (前驱重跑 → 下游吃到的输入变了, 也得重跑)', async () => {
    const CHAIN = JSON.stringify({ name: 's', nodes: { a: { goal: 'A' }, b: { goal: 'B', depends_on: ['a'] } } });
    // 点名**上游** a —— judge 视图按**子图拓扑序**排 (上游在前), 故 a 排第一。
    // ⚠ 这个"故"是 2026-07-30 才成立的: 此前视图顺序是人看的摘要那句 `sort` **原地**留下的
    // 副作用 = 按内容寻址 id 的字典序 = 哈希序, 谁在前面纯属偶然 (给指纹加一个字段就翻了个个儿)。
    const f = loopFake([{ converged: false, failureReason: 'a 是编的', rejectedNodes: [0] }, { converged: true }], CHAIN);
    await runExecutorDagWithPlan(node({ max_rounds: 2 }), cfg(f.generate, false, true, f.judgeSend));
    // 轮1 跑 2 个; 轮2 上游被毒重跑, 下游因"前驱不可复用"也重跑 → 共 4 次。
    expect(f.leafCalls).toHaveLength(4);
  });
});

// ── D-F (2026-07-30): 撤外层 fixpoint 之后, 内环要补上三样原属外层的东西 ─────────────
//
// ① 裁决出得来 (`judge_final` → LeafResult.converged) —— 否则没有任何一层再问「整体目标成了吗」;
// ② 轮级 conductor 升级 —— "多轮不收敛就换更强的脑子"这个能力原先只活在外层;
// ③ 审计 checkpoint —— 子树碰过的文件此前只活在内存里, 崩了就没。

describe('D-F — 终轮必判 (judge_final): 撤外层之后裁决的唯一出口', () => {
  test('缺省不判 → leaf 上**没有** converged (缺席 ≠ 未收敛, 是"没人判过")', async () => {
    const f = fake([P1], [{ converged: true }]);
    const r = await runExecutorDagWithPlan(node({ max_rounds: 1 }), cfg(f.generate, false, true, f.judgeSend));
    expect(f.judges()).toBe(0);
    expect(r.results.C?.converged).toBeUndefined();
    expect(r.results.C?.rounds).toBe(1);
  });

  test('judge_final + max_rounds:1 → 判一次, 裁决盖在 leaf 上 (单轮档也拿得到答案)', async () => {
    const f = fake([P1], [{ converged: true }]);
    const r = await runExecutorDagWithPlan(node({ max_rounds: 1, judge_final: true }), cfg(f.generate, false, true, f.judgeSend));
    expect(f.judges()).toBe(1);
    expect(f.expands()).toBe(1); // 判完没有下一轮可去
    expect(r.results.C?.converged).toBe(true);
  });

  test('judge_final 判未收敛 → converged=false 如实带出 (单轮档不因"跑完了"就算成)', async () => {
    const f = fake([P1], [{ converged: false, failureReason: '产出是编的' }]);
    const r = await runExecutorDagWithPlan(node({ max_rounds: 1, judge_final: true }), cfg(f.generate, false, true, f.judgeSend));
    expect(r.results.C?.converged).toBe(false);
  });

  test('多轮跑满仍未收敛 → converged=false + rounds=实跑轮数 (不谎报收敛)', async () => {
    const f = fake([P1], [{ converged: false, failureReason: '还是不行' }]);
    const r = await runExecutorDagWithPlan(node({ max_rounds: 2, judge_final: true }), cfg(f.generate, false, true, f.judgeSend));
    expect(r.results.C?.converged).toBe(false);
    expect(r.results.C?.rounds).toBe(2);
  });

  test('多轮收敛 → converged=true + rounds=收敛在第几轮 (收敛即停)', async () => {
    const f = fake([P1, P1], [{ converged: false, failureReason: 'r1' }, { converged: true }]);
    const r = await runExecutorDagWithPlan(node({ max_rounds: 4, judge_final: true }), cfg(f.generate, false, true, f.judgeSend));
    expect(r.results.C?.converged).toBe(true);
    expect(r.results.C?.rounds).toBe(2);
  });

  test('journal 已收敛 → resume 直接返上次结论时也带裁决 (resume 路径不掉字段)', async () => {
    manager.writeNodeLoopJournal(RUN, {
      runId: RUN, nodeId: 'C', completedRounds: 2, poisoned: [],
      converged: true, lastOutput: '[上次的结论]', updatedAt: '2026-07-30T00:00:00Z', schemaVersion: 1,
    });
    const f = fake([P1], [{ converged: true }]);
    const r = await runExecutorDagWithPlan(node({ max_rounds: 3, judge_final: true }), cfg(f.generate, true, true, f.judgeSend));
    expect(r.results.C?.converged).toBe(true);
    expect(r.results.C?.rounds).toBe(2);
  });
});

describe('D-F — 审计 checkpoint: 落盘但**永不**用于 resume-skip', () => {
  test('conductor 节点落一份绿 checkpoint (子树干了什么, 崩了之后还查得到)', async () => {
    const f = fake([P1], [{ converged: true }]);
    await runExecutorDagWithPlan(node(), cfg(f.generate, false, true, f.judgeSend));
    const cp = manager.loadCheckpoint(RUN, 'C');
    expect(cp).toBeTruthy();
    expect(cp!.leafKind).toBe('conductor');
    expect(cp!.status).toBe('done');
  });

  test('有绿 checkpoint 也照样重新展开 —— 纪律: conductor 节点永不整体 resume-skip', async () => {
    const f1 = fake([P1], [{ converged: true }]);
    await runExecutorDagWithPlan(node(), cfg(f1.generate, false, true, f1.judgeSend));
    expect(manager.loadCheckpoint(RUN, 'C')).toBeTruthy();
    // 同一个 runId 开 resume 再跑: 若 checkpoint 被当成"已绿可跳", 展开次数会是 0。
    const f2 = fake([P1], [{ converged: true }]);
    const r = await runExecutorDagWithPlan(node(), cfg(f2.generate, true, true, f2.judgeSend));
    expect(f2.expands()).toBe(1);
    expect(r.results.C?.skipped).toBeFalsy();
  });

  test('环没收敛就崩 → 没有绿 checkpoint, 但毒集仍在 journal 里 (两份状态各司其职)', async () => {
    const f = fake([P1], [{ converged: false, failureReason: '不行' }]);
    // 全轮未收敛但子节点跑成了 → 节点 status 仍是 done, 所以这里换个角度证:
    // journal 是每轮判完就写的, checkpoint 是节点定局才写的 —— 前者的轮次一定 ≥ 后者的存在性。
    await runExecutorDagWithPlan(node({ max_rounds: 2 }), cfg(f.generate, false, true, f.judgeSend));
    const j = JSON.parse(readFileSync(join(runDir(), '_loop-C.json'), 'utf-8')) as NodeLoopJournal;
    expect(j.completedRounds).toBe(2);
    expect(j.converged).toBeFalsy();
  });
});

describe('D-F — 轮级 conductor 升级 (原属外层 fixpoint 的能力, 不能跟着外层一起撤掉)', () => {
  // 升级闸要求 provider 已注册 (escalationProviderReady) → 注册假 provider, 零真调用。
  registerProvider('escl', { baseUrl: 'http://127.0.0.1:9', apiKey: 'test-key', api: 'openai-compatible' });

  /** 回收每次**展开**用的坐标 (leaf 调用不算)。 */
  function modelSpy() {
    const expandModels: string[] = [];
    const generate: GenerateFn = async (req) => {
      const user = req.messages.find((m) => m.role === 'user');
      const text = typeof user?.content === 'string' ? user.content : '';
      if (!leafId(text)) {
        expandModels.push(String((req as { model?: string }).model));
        return { text: P1, usage: { in: 1, out: 1 } };
      }
      return { text: 'ok', usage: { in: 1, out: 1 } };
    };
    return { generate, expandModels };
  }

  test('第 1 轮弱 conductor, 第 2 轮起换升级坐标重画 (画不出来的图再画一遍多半还是画不出来)', async () => {
    const m = modelSpy();
    await runExecutorDagWithPlan(node({ max_rounds: 3 }), {
      ...cfg(m.generate, false, true, judgeSendOf([{ converged: false, failureReason: 'r1' }, { converged: true }])),
      conductorEscalationModel: 'escl:strong',
    });
    expect(m.expandModels).toEqual(['c:m', 'escl:strong']);
  });

  test('escalateAfterRound 可调 (旋钮与外层共用一个, 两处各写一份默认值就会漂)', async () => {
    const m = modelSpy();
    await runExecutorDagWithPlan(node({ max_rounds: 3 }), {
      ...cfg(m.generate, false, true, judgeSendOf([{ converged: false }, { converged: false }, { converged: true }])),
      conductorEscalationModel: 'escl:strong',
      escalateAfterRound: 3,
    });
    expect(m.expandModels).toEqual(['c:m', 'c:m', 'escl:strong']);
  });

  test('升级坐标的 provider 没注册 → 维持弱 conductor (没配 API key 就别假装能升)', async () => {
    const m = modelSpy();
    await runExecutorDagWithPlan(node({ max_rounds: 2 }), {
      ...cfg(m.generate, false, true, judgeSendOf([{ converged: false }, { converged: true }])),
      conductorEscalationModel: 'nope-not-registered:strong',
    });
    expect(m.expandModels).toEqual(['c:m', 'c:m']);
  });

  test('节点显式钉了 model → 升级压不过它 (TPL-3 显式最高优先)', async () => {
    const m = modelSpy();
    await runExecutorDagWithPlan(node({ max_rounds: 2, model: 'pinned:x' }), {
      ...cfg(m.generate, false, true, judgeSendOf([{ converged: false }, { converged: true }])),
      conductorEscalationModel: 'escl:strong',
    });
    expect(m.expandModels).toEqual(['pinned:x', 'pinned:x']);
  });
});

describe('D-F — 环的信息通道: 失败子节点的败因不许在环里丢掉', () => {
  /** 一个子节点跑成、一个子节点失败 (leaf 抛 → 引擎记 failed 并把原因写进 output)。 */
  const SUB2 = JSON.stringify({ name: 's', nodes: { good: { goal: '好的那步' }, bad: { goal: '坏的那步' } } });

  test('judge 视图里带得到败因原文 (只给 `[failed]` 会让 judge 自己编猜测)', async () => {
    const judgeViews: string[] = [];
    const generate: GenerateFn = async (req) => {
      const user = req.messages.find((m) => m.role === 'user');
      const text = typeof user?.content === 'string' ? user.content : '';
      const id = leafId(text);
      if (!id) return { text: SUB2, usage: { in: 1, out: 1 } };
      // 子节点 id 后缀是内容寻址的哈希, 认不出原名 → 靠 goal 正文分辨哪一步。
      if (text.includes('坏的那步')) throw new Error('产物校验失败: filesTouched 空 — leaf 自报完成但未写文件');
      return { text: 'ok', usage: { in: 1, out: 1 } };
    };
    await runExecutorDagWithPlan(
      node({ max_rounds: 1, judge_final: true }),
      cfg(generate, false, true, judgeSendOf([{ converged: false, failureReason: 'x' }], (p) => judgeViews.push(p))),
    );
    expect(judgeViews).toHaveLength(1);
    expect(judgeViews[0]).toContain('产物校验失败');
    expect(judgeViews[0]).toContain('filesTouched 空');
  });

  test('下游/审计那份 output 同样带得到 (崩了之后查得出是哪一步为什么坏)', async () => {
    const generate: GenerateFn = async (req) => {
      const user = req.messages.find((m) => m.role === 'user');
      const text = typeof user?.content === 'string' ? user.content : '';
      if (!leafId(text)) return { text: SUB2, usage: { in: 1, out: 1 } };
      if (text.includes('坏的那步')) throw new Error('某个很确切的败因');
      return { text: 'ok', usage: { in: 1, out: 1 } };
    };
    const r = await runExecutorDagWithPlan(node(), cfg(generate, false, true));
    expect(r.results.C?.output).toContain('某个很确切的败因');
  });
});

/**
 * **judge 调不通 ≠ 未收敛**(2026-07-31,一次真跑烧了 65 分钟换来的)。
 *
 * 那一跑里 judge 座位在 codex 上恒抛 `Unsupported parameter: temperature`。此前这条路与
 * 「judge 判词解析不了」走同一个出口:都落 `converged:false` 然后**继续转下一轮** ——
 * 而下一轮的 judge 会以完全相同的方式再抛一次。于是一个改配置一分钟能修的事,
 * 烧掉了全部轮数,症状看起来像「任务太难,一直在修」。
 *
 * 分界取 `ModelError`(仓里既有的传输/配置错类),不靠猜错误文本:
 * 传输/配置层的故障是**确定性**的,再转多少轮都一样;判词解析不了则可能下一轮就好了。
 */
describe('judge 调不通 → infra-error 提前退环', () => {
  const modelErrJudge = (): NonNullable<ExecutorDagConfig['judgeSend']> =>
    (async () => {
      throw new ModelError('transport', 'pi: Codex error: Unsupported parameter: temperature');
    }) as never;

  test('★ 第 1 轮就退,不烧剩余轮数 —— 展开只发生一次', async () => {
    const f = fake([P1], []);
    const res = await runExecutorDagWithPlan(node({ max_rounds: 3 }), cfg(f.generate, false, true, modelErrJudge()));
    // 关键读数: max_rounds=3 而展开只跑了 1 次。此前会跑满 3 次。
    expect(f.expands()).toBe(1);
    expect(res.results.C!.converged).toBe(false); // fail-closed 不变: 判不出来绝不当成过了
    expect(res.results.C!.infraStopped).toContain('Unsupported parameter: temperature');
  });

  test('★ journal 记下 infra-error 与判词原文 —— 而不是 blocked', async () => {
    const f = fake([P1], []);
    await runExecutorDagWithPlan(node({ max_rounds: 3 }), cfg(f.generate, false, true, modelErrJudge()));
    const j = JSON.parse(readFileSync(join(runDir(), '_loop-C.json'), 'utf-8')) as NodeLoopJournal;
    // N5 词表里这两格的**下一步相反**: blocked 是"要人给外部输入", infra-error 是"引擎该修"。
    expect(j.stop?.kind).toBe('infra-error');
    expect(j.stop?.evidence).toContain('judge 调不通');
    expect(j.stop?.atRound).toBe(1);
  });

  test('判词只是解析不了 (非 ModelError) → 保持原行为, 继续转', async () => {
    // 这一条守的是**不要修过头**: 模型这一发没说清楚, 下一轮可能就好了, 不该也提前退。
    const f = fake([P1], []);
    const flaky = (async () => {
      throw new Error('判词 JSON 解析失败');
    }) as never;
    const res = await runExecutorDagWithPlan(node({ max_rounds: 3 }), cfg(f.generate, false, true, flaky));
    expect(f.expands()).toBe(3); // 跑满
    expect(res.results.C!.infraStopped).toBeUndefined();
  });

  /**
   * 2026-08-16 订正 —— **上面那句「分界取 `ModelError`」与它自己的意图相反**。
   *
   * `ModelError` 不是"传输/配置错类": kind 有六个 (`model/index.ts`),
   * `invalid JSON` 抛的是 `ModelError('parse')`、schema 不合抛 `ModelError('validation')` ——
   * 正是上一条测试说"不该提前退"的那一类。它只因为**碰巧不是 ModelError**(裸 `Error`)才没红。
   * 换句话说: 上一条守的是"裸 Error 不退", 而真实的 parse 失败一直在走提前退那条路。
   *
   * 打亮它的是把 gate 座位换到 M3 (owner 2026-08-15 裁): flash 上这一格 0/120 从没亮过,
   * M3 关思考实测 1/60 (`.omd/eval/gate-m3`)。
   *
   * 分界改成**可重试性** (`isTransientModelFault`), 复用熔断已有的 `isProviderFault`,
   * 不新造第二份分类表。⚠ `transport` 仍算确定性 —— 它是 `index.ts` 的**未分类兜底桶**
   * (任何非 ModelError 的 provider 抛错都落这儿, 含 codex 那个确定性 400), 当瞬时就退回 65 分钟。
   */
  const kindJudge = (err: ModelError): NonNullable<ExecutorDagConfig['judgeSend']> =>
    (async () => {
      throw err;
    }) as never;

  test("★ ModelError('parse') 判词解析不了 → 不提前退环 (下一轮可能就好)", async () => {
    // 真实的 parse 失败每轮文本不同 (错误里带随输出变的 token), 于是也不会撞上闸级熔断。
    const f = fake([P1], []);
    const res = await runExecutorDagWithPlan(
      node({ max_rounds: 3 }),
      cfg(f.generate, false, true, streakJudge((n) => new ModelError('parse', `invalid JSON: Unrecognized token '无${n}'`))),
    );
    expect(f.expands()).toBe(3); // 跑满, 不提前退
    expect(res.results.C!.infraStopped).toBeUndefined();
  });

  test('★ http provider-fault (MiniMax base_resp 1000 瞬时) → 第 1 轮不退', async () => {
    // minimax-native 把**业务码**塞进 status (1000 = unknown error, 官方处置"稍后再试"),
    // 于是它落进 `isProviderFault` 的 `s >= 500` 那一支 —— 瞬时, 不该在第 1 轮就终止内环。
    // ⚠ 断言只守**第 1 轮**: 1000 的文本每轮相同, 第 2 轮起由闸级熔断正当接管 (见下面那条)。
    // 改动前这里是 1 (第 1 轮就退), 所以这条仍然证伪得了旧判据。
    const f = fake([P1], []);
    await runExecutorDagWithPlan(
      node({ max_rounds: 3 }),
      cfg(f.generate, false, true, kindJudge(new ModelError('http', 'minimax: base_resp 1000 unknown error', { status: 1000 }))),
    );
    expect(f.expands()).toBeGreaterThanOrEqual(2);
  });

  /**
   * **闸级熔断** (2026-08-16) —— §8.4 那条原则的第三个粒度。
   *
   * 上面按 kind 分的判据有个够不着的角: 一个**确定性**故障如果碰巧落在"瞬时"那一类里,
   * 就会每轮重来一次直到轮数烧光。实例: `minimax-native` 把业务码塞进 `status`, 而业务码
   * 全 ≥ 1000 → 鉴权失败 (1004) / 无效 key (2049) 一律落进 `s >= 500` 那支被判成瞬时。
   * 按 kind 猜不出来 —— 但**转一轮量一量**就知道。
   *
   * 判据沿用仓里既有的那条(轮级 D-Q、动作级 §8.4 都是它): **「相同」而不是「重复」**。
   *   逐字相同 → 这一格零位移 → 确定性, 退环
   *   文本在变 → 事情在动 (模型换了说法) → 继续转
   *
   * 为什么这个键在这里正好合适, 不用调:
   *   · 坏 key: 每轮逐字相同 → 第 2 轮退 ✅
   *   · 瞬时 1000: 文本也相同, 但连续两轮的概率 ≈ 0.017² ≈ 0.03% (`.omd/eval/gate-m3` 实测
   *     M3 关思考 1/60), 几乎不会误伤; 真连挂两次, 停下来也是对的
   *   · parse 抖动: 错误里带 `Unrecognized token '无'` 这类**随输出变**的片段 → 文本不同 → 继续 ✅
   */
  const streakJudge = (mk: (n: number) => ModelError): NonNullable<ExecutorDagConfig['judgeSend']> => {
    let n = 0;
    return (async () => {
      throw mk(++n);
    }) as never;
  };

  test('★ 瞬时类但**逐字相同** (坏 key 1004 每轮同一句) → 第 2 轮退环, infra-error', async () => {
    const f = fake([P1], []);
    const res = await runExecutorDagWithPlan(
      node({ max_rounds: 3 }),
      cfg(f.generate, false, true, streakJudge(() => new ModelError('http', 'minimax: base_resp 1004 鉴权失败', { status: 1004 }))),
    );
    expect(f.expands()).toBe(2); // 转一轮量出"零位移", 第 2 轮退 —— 不烧满 3 轮
    expect(res.results.C!.infraStopped).toContain('1004');
    const j = JSON.parse(readFileSync(join(runDir(), '_loop-C.json'), 'utf-8')) as NodeLoopJournal;
    expect(j.stop?.kind).toBe('infra-error'); // 不是 blocked: 该修的是凭证/引擎, 不是"等人给输入"
  });

  test('对照: 同类错但**每轮文本不同** (parse 的 token 在变) → 跑满, 不退 (别修过头)', async () => {
    const f = fake([P1], []);
    const res = await runExecutorDagWithPlan(
      node({ max_rounds: 3 }),
      cfg(f.generate, false, true, streakJudge((n) => new ModelError('parse', `invalid JSON: Unrecognized token '第${n}个'`))),
    );
    expect(f.expands()).toBe(3);
    expect(res.results.C!.infraStopped).toBeUndefined();
  });

  /**
   * **失效矩阵** (2026-08-16) —— 六个 kind + 两个显式表态, 一格一行, 谁都不许静默改归属。
   *
   * 为什么要一张表而不是几条散测: S-40 的病根就是「注释把两类分开了, 判据把两类合并了」,
   * 而当时**这一格是有测试的**(只是夹具注入裸 `Error`, 与生产真抛的 `ModelError` 对不上)。
   * 一张穷尽的表让"某一格悄悄换了边"当场可见 —— 散测只保证被点到的那几格。
   *
   * 每行的错误文本都带轮次(`#n`)以避开闸级熔断, 这一格由它自己的两条测试守。
   */
  const FAULT_MATRIX: ReadonlyArray<{ 名: string; mk: (n: number) => ModelError; 展开: number }> = [
    // ── 确定性: 第 1 轮就退, 不烧剩余轮数 ────────────────────────────────────────
    { 名: 'config (坐标错/缺凭证)', mk: (n) => new ModelError('config', `no creds #${n}`), 展开: 1 },
    { 名: 'transport (未分类兜底桶, 含 codex 那个确定性 400)', mk: (n) => new ModelError('transport', `pi: Codex error #${n}`), 展开: 1 },
    { 名: 'http 400 (请求错, 非 provider-fault)', mk: (n) => new ModelError('http', `bad request #${n}`, { status: 400 }), 展开: 1 },
    { 名: "显式 transient:false 压过 kind (坏 key)", mk: (n) => new ModelError('http', `base_resp 1004 #${n}`, { fault: 'provider', transient: false }), 展开: 1 },
    { 名: "fault:'request' 且不瞬时 (参数错)", mk: (n) => new ModelError('http', `invalid params #${n}`, { fault: 'request', transient: false }), 展开: 1 },
    // ── 瞬时: 跑满, 下一轮可能就好 ───────────────────────────────────────────────
    { 名: 'parse (invalid JSON)', mk: (n) => new ModelError('parse', `invalid JSON #${n}`), 展开: 3 },
    { 名: 'validation (schema 不合)', mk: (n) => new ModelError('validation', `schema failed #${n}`), 展开: 3 },
    { 名: 'truncation (推理吃光预算)', mk: (n) => new ModelError('truncation', `truncated #${n}`), 展开: 3 },
    { 名: 'http 429 (限流)', mk: (n) => new ModelError('http', `rate limited #${n}`, { status: 429 }), 展开: 3 },
    { 名: 'http 503 (provider 5xx)', mk: (n) => new ModelError('http', `unavailable #${n}`, { status: 503 }), 展开: 3 },
    { 名: '显式 transient:true 压过 kind (config 也能被判瞬时)', mk: (n) => new ModelError('config', `weird #${n}`, { transient: true }), 展开: 3 },
    { 名: "fault:'request' 但瞬时 (涉敏, 下一轮内容不同)", mk: (n) => new ModelError('http', `sensitive #${n}`, { fault: 'request', transient: true }), 展开: 3 },
  ];

  for (const row of FAULT_MATRIX) {
    test(`矩阵: ${row.名} → 展开 ${row.展开} 次`, async () => {
      const f = fake([P1], []);
      const res = await runExecutorDagWithPlan(node({ max_rounds: 3 }), cfg(f.generate, false, true, streakJudge(row.mk)));
      expect(f.expands()).toBe(row.展开);
      // 提前退的那些必须报 infra-error (引擎/配置该修), 不是 blocked (等人给输入) —— N5 词表。
      if (row.展开 < 3) {
        expect(res.results.C!.infraStopped).toBeTruthy();
        const j = JSON.parse(readFileSync(join(runDir(), '_loop-C.json'), 'utf-8')) as NodeLoopJournal;
        expect(j.stop?.kind).toBe('infra-error');
      } else {
        expect(res.results.C!.infraStopped).toBeUndefined();
      }
    });
  }

  test('对照: http 400 请求错 → 仍提前退环 (别修过头)', async () => {
    // 4xx 非 provider-fault = 确定性请求错, 再转多少轮都同样抛 —— 这一格必须保持原行为。
    const f = fake([P1], []);
    const res = await runExecutorDagWithPlan(
      node({ max_rounds: 3 }),
      cfg(f.generate, false, true, kindJudge(new ModelError('http', 'bad request: unsupported parameter', { status: 400 }))),
    );
    expect(f.expands()).toBe(1);
    expect(res.results.C!.infraStopped).toContain('unsupported parameter');
  });
});

/**
 * **子图节点也要发 span**(2026-07-31)。
 *
 * 此前只有外层 settle 循环调 `recordSpan`,而运行时展开出来的子节点走的是 conductor 内环 ——
 * 于是它们在观测面上只有 generation、没有 span,而 generation 又按 nodeId 挂在那个不存在的
 * span 上 → **全成孤儿**。实测一次 goal:13 条 observation 里 10 条孤儿、只有 1 个 span,
 * 「一条 trace 打开是整张图的形状」这句话对 goal 路径基本不成立。
 */
describe('子图节点的 span', () => {
  const LF = { LANGFUSE_HOST: 'http://127.0.0.1:9', LANGFUSE_PUBLIC_KEY: 'pk', LANGFUSE_SECRET_KEY: 'sk' };

  test('★ 内环里展开的每个子节点都有自己的 span (否则它的 generation 是孤儿)', async () => {
    const prev = { ...process.env };
    Object.assign(process.env, LF);
    _resetLangfuseForTest();
    try {
      const f = fake([P2], [{ converged: true }]); // P2 有两个子节点: research → impl
      await runExecutorDagWithPlan(node({ max_rounds: 1, judge_final: true }), cfg(f.generate, false, true, f.judgeSend));
      const spans = _peekLangfuseQueue()
        .filter((e) => e.type === 'span-create')
        .map((e) => String((e.body as { name: string }).name));
      // 子节点 id 是内容寻址的 `C::<hash>`, 只断言"有属于 C 子树的 span"而不写死 hash。
      const childSpans = spans.filter((n) => n.includes('C::'));
      expect(childSpans.length).toBeGreaterThanOrEqual(2);
    } finally {
      _resetLangfuseForTest();
      for (const k of Object.keys(LF)) delete process.env[k];
      Object.assign(process.env, prev);
    }
  });
});

/**
 * **冻结判据进环**(2026-08-01)。此前它是环外节点(`accept`, depends_on: ['execute'])——
 * 必须先把轮数烧完,那道 30 秒就能判出来的确定性闸才第一次被问到。实测撞过更坏的一档:
 * judge 因配置错恒抛,环永远拿不到裁决,判据一次都没跑成,而它本可以在第 1 轮就判绿。
 *
 * 这一组钉的是**四条护栏**,缺任何一条这个改动都会造出比它解决的更难发现的问题。
 */
describe('冻结判据进环 (四条护栏)', () => {
  /** 假 command runner: 前 n 轮红, 之后绿。 */
  const freezeRunner = (greenFrom: number) => {
    let n = 0;
    return async () => ({ text: '', usage: { in: 0, out: 0 }, timedOut: false, signal: null, exitCode: ++n >= greenFrom ? 0 : 1 });
  };

  test('★ 判据绿 → 这一轮就是最后一轮, 不烧剩余轮数', async () => {
    const f = fake([P1], [{ converged: false, failureReason: 'judge 觉得还差点' }]);
    const res = await runExecutorDagWithPlan(node({ max_rounds: 3 }), {
      ...cfg(f.generate, false, true, f.judgeSend),
      commandRunner: freezeRunner(1) as never,
      freezeCriterion: { command: 'bun test', expectExit: 0 },
    });
    expect(f.expands()).toBe(1); // max_rounds=3 而只展开一次
    expect(res.results.C!.converged).toBe(true); // D-I: 以判据为准
  });

  test('★ 护栏② 判据绿时**仍然问了一次 judge**, 且它那一票单独带出来', async () => {
    // 不问的话「judge 太紧」(判据过了而 judge 说没成) 永远观测不到 —— 从另一头杀掉判据轴。
    const f = fake([P1], [{ converged: false, failureReason: 'judge 说没成' }]);
    const res = await runExecutorDagWithPlan(node({ max_rounds: 3 }), {
      ...cfg(f.generate, false, true, f.judgeSend),
      commandRunner: freezeRunner(1) as never,
      freezeCriterion: { command: 'bun test', expectExit: 0 },
    });
    expect(f.judges()).toBe(1); // 问过
    expect(res.results.C!.converged).toBe(true); // 判据说了算
    expect(res.results.C!.judgeConverged).toBe(false); // 而 judge 自己投的是反对 —— 正是那一格
  });

  test('★ 护栏① judge 的视野里没有判据结论 (否则它会抄答案)', async () => {
    const f = fake([P1], [{ converged: true }]);
    await runExecutorDagWithPlan(node({ max_rounds: 3 }), {
      ...cfg(f.generate, false, true, f.judgeSend),
      commandRunner: freezeRunner(1) as never,
      freezeCriterion: { command: 'bun test --coverage', expectExit: 0 },
    });
    // 判据的命令原文与"退出码符合预期"那句 facts 都不许出现在判词 prompt 里。
    const prompt = f.judgePrompts.join('\n');
    expect(prompt).not.toContain('bun test --coverage');
    expect(prompt).not.toContain('命令退出码符合预期');
  });

  test('判据红 → 照常转下一轮 (它只有"停"的权力, 没有"继续"的权力)', async () => {
    const f = fake([P1], [{ converged: false, failureReason: '还差' }]);
    const res = await runExecutorDagWithPlan(node({ max_rounds: 3 }), {
      ...cfg(f.generate, false, true, f.judgeSend),
      commandRunner: freezeRunner(99) as never, // 恒红
      freezeCriterion: { command: 'bun test', expectExit: 0 },
    });
    expect(f.expands()).toBe(3);
    expect(res.results.C!.converged).toBe(false);
  });

  test('★ 护栏④ 判据绿但 judge 调不通 → 仍按判据收敛, 但 journal 写明"只有一道闸"', async () => {
    const f = fake([P1], []);
    const dead = (async () => {
      throw new ModelError('transport', 'pi: Codex error: Unsupported parameter: temperature');
    }) as never;
    const res = await runExecutorDagWithPlan(node({ max_rounds: 3 }), {
      ...cfg(f.generate, false, true, dead),
      commandRunner: freezeRunner(1) as never,
      freezeCriterion: { command: 'bun test', expectExit: 0 },
    });
    expect(res.results.C!.converged).toBe(true);
    // judge 没投过票 ≠ 投了反对票 —— 缺席, 不编一个 false。
    expect(res.results.C!.judgeConverged).toBeUndefined();
    const j = JSON.parse(readFileSync(join(runDir(), '_loop-C.json'), 'utf-8')) as NodeLoopJournal;
    expect(j.stop?.kind).toBe('success');
    expect(j.stop?.evidence).toContain('只有一道闸');
  });

  test('没配 freezeCriterion → 逐字旧行为 (零回归)', async () => {
    const f = fake([P1], [{ converged: false, failureReason: '还差' }]);
    const res = await runExecutorDagWithPlan(node({ max_rounds: 2 }), cfg(f.generate, false, true, f.judgeSend));
    expect(f.expands()).toBe(2);
    expect(res.results.C!.judgeConverged).toBeUndefined();
  });
});
