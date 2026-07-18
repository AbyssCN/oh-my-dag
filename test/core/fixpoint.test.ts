import { describe, expect, test } from 'bun:test';
import {
  runFixpoint,
  defaultEnrich,
  DEFAULT_MAX_ROUNDS,
  type FixpointVerdict,
  type RoundRunner,
  type FixpointJudge,
} from '../../src/harness/plan/fixpoint';

// 通用外层 fixpoint 原语 — 纯逻辑, 全注入 (roundRunner/judge/enrich), 无 DB / 无模型。
// 证: 收敛即停 / 有界终止 / roundRunner 抛 (failed·degenerate) / judge fail-closed / 单调 enrich 注入。

/** roundRunner: 回显本轮 input (用于断言 enrich 注入)。 */
const echoRunner: RoundRunner<string> = async (input) => input;

/** judge 工厂: 第 convergeAt 轮起判收敛; 之前判未收敛并给 failureReason。 */
function judgeAt(convergeAt: number, reason = 'need-more'): FixpointJudge<string> {
  return async (_result, round): Promise<FixpointVerdict> =>
    round >= convergeAt
      ? { converged: true, score: 1 }
      : { converged: false, score: 0.3, failureReason: `${reason}-${round}` };
}

describe('runFixpoint (generic outer fixpoint)', () => {
  test('round 1 收敛 → 立即停, rounds=1, status=converged', async () => {
    const r = await runFixpoint('task', echoRunner, judgeAt(1), { maxRounds: 5 });
    expect(r.status).toBe('converged');
    expect(r.converged).toBe(true);
    expect(r.rounds.length).toBe(1);
    expect(r.finalRound?.round).toBe(1);
  });

  test('round 2 收敛 + enrich 把 round1 失败原因注入 round2 input (单调)', async () => {
    const seen: string[] = [];
    const runner: RoundRunner<string> = async (input) => {
      seen.push(input);
      return input;
    };
    const r = await runFixpoint('原始任务', runner, judgeAt(2, 'fix-X'), { maxRounds: 5 });
    expect(r.status).toBe('converged');
    expect(r.rounds.length).toBe(2);
    // round1 input = 原始任务 (无 refinement)
    expect(seen[0]).toBe('原始任务');
    // round2 input 含 round1 的 failureReason
    expect(seen[1]).toContain('ITERATION REFINEMENT');
    expect(seen[1]).toContain('fix-X-1');
    expect(seen[1]).toContain('原始任务');
  });

  test('永不收敛 → 触 maxRounds, status=exhausted, 不抛, rounds=maxRounds', async () => {
    const r = await runFixpoint('t', echoRunner, judgeAt(99), { maxRounds: 3 });
    expect(r.status).toBe('exhausted');
    expect(r.converged).toBe(false);
    expect(r.rounds.length).toBe(3);
    expect(r.finalRound?.round).toBe(3);
  });

  test('roundRunner 第 2 轮抛 → status=failed, finalRound=round1 (保留先前成功轮) + error 含原因', async () => {
    const runner: RoundRunner<string> = async (input, round) => {
      if (round === 2) throw new Error('boom-r2');
      return input;
    };
    const r = await runFixpoint('t', runner, judgeAt(99), { maxRounds: 5 });
    expect(r.status).toBe('failed');
    expect(r.converged).toBe(false);
    expect(r.rounds.length).toBe(1);
    expect(r.finalRound?.round).toBe(1);
    expect(r.error).toContain('boom-r2');
  });

  test('roundRunner 在最后一轮抛 → status=failed, finalRound=倒数第二轮', async () => {
    const runner: RoundRunner<string> = async (_input, round) => {
      if (round === 3) throw new Error('last-round-boom');
      return 'ok';
    };
    const r = await runFixpoint('t', runner, judgeAt(99), { maxRounds: 3 });
    expect(r.status).toBe('failed');
    expect(r.rounds.length).toBe(2);
    expect(r.finalRound?.round).toBe(2);
    expect(r.error).toContain('last-round-boom');
  });

  test('judge 在第 2 轮抛 (fail-closed 安全路径) → status=failed, finalRound=round2, rounds=2', async () => {
    let judgeCall = 0;
    const judge: FixpointJudge<string> = async () => {
      judgeCall++;
      if (judgeCall === 2) throw new Error('judge-down-r2');
      return { converged: false, score: 0.3, failureReason: 'need-more' };
    };
    const r = await runFixpoint('t', echoRunner, judge, { maxRounds: 5 });
    expect(r.status).toBe('failed');
    expect(r.rounds.length).toBe(2);
    expect(r.finalRound?.round).toBe(2);
    expect(r.finalRound?.verdict.failureReason).toContain('judge failed');
    expect(r.error).toContain('judge-down-r2');
  });

  test('roundRunner 第 1 轮即抛 → status=degenerate, finalRound=null', async () => {
    const runner: RoundRunner<string> = async () => {
      throw new Error('boom-1');
    };
    const r = await runFixpoint('t', runner, judgeAt(1), { maxRounds: 3 });
    expect(r.status).toBe('degenerate');
    expect(r.converged).toBe(false);
    expect(r.rounds.length).toBe(0);
    expect(r.finalRound).toBeNull();
    expect(r.error).toContain('boom-1');
  });

  test('judge 抛 → fail-closed: 该轮记未收敛 + 停 (status=failed), 不静默 pass 不无限转', async () => {
    const judge: FixpointJudge<string> = async () => {
      throw new Error('judge-down');
    };
    const r = await runFixpoint('t', echoRunner, judge, { maxRounds: 5 });
    expect(r.status).toBe('failed');
    expect(r.converged).toBe(false);
    expect(r.rounds.length).toBe(1);
    expect(r.finalRound?.verdict.converged).toBe(false);
    expect(r.finalRound?.verdict.failureReason).toContain('judge failed');
  });

  test('maxRounds < 1 → 钳到 1', async () => {
    const r = await runFixpoint('t', echoRunner, judgeAt(99), { maxRounds: 0 });
    expect(r.rounds.length).toBe(1);
    expect(r.status).toBe('exhausted');
  });

  test('defaultEnrich: round1 不改; round>1 含 refinement + 原 input', () => {
    expect(defaultEnrich('orig', 'reason', 1)).toBe('orig');
    expect(defaultEnrich('orig', '', 2)).toBe('orig'); // 无 reason 也不改
    const e = defaultEnrich('orig', 'because-Y', 2);
    expect(e).toContain('orig');
    expect(e).toContain('because-Y');
    expect(e).toContain('round 2');
  });

  test('DEFAULT_MAX_ROUNDS = 3', () => {
    expect(DEFAULT_MAX_ROUNDS).toBe(3);
  });
});
