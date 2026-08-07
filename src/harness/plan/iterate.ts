/**
 * plan/iterate —— omd **内层 DAG** (in-process executor-dag) 的外层 fixpoint 迭代。
 *
 * ⚠ **自主 goal 引擎已不走这条** (D-F, 2026-07-30): `runGoal` 的两段都改成了一个带内环的
 * `executor:'conductor'` 节点 (环封节点内, 状态落 `_loop-<nodeId>.json`)。留在这里的调用方只剩
 * **两个手动 slash 命令** —— `/iterate` (iterate-extension) 与 `/execute` (execute-extension),
 * 它们喂进来的是一段自由文本任务, 没有节点可挂环。要撤这一层得先把那两条路也搬过去 (有用例再做);
 * 在那之前 `_fixpoint.json` 仍是它俩的持久化面, **不是死代码**。
 *
 * 把 runExecutorDag (conductor 规划一次 → fan-out leaves → results, 无迭代) 套进 runFixpoint:
 *
 *   一轮 = 一张静态 applicative 图 (runExecutorDag) → judge 看整轮结果收敛没 →
 *   不满意把失败原因注入下一轮 task → conductor 据此重画 → 直到收敛 / 触 maxRounds。
 *
 * 这是 **workflow 级 fixpoint** (重画整张内层图)。node 级 refine (重跑单 leaf) 是 PG DAG verifier
 * 路径的事 (宿主宏观引擎 外层), 不在 omd in-process 这层 —— in-process leaf 无 per-node postcondition,
 * 整轮 judge 是最自然的收敛粒度。
 *
 * 默认收敛 judge 共用 plan/llm-judge (与 replanner 同一套); 全注入 (_runDag / judge) → 无 DB /
 * 无模型即可完整测试。onComplete 由本层闭包**每轮**显式调用 (不依赖 _runDag 实现透传)。
 *
 * **conductor 跨轮升级 (单 loop, 不双套)**: fixpoint 的 judge 就是这层的 verifier; 它缺的只是
 * "失败多轮还换不换更强的脑子"。故本层在 round ≥ escalateAfterRound 且升级模型 provider 就绪时,
 * 用 conductorEscalationModel 重画 (round 1 弱 conductor / 后续升级)。**executor-dag 内部的
 * verify+升级循环在本层被显式关闭** (剥 verifier 字段 → 它不触发) —— 避免内外两层 verify 嵌套
 * (double-loop: 成本翻倍 + 谁负责收敛语义打架)。本层 judge = 唯一 verify 循环。
 */
import {
  runExecutorDag,
  type ExecutorDagConfig,
  type ExecutorDagResult,
} from '../dag/engine';
import type { PriorExec } from '../dag/types';
import {
  runFixpoint,
  DEFAULT_MAX_ROUNDS,
  type FixpointResult,
  type FixpointJudge,
} from './fixpoint';
import { merkleFingerprints } from '../plan-passes/semantic-key';
import type { FixpointJournal } from '../continuity/types';
import { makeLlmConvergenceJudge } from './llm-judge';
import { escalationProviderReady } from '../verifier';
import { logger } from '../logger';

export interface IterateConfig extends ExecutorDagConfig {
  /** 最大迭代轮数 (默认 DEFAULT_MAX_ROUNDS=3)。 */
  maxRounds?: number;
  // judgeModel 已上移到 ExecutorDagConfig (conductor 节点的内环 judge 也要用它, D-A)。
  // 本层的回落仍是 leafModel (见下方 makeLlmConvergenceJudge 的接线), 与节点内环回落 conductorModel 不同。
  /** 收敛阈值 (进 judge prompt 作 bar)。默认 0.8。 */
  convergenceThreshold?: number;
  /**
   * 从第几轮起用 conductorEscalationModel 重画 (默认 2 = round 1 弱 conductor, 后续升级)。
   * 仅在 conductorEscalationModel 给定且其 provider 已注册时生效; 否则全程弱 conductor (维持弱)。
   * (conductorEscalationModel 自 ExecutorDagConfig 继承; 本层用它做轮级升级, 非 executor-dag 内部升级。)
   */
  escalateAfterRound?: number;
  /** 注入式收敛 judge (默认 = LLM judge)。测试 / 自定义评判传这个。 */
  judge?: FixpointJudge<ExecutorDagResult>;
  /**
   * 注入式 runDag (默认 runExecutorDag)。测试传 fake, 不碰 live 模型。
   * 第三参 prior = 上一轮的 {plan, results} (D-21 跨轮复用)。
   */
  _runDag?: (task: string, config: ExecutorDagConfig, prior?: PriorExec) => Promise<ExecutorDagResult>;
  /**
   * 跨轮复用开关 (默认开)。关掉 = 每轮从零重跑 (A/B 对照用)。
   *
   * 为什么默认开: 修复轮的图和上一轮 80% 同构 —— 不带 prior 就是整图重跑, "只重跑污染节点"
   * 这句话在代码里根本没落地过 (P1 前 iterate 调 runDag 从不传 prior, 复用只在轮内 escalation 生效)。
   */
  crossRoundReuse?: boolean;
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
 * 跑 omd 内层 DAG 的外层 fixpoint 迭代。
 * 每轮重画整张内层图 (conductor 据上轮失败原因重新分解), 直到 judge 判收敛或触 maxRounds。
 *
 * @param task   原始任务
 * @param config conductor/leaf 模型 (必填) + 迭代参数 + 注入点 (_runDag / judge)
 */
export async function iterateExecutorDag(task: string, config: IterateConfig): Promise<IterateResult> {
  if (!config.conductorModel) throw new Error('iterate: conductorModel 必填 (无硬默认)');
  if (!config.leafModel) throw new Error('iterate: leafModel 必填 (无硬默认)');

  const runDag = config._runDag ?? runExecutorDag;
  // D-4 毒集: 被 judge 点名拒绝过的节点**语义指纹**。累积不撤 —— 指纹含前驱闭包, 所以一个毒指纹
  // 恒等于"这个节点在这个上游语境下产出被拒过", 这件事不会随轮次变假 (上游变了指纹本身就变了)。
  const poisoned = new Set<string>();
  const baseJudge =
    config.judge ??
    makeLlmConvergenceJudge<ExecutorDagResult>({
      judgeModel: config.judgeModel || config.leafModel,
      task,
      threshold: config.convergenceThreshold,
      // 内层 DAG 整轮总算"跑完了"(单 leaf 失败在 summary 里); roundRunner 抛才是整轮崩 (fixpoint 接住)。
      extract: (r) => ({ status: 'done', summary: summarizeDagResult(r) }),
    });

  /**
   * D-4b 铸票: judge 点的是**本轮 id**, 当场用本轮 plan 翻成语义指纹再入毒集。
   * 必须在这里翻 —— 下一轮 conductor 重画后那些 id 就没有意义了 (且指纹刻意不含 id)。
   *
   * **fail-closed (D-4e)**: 判了不收敛却拿不到**任何一张可解析的票** (没点名 / 点的全是图里不存在的
   * id) = 对"哪里错了"零信息, 而"整轮被拒"是已知的 → 本轮产出整体不进下一轮的复用源, 退回 P1 之前的
   * 整图重跑基线。不这么兜的话, 一个偷懒的 judge 就把上面这道闸悄悄绕过去了 —— 而它恰恰只在生产
   * (弱 judge 模型漏填字段) 才发作。
   *
   * 这里**不**往毒集里塞本轮全部指纹: 毒集累积不撤, 只该装有证据的条目, 不装猜测。
   */
  const judge: FixpointJudge<ExecutorDagResult> = async (result, round) => {
    const verdict = await baseJudge(result, round);
    if (verdict.converged) {
      distrustLastRound = false;
      persistJournal(round, true);
      return verdict;
    }
    const fps = merkleFingerprints(result.plan);
    const minted: string[] = [];
    const ghosts: string[] = [];
    for (const id of verdict.rejectedNodes ?? []) {
      const fp = fps.get(id);
      if (fp) {
        poisoned.add(fp);
        minted.push(id);
      } else ghosts.push(id);
    }
    if (ghosts.length) {
      logger.warn({ round, ghosts }, '[omd/iterate] judge 点名了图中不存在的节点 id → 丢弃 (D-4)');
    }
    distrustLastRound = minted.length === 0;
    if (distrustLastRound) {
      logger.warn(
        { round, named: verdict.rejectedNodes?.length ?? 0 },
        '[omd/iterate] judge 判未收敛但无一张可解析的票 → 本轮产出整体不复用 (D-4 fail-closed)',
      );
    } else {
      logger.info({ round, rejected: minted, poisonedTotal: poisoned.size }, '[omd/iterate] D-4 铸票: 被拒节点指纹入毒集');
    }
    persistJournal(round, false, verdict.failureReason);
    return verdict;
  };

  const maxRounds = config.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const escalateAfterRound = config.escalateAfterRound ?? 2;

  // 剥出: onComplete (本层每轮显式调, 防 _runDag=runExecutorDag 双调) +
  //       verifier/maxEscalations (executor-dag 内部 verify+升级循环 → 本层关闭它, 防 double-loop:
  //       本层 fixpoint judge 已是唯一 verify 循环)。conductorEscalationModel 留作本层轮级升级用。
  const { onComplete, verifier: _verifier, maxEscalations: _maxEsc, conductorEscalationModel, crossRoundReuse, ...dagConfig } = config;
  const canEscalate = escalationProviderReady(conductorEscalationModel);
  // 跨轮复用: 上一轮的 {plan, results} 喂下一轮 → 语义没变的节点零 LLM 注入上轮输出 (D-21)。
  // 毒集在**调用当刻**才拼进去 (不是上轮结束时快照): judge 是在 roundRunner 返回之后才跑的,
  // 上轮的票要等 judge 铸完才存在。提前快照 = 永远晚一轮, 毒集等于白加。
  let lastRound: { plan: ExecutorDagResult['plan']; results: ExecutorDagResult['results'] } | undefined;
  // judge 拒了整轮却说不出哪个节点错 → 这一轮的产出整体不可信, 下一轮不拿它当复用源 (见 judge 包装)。
  let distrustLastRound = false;
  const priorArg = (): PriorExec | undefined =>
    lastRound && !distrustLastRound ? { ...lastRound, ...(poisoned.size ? { poisoned } : {}) } : undefined;

  // ── INV-P2-6 外层持久化 ──────────────────────────────────────────────────
  // `_dag.json` + per-node checkpoint 只覆盖**一张内层图**; 轮次/复用源/毒集是外层的, 此前全在
  // 进程内 —— 崩一次就从第 1 轮起、毒集清零 (被拒产出复活)。这里把它们写进 `_fixpoint.json`。
  // 写在**每轮 judge 判完之后**: 死在一轮中途 → 该轮无 journal, resume 重跑该轮 (其内部绿节点
  // 仍由 per-node checkpoint 兜住)。全程 fail-open (manager 内部吞异常), 持久化挂了不断迭代。
  const continuity = config.continuity;
  const persistJournal = (round: number, converged: boolean, reason?: string): void => {
    if (!continuity) return;
    continuity.manager.writeFixpointJournal(continuity.runId, {
      runId: continuity.runId,
      completedRounds: round,
      poisoned: [...poisoned],
      ...(lastRound ? { lastRound: lastRound as unknown as FixpointJournal['lastRound'] } : {}),
      distrustLastRound,
      ...(reason ? { prevReason: reason } : {}),
      converged,
      updatedAt: new Date().toISOString(),
      schemaVersion: 1,
    });
  };

  // 恢复: 只在调用方明确要 resume 时读 (与 per-node resume 同一个开关, 不新增 API 面)。
  const journal = continuity?.resume ? continuity.manager.loadFixpointJournal(continuity.runId) : null;
  let startRound = 1;
  let seedReason = '';
  if (journal) {
    for (const fp of journal.poisoned) poisoned.add(fp);
    // crossRoundReuse:false 是 A/B 对照口子 —— 恢复时也照样不给复用源, 否则对照组被静默破坏。
    if (journal.lastRound && crossRoundReuse !== false) {
      lastRound = journal.lastRound as unknown as typeof lastRound;
    }
    distrustLastRound = journal.distrustLastRound ?? false;
    seedReason = journal.prevReason ?? '';
    startRound = journal.completedRounds + 1;
    logger.info(
      { runId: continuity!.runId, startRound, poisoned: poisoned.size, hadPrior: !!lastRound, converged: journal.converged },
      '[omd/iterate] 外层恢复: 接回轮次/毒集/复用源 (INV-P2-6)',
    );
  }

  return runFixpoint<ExecutorDagResult>(
    task,
    async (roundInput, round) => {
      // round ≥ escalateAfterRound 且升级模型 provider 就绪 → 换强 conductor 重画; 否则维持弱。
      const useEscalation = round >= escalateAfterRound && canEscalate;
      const roundConfig: ExecutorDagConfig = useEscalation
        ? { ...dagConfig, conductorModel: conductorEscalationModel! }
        : dagConfig;
      if (useEscalation) {
        logger.info(
          { round, from: dagConfig.conductorModel, to: conductorEscalationModel },
          '[omd/iterate] 未收敛多轮 → conductor 轮级升级重画',
        );
      }
      const res = await runDag(roundInput, roundConfig, priorArg());
      if (res.reusedNodes?.length) {
        logger.info(
          { round, reused: res.reusedNodes.length, total: Object.keys(res.results).length },
          '[omd/iterate] 跨轮复用命中 → 只重跑污染节点 (D-21)',
        );
      }
      if (crossRoundReuse !== false) lastRound = { plan: res.plan, results: res.results };
      if (onComplete) await onComplete(res);
      return res;
    },
    judge,
    { maxRounds, startRound, ...(seedReason ? { seedReason } : {}) },
  );
}
