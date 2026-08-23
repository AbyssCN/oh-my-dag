/**
 * **轮间交接强制带「下一步 (nextSteps)」**(#228,2026-08-23)。
 *
 * ## 现场
 *
 * 内环交接只看 `prevReason`(judge 的 `failureReason`)。而 #226 实测:判词单项 p95 = 1854 字符,
 * 单项 ≥1500 的占 7.8%;交接从**头部**切 → 切掉的正是**尾部** —— 判词尾部通常正是「下一轮
 * 该做什么」。结果:账本记着判词有「下一步」,模型一个字符没看见,环在原地打转。
 *
 * #226 把截断后的告示/指针补上、把 `NOVELTY_COLLAPSE_LINE` 摘到 `mustReach`,但**判词本身
 * 的「下一步」没有结构化** —— 它与「缺哪条要求」挤在同一个 `failureReason` 字符串里,
 * 读者分不出哪段是抱怨、哪段是可执行动作。
 *
 * ## 本片的真增量(两片,与 #226 严守单一变量)
 *
 * ① **judge 把 `nextSteps` 拆成独立结构化字段**(fixpoint verdict 形态):converged=false
 *   时必填,要求是机制级动作。整轮 failed / 闸合成判词那条路径不要求填(undefined)。
 * ② **`renderHandoff` 把 `nextSteps` 加进 `mustReach`**,与 `NOVELTY_COLLAPSE_LINE` 同一条
 *   纪律(必达块不参与截断预算,唯一通道就是 prompt)。
 *
 * ## 与 #226 的边界
 *
 * 不动 `HANDOFF_CAP_CHARS`(单一变量:额度是另一个决定);不动 `NOVELTY_COLLAPSE_LINE` 摘
 * 出去的逻辑;不动 `RoundVerdict` 四态语义。`nextSteps` 走的是**独立通道**:judge verdict
 * → journal.prevReason **之外**的字段 → renderHandoff 的下一个参数,而不是塞进 prevReason
 * 再用正则拆 —— 后者每多一种必达块就要改一处正则,漂一次坏一处。
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runExecutorDagWithPlan } from '../../src/harness/dag/engine';
import { CheckpointManager } from '../../src/harness/continuity/checkpoint-manager';
import type { ConductorPlan } from '../../src/harness/conductor-plan';
import type { ExecutorDagConfig, GenerateFn } from '../../src/harness/dag/types';

let root: string;
let manager: CheckpointManager;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'omd-handoff-ns-'));
  manager = new CheckpointManager(root);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const leafId = (p: string): string => /\[omd leaf: ([^\]]+)\]/.exec(p)?.[1] ?? '';
const SUB = JSON.stringify({ name: 's', nodes: { w: { goal: '干活' } } });
const plan = (maxRounds: number): ConductorPlan =>
  ({ name: 'outer', nodes: { C: { goal: '做完', executor: 'conductor', max_rounds: maxRounds, judge_final: true } } }) as ConductorPlan;

/** 判词里可辨认的头尾 + 可控长度 —— 沿用 #226 同款, 复用其单一变量锁。 */
const HEAD = '判词开头-可辨认';
const TAIL = '判词结尾-下一步该做什么';
function reasonOf(len: number): string {
  const filler = '数'.repeat(Math.max(0, len - HEAD.length - TAIL.length));
  return `${HEAD}${filler}${TAIL}`;
}

/** 一段**逐字可辨认**的 nextSteps —— 拼装成「机制级动作」的样子, 不只是空话。 */
const NEXT_STEPS = '下一步: 把判词的 nextSteps 字段接到 renderHandoff 的 mustReach 里, 字段为空则不挂块';

/** 抽出交接里 `<上一轮未通过>...</上一轮未通过>` 这一块的正文。 */
function blockBody(prompt: string): string | null {
  const m = /<上一轮未通过>([\s\S]*?)<\/上一轮未通过>/.exec(prompt);
  return m?.[1] ?? null;
}

/**
 * 跑一遍内环。`verdictExtra` 走 judgeSend 的 `parsed` 字段 —— 实装后 fixpoint verdict 形态
 * 会有 `nextSteps`, 这里直接以**契约形态**传, 让它在实装前天然红。
 */
async function run(
  opts: { reason: string; nextSteps?: string; maxRounds?: number },
): Promise<{ expands: string[]; journal: ReturnType<typeof loadJournal> }> {
  const { reason, nextSteps, maxRounds = 2 } = opts;
  const expands: string[] = [];
  const generate: GenerateFn = async (req) => {
    const text = String(req.messages.find((m) => m.role === 'user')?.content ?? '');
    if (leafId(text)) return { text: 'ok', usage: { in: 1, out: 1 } };
    expands.push(text);
    return { text: SUB, usage: { in: 1, out: 1 } };
  };
  await runExecutorDagWithPlan(plan(maxRounds), {
    conductorModel: 'c:m',
    leafModel: 'l:m',
    agentTemplates: new Map(),
    continuity: { manager, runId: 'handoff-ns-run', repoRoot: root },
    generate,
    judgeSend: (async () => {
      // nextSteps 缺席 = 整轮 failed / 闸合成判词那条路径 (实装后不强制)。给就拼进去, 不给就不带键。
      const v: Record<string, unknown> = {
        converged: false,
        score: 0,
        failureReason: reason,
        rejectedNodes: [],
      };
      if (nextSteps !== undefined) v.nextSteps = nextSteps;
      return { text: JSON.stringify(v), parsed: v, usage: { in: 1, out: 1 } };
    }) as never,
  } as ExecutorDagConfig);
  return { expands, journal: loadJournal() };
}

function loadJournal(): import('../../src/harness/continuity/types').NodeLoopJournal | null {
  return manager.loadNodeLoopJournal('handoff-ns-run', 'C');
}

describe('#228 轮间交接:nextSteps 必达', () => {
  test('★ judge 给了 nextSteps → 下一轮交接里逐字完整出现, 且在 <上一轮未通过> 块之外', async () => {
    // 怎么让它红 (实装前, 两条都该红):
    // ① `fixpoint.ts` 的 `FixpointVerdict` 还没有 `nextSteps` 字段 → judgeSend.parsed 里写它,
    //    TS 会直接编不过。
    // ② 即使绕过类型也跑起来了, renderHandoff 没把 nextSteps 纳入交接 → `expand` 里找不到 NEXT_STEPS, 断言 1 红。
    // ③ 即便并进 prevReason 也无法稳定在 `<上一轮未通过>` 之外(块边界被穿过), 断言 2 红。
    const { expands } = await run({ reason: reasonOf(200), nextSteps: NEXT_STEPS });
    const p = expands[1]!; // 第 2 轮的 conductor prompt = 收到上一轮交接的那一轮

    expect(p).toContain(NEXT_STEPS); // 逐字完整出现
    const body = blockBody(p);
    expect(body, '<上一轮未通过> 块必须存在').not.toBeNull();
    expect(body!).not.toContain(NEXT_STEPS); // 出现在**块之外**(tail 段)
  });

  test('★ 触发截断时 nextSteps 仍逐字完整出现(单一变量锁:必达块不参与预算)', async () => {
    // 怎么让它红 (反向自检): 在 `engine.ts` 的 `renderHandoff` 里, 删掉把 `nextSteps`
    // push 进 `mustReach` 的那一行 → 它回到 `body`, body 触发截断时被头切吃掉, 断言 1 红。
    // 这正是改动前的行为:判词尾部正好是被切掉的那一侧,而「下一步」偏偏在尾部。
    const { expands } = await run({ reason: reasonOf(3000), nextSteps: NEXT_STEPS });
    const p = expands[1]!;

    expect(p).toContain('交接硬上限'); // 前提: 这一轮确实触发了截断
    expect(p).toContain(NEXT_STEPS); // 而 nextSteps 照样逐字到了
    const body = blockBody(p)!;
    expect(body).not.toContain(NEXT_STEPS); // 仍在块外 —— 必达块走 tail 段, 与 NOVELTY 同形
  });

  test('★ judge 没给 nextSteps → 交接里没有 nextSteps 块标题, 也没有占位文本', async () => {
    // 怎么让它红 (反向自检): 在 `renderHandoff` 里给 nextSteps 缺席的路径写一句
    // `[无 nextSteps]` 之类的占位 → 这条断言的「不包含占位」红。
    // 或把 nextSteps 字段**永远**渲染成块 → 这条断言的「不包含 nextSteps 标题」红。
    const { expands } = await run({ reason: reasonOf(200) /* nextSteps 缺席 */ });
    const p = expands[1]!;

    // 不该出现的占位串 (实装不该编): 看见任意一条就红。
    const forbidden = [
      '[无 nextSteps]',
      '[无可执行下一步]',
      '[下一步待补]',
      'nextSteps: <空>',
      'nextSteps: undefined',
    ];
    for (const s of forbidden) expect(p).not.toContain(s);

    // nextSteps 字段名本身也不该作为块标记出现在 prompt 里 —— 没值就别挂标题。
    expect(p).not.toMatch(/<下一步[> \n]/);
    expect(p).not.toMatch(/<nextSteps[> \n]/i);
  });

  test('★ nextSteps 原文随 RoundVerdict 写入磁盘, 能从 NodeLoopJournal.verdicts 逐字读回', async () => {
    // 怎么让它红 (反向自检): `engine.ts` 里把 verdict.nextSteps 漏接到 roundVerdicts.push →
    // journal.verdicts 上的 RoundVerdict 没有该字段, 断言红。
    // 同时也是 #227 「判词写入磁盘」的延伸: 这一位钉的是 nextSteps **没被吞进 prevReason 字符串里**。
    const { journal } = await run({ reason: reasonOf(200), nextSteps: NEXT_STEPS, maxRounds: 2 });

    expect(journal, '节点级环 journal 必须写入磁盘').not.toBeNull();
    const verdicts = journal!.verdicts ?? [];
    expect(verdicts.length).toBeGreaterThanOrEqual(1);

    // 至少有一条 RoundVerdict 带 nextSteps 且逐字相等。
    const withNext = verdicts.filter((v) => v.nextSteps !== undefined);
    expect(withNext.length).toBeGreaterThanOrEqual(1);
    expect(withNext[0]!.nextSteps).toBe(NEXT_STEPS);
  });
});
