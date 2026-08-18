/**
 * **逐轮两道闸的裁决进 journal**(2026-08-06)。
 *
 * ## 它解锁的是一个早就写好、却一直判不了的决定
 *
 * D-I「以判据为准」只在**绿**的方向兑现:判据绿 → 直接收敛,judge 的票只记录。
 * 红的方向没有对称守卫 —— 判据红时 judge 仍可宣布收敛。上一程查过要不要补,
 * 判据先钉死在「出现过 `判据红 ∧ judge 说收敛` 才补」(免得给够不着的分支加兜底)。
 *
 * **而那个条件到今天都判不了 —— 逐轮的两个布尔谁都没记。**
 * journal 里的 `converged` 是节点级最终结论,答不了"第 2 轮判据红时 judge 说了什么"。
 * 这个文件钉住的就是那一位:记下来之后,那条预先声明的判据变成一次 grep。
 *
 * ⚠ **反向自检**:
 *  · 删掉 `roundVerdicts.push({...})` → 三条全红;
 *  · 把 `criterion` 的三态压成布尔(`freezeGreen ? 'green' : 'red'`)→「没配判据不是判据红」红;
 *  · 把 `judge` 在 `unreachable` 时记成 `'rejected'` → 那条也会红(此处未单列,见 types 的注)。
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runExecutorDagWithPlan } from '../../src/harness/dag/engine';
import { CheckpointManager } from '../../src/harness/continuity/checkpoint-manager';
import type { ConductorPlan } from '../../src/harness/conductor-plan';
import type { ExecutorDagConfig, GenerateFn } from '../../src/harness/dag/types';

const RUN = 'verdict-run';
let root: string;
let manager: CheckpointManager;
let saved: string | undefined;

beforeEach(() => {
  saved = process.env.OMD_DATA_HOME;
  delete process.env.OMD_DATA_HOME;
  root = mkdtempSync(join(tmpdir(), 'omd-verdict-'));
  manager = new CheckpointManager(root);
});
afterEach(() => {
  if (saved === undefined) delete process.env.OMD_DATA_HOME;
  else process.env.OMD_DATA_HOME = saved;
  rmSync(root, { recursive: true, force: true });
});

const SUB = JSON.stringify({ name: 's', nodes: { impl: { goal: '实装' } } });
const leafId = (p: string): string => /\[omd leaf: ([^\]]+)\]/.exec(p)?.[1] ?? '';

const plan = (maxRounds: number): ConductorPlan =>
  ({ name: 'outer', nodes: { C: { goal: '把这件事做完', executor: 'conductor', max_rounds: maxRounds } } }) as ConductorPlan;

const generate: GenerateFn = async (req) => {
  const text = String(req.messages.find((m) => m.role === 'user')?.content ?? '');
  return leafId(text)
    ? { text: 'out', usage: { in: 1, out: 1 } }
    : { text: SUB, usage: { in: 1, out: 1 } };
};

/** judge fake:每轮返一个固定裁决。 */
const judgeOf = (converged: boolean): NonNullable<ExecutorDagConfig['judgeSend']> =>
  (async () => {
    const v = { converged, score: converged ? 1 : 0, failureReason: converged ? '' : '还不行', rejectedNodes: [] as string[] };
    return { text: JSON.stringify(v), parsed: v, usage: { in: 1, out: 1 } };
  }) as never;

const run = async (over: Partial<ExecutorDagConfig>, maxRounds = 1): Promise<void> => {
  await runExecutorDagWithPlan(plan(maxRounds), {
    conductorModel: 'c:m',
    leafModel: 'l:m',
    agentTemplates: new Map(),
    generate,
    continuity: { manager, runId: RUN, repoRoot: root },
    ...over,
  } as unknown as ExecutorDagConfig);
};

describe('逐轮裁决进 journal (D-I 那条预设判据的观测面)', () => {
  test('判据绿 → 记 green, 而 **judge 的票单独记下来** (它不决定, 但要看得见)', async () => {
    await run({
      freezeCriterion: { command: 'true' },
      commandRunner: async () => ({ text: '', exitCode: 0, usage: { in: 0, out: 0 }, timedOut: false, signal: null }),
      // judge 说没成, 但判据绿说了算 —— 「judge 太紧」那一格全靠这条记录才观测得到
      judgeSend: judgeOf(false),
    });
    const j = manager.loadNodeLoopJournal(RUN, 'C');
    expect(j?.verdicts).toEqual([{ round: 1, criterion: 'green', judge: 'rejected' }]);
    expect(j?.converged).toBe(true); // 判据说了算
  });

  test('⭐ 判据红 ∧ judge 说收敛 —— **这正是那条预设判据要找的组合**, 现在它在盘上了', async () => {
    await run({
      freezeCriterion: { command: 'false' },
      commandRunner: async () => ({ text: '', exitCode: 1, usage: { in: 0, out: 0 }, timedOut: false, signal: null }),
      judgeSend: judgeOf(true),
    });
    const j = manager.loadNodeLoopJournal(RUN, 'C');
    const hit = (j?.verdicts ?? []).filter((v) => v.criterion === 'red' && v.judge === 'converged');
    expect(hit).toHaveLength(1);
    // ⚠ 行为**没改**: judge 照旧能宣布收敛。这条只证明它现在**看得见**了。
    expect(j?.converged).toBe(true);
  });

  test('没配冻结判据 → criterion 记 `none`, **不是** `red`(两者下一步不同)', async () => {
    // ⚠ 要 `judge_final` 才走得到判决点: 单轮档 + 没有 judge_final + 没配判据时,
    //   引擎**根本不请 judge**(没有下一轮可去, 判了也没有用它的地方)—— 那一档一条裁决都不该有,
    //   而不是记一条"两道闸都没过"。下面那条空判就是钉这个的。
    await runExecutorDagWithPlan(
      { name: 'outer', nodes: { C: { goal: '做完', executor: 'conductor', max_rounds: 1, judge_final: true } } } as ConductorPlan,
      {
        conductorModel: 'c:m', leafModel: 'l:m', agentTemplates: new Map(), generate,
        continuity: { manager, runId: RUN, repoRoot: root }, judgeSend: judgeOf(true),
      } as unknown as ExecutorDagConfig,
    );
    const j = manager.loadNodeLoopJournal(RUN, 'C');
    expect(j?.verdicts?.[0]?.criterion).toBe('none');
    expect((j?.verdicts ?? []).some((v) => v.criterion === 'red')).toBe(false);
  });

  test('两道闸一道都没跑(单轮 + 无 judge_final + 无判据)→ 一条裁决都不记, 不编一条"都没过"', async () => {
    await run({ judgeSend: judgeOf(true) });
    const j = manager.loadNodeLoopJournal(RUN, 'C');
    expect(j?.verdicts ?? []).toHaveLength(0); // 没判过 ≠ 判了没过
  });

  test('resume 接回旧轮的裁决 —— 断在第 1 轮再续跑, 第 1 轮那条不许凭空消失', async () => {
    manager.writeNodeLoopJournal(RUN, {
      runId: RUN,
      nodeId: 'C',
      completedRounds: 1,
      poisoned: [],
      verdicts: [{ round: 1, criterion: 'red', judge: 'rejected' }],
      updatedAt: new Date().toISOString(),
      schemaVersion: 1,
    });
    await run(
      {
        continuity: { manager, runId: RUN, repoRoot: root, resume: true },
        freezeCriterion: { command: 'true' },
        commandRunner: async () => ({ text: '', exitCode: 0, usage: { in: 0, out: 0 }, timedOut: false, signal: null }),
        judgeSend: judgeOf(true),
      },
      2,
    );
    const j = manager.loadNodeLoopJournal(RUN, 'C');
    expect(j?.verdicts?.[0]).toEqual({ round: 1, criterion: 'red', judge: 'rejected' }); // 旧的还在
    expect(j?.verdicts?.[1]?.round).toBe(2); // 新的接在后面
  });
});
