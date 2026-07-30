/**
 * **批次 4** 的引擎侧: D-Q 检测者 (图内 fan-in + 图外观察者 + BLOCKED 出口) · D-P 协作式取消 ·
 * D-12 `filesRead` 观测 (制品 lint + 读毒) · 运行时展开回写观察面。
 *
 * 每一条都有一个"改坏了不会红"的失效形态, 这个文件就是冲那些形态去的:
 *  - 检测者的票**不进毒集** → 环下一轮照样在坏结果上盖 (静默);
 *  - BLOCKED **被读成失败或收敛** → 要么把该找人的事判死, 要么谎报成功;
 *  - 取消**顺手杀在飞节点** → 已跑完的东西保不住, "协作式"三个字就是空话;
 *  - 制品 lint 的发现**不进下一轮 prompt** → conductor 永远不知道自己少画了一条边;
 *  - 读毒漏掉消费方 → 读过被拒制品的节点被当成好结果复用 (D-12 的全部增量就在这);
 *  - 运行时子节点**并进 `_dag.json` 的 nodeIds/plan** → 下次 resume 代数对不上, 整图重跑。
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runExecutorDagWithPlan } from '../../src/harness/executor-dag';
import { CheckpointManager } from '../../src/harness/continuity/checkpoint-manager';
import { computeReuse } from '../../src/harness/plan-passes/semantic-key';
import type { ConductorPlan } from '../../src/harness/conductor-plan';
import type { DagNodeEvent, ExecutorDagConfig, GenerateFn, LeafResult } from '../../src/harness/executor-dag-types';
import type { DagMetadata } from '../../src/harness/continuity/types';

const RUN = 'b4-run';
let root: string;
let manager: CheckpointManager;
let saved: string | undefined;

beforeEach(() => {
  saved = process.env.OMD_DATA_HOME;
  delete process.env.OMD_DATA_HOME;
  root = mkdtempSync(join(tmpdir(), 'omd-b4-'));
  manager = new CheckpointManager(root);
});
afterEach(() => {
  if (saved === undefined) delete process.env.OMD_DATA_HOME;
  else process.env.OMD_DATA_HOME = saved;
  rmSync(root, { recursive: true, force: true });
});

const leafId = (p: string): string => /\[omd leaf: ([^\]]+)\]/.exec(p)?.[1] ?? '';
/** judge 视图里的 `### <id> [状态]` → id 列表 (顺序 = 子图拓扑序)。 */
const judgeIds = (prompt: string): string[] => [...prompt.matchAll(/### (\S+) \[/g)].map((m) => m[1]!);

const conductorPlan = (over: Record<string, unknown> = {}): ConductorPlan =>
  ({ name: 'outer', nodes: { C: { goal: '把这件事做完', executor: 'conductor', ...over } } }) as ConductorPlan;

const cfg = (over: Partial<ExecutorDagConfig> & { generate: GenerateFn }): ExecutorDagConfig =>
  ({
    conductorModel: 'c:m',
    leafModel: 'l:m',
    agentTemplates: new Map(),
    continuity: { manager, runId: RUN, repoRoot: root },
    ...over,
  }) as ExecutorDagConfig;

/** judgeSend fake: 每轮按 `pick` 决定拒谁 (拿到本轮 judge 视图里的真 id 列表)。 */
const judgeSendOf = (
  rounds: Array<{ converged: boolean; pick?: (ids: string[], prompt: string) => string[] }>,
  seen?: string[],
): NonNullable<ExecutorDagConfig['judgeSend']> => {
  let n = 0;
  return (async (req: { messages: { content: string }[] }) => {
    const prompt = String(req.messages[0]?.content ?? '');
    const r = rounds[Math.min(n, rounds.length - 1)]!;
    n++;
    seen?.push(prompt);
    const rejectedNodes = r.converged ? [] : (r.pick?.(judgeIds(prompt), prompt) ?? []);
    const v = { converged: r.converged, score: r.converged ? 1 : 0, failureReason: r.converged ? undefined : '还不行', rejectedNodes };
    return { text: JSON.stringify(v), parsed: v, usage: { in: 1, out: 1 } };
  }) as never;
};

// ── D-Q 图内检测者 ──────────────────────────────────────────────────────────

describe('D-Q 图内 fan-in 检测者', () => {
  /** 子图: work → check(detector, 依赖 work)。检测者按协议点名 work。 */
  const SUB = JSON.stringify({
    name: 's',
    nodes: {
      work: { goal: '干活' },
      check: { goal: '检查', detector: true, depends_on: ['work'] },
    },
  });

  /** 检测者 leaf 从自己 prompt 里的 `### <depId>` 拿到兄弟的真 id, 照协议点名它 (真检测者就是这么点)。 */
  const detectorGenerate = (opts: { reject?: boolean; blocked?: string } = {}): GenerateFn => async (req) => {
    const text = typeof req.messages.find((m) => m.role === 'user')?.content === 'string'
      ? (req.messages.find((m) => m.role === 'user')!.content as string)
      : '';
    const id = leafId(text);
    if (!id) return { text: SUB, usage: { in: 1, out: 1 } }; // 展开调用
    if (!text.includes('检测者输出协议')) return { text: `out:${id}`, usage: { in: 1, out: 1 } };
    const dep = /### (\S+)/.exec(text)?.[1] ?? '';
    const lines = ['分析完毕。'];
    if (opts.reject) lines.push(`REJECT: ${dep}`);
    if (opts.blocked) lines.push(`BLOCKED: ${opts.blocked}`);
    return { text: lines.join('\n'), usage: { in: 1, out: 1 } };
  };

  test('检测者 REJECT 兄弟 → 该子节点进毒集, 下一轮**必重跑** (不被跨轮复用)', async () => {
    const ran: string[] = [];
    const base = detectorGenerate({ reject: true });
    const generate: GenerateFn = async (req) => {
      const r = await base(req);
      const text = typeof req.messages.find((m) => m.role === 'user')?.content === 'string'
        ? (req.messages.find((m) => m.role === 'user')!.content as string)
        : '';
      const id = leafId(text);
      if (id) ran.push(id);
      return r;
    };
    // judge 一个都不点名 —— 于是"work 第二轮重跑了"只可能来自**检测者**的票。
    const r = await runExecutorDagWithPlan(
      conductorPlan({ max_rounds: 2, judge_final: true }),
      cfg({ generate, judgeSend: judgeSendOf([{ converged: false, pick: () => [] }, { converged: true }]) }),
    );
    const workRuns = ran.filter((id) => id.startsWith('C::') && !id.includes('undefined'));
    // 两轮各跑一次 work + 一次 check = 4 次 leaf 调用 (全被检测者的票逼着重跑)。
    expect(workRuns.length).toBe(4);
    expect(r.results.C?.status).toBe('done');
  });

  test('检测者 BLOCKED → 环**提前退出**: 不再重展开, leaf.blocked 有话, converged 恒 false', async () => {
    let expands = 0;
    const base = detectorGenerate({ blocked: '目标自相矛盾, 需要 owner 拍板' });
    const generate: GenerateFn = async (req) => {
      const text = typeof req.messages.find((m) => m.role === 'user')?.content === 'string'
        ? (req.messages.find((m) => m.role === 'user')!.content as string)
        : '';
      if (!leafId(text)) expands++;
      return base(req);
    };
    const r = await runExecutorDagWithPlan(
      conductorPlan({ max_rounds: 4, judge_final: true }),
      cfg({ generate, judgeSend: judgeSendOf([{ converged: false, pick: () => [] }]) }),
    );
    const leaf = r.results.C!;
    expect(leaf.blocked).toContain('需要 owner 拍板');
    expect(leaf.converged).toBe(false); // fail-closed: 阻塞绝不算收敛
    expect(expands).toBe(1); // 4 轮的预算, 只画了 1 次 —— 剩下 3 轮是纯烧钱
  });

  test('检测者装在**环外**的普通节点上 → 忽略 (环外没有消费者, 不静默当裁决用)', async () => {
    const plan = {
      name: 'flat',
      nodes: { a: { goal: '干活' }, d: { goal: '检查', detector: true, depends_on: ['a'] } },
    } as unknown as ConductorPlan;
    const generate: GenerateFn = async (req) => {
      const text = String(req.messages.find((m) => m.role === 'user')?.content ?? '');
      // 环外的 detector 节点不该拿到协议 (附了也没人读它的裁决 = 又一个"验证的样子")。
      expect(text).not.toContain('检测者输出协议');
      return { text: 'REJECT: a', usage: { in: 1, out: 1 } };
    };
    const r = await runExecutorDagWithPlan(plan, cfg({ generate }));
    expect(r.results.a?.status).toBe('done'); // 没被那句 REJECT 影响
    expect(r.results.d?.status).toBe('done');
  });
});

// ── D-Q 环空转 → BLOCKED ────────────────────────────────────────────────────

describe('D-Q 环空转 → BLOCKED (确定性判据)', () => {
  const SUB = JSON.stringify({ name: 's', nodes: { impl: { goal: '实装' } } });

  test('两轮画出同一张子图 + 拒的还是同一批 → BLOCKED, 不再烧剩下的轮', async () => {
    let expands = 0;
    const generate: GenerateFn = async (req) => {
      const text = String(req.messages.find((m) => m.role === 'user')?.content ?? '');
      const id = leafId(text);
      if (!id) {
        expands++;
        return { text: SUB, usage: { in: 1, out: 1 } };
      }
      return { text: `out:${id}`, usage: { in: 1, out: 1 } };
    };
    const r = await runExecutorDagWithPlan(
      conductorPlan({ max_rounds: 4, judge_final: true }),
      // 每轮都拒同一个 (唯一那个子节点), 而 conductor 每轮画的是同一张图 → 空转
      cfg({ generate, judgeSend: judgeSendOf([{ converged: false, pick: (ids) => ids }]) }),
    );
    const leaf = r.results.C!;
    expect(leaf.blocked).toContain('环空转');
    expect(leaf.converged).toBe(false);
    expect(expands).toBe(2); // 第 2 轮判出空转就停 —— 4 轮预算只用了 2 轮
    expect(r.observations?.some((o) => o.kind === 'loop-no-progress')).toBe(true);
  });

  test('每轮画出不同子图 → 不判空转 (环正在起作用, 该跑满就跑满)', async () => {
    const subs = [
      JSON.stringify({ name: 's', nodes: { a: { goal: '第一版' } } }),
      JSON.stringify({ name: 's', nodes: { b: { goal: '换个做法' } } }),
      JSON.stringify({ name: 's', nodes: { c: { goal: '再换' } } }),
    ];
    let expands = 0;
    const generate: GenerateFn = async (req) => {
      const text = String(req.messages.find((m) => m.role === 'user')?.content ?? '');
      const id = leafId(text);
      if (!id) return { text: subs[Math.min(expands++, subs.length - 1)]!, usage: { in: 1, out: 1 } };
      return { text: `out:${id}`, usage: { in: 1, out: 1 } };
    };
    const r = await runExecutorDagWithPlan(
      conductorPlan({ max_rounds: 3, judge_final: true }),
      cfg({ generate, judgeSend: judgeSendOf([{ converged: false, pick: (ids) => ids }]) }),
    );
    expect(r.results.C?.blocked).toBeUndefined();
    expect(expands).toBe(3); // 跑满 3 轮
  });
});

// ── D-12 filesRead 观测 + 制品 lint + 读毒 ──────────────────────────────────

describe('D-12 filesRead → 制品 lint (INV-P2-4) 与读毒 (INV-P2-5)', () => {
  /** 子图: 一个写 art.txt 的节点 + 一个读 art.txt 的节点, **图上刻意没有边**。 */
  const SUB = JSON.stringify({
    name: 's',
    nodes: {
      w: { goal: '写产物', executor: 'agent', output_type: 'file', output_path: 'art.txt' },
      r: { goal: '读产物再做事', executor: 'agent' },
    },
  });
  const isWriter = (prompt: string): boolean => prompt.includes('写产物');

  const genOf = (sub = SUB): GenerateFn => async (req) => {
    const text = String(req.messages.find((m) => m.role === 'user')?.content ?? '');
    const id = leafId(text);
    return id ? { text: `out:${id}`, usage: { in: 1, out: 1 } } : { text: sub, usage: { in: 1, out: 1 } };
  };

  const agentRunnerOf = (calls: string[]) => async ({ prompt }: { prompt: string }) => {
    const w = isWriter(prompt);
    calls.push(w ? 'w' : 'r');
    if (w) {
      writeFileSync(join(root, 'art.txt'), `产物 ${calls.length}\n`);
      return { text: 'WROTE', usage: { in: 1, out: 1 }, filesTouched: ['art.txt'], filesRead: [], cwd: root };
    }
    return { text: 'READ', usage: { in: 1, out: 1 }, filesTouched: [], filesRead: ['art.txt'], cwd: root };
  };

  test('filesRead 冒到 LeafResult + 落 checkpoint.inputPaths + resume 时还原', async () => {
    const calls: string[] = [];
    const r = await runExecutorDagWithPlan(
      conductorPlan(),
      cfg({ generate: genOf(), agentRunner: agentRunnerOf(calls) }),
    );
    const reader = Object.entries(r.results).find(([, v]) => v.output === 'READ')![1];
    expect(reader.filesRead).toEqual(['art.txt']);
    const cp = manager.loadCheckpoint(RUN, Object.entries(r.results).find(([, v]) => v.output === 'READ')![0]);
    expect(cp?.inputPaths).toEqual(['art.txt']);

    // resume: 该节点被当绿跳过, 观察面**不该因此变窄**。
    const calls2: string[] = [];
    const r2 = await runExecutorDagWithPlan(
      conductorPlan(),
      cfg({ generate: genOf(), agentRunner: agentRunnerOf(calls2), continuity: { manager, runId: RUN, repoRoot: root, resume: true } }),
    );
    const reader2 = Object.values(r2.results).find((v) => v.skipped && v.filesRead?.length);
    expect(reader2?.filesRead).toEqual(['art.txt']);
  });

  test('未声明的制品依赖 → 进 observations, 且**指名两个节点**', async () => {
    const calls: string[] = [];
    const r = await runExecutorDagWithPlan(conductorPlan(), cfg({ generate: genOf(), agentRunner: agentRunnerOf(calls) }));
    const o = r.observations?.find((x) => x.kind === 'undeclared-artifact-dep');
    expect(o).toBeDefined();
    expect(o!.nodes).toHaveLength(2);
    expect(o!.message).toContain('art.txt');
  });

  test('lint 的发现**进下一轮重展开的 prompt** (否则 conductor 永远不知道自己少画了边)', async () => {
    const calls: string[] = [];
    const expandPrompts: string[] = [];
    const generate: GenerateFn = async (req) => {
      const text = String(req.messages.find((m) => m.role === 'user')?.content ?? '');
      const id = leafId(text);
      if (id) return { text: `out:${id}`, usage: { in: 1, out: 1 } };
      expandPrompts.push(text);
      return { text: SUB, usage: { in: 1, out: 1 } };
    };
    await runExecutorDagWithPlan(
      conductorPlan({ max_rounds: 2, judge_final: true }),
      cfg({ generate, agentRunner: agentRunnerOf(calls), judgeSend: judgeSendOf([{ converged: false, pick: () => [] }, { converged: true }]) }),
    );
    expect(expandPrompts).toHaveLength(2);
    expect(expandPrompts[1]).toContain('未声明的制品依赖');
  });

  test('读毒: judge 拒了写方 → **读过那份产物的消费方也不复用** (它没被点名、id 也没变)', async () => {
    const calls: string[] = [];
    const r = await runExecutorDagWithPlan(
      conductorPlan({ max_rounds: 2, judge_final: true }),
      cfg({
        generate: genOf(),
        agentRunner: agentRunnerOf(calls),
        // 第一轮只点名写方 (拿它的输出 WROTE 定位), 第二轮收敛。
        judgeSend: judgeSendOf([
          // 视图形状: `### <id> [状态]` + 可选的 `[引擎实测] …` 行 + 输出正文 → 用 id 与 WROTE 之间
          // 不含下一个 `###` 来定位 (2026-07-30 视图加了实测行, 硬编码换行数的写法当场就脆)。
          { converged: false, pick: (ids, prompt) => ids.filter((id) => new RegExp(`### ${id} \\[[^#]*WROTE`).test(prompt)) },
          { converged: true },
        ]),
      }),
    );
    expect(r.results.C?.status).toBe('done');
    // w 两轮都跑 (被点名); r 也两轮都跑 —— 若读毒没生效, 第二轮的 r 会被跨轮复用而只跑一次。
    expect(calls.filter((c) => c === 'w')).toHaveLength(2);
    expect(calls.filter((c) => c === 'r')).toHaveLength(2);
  });

  test('对照组: 没有毒 → 语义没变的子节点**照常复用** (证明上面不是"永远重跑"的空转断言)', async () => {
    const calls: string[] = [];
    await runExecutorDagWithPlan(
      conductorPlan({ max_rounds: 2, judge_final: true }),
      cfg({
        generate: genOf(),
        agentRunner: agentRunnerOf(calls),
        judgeSend: judgeSendOf([{ converged: false, pick: () => [] }, { converged: true }]),
      }),
    );
    expect(calls.filter((c) => c === 'w')).toHaveLength(1); // 第二轮零 LLM 复用
    expect(calls.filter((c) => c === 'r')).toHaveLength(1);
  });
});

describe('D-12 读毒的外层版 (computeReuse, INV-P2-5 的 GWT)', () => {
  const plan = (): ConductorPlan =>
    ({ name: 'p', nodes: { A: { goal: '写 f' }, B: { goal: '读 f 再做事' } } }) as ConductorPlan;
  const leaf = (id: string, over: Partial<LeafResult> = {}): LeafResult =>
    ({ id, status: 'done', kind: 'agent', output: 'o', deps: [], usage: { in: 0, out: 0 }, ...over }) as LeafResult;

  test('B 上一轮读过被拒节点 A 写的 f → B 不入复用池 (哪怕 B 指纹命中且没被点名)', () => {
    const p = plan();
    const prior = {
      plan: p,
      results: { A: leaf('A', { filesTouched: ['f'] }), B: leaf('B', { filesRead: ['f'] }) },
    };
    const { merkleFingerprints } = require('../../src/harness/plan-passes/semantic-key') as typeof import('../../src/harness/plan-passes/semantic-key');
    const poisoned = new Set([merkleFingerprints(p).get('A')!]);
    const reuse = computeReuse(p, prior, poisoned);
    expect(reuse.has('A')).toBe(false); // 被点名的本来就不复用
    expect(reuse.has('B')).toBe(false); // ← D-12 的增量: 消费方也不复用
  });

  test('没有毒时 B 照常复用 (闸不是恒关)', () => {
    const p = plan();
    const prior = {
      plan: p,
      results: { A: leaf('A', { filesTouched: ['f'] }), B: leaf('B', { filesRead: ['f'] }) },
    };
    const reuse = computeReuse(p, prior);
    expect(reuse.has('B')).toBe(true);
  });
});

// ── D-P 协作式取消 ──────────────────────────────────────────────────────────

describe('D-P 协作式取消', () => {
  const FLAT = {
    name: 'flat',
    nodes: { a: { goal: '第一步' }, b: { goal: '第二步' }, c: { goal: '第三步' } },
  } as unknown as ConductorPlan;

  test('取消后**不派新节点**, 已跑完的全保留, notRun 如实列出没跑的', async () => {
    const ac = new AbortController();
    const ran: string[] = [];
    const generate: GenerateFn = async (req) => {
      const text = String(req.messages.find((m) => m.role === 'user')?.content ?? '');
      const id = leafId(text);
      ran.push(id);
      ac.abort('测试叫停'); // 第一个节点跑完就叫停
      return { text: `out:${id}`, usage: { in: 1, out: 1 } };
    };
    const r = await runExecutorDagWithPlan(FLAT, cfg({ generate, cancelSignal: ac.signal, maxFanout: 1 }));
    expect(r.cancelled?.reason).toBe('测试叫停');
    // 已跑完的一个都不少; 没跑的**不伪造结果**, 而是如实进 notRun。
    expect(Object.keys(r.results)).toHaveLength(ran.length);
    expect(r.cancelled!.notRun.length).toBe(3 - ran.length);
    expect(r.cancelled!.notRun.every((id) => r.results[id] === undefined)).toBe(true);
  });

  test('已跑完的节点留了绿 checkpoint → 同一个 runId resume 时被跳过 ("已跑完的全保留"的兑现处)', async () => {
    const ac = new AbortController();
    const generate: GenerateFn = async (req) => {
      const text = String(req.messages.find((m) => m.role === 'user')?.content ?? '');
      const id = leafId(text);
      ac.abort('叫停');
      return { text: `out:${id}`, usage: { in: 1, out: 1 } };
    };
    const first = await runExecutorDagWithPlan(FLAT, cfg({ generate, cancelSignal: ac.signal, maxFanout: 1 }));
    const doneIds = Object.keys(first.results);
    expect(doneIds.length).toBeGreaterThan(0);

    const ran2: string[] = [];
    const generate2: GenerateFn = async (req) => {
      const text = String(req.messages.find((m) => m.role === 'user')?.content ?? '');
      ran2.push(leafId(text));
      return { text: 'ok', usage: { in: 1, out: 1 } };
    };
    const second = await runExecutorDagWithPlan(
      FLAT,
      cfg({ generate: generate2, continuity: { manager, runId: RUN, repoRoot: root, resume: true } }),
    );
    for (const id of doneIds) {
      expect(second.results[id]?.skipped).toBe(true); // 跳过, 没重跑
      expect(ran2).not.toContain(id);
    }
    expect(second.cancelled).toBeUndefined();
  });

  test('内环轮间取消: 第 1 轮判完就叫停 → 只画了 1 次, 不谎报收敛, journal 可续', async () => {
    const ac = new AbortController();
    const SUB = JSON.stringify({ name: 's', nodes: { impl: { goal: '实装' } } });
    let expands = 0;
    const generate: GenerateFn = async (req) => {
      const text = String(req.messages.find((m) => m.role === 'user')?.content ?? '');
      const id = leafId(text);
      if (!id) {
        expands++;
        return { text: SUB, usage: { in: 1, out: 1 } };
      }
      return { text: `out:${id}`, usage: { in: 1, out: 1 } };
    };
    const judgeSend = ((async (req: { messages: { content: string }[] }) => {
      ac.abort('轮间叫停'); // judge 判完 = 下一个接缝就是"要不要开新一轮"
      const v = { converged: false, score: 0, failureReason: '还不行', rejectedNodes: [] as string[] };
      void req;
      return { text: JSON.stringify(v), parsed: v, usage: { in: 1, out: 1 } };
    }) as never) as NonNullable<ExecutorDagConfig['judgeSend']>;
    const r = await runExecutorDagWithPlan(
      conductorPlan({ max_rounds: 4, judge_final: true }),
      cfg({ generate, judgeSend, cancelSignal: ac.signal }),
    );
    expect(expands).toBe(1);
    expect(r.results.C?.converged).not.toBe(true); // 不谎报收敛
    const journal = manager.loadNodeLoopJournal(RUN, 'C');
    expect(journal?.completedRounds).toBe(1); // 已判的那一轮记下了 → resume 从第 2 轮接
  });
});

// ── 观察面: 运行时展开回写 ─────────────────────────────────────────────────

describe('运行时展开的观察面 (_dag.json runtimeNodes + expanded 事件)', () => {
  const SUB = JSON.stringify({ name: 's', nodes: { one: { goal: '甲' }, two: { goal: '乙', depends_on: ['one'] } } });

  test('子节点回写 `_dag.json` 的 runtimeNodes, 而 nodeIds/deps/plan/generation **一个字不改**', async () => {
    const generate: GenerateFn = async (req) => {
      const text = String(req.messages.find((m) => m.role === 'user')?.content ?? '');
      const id = leafId(text);
      return id ? { text: `out:${id}`, usage: { in: 1, out: 1 } } : { text: SUB, usage: { in: 1, out: 1 } };
    };
    await runExecutorDagWithPlan(conductorPlan(), cfg({ generate }));
    const meta = JSON.parse(readFileSync(join(root, '.omd', 'continuity', RUN, '_dag.json'), 'utf-8')) as DagMetadata;
    expect(meta.runtimeNodes).toHaveLength(2);
    expect(meta.runtimeNodes!.every((n) => n.parent === 'C' && n.id.startsWith('C::'))).toBe(true);
    // ⚠ 这三条是 resume 的命根子: 运行时子节点并进去 → 下次 resume 算出的代数与盘上每份
    // checkpoint 都对不上 → 整图作废重跑 (continuity 的意义被自己吃掉)。
    expect(meta.nodeIds).toEqual(['C']);
    expect(Object.keys(meta.plan!.nodes)).toEqual(['C']);
    expect(meta.generation).toBeDefined();
  });

  test('发 expanded 事件 (活体进度: 子节点进得了 dag_status 的图, 不再只有父节点一个点)', async () => {
    const events: DagNodeEvent[] = [];
    const generate: GenerateFn = async (req) => {
      const text = String(req.messages.find((m) => m.role === 'user')?.content ?? '');
      const id = leafId(text);
      return id ? { text: `out:${id}`, usage: { in: 1, out: 1 } } : { text: SUB, usage: { in: 1, out: 1 } };
    };
    await runExecutorDagWithPlan(conductorPlan(), cfg({ generate, onNodeEvent: (e) => events.push(e) }));
    const exp = events.filter((e): e is Extract<DagNodeEvent, { type: 'expanded' }> => e.type === 'expanded');
    expect(exp).toHaveLength(1);
    expect(exp[0]!.parent).toBe('C');
    expect(exp[0]!.nodes).toHaveLength(2);
    // 边也带上 —— 没有边的话渲染出来是两个孤点, 看不出子图长什么样。
    expect(exp[0]!.nodes.some((n) => n.deps.length > 0)).toBe(true);
  });
});
