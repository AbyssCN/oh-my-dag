/**
 * **S6 / G2 —— 内环故障注入** (2026-07-31)。
 *
 * ## 为什么这份非有不可
 *
 * G2「崩溃不丢已批准制品」此前一直记着「❌ 旧路径绿灯」。那句话的准确含义是:
 * 2026-07-29 那次 11 条全绿的故障注入打的是**外层 fixpoint**(`_fixpoint.json` +
 * `iterateExecutorDag`), 而环后来**搬进了 conductor 节点**, 状态换成了 `_loop-<nodeId>.json`
 * (`NodeLoopJournal`)。旧证据证的是一台已经不在主路径上的机器。
 *
 * 落到读数上更难看: 本文件写之前, **全仓没有一个测试提到过 `NodeLoopJournal` 或 `_loop-`**。
 * 内环的崩溃恢复按七态词表是 `Missing` —— 不是"测过但没测够"。
 *
 * ## 与旧那次的差别(诚实边界, 别把这份读成等价替代)
 *
 * 旧那次是**真杀子进程**(等哨兵 → SIGKILL → 带 `--resume` 重起), 因此它顺带证了"写到一半掉电"
 * 这一类真实撕裂。本文件是**进程内**的: 用「跑完第 1 轮就收手, 再以 `resume` 起第二次」来
 * 模拟崩溃, 用**直接把 journal 文件改坏**来模拟撕裂。
 *
 * 这个替代对 F2/F3/F4 是**忠实的** —— 那三组问的都是"引擎读到一份残缺/过期的盘上状态时怎么办",
 * 而残缺状态由谁造成不影响读的一方。对 F1 只是**近似**: 真杀进程还能撞上"写了一半的
 * checkpoint", 这里造不出来。那一格仍记在未决里。
 *
 * ## 四组各自钉什么
 *
 * - **F1** 崩在轮中 → resume 只补跑没绿的; 不带 `resume` 则整轮重来(恢复必须显式, 是设计)
 * - **F2** 毒集跨进程存活, 且**毒集里的子节点不许靠 per-node checkpoint 复活** ←最值钱的一条
 * - **F3** journal 撕裂 / `.tmp` 残留 / runDir 被删 → 不炸, 降级
 * - **F4** 已绿子节点的产物被删/被改 → 不跳过, 重跑
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runExecutorDagWithPlan } from '../dag/engine';
import { expandConductorNode } from './conductor-expand';
import { PLAN_BOUNDARY } from '../conductor-plan';
import { CheckpointManager } from '../continuity/checkpoint-manager';
import type { ConductorPlan } from '../conductor-plan';
import type { ContentPart } from '../../model/gateway';
import type { ExecutorDagConfig, GenerateFn } from '../dag/types';

const contentText = (c: string | ContentPart[] | undefined): string =>
  typeof c === 'string' ? (c ?? '') : (c ?? []).map((p) => (p.type === 'text' ? p.text : '')).join('\n');

/** 固定子图: 两个互不依赖的写方。刻意不放 fan-in —— 本文件测的是恢复不是裁决通道。 */
const SUB_PLAN = JSON.stringify({
  name: 'sub',
  nodes: { 'write-a': { goal: '写 A 部分' }, 'write-b': { goal: '写 B 部分' } },
});

/**
 * 子节点的**内容寻址 id**(D-B)。judge 的 `rejectedNodes` 走 `splitNamedIds` 精确匹配 ——
 * 可读名匹配不上会落进 ghosts(幻觉不许铸票), 所以这里必须先把真 id 算出来。
 * 算法与引擎同一个函数, 因此这不是"抄一份 id 规则", 是问它要。
 */
const CHILD_ID: Record<string, string> = Object.fromEntries(
  expandConductorNode('P', JSON.parse(SUB_PLAN) as ConductorPlan).children.map((c) => [c.originalId, c.id]),
);

const loopPlan = (maxRounds: number): ConductorPlan => ({
  name: 'p',
  nodes: { P: { goal: '两部分都要写好', executor: 'conductor', max_rounds: maxRounds } },
});

/** 记下每次真跑过的 leaf goal —— **复用/跳过的观察面就是它**(复用 = 零 LLM 调用)。 */
function makeGenerate(): { generate: GenerateFn; leafGoals: string[] } {
  const leafGoals: string[] = [];
  const generate: GenerateFn = async (req) => {
    const user = contentText(req.messages.find((m) => m.role === 'user')?.content);
    if (user.includes(PLAN_BOUNDARY.trim().split('\n')[0]!) || user.includes('TASK (dynamic')) {
      return { text: SUB_PLAN, usage: { in: 1, out: 1 } };
    }
    const goal = /写 [AB] 部分/.exec(user)?.[0] ?? 'other';
    leafGoals.push(goal);
    return { text: `out:${goal}`, usage: { in: 1, out: 1 } };
  };
  return { generate, leafGoals };
}

/**
 * @param reject 内环 judge 每轮点名的**可读名**(本函数翻成内容寻址 id 再交给 judge stub ——
 *   真 judge 拿到的视图里就是 id, 用可读名会被当幻觉丢掉)。空 = 不点名。
 * @param converged 判不判收敛。
 */
const cfg = (
  generate: GenerateFn,
  root: string,
  opts: { resume?: boolean; reject?: string[]; converged?: boolean; runId?: string } = {},
): ExecutorDagConfig =>
  ({
    conductorModel: 'c:m',
    leafModel: 'l:m',
    generate,
    agentTemplates: new Map(),
    judgeSend: async () => ({
      text: '',
      parsed: {
        converged: opts.converged ?? false,
        score: opts.converged ? 9 : 3,
        failureReason: opts.converged ? undefined : '还差一点',
        rejectedNodes: (opts.reject ?? []).map((n) => CHILD_ID[n] ?? n),
      },
      usage: { in: 0, out: 0 },
      raw: {},
      model: 'judge:fake',
      attempts: 1,
    }),
    continuity: {
      manager: new CheckpointManager(root),
      runId: opts.runId ?? 'run-1',
      ...(opts.resume ? { resume: true } : {}),
    },
  }) as unknown as ExecutorDagConfig;

const freshRoot = (): string => mkdtempSync(join(tmpdir(), 'omd-innerfault-'));
/** runDir = <root>/.omd/continuity/<runId>(未设 OMD_DATA_HOME 时的语义)。 */
const runDir = (root: string, runId = 'run-1'): string => join(root, '.omd', 'continuity', runId);
const loopFile = (root: string, runId = 'run-1'): string => join(runDir(root, runId), '_loop-P.json');

// ── F1: 崩在轮中 ─────────────────────────────────────────────────────────────

describe('F1 — 崩在轮中, resume 只补跑没绿的', () => {
  test('多轮档跑完留下 journal 与已绿 checkpoint', async () => {
    const root = freshRoot();
    const { generate, leafGoals } = makeGenerate();
    await runExecutorDagWithPlan(loopPlan(2), cfg(generate, root));
    expect(leafGoals.length).toBeGreaterThanOrEqual(2);
    // journal 真的在盘上 —— 没有它, 下面每一条都是在测空气。
    expect(existsSync(loopFile(root))).toBe(true);
    const j = JSON.parse(readFileSync(loopFile(root), 'utf-8')) as { nodeId: string; completedRounds: number };
    expect(j.nodeId).toBe('P');
    expect(j.completedRounds).toBe(2);
    rmSync(root, { recursive: true, force: true });
  });

  test('⚠ **单轮档(缺省)根本不写 journal** —— 写这份测试时才发现的一条', async () => {
    // `executor-dag.ts` 的 `if (maxRounds === 1 && !judgeFinal) return settle(...)`:
    // 单轮档不请 judge(没有下一轮, 判了也没有用它的地方), 于是那条 `writeLoopJournal` 走不到。
    //
    // **这不是缺陷, 但必须写下来**: 单轮档的内环崩溃恢复**只靠 per-node checkpoint**,
    // 没有环状态可接。而这一格是自洽的 —— 单轮档里没有 judge 也就没有毒集, 本来就没有
    // 「被拒的产出借崩溃复活」可言。危险的是**误以为它有** journal 兜底而在别处依赖那份状态。
    const root = freshRoot();
    await runExecutorDagWithPlan(loopPlan(1), cfg(makeGenerate().generate, root));
    expect(existsSync(loopFile(root))).toBe(false);
    // 但 per-node checkpoint 照落 —— 已绿仍跳得过(下一条用例证的就是它)。
    expect(readdirSync(runDir(root)).some((f) => f.endsWith('.json') && !f.startsWith('_'))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  test('带 resume 起第二次 → 已绿子节点零 LLM 调用', async () => {
    const root = freshRoot();
    const first = makeGenerate();
    await runExecutorDagWithPlan(loopPlan(1), cfg(first.generate, root));
    expect(first.leafGoals).toHaveLength(2);

    const second = makeGenerate();
    await runExecutorDagWithPlan(loopPlan(1), cfg(second.generate, root, { resume: true }));
    // 两个写方都被 checkpoint 兜住 → 一次 leaf 调用都不该有。
    expect(second.leafGoals).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });

  test('**不带 resume → 整轮重跑**(恢复必须显式, 这是设计不是缺陷)', async () => {
    const root = freshRoot();
    const first = makeGenerate();
    await runExecutorDagWithPlan(loopPlan(1), cfg(first.generate, root));

    const second = makeGenerate();
    await runExecutorDagWithPlan(loopPlan(1), cfg(second.generate, root)); // 无 resume
    expect(second.leafGoals.sort()).toEqual(['写 A 部分', '写 B 部分']);
    rmSync(root, { recursive: true, force: true });
  });

  test('换一个 runId → 上一个 run 的 checkpoint 一概不认(run 之间不串味)', async () => {
    const root = freshRoot();
    const first = makeGenerate();
    await runExecutorDagWithPlan(loopPlan(1), cfg(first.generate, root, { runId: 'run-1' }));

    const second = makeGenerate();
    await runExecutorDagWithPlan(loopPlan(1), cfg(second.generate, root, { runId: 'run-2', resume: true }));
    expect(second.leafGoals).toHaveLength(2);
    rmSync(root, { recursive: true, force: true });
  });
});

// ── F2: 毒集 ─────────────────────────────────────────────────────────────────

/**
 * **崩溃的进程内等价物**(诚实说明,别把它当真杀进程读):
 * 第一次用 `max_rounds: N` 跑满 → journal 记 `completedRounds: N`;
 * 第二次给 `max_rounds: N+1` 并带 `resume` → 引擎从第 N+1 轮起跑。
 * 这与"崩在第 N+1 轮之前、盘上只有前 N 轮的状态"在**引擎读到的东西**上是同一件事 ——
 * 而 F2 问的正是"引擎读到一份过期的盘上状态时会不会复活被拒的产出"。
 */
describe('F2 — 毒集跨进程存活, 被拒的产出不许借崩溃复活', () => {
  test('journal 里记下了被点名的子节点, 且键是内容寻址 id 不是可读名', async () => {
    const root = freshRoot();
    const { generate } = makeGenerate();
    await runExecutorDagWithPlan(loopPlan(2), cfg(generate, root, { reject: ['write-a'] }));
    const j = JSON.parse(readFileSync(loopFile(root), 'utf-8')) as { poisoned: string[] };
    expect(j.poisoned).toHaveLength(1);
    // NodeLoopJournal 的注说的那把"一把钥匙同时开两把锁": 拦 resume 复活, 也拦跨轮复用。
    expect(j.poisoned[0]).toContain('P');
    expect(j.poisoned[0]).not.toBe('write-a');
    rmSync(root, { recursive: true, force: true });
  });

  test('**被点名的子节点 resume 时强制重跑, 没点名的仍跳过** ←旧路径上真出过的那条缺陷', async () => {
    const root = freshRoot();
    const first = makeGenerate();
    await runExecutorDagWithPlan(loopPlan(2), cfg(first.generate, root, { reject: ['write-a'] }));

    const second = makeGenerate();
    await runExecutorDagWithPlan(loopPlan(3), cfg(second.generate, root, { resume: true, reject: ['write-a'] }));
    // 只有被拒的那个重跑; write-b 命中 checkpoint。
    // 若毒集没跨进程活下来, 这里会是 [] —— 两个都被当绿跳过, 那正是"被拒的产出借崩溃复活"。
    expect(second.leafGoals).toEqual(['写 A 部分']);
    rmSync(root, { recursive: true, force: true });
  });

  test('毒集**累积不撤**: 第二次又点了别人, 前一个仍在集合里', async () => {
    const root = freshRoot();
    await runExecutorDagWithPlan(loopPlan(2), cfg(makeGenerate().generate, root, { reject: ['write-a'] }));
    await runExecutorDagWithPlan(
      loopPlan(3),
      cfg(makeGenerate().generate, root, { resume: true, reject: ['write-b'] }),
    );
    const j = JSON.parse(readFileSync(loopFile(root), 'utf-8')) as { poisoned: string[] };
    // 撤了任何一个 = 那一个的坏产出重新有资格被复用。
    expect(j.poisoned).toHaveLength(2);
    rmSync(root, { recursive: true, force: true });
  });

  test('崩一次不该换来额外轮数 —— max_rounds 仍是总上界', async () => {
    const root = freshRoot();
    await runExecutorDagWithPlan(loopPlan(2), cfg(makeGenerate().generate, root));
    const before = (JSON.parse(readFileSync(loopFile(root), 'utf-8')) as { completedRounds: number }).completedRounds;
    expect(before).toBe(2); // 第一次已经走满

    const second = makeGenerate();
    await runExecutorDagWithPlan(loopPlan(2), cfg(second.generate, root, { resume: true }));
    const after = (JSON.parse(readFileSync(loopFile(root), 'utf-8')) as { completedRounds: number }).completedRounds;
    // resume 从 completedRounds+1 起跑, 而上界仍是 2 → 不该被推到 3、4。
    expect(after).toBeLessThanOrEqual(2);
    // 而且既然没有新轮可跑, 一次 leaf 调用都不该发生。
    expect(second.leafGoals).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });

  test('已判收敛的环, resume 无事可做(不该再烧一遍 leaf)', async () => {
    const root = freshRoot();
    await runExecutorDagWithPlan(loopPlan(2), cfg(makeGenerate().generate, root, { converged: true }));
    const j = JSON.parse(readFileSync(loopFile(root), 'utf-8')) as { converged?: boolean };
    expect(j.converged).toBe(true);

    const second = makeGenerate();
    await runExecutorDagWithPlan(loopPlan(2), cfg(second.generate, root, { resume: true, converged: true }));
    expect(second.leafGoals).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });
});

// ── F3: 盘上状态坏掉 ─────────────────────────────────────────────────────────

describe('F3 — journal 撕裂 / 残留 / 整个目录没了, 一律不炸', () => {
  test('**journal 被截断(写到一半掉电)→ 不抛, 退回第 1 轮**', async () => {
    const root = freshRoot();
    await runExecutorDagWithPlan(loopPlan(2), cfg(makeGenerate().generate, root, { reject: ['write-a'] }));
    // 撕一半 —— JSON.parse 必失败。
    const raw = readFileSync(loopFile(root), 'utf-8');
    writeFileSync(loopFile(root), raw.slice(0, Math.floor(raw.length / 2)));

    const second = makeGenerate();
    const r = await runExecutorDagWithPlan(loopPlan(3), cfg(second.generate, root, { resume: true }));
    expect(r.results.P).toBeDefined(); // 没抛
    rmSync(root, { recursive: true, force: true });
  });

  test('撕裂后毒集经**归档 checkpoint** 存活: 被拒子节点仍强制重跑, 其余照旧跳过 (刀①-1)', async () => {
    const root = freshRoot();
    const first = makeGenerate();
    await runExecutorDagWithPlan(loopPlan(2), cfg(first.generate, root, { reject: ['write-a'] }));
    const raw = readFileSync(loopFile(root), 'utf-8');
    writeFileSync(loopFile(root), raw.slice(0, 20));

    const second = makeGenerate();
    await runExecutorDagWithPlan(loopPlan(3), cfg(second.generate, root, { resume: true }));
    // 2026-08-30 之前这里钉的是**已知降级**: journal 撕裂 → 毒集丢 → 被拒的 write-a 被
    // checkpoint 当绿跳过 (断言 `[]`)。刀①-1 (闸门三角结) 把否决落成**归档盘上 checkpoint**,
    // 毒这件事从此有两份记录 —— journal 撕了, 归档还在, loadCheckpoint 读不到被拒份 →
    // write-a 仍强制重跑。**只有被拒的那一个重跑**, 没被拒的绿照旧跳过 (降级面收窄到零)。
    expect(second.leafGoals).toEqual(['写 A 部分']);
    rmSync(root, { recursive: true, force: true });
  });

  test('journal 的 nodeId 对不上 → 当没有(防错位, 同 loadCheckpoint)', async () => {
    const root = freshRoot();
    await runExecutorDagWithPlan(loopPlan(2), cfg(makeGenerate().generate, root, { reject: ['write-a'] }));
    const j = JSON.parse(readFileSync(loopFile(root), 'utf-8')) as Record<string, unknown>;
    writeFileSync(loopFile(root), JSON.stringify({ ...j, nodeId: '别的节点' }));

    const second = makeGenerate();
    const r = await runExecutorDagWithPlan(loopPlan(3), cfg(second.generate, root, { resume: true }));
    expect(r.results.P).toBeDefined();
    rmSync(root, { recursive: true, force: true });
  });

  test('原子写残留的 `.tmp` 不被当成 journal', async () => {
    const root = freshRoot();
    await runExecutorDagWithPlan(loopPlan(2), cfg(makeGenerate().generate, root));
    writeFileSync(`${loopFile(root)}.tmp`, '{ 这不是合法 JSON');

    const second = makeGenerate();
    const r = await runExecutorDagWithPlan(loopPlan(1), cfg(second.generate, root, { resume: true }));
    expect(r.results.P).toBeDefined();
    // 真 journal 仍在, 恢复照常(已绿仍跳过)。
    expect(second.leafGoals).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });

  test('整个 runDir 被删 → 从头跑, 不抛', async () => {
    const root = freshRoot();
    await runExecutorDagWithPlan(loopPlan(1), cfg(makeGenerate().generate, root));
    rmSync(runDir(root), { recursive: true, force: true });

    const second = makeGenerate();
    const r = await runExecutorDagWithPlan(loopPlan(1), cfg(second.generate, root, { resume: true }));
    expect(r.results.P).toBeDefined();
    expect(second.leafGoals).toHaveLength(2); // 从头
    rmSync(root, { recursive: true, force: true });
  });
});

// ── F4: 已绿节点的产物被动过 ─────────────────────────────────────────────────

describe('F4 — checkpoint 说绿不算数, 产物没了/变了就得重跑', () => {
  /** 找出某个子节点的 per-node checkpoint 文件(runDir 下除 `_` 开头之外的 json)。 */
  const nodeCheckpoints = (root: string): string[] =>
    readdirSync(runDir(root)).filter((f) => f.endsWith('.json') && !f.startsWith('_'));

  test('已绿子节点的 checkpoint 被**删** → 该节点重跑, 兄弟仍跳过', async () => {
    const root = freshRoot();
    const first = makeGenerate();
    await runExecutorDagWithPlan(loopPlan(1), cfg(first.generate, root));
    const cps = nodeCheckpoints(root);
    expect(cps.length).toBeGreaterThanOrEqual(2); // 不是空转
    // 删**子节点**的 checkpoint: readdir 顺序不保证, 而 P 自己的 checkpoint 是裸 "P.json" ——
    // 删到它不会触发子节点重跑, 断言就空转了 (2026-08-10 被 D-3 mcp 指纹变更暴露:
    // 子节点内容寻址 id 一换, readdir 顺序翻面, cps[0] 从子节点变成 P.json)。
    const victim = cps.find((f) => f.includes('::'));
    expect(victim).toBeDefined(); // 子节点 id 含 `::` (内容寻址), 挑不到 = 图没展开, 测空气
    unlinkSync(join(runDir(root), victim!));

    const second = makeGenerate();
    await runExecutorDagWithPlan(loopPlan(1), cfg(second.generate, root, { resume: true }));
    // 只补跑被删的那一个 —— 损坏不扩散。
    expect(second.leafGoals).toHaveLength(1);
    rmSync(root, { recursive: true, force: true });
  });

  test('已绿子节点的 checkpoint 被**改坏** → 同样只有它重跑(损坏不扩散)', async () => {
    const root = freshRoot();
    const first = makeGenerate();
    await runExecutorDagWithPlan(loopPlan(1), cfg(first.generate, root));
    const cps = nodeCheckpoints(root);
    // 同上: 挑**子节点** checkpoint 改坏 (readdir 顺序不保证, 删/改到 P 自己的 = 断言空转)。
    const victim = cps.find((f) => f.includes('::'));
    expect(victim).toBeDefined();
    writeFileSync(join(runDir(root), victim!), '{ 半截');

    const second = makeGenerate();
    await runExecutorDagWithPlan(loopPlan(1), cfg(second.generate, root, { resume: true }));
    expect(second.leafGoals).toHaveLength(1);
    rmSync(root, { recursive: true, force: true });
  });

  test('全部 checkpoint 都坏 → 全重跑, 仍不抛', async () => {
    const root = freshRoot();
    await runExecutorDagWithPlan(loopPlan(1), cfg(makeGenerate().generate, root));
    for (const f of nodeCheckpoints(root)) writeFileSync(join(runDir(root), f), 'not json');

    const second = makeGenerate();
    const r = await runExecutorDagWithPlan(loopPlan(1), cfg(second.generate, root, { resume: true }));
    expect(r.results.P).toBeDefined();
    expect(second.leafGoals).toHaveLength(2);
    rmSync(root, { recursive: true, force: true });
  });
});
