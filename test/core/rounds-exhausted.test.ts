/**
 * **内环轮数用尽 = `rounds-exhausted`,不是 `infra-error`**(2026-08-06)。
 *
 * ## 它治的是什么
 *
 * 盘上实测:10 条 `infra-error` 里 **9 条**是这一格,而且是**同一个 run 的同一个节点**
 * 在 8 小时里被重入 9 次、每次 **0–1ms** 死在同一行。而 `infra-error` 的判词写着
 * 「重试 / 换池」—— **对这一格重试一万次都是同样的 0ms 死**。
 * 更坏的是 `infra-error` 在 run 级 severity 里排第一,于是整跑的结论被一个"没轮次了"
 * 盖成"引擎坏了"。**两个相反的下一步共用一个词** —— 正是 `node-failure.ts` 立身要治的形态。
 *
 * ## ⚠ 反向自检(仓规:一条永远绿的闸不是闸)
 *
 *  · 把 `executor-dag` 那行改回 `failureKind: 'infra-error'` → 「归 rounds-exhausted」与
 *    「run 级念 blocked」两条立刻红;
 *  · 把判词里的 `journalPath` 换成写死的 `'_loop-C.json'` → 「判词给的是真路径」红
 *    (真路径在临时目录里,写死的猜不中);
 *  · 把 `NODE_TO_RUN['rounds-exhausted']` 改回 `'infra-error'` → 「不许盖过其它成因」红。
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runExecutorDagWithPlan } from '../../src/harness/dag/engine';
import { CheckpointManager } from '../../src/harness/continuity/checkpoint-manager';
import { FAILURE_KIND_INFO } from '../../src/harness/node-failure';
import { deriveRunOutcome } from '../../src/harness/run-outcome';
import type { ConductorPlan } from '../../src/harness/conductor-plan';
import type { ExecutorDagConfig, GenerateFn } from '../../src/harness/dag/types';

const RUN = 'exhausted-run';
let root: string;
let manager: CheckpointManager;
let saved: string | undefined;

beforeEach(() => {
  saved = process.env.OMD_DATA_HOME;
  delete process.env.OMD_DATA_HOME;
  root = mkdtempSync(join(tmpdir(), 'omd-exh-'));
  manager = new CheckpointManager(root);
});
afterEach(() => {
  if (saved === undefined) delete process.env.OMD_DATA_HOME;
  else process.env.OMD_DATA_HOME = saved;
  rmSync(root, { recursive: true, force: true });
});

const plan = (maxRounds: number): ConductorPlan =>
  ({ name: 'outer', nodes: { C: { goal: '把这件事做完', executor: 'conductor', max_rounds: maxRounds } } }) as ConductorPlan;

/** 盘上那份 journal 的形状:跑满了轮数、judge 最后一轮仍判未达标。 */
const writeExhaustedJournal = (rounds: number): void =>
  manager.writeNodeLoopJournal(RUN, {
    runId: RUN,
    nodeId: 'C',
    completedRounds: rounds,
    poisoned: [],
    converged: false,
    stop: { kind: 'not-converged', evidence: `轮数用尽仍未收敛 (跑满 ${rounds} / 上限 ${rounds} 轮)`, atRound: rounds },
    updatedAt: new Date().toISOString(),
    schemaVersion: 1,
  });

describe('内环轮数用尽的重入', () => {
  test('归 rounds-exhausted 且**零执行** —— 不是 infra-error(重试一万次都是同样的 0ms 死)', async () => {
    writeExhaustedJournal(2);
    let calls = 0;
    const generate: GenerateFn = async () => {
      calls++;
      return { text: '{"name":"s","nodes":{"impl":{"goal":"实装"}}}', usage: { in: 1, out: 1 } };
    };
    const r = await runExecutorDagWithPlan(plan(2), {
      conductorModel: 'c:m',
      leafModel: 'l:m',
      agentTemplates: new Map(),
      generate,
      continuity: { manager, runId: RUN, repoRoot: root, resume: true },
    } as unknown as ExecutorDagConfig);

    expect(r.results.C?.status).toBe('failed');
    expect(r.results.C?.failureKind).toBe('rounds-exhausted'); // ← 改动前是 'infra-error'
    expect(calls).toBe(0); // 零执行: 一个模型都没打, 这正是"重试无用"的原因
    expect(r.results.C?.converged).not.toBe(true); // 不谎报收敛
  });

  test('判词给的是**真**的 journal 路径 —— 猜不到的出口等于没出口', async () => {
    writeExhaustedJournal(1);
    const r = await runExecutorDagWithPlan(plan(1), {
      conductorModel: 'c:m',
      leafModel: 'l:m',
      agentTemplates: new Map(),
      generate: (async () => ({ text: '{}', usage: { in: 0, out: 0 } })) as GenerateFn,
      continuity: { manager, runId: RUN, repoRoot: root, resume: true },
    } as unknown as ExecutorDagConfig);

    const out = r.results.C?.output ?? '';
    const path = manager.loopPath(RUN, 'C');
    expect(existsSync(path)).toBe(true); // 判词指的那个文件真的在
    expect(out).toContain(path); // 且判词里给的就是它
    expect(out).toContain('max_rounds'); // 出口①
    expect(out).toContain('原样重试没有用'); // 明说别重试
  });

  test('词表:retryable=false 且下一步与 infra-error 不同(两格判词一样就该合并)', () => {
    const ex = FAILURE_KIND_INFO['rounds-exhausted'];
    expect(ex.retryable).toBe(false);
    expect(ex.loopState).toBe('BLOCKED');
    expect(ex.nextAction).not.toBe(FAILURE_KIND_INFO['infra-error']!.nextAction);
    expect(FAILURE_KIND_INFO['infra-error']!.retryable).toBe(true); // 对照: 那一格才是"重试有用"
  });

  test('run 级:轮数用尽**不许**盖过同图里的其它成因念成"引擎坏了"', () => {
    const outcome = deriveRunOutcome({
      results: {
        C: { status: 'failed', failureKind: 'rounds-exhausted' },
        v: { status: 'failed', failureKind: 'assert-failed' },
      },
    } as never);
    // blocked 的严重度低于 infra-error: 改动前这张图会被念成 infra-error ("去看栈"), 而该看的是判据。
    expect(outcome).toBe('blocked');
  });
});
