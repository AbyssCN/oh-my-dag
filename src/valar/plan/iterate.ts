/**
 * plan/iterate —— valar **内层 DAG** (in-process executor-dag) 的外层 fixpoint 迭代。
 *
 * 把 runExecutorDag (conductor 规划一次 → fan-out leaves → results, 无迭代) 套进 runFixpoint:
 *
 *   一轮 = 一张静态 applicative 图 (runExecutorDag) → judge 看整轮结果收敛没 →
 *   不满意把失败原因注入下一轮 task → conductor 据此重画 → 直到收敛 / 触 maxRounds。
 *
 * 这是 **workflow 级 fixpoint** (重画整张内层图)。node 级 refine (重跑单 leaf) 是 PG DAG verifier
 * 路径的事 (valinor 外层), 不在 valar in-process 这层 —— in-process leaf 无 per-node postcondition,
 * 整轮 judge 是最自然的收敛粒度。
 *
 * 默认收敛 judge 共用 plan/llm-judge (与 replanner 同一套); 全注入 (_runDag / judge) → 无 DB /
 * 无模型即可完整测试。onComplete 由本层闭包**每轮**显式调用 (不依赖 _runDag 实现透传)。
 */
import {
  runExecutorDag,
  type ExecutorDagConfig,
  type ExecutorDagResult,
} from '../executor-dag';
import {
  runFixpoint,
  DEFAULT_MAX_ROUNDS,
  type FixpointResult,
  type FixpointJudge,
} from './fixpoint';
import { makeLlmConvergenceJudge } from './llm-judge';

export interface IterateConfig extends ExecutorDagConfig {
  /** 最大迭代轮数 (默认 DEFAULT_MAX_ROUNDS=3)。 */
  maxRounds?: number;
  /** 收敛 judge 模型 'provider:modelId' (默认 = leafModel)。仅默认 LLM judge 用。 */
  judgeModel?: string;
  /** 收敛阈值 (进 judge prompt 作 bar)。默认 0.8。 */
  convergenceThreshold?: number;
  /** 注入式收敛 judge (默认 = LLM judge)。测试 / 自定义评判传这个。 */
  judge?: FixpointJudge<ExecutorDagResult>;
  /** 注入式 runDag (默认 runExecutorDag)。测试传 fake, 不碰 live 模型。 */
  _runDag?: (task: string, config: ExecutorDagConfig) => Promise<ExecutorDagResult>;
}

export type IterateResult = FixpointResult<ExecutorDagResult>;

/** 把一轮 DAG 结果的 leaf 输出汇成一段给 judge 看 (失败节点标注, 截断防爆 prompt)。 */
export function summarizeDagResult(r: ExecutorDagResult, maxPerNode = 1200): string {
  const lines: string[] = [`plan: ${r.plan.name} · ${r.levels.length} levels · ${Object.keys(r.results).length} nodes`];
  for (const [id, leaf] of Object.entries(r.results)) {
    const head = `### ${id} [${leaf.status}]`;
    const body = leaf.status === 'failed' ? '(failed)' : (leaf.output ?? '').slice(0, maxPerNode);
    lines.push(`${head}\n${body}`);
  }
  return lines.join('\n\n');
}

/**
 * 跑 valar 内层 DAG 的外层 fixpoint 迭代。
 * 每轮重画整张内层图 (conductor 据上轮失败原因重新分解), 直到 judge 判收敛或触 maxRounds。
 *
 * @param task   原始任务
 * @param config conductor/leaf 模型 (必填) + 迭代参数 + 注入点 (_runDag / judge)
 */
export async function iterateExecutorDag(task: string, config: IterateConfig): Promise<IterateResult> {
  if (!config.conductorModel) throw new Error('iterate: conductorModel 必填 (无硬默认)');
  if (!config.leafModel) throw new Error('iterate: leafModel 必填 (无硬默认)');

  const runDag = config._runDag ?? runExecutorDag;
  const judge =
    config.judge ??
    makeLlmConvergenceJudge<ExecutorDagResult>({
      judgeModel: config.judgeModel || config.leafModel,
      task,
      threshold: config.convergenceThreshold,
      // 内层 DAG 整轮总算"跑完了"(单 leaf 失败在 summary 里); roundRunner 抛才是整轮崩 (fixpoint 接住)。
      extract: (r) => ({ status: 'done', summary: summarizeDagResult(r) }),
    });
  const maxRounds = config.maxRounds ?? DEFAULT_MAX_ROUNDS;

  // onComplete 由本层每轮显式调 (剥出, 不随 dagConfig 透传 → 防 _runDag=runExecutorDag 双调)。
  const { onComplete, ...dagConfig } = config;

  return runFixpoint<ExecutorDagResult>(
    task,
    async (roundInput) => {
      const res = await runDag(roundInput, dagConfig);
      if (onComplete) await onComplete(res);
      return res;
    },
    judge,
    { maxRounds },
  );
}
