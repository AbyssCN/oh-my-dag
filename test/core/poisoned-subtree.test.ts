/**
 * **通道⑤: 被毒的展开节点, 它的子节点也得一起清** (2026-07-29)。
 *
 * 承故障注入那条可推广的约束 —— **上轮产出能进本轮的路不止一条, 只堵一条等于没堵**。
 *
 * `dropPoisonedGreens` 补上了 continuity 这条通道, 但它按 **id 精确匹配**删绿, 而 map / conductor
 * 的子节点 id 是 `${parentId}::${key}` —— 它们**运行期才挂进 plan.nodes**, 而该函数跑在 resume
 * 预载阶段, 那时 `plan` 里根本没有它们, 指纹遍历与前向闭包都够不着。
 *
 * 于是会漏成这样:
 *   judge 拒了展开节点 C → C 的绿被清、C 重新展开 → 内容没变则子节点拿到**同样的内容寻址 id**
 *   (D-B/INV-U2 的构造保证) → 各自命中自己那份**被拒的** checkpoint → 整棵子树跳过。
 *   **父节点重跑了, 干活的子节点一个没重跑, 被拒的产出照样交付。**
 *
 * 这条与原缺陷同一族: 都只有 resume 路径才走得到, 正常跑一轮撞不上。
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runExecutorDagWithPlan } from '../../src/harness/executor-dag';
import { CheckpointManager } from '../../src/harness/continuity/checkpoint-manager';
import { merkleFingerprints } from '../../src/harness/plan-passes/semantic-key';
import type { ConductorPlan } from '../../src/harness/conductor-plan';
import type { ExecutorDagConfig, GenerateFn } from '../../src/harness/executor-dag-types';

const RUN = 'poison-run';
let root: string;
let manager: CheckpointManager;
let savedDataHome: string | undefined;

beforeEach(() => {
  savedDataHome = process.env.OMD_DATA_HOME;
  delete process.env.OMD_DATA_HOME;
  root = mkdtempSync(join(tmpdir(), 'omd-poison-'));
  manager = new CheckpointManager(root);
});
afterEach(() => {
  if (savedDataHome === undefined) delete process.env.OMD_DATA_HOME;
  else process.env.OMD_DATA_HOME = savedDataHome;
  rmSync(root, { recursive: true, force: true });
});

const leafId = (p: string): string => /\[omd leaf: ([^\]]+)\]/.exec(p)?.[1] ?? '';
const SUBPLAN = JSON.stringify({ name: 's', nodes: { step1: { goal: '第一步' }, step2: { goal: '第二步', depends_on: ['step1'] } } });

/** conductor 节点在外层图里的样子。 */
const outer = (): ConductorPlan =>
  ({ name: 'outer', nodes: { C: { goal: '把这件事做完', executor: 'conductor' } } }) as ConductorPlan;

function fake(): { generate: GenerateFn; leafCalls: string[] } {
  const leafCalls: string[] = [];
  const generate: GenerateFn = async (req) => {
    const user = req.messages.find((m) => m.role === 'user');
    const text = typeof user?.content === 'string' ? user.content : '';
    const id = leafId(text);
    if (!id) return { text: SUBPLAN, usage: { in: 1, out: 1 } };
    leafCalls.push(id);
    return { text: `out:${id}`, usage: { in: 1, out: 1 } };
  };
  return { generate, leafCalls };
}

const cfg = (generate: GenerateFn, resume: boolean): ExecutorDagConfig => ({
  conductorModel: 'c:m',
  leafModel: 'l:m',
  generate,
  agentTemplates: new Map(),
  continuity: { manager, runId: RUN, repoRoot: root, ...(resume ? { resume: true } : {}) },
});

describe('通道⑤ — 被毒的 conductor 节点, 子树的绿必须一起清', () => {
  test('毒了父节点 → resume 时子节点**全部重跑** (不许靠内容寻址 id 命中被拒的 checkpoint)', async () => {
    // ── 第 1 轮: 正常跑完, 父与两个子节点都落绿 checkpoint ──
    const r1 = fake();
    await runExecutorDagWithPlan(outer(), cfg(r1.generate, false));
    expect(r1.leafCalls).toHaveLength(2);
    const childIds = r1.leafCalls.slice().sort();
    for (const cid of childIds) expect(cid.startsWith('C::')).toBe(true);

    // ── judge 拒了 C → C 的指纹进毒集 ──
    const poisoned = new Set([merkleFingerprints(outer()).get('C')!]);

    // ── 第 2 轮 resume: 父重新展开, 子节点内容没变 → id 逐字相同 ──
    const r2 = fake();
    // prior 带毒集进来 (与 iterate.ts 的接线同形)。
    await runExecutorDagWithPlan(outer(), cfg(r2.generate, true), { plan: outer(), results: {}, poisoned } as never);

    // 判据: 两个子节点都真的**又跑了一遍**。若通道⑤没堵, 这里会是 0 (全被当绿跳过)。
    expect(r2.leafCalls.sort()).toEqual(childIds);
  });

  test('控制组: 没有毒集时子节点照常 resume-skip (证明上一条不是"恒重跑")', async () => {
    const r1 = fake();
    await runExecutorDagWithPlan(outer(), cfg(r1.generate, false));
    expect(r1.leafCalls).toHaveLength(2);

    const r2 = fake();
    await runExecutorDagWithPlan(outer(), cfg(r2.generate, true));
    // 内容没变 → 内容寻址 id 没变 → 子节点各自命中自己的绿 → 一个都不重跑。
    expect(r2.leafCalls).toHaveLength(0);
  });

  /**
   * judge 更可能点名的是**具体坏掉的那个子节点**, 而不是笼统的父节点 —— 它在轮结果里看得见子节点。
   * 这条钉的就是那个形态: 毒的是子节点本身, 它必须重跑。
   *
   * 难点在于毒集的键是**指纹**而非 id, 而子节点的指纹只有在它已经挂进 plan 之后才算得出来 ——
   * resume 预载阶段它还不在图里。故 `dropPoisonedGreens` 那条"重算指纹再比对"的路对子节点是断的。
   */
  test('毒的是**子节点本身** → 它必须重跑 (judge 通常点名的就是具体那个)', async () => {
    const r1 = fake();
    const res1 = await runExecutorDagWithPlan(outer(), cfg(r1.generate, false));
    const childIds = r1.leafCalls.slice().sort();
    expect(childIds).toHaveLength(2);

    // judge 在**轮结果的 plan** 上翻 id → 指纹 (iterate.ts:125 的做法), 那时子节点已在图里。
    const fpsAtJudge = merkleFingerprints(res1.plan);
    const victim = childIds[0]!;
    const victimFp = fpsAtJudge.get(victim);
    expect(victimFp).toBeTruthy(); // 前提: 判决时子节点确实在图里, 点得到名

    const r2 = fake();
    await runExecutorDagWithPlan(
      outer(),
      cfg(r2.generate, true),
      { plan: res1.plan, results: {}, poisoned: new Set([victimFp!]) } as never,
    );
    expect(r2.leafCalls).toContain(victim);
  });

  test('毒的是**别的**节点 → 不误伤 conductor 子树', async () => {
    const twoNode = (): ConductorPlan =>
      ({ name: 'outer', nodes: {
        other: { goal: '无关节点' },
        C: { goal: '把这件事做完', executor: 'conductor' },
      } }) as ConductorPlan;

    const r1 = fake();
    await runExecutorDagWithPlan(twoNode(), cfg(r1.generate, false));
    const childCalls = r1.leafCalls.filter((id) => id.startsWith('C::'));
    expect(childCalls).toHaveLength(2);

    const poisoned = new Set([merkleFingerprints(twoNode()).get('other')!]);
    const r2 = fake();
    await runExecutorDagWithPlan(
      twoNode(),
      cfg(r2.generate, true),
      { plan: twoNode(), results: {}, poisoned } as never,
    );
    // other 重跑, C 的子树照常跳过 —— 毒集是点名制, 不是连坐制。
    expect(r2.leafCalls.filter((id) => id.startsWith('C::'))).toHaveLength(0);
    expect(r2.leafCalls).toContain('other');
  });
});
