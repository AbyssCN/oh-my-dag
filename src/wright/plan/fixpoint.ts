/**
 * plan/fixpoint —— 通用**外层 fixpoint** 原语 (Kleene 迭代到不动点 / 有界终止)。
 *
 * DAG 迭代研究 (docs/knowledge/research/dag-iteration-best-of-n-2026-06-03.md) 裁决:
 * xihe 现纯 applicative, 正路 = **保持每轮 applicative + 外层 fixpoint**, 不升全图 monadic。
 * 这一层是两个引擎共用的迭代核 —— 把"循环"放在静态图**外面**:
 *
 *   wright 内层 DAG (in-process) → iterate.ts 绑 runExecutorDag
 *   xihe 外层 DAG (PG)        → replanner.ts 绑 PG workflow round-runner
 *
 * 每轮: enrich(input) → roundRunner(跑一张静态 applicative 图) → judge(收敛谓词)。
 * converged → 停 (不动点); 否则把 failureReason **单调注入** (只加不撤, CALM) 进下一轮 input,
 * 直到收敛或触 maxRounds (well-founded 有界终止)。
 *
 * 纯逻辑 + 全注入 (roundRunner / judge / enrich) → 无 DB / 无模型即可完整测试。
 */

/** 一轮的收敛判决 (judge 输出)。converged=true ⟺ 不动点到达, 停止迭代。 */
export interface FixpointVerdict {
  converged: boolean;
  /** [0,1] 质量分 (可选, 记录 + 调用方 early-exit 用)。 */
  score?: number;
  /** converged=false 时: 下一轮改进方向, 经 enrich 注入下一轮 input。 */
  failureReason?: string;
}

/** 一轮快照 (审计 + 单调 context 溯源)。 */
export interface FixpointRound<R> {
  /** 1-based 轮次。 */
  round: number;
  /** 本轮 roundRunner 的产出。 */
  result: R;
  /** 本轮 judge 判决。 */
  verdict: FixpointVerdict;
}

/**
 * 终止原因:
 *  - converged   : judge 判不动点到达 (正常收敛)
 *  - exhausted   : 触 maxRounds 仍未收敛 (有界终止, 非异常)
 *  - failed      : 某轮 roundRunner / judge 抛错 (已有先前成功轮)
 *  - degenerate  : 第一轮 roundRunner 即抛 (零产出)
 */
export type FixpointStatus = 'converged' | 'exhausted' | 'failed' | 'degenerate';

export interface FixpointResult<R> {
  /** 所有已完成轮 (按轮次升序, 只追加)。 */
  rounds: FixpointRound<R>[];
  /** 最后一轮 (converged/exhausted/failed); degenerate 时为 null。 */
  finalRound: FixpointRound<R> | null;
  converged: boolean;
  status: FixpointStatus;
  /** failed/degenerate 时的错误信息 (roundRunner / judge 抛的原因; 调试唯一入口)。 */
  error?: string;
}

export interface FixpointOpts {
  /** 最大轮数 (well-founded 终止上界)。< 1 → 钳到 1。 */
  maxRounds: number;
}

/** roundRunner: 给定本轮 (已 enrich 的) input + 轮次 → 产出 result。抛错 = 本轮 DAG 整体崩。 */
export type RoundRunner<R> = (input: string, round: number) => Promise<R>;

/** judge: 看 result → 收敛判决。纯函数语义 (无副作用); 抛错 = fail-closed (判未收敛并停, 不静默 pass)。 */
export type FixpointJudge<R> = (result: R, round: number) => Promise<FixpointVerdict>;

/** enrich: 把上一轮 failureReason 单调注入下一轮 input (只加不撤, CALM 单调性)。 */
export type EnrichFn = (originalInput: string, prevReason: string, round: number) => string;

/** 默认最大轮数 (1-dev harness: 3 轮以内收敛, 超出 token ROI 递减)。 */
export const DEFAULT_MAX_ROUNDS = 3;

/**
 * 默认 enrich: round 1 用原 input; 之后把上一轮失败原因追加成 refinement 段。
 * 只注入"上一轮"原因 (最 actionable), 不堆全历史 → 防 context 膨胀。
 */
export function defaultEnrich(originalInput: string, prevReason: string, round: number): string {
  if (!prevReason || round <= 1) return originalInput;
  return [
    originalInput,
    '',
    `===== ITERATION REFINEMENT (round ${round}) =====`,
    `Previous attempt did not converge. Root cause: ${prevReason}`,
    'Produce an improved result that specifically addresses this. Do NOT repeat the same failure.',
  ].join('\n');
}

/**
 * 跑外层 fixpoint。两个 DAG 引擎共用 —— 区别只在 roundRunner (wright inproc / xihe PG)。
 *
 * 不变量:
 *  - rounds.length ≤ maxRounds (有界, well-founded)
 *  - converged=true 只在 judge 明确判定时 (不靠字符串相等, 防假收敛)
 *  - roundRunner 抛 → 停 (failed/degenerate), 不重试整图 (重试是节点级 recovery 的事, 不在此层)
 *  - judge 抛 → fail-closed: 该轮判未收敛并停, 绝不静默当 pass, 也不无限转
 */
export async function runFixpoint<R>(
  input: string,
  roundRunner: RoundRunner<R>,
  judge: FixpointJudge<R>,
  opts: FixpointOpts,
  enrich: EnrichFn = defaultEnrich,
): Promise<FixpointResult<R>> {
  const maxRounds = Math.max(1, Math.floor(opts.maxRounds));
  const rounds: FixpointRound<R>[] = [];
  let prevReason = '';

  for (let round = 1; round <= maxRounds; round++) {
    const roundInput = enrich(input, prevReason, round);

    // 跑一张静态 applicative 图。抛 → 停 (第一轮 = degenerate, 否则 = failed)。
    let result: R;
    try {
      result = await roundRunner(roundInput, round);
    } catch (e) {
      return {
        rounds,
        finalRound: rounds.length > 0 ? rounds[rounds.length - 1]! : null,
        converged: false,
        status: rounds.length === 0 ? 'degenerate' : 'failed',
        error: `round ${round} runner failed: ${(e as Error).message.slice(0, 200)}`,
      };
    }

    // 收敛谓词。judge 抛 → fail-closed (记未收敛 + 停)。
    let verdict: FixpointVerdict;
    try {
      verdict = await judge(result, round);
    } catch (e) {
      const msg = (e as Error).message.slice(0, 200);
      const fr: FixpointRound<R> = {
        round,
        result,
        verdict: { converged: false, failureReason: `judge failed: ${msg}` },
      };
      rounds.push(fr);
      return { rounds, finalRound: fr, converged: false, status: 'failed', error: `round ${round} judge failed: ${msg}` };
    }

    const fr: FixpointRound<R> = { round, result, verdict };
    rounds.push(fr);

    if (verdict.converged) {
      return { rounds, finalRound: fr, converged: true, status: 'converged' };
    }
    prevReason = verdict.failureReason ?? '';
  }

  // 触顶: 有界终止 (well-founded), 非异常 —— 返回最后一轮作 best-effort 产出。
  return {
    rounds,
    finalRound: rounds[rounds.length - 1] ?? null,
    converged: false,
    status: 'exhausted',
  };
}
