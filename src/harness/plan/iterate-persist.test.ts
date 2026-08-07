/**
 * 外层 fixpoint 持久化 (INV-P2-6) —— 崩溃恢复不丢已批准制品, 也不丢毒集。
 *
 * 补的缺口: `dag_resume` 恢复的是**单张内层图**的 `_dag.json`; 外层轮 (iterateExecutorDag) 的轮次、
 * 跨轮复用源、D-4 毒集此前全是进程内闭包变量 —— 进程一死全丢, 重跑从第 1 轮起且毒集清零。
 * 毒集清零最坏: **被拒的产出会因此复活**, 比不复用更糟。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { iterateExecutorDag } from './iterate';
import { merkleFingerprints } from '../plan-passes/semantic-key';
import { CheckpointManager } from '../continuity/checkpoint-manager';
import type { ConductorPlan } from '../conductor-plan';
import type { ExecutorDagResult, PriorExec } from '../dag/types';

const plan: ConductorPlan = { name: 'p', nodes: { a: { goal: '不变的活' }, b: { goal: '要修的活' } } };

const stub = (ids: string[]): ExecutorDagResult =>
  ({
    plan,
    sessionId: 's',
    levels: [ids],
    results: Object.fromEntries(
      ids.map((id) => [id, { id, status: 'done', kind: 'inproc', output: `out:${id}`, deps: [], usage: { in: 1, out: 1 } }]),
    ),
    reusedNodes: [],
    usage: { conductor: { in: 0, out: 0 }, leavesIn: 0, leavesOut: 0, leavesCacheHit: 0 },
  }) as unknown as ExecutorDagResult;

const freshContinuity = (resume?: boolean) => {
  const root = mkdtempSync(join(tmpdir(), 'omd-fixpoint-'));
  return { manager: new CheckpointManager(root), runId: 'run-1', ...(resume ? { resume: true } : {}) };
};

/** 跑 iterate; judge 按 verdicts 数组逐轮给判决。回收每轮拿到的 prior。 */
const run = async (
  continuity: ReturnType<typeof freshContinuity>,
  verdicts: Array<{ converged: boolean; rejectedNodes?: string[]; failureReason?: string }>,
  maxRounds = 3,
) => {
  const priors: (PriorExec | undefined)[] = [];
  const inputs: string[] = [];
  let i = 0;
  const res = await iterateExecutorDag('修好它', {
    conductorModel: 'c:m',
    leafModel: 'l:m',
    maxRounds,
    continuity,
    judge: async () => {
      const v = verdicts[Math.min(i++, verdicts.length - 1)]!;
      return { ...v, score: v.converged ? 1 : 0 };
    },
    _runDag: async (task, _cfg, prior) => {
      priors.push(prior);
      inputs.push(task);
      return stub(['a', 'b']);
    },
  });
  return { priors, inputs, res };
};

describe('外层 journal 落地 (INV-P2-6)', () => {
  test('每轮判完写 _fixpoint.json: 轮次 + 毒集 + 复用源', async () => {
    const c = freshContinuity();
    await run(c, [{ converged: false, rejectedNodes: ['b'], failureReason: 'b 是编的' }, { converged: true }]);
    const j = c.manager.loadFixpointJournal('run-1');
    expect(j).not.toBeNull();
    expect(j!.completedRounds).toBe(2);
    expect(j!.converged).toBe(true);
    expect(j!.poisoned).toEqual([merkleFingerprints(plan).get('b')!]);
    expect(j!.lastRound?.plan.name).toBe('p');
    expect(Object.keys(j!.lastRound?.results ?? {}).sort()).toEqual(['a', 'b']);
  });

  test('未收敛轮把失败原因也记下 (恢复后要接回 enrich)', async () => {
    const c = freshContinuity();
    await run(c, [{ converged: false, rejectedNodes: ['b'], failureReason: 'b 是编的' }], 1);
    const j = c.manager.loadFixpointJournal('run-1');
    expect(j!.completedRounds).toBe(1);
    expect(j!.converged).toBe(false);
    expect(j!.prevReason).toBe('b 是编的');
  });

  test('没配 continuity → 不写, 也不炸 (纯内存模式零回归)', async () => {
    const priors: (PriorExec | undefined)[] = [];
    const r = await iterateExecutorDag('t', {
      conductorModel: 'c:m',
      leafModel: 'l:m',
      maxRounds: 1,
      judge: async () => ({ converged: true, score: 1 }),
      _runDag: async (_t, _c, prior) => {
        priors.push(prior);
        return stub(['a']);
      },
    });
    expect(r.converged).toBe(true);
  });
});

describe('外层恢复 (INV-P2-6)', () => {
  test('崩在第 1 轮后 → resume 从第 2 轮起跑, 不重跑第 1 轮', async () => {
    const c = freshContinuity();
    await run(c, [{ converged: false, rejectedNodes: ['b'], failureReason: 'b 是编的' }], 1); // 触 maxRounds 停

    // 新进程: 同 runId + resume
    const c2 = { ...c, resume: true };
    const { priors, inputs, res } = await run(c2, [{ converged: true }], 3);
    expect(res.rounds).toHaveLength(1); // 本进程只跑了一轮 —— 第 2 轮
    // 恢复的失败原因进了本轮 input (enrich 生效, 不是从原始 task 重来)
    expect(inputs[0]).toContain('b 是编的');
    // 复用源接回来了
    expect(priors[0]?.plan.name).toBe('p');
    expect(priors[0]?.results.a?.output).toBe('out:a');
  });

  test('毒集跨进程存活 —— 被拒产出不因崩溃复活', async () => {
    const c = freshContinuity();
    await run(c, [{ converged: false, rejectedNodes: ['b'], failureReason: 'r' }], 1);

    const { priors } = await run({ ...c, resume: true }, [{ converged: true }], 3);
    expect([...(priors[0]?.poisoned ?? [])]).toEqual([merkleFingerprints(plan).get('b')!]);
  });

  test('不带 resume → 不读 journal, 从第 1 轮起 (旧行为)', async () => {
    const c = freshContinuity();
    await run(c, [{ converged: false, rejectedNodes: ['b'], failureReason: 'r' }], 1);

    const { priors, inputs } = await run({ ...c }, [{ converged: true }], 3);
    expect(priors[0]).toBeUndefined(); // 首轮无 prior
    expect(inputs[0]).not.toContain('ITERATION REFINEMENT');
  });

  test('maxRounds 是**总**上界: journal 说跑满了, 恢复也不额外多跑', async () => {
    const c = freshContinuity();
    // maxRounds=2 跑满两轮仍未收敛
    await run(c, [{ converged: false, rejectedNodes: ['b'], failureReason: 'r' }], 2);
    expect(c.manager.loadFixpointJournal('run-1')!.completedRounds).toBe(2);

    // 恢复时仍给 maxRounds=2 → 起跑点被钳到第 2 轮, 只判一次, 不是再来两轮
    const { res } = await run({ ...c, resume: true }, [{ converged: true }], 2);
    expect(res.rounds).toHaveLength(1);
  });

  test('fail-closed 状态也跨进程: 上一轮开不出票 → 恢复后照样不复用', async () => {
    const c = freshContinuity();
    await run(c, [{ converged: false, failureReason: '说不出哪错了' }], 1); // 无 rejectedNodes
    expect(c.manager.loadFixpointJournal('run-1')!.distrustLastRound).toBe(true);

    const { priors } = await run({ ...c, resume: true }, [{ converged: true }], 3);
    expect(priors[0]).toBeUndefined(); // 不可信的那轮没被当复用源接回来
  });
});
