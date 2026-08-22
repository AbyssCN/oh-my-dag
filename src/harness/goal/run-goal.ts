/**
 * goal/run-goal —— 自主 goal 引擎的**薄竖切** (SDD 2026-07-28 omd-goal-engine, P1 / D-9)。
 *
 * 一个 goal 进来, 自主走完 research → spec → execute → verify → 1 轮修复, 阶段间零人工介入
 * (INV-GOAL-1)。它替代的是手动技能链 `/omd-research-deep → /omd-grill → /omd-contract → /omd-execute`。
 *
 * **外层严格无环** (D-2): 这里是一条固定的阶段序列, 不画回边。
 *
 * **D-F (2026-07-30): 外层 fixpoint 已撤**。此前 execute 段走 `iterateExecutorDag` —— 一层 run 级
 * 的环 (重画整张内层图) 套着节点内可能存在的另一层。P1 的 double-loop 教训是两层 verify 必须
 * 二选一 (成本翻倍 + 谁负责收敛语义打架), D-A 定的是**留节点内那一层**。于是现在两段都是
 * 一个 `executor:'conductor'` 节点:
 *
 *   契约段 `goal-contract` (specRounds) · 执行段 `goal-execute` (maxRounds)
 *
 * 环因此封在节点内且有轮数上限 (INV-GOAL-4), 状态 (轮次/毒集/上轮原因) 落**节点级** journal
 * `_loop-<nodeId>.json` —— run 级 `_fixpoint.json` 在这条路上不再被写也不再被读 (概念没删,
 * 是从 run 级降到了节点级; 删掉它等于把"被拒产出借崩溃复活"那个缺陷换个方式重新引入)。
 *
 * ⚠ 撤外层的代价记在 `judge_final` 上: 内环 judge 判的是**一个节点的 goal**, 而执行段那个节点的
 * goal 就是整个任务, 所以「整体目标成了吗」仍有人问 —— 但只有 `judge_final:true` 才在最后一轮
 * 真去问。别把它当成可省的旋钮。
 *
 * 为什么阶段序列仍是**编排代码**而不是一张 DAG: 判卷标准 (D-I) 必须留在环外, 它是在 classify 段
 * 算好后冻进两个节点的输入的 —— 让它进图就等于让执行体自己的环去产出判据 (D-J 整套防作弊的地基
 * 就是"判卷标准是执行体动不了的东西")。
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runExecutorDagWithPlan } from '../dag/engine';
import { makeDefaultGenerate } from '../dag/defaults';
import type { ConductorPlan } from '../conductor-plan';
import type { ExecutorDagResult } from '../dag/types';
import { classifyGoal, renderAcceptance, type AcceptanceSpec, type GoalClassification, type GoalTier } from './classify-acceptance';
import { acceptanceCommandBlockReason } from './acceptance-gate';
import type { RunOutcomeKind } from '../run-outcome';
import { loadSddContract } from './sdd-direct';
import type { ExecutorDagConfig } from '../dag/types';
import { TEST_STEP_PREFIX, acceptSideOf, buildAcceptDelta, extractFailSet, stableFailSet, unstableFailSet, type AcceptSide } from './accept-delta';
import { readExperimentFlags } from './experiment-flags';
import { classifySpecWrite, type SpecWrite, type SpecWriteSource } from './spec-write';
import { summarizeDelta, type DeltaReport, type VerifyStepStatus } from './delta-compare';
import { parseBreakdown, type SddContract, type SddSlice } from './sdd-direct';
import { acceptCommandFromBreakdown, compileBreakdown, describeParallelism, parallelismReadout } from './sdd-compile';
import { coverSlices, describeSliceCoverage, type SliceCoverageReport } from './slice-coverage';
import { attributeWriteSet, classifyWriteScope, describeWriteSet, SDD_DECLARED_WRITE_SET, type DeclaredWriteSet, type WriteScopeKind, type WriteSetDeclaration, type WriteSetReport } from '../writeset/write-set';
import { collectRunTickets, type RunTicketSink } from '../pathfinder/run-tickets';
import { logger } from '../logger';
import { appendBoard, type BoardEntry } from '../board/run-board';
import { resolveProfile, type LeafProfile } from '../profiles/profile';
import { fingerprintOf, type ReviewFinding } from '../profiles/review-ledger';
import { maybeRunDesignReview, type DesignReviewResult } from './design-review';
import { escalationProviderReady } from '../verifier';

// D-I: 两条轴的类型与分类器都归 ./acceptance (那里是判据轴的单一真源); 此处 re-export 保旧调用面。
export type { AcceptanceSpec, GoalClassification, GoalTier } from './classify-acceptance';

/**
 * 已结晶 SDD → 执行型验收 (直通档的判据来源, 2026-08-11 run 7d50fda2 修)。
 *
 * 命令怎么推在 `sdd-compile.acceptCommandFromBreakdown` (单真源); 这里只管**要不要用它**:
 * 分解段解析不了 / 无 verify 列 → undefined, 回落分类器那条 (fail-open 但不吞证据 —— 存量
 * SDD 里"分解段无表"的今天仍在跑, 拒起跑是无谓回归)。
 */
function sddDerivedAcceptance(sdd: SddContract): AcceptanceSpec | undefined {
  let command: string | undefined;
  try {
    command = acceptCommandFromBreakdown(parseBreakdown(sdd.text));
  } catch (err) {
    logger.warn(
      { sdd: sdd.path, err: String(err instanceof Error ? err.message : err).slice(0, 160) },
      '[run-goal] 直通档: 分解表解析不了 → 验收命令回落分类器 (不静默)',
    );
    return undefined;
  }
  if (!command) {
    logger.warn({ sdd: sdd.path }, '[run-goal] 直通档: verify 列推不出验收命令 → 回落分类器 (不静默)');
    return undefined;
  }
  // 推出来也得**跑得起来**: verify 列写了白名单外的命令 (pytest/make/…) 时, 直接拿去当验收
  // 会在命令闸上被拒 —— 那是"假红" (规划期说能跑, 执行期根本没跑), 比回落更坏。
  const blocked = acceptanceCommandBlockReason(command);
  if (blocked) {
    logger.warn({ sdd: sdd.path, command, blocked }, '[run-goal] 直通档: verify 列推出的命令过不了命令闸 → 回落分类器 (不静默)');
    return undefined;
  }
  // expectExit 恒 0: 这是**总验收** (全绿), TDD 中途那次证红由平铺图的 RED 节点带 expect_exit=1。
  return { kind: 'executable', command, expectExit: 0 };
}

export type GoalStageName = 'classify' | 'survey' | 'research' | 'spec' | 'execute';

export interface GoalStage {
  stage: GoalStageName;
  status: 'done' | 'failed' | 'skipped';
  /**
   * **这一步是怎么结束的** (N5, 2026-07-31)。`status` 一字未动, 这是**加的那一位**。
   *
   * 治的是 2026-07-31 第二跑 live 抓到的那行: 一次判定正确的 BLOCKED 被 `status` 念成 `failed`
   * (`[failed] execute — 2 轮阻塞…`), 而同一份摘要底下另一行写着"阻塞(需外部输入)" ——
   * 同一份输出里两行互相打架。词表与判据在 {@link RunOutcomeKind}。
   */
  outcome: RunOutcomeKind;
  /** 一行人可读结论 (失败原因 / 跳过理由 / 产物指针)。 */
  summary: string;
}

export interface RunGoalConfig {
  cwd: string;
  /** 引擎 config 基座 (座位 + agent/command/research runner)。execute 阶段直接用它。 */
  dag: ExecutorDagConfig;
  /**
   * execute 段 conductor 节点的**内环**轮数上限 (1 轮修复 = 2)。默认 2 —— D-9 薄竖切就是"一轮修复"。
   * 上限 4 (schema 钳)。轮的语义是**逐轮重展开**, 不是重跑同一张子图。
   */
  maxRounds?: number;
  /** research 节点内环轮数 (有界, INV-GOAL-4)。默认 1。 */
  researchRounds?: number;
  /**
   * 契约段 (survey/research/spec 那个 conductor 节点) 的内环轮数。默认 1 = 只画一次。
   * >1 才启用**补调研**: 契约写完若判未达成, 下一轮重画时可以长出一个上一轮没有的调研步 (D-G′/D-A)。
   */
  specRounds?: number;
  /** 强制档位 (成本轴); 省略 = 自动分类 (D-5)。**不覆盖判据轴** —— 验收分型仍照跑 (D-I)。 */
  tier?: GoalTier;
  /** 强制验收分型 (判据轴, D-I); 省略 = 自动分类。 */
  acceptance?: AcceptanceSpec;
  /** spec 落盘目录 (默认 <cwd>/docs/plan)。 */
  specDir?: string;
  /**
   * 直通入口 (SDD 2026-08-10-solve-sdd-direct-entry): 已结晶 SDD 的路径。给了 → 契约段子图
   * **零展开零转录** (specPath/evidence 直接取自该文件, 与闸 C 同一条消费通路), research 不跑。
   * 文件读不到 / 缺契约·分解段 → 起跑即抛 (fail-loud, 不静默降级回全程 goal)。
   */
  sddPath?: string;
  /** 日期串 (spec 文件名)。测试注入; 默认今天 YYYY-MM-DD。 */
  _today?: () => string;
  /** 注入式分类器 (测试 / 自定义): 一次出两条轴 (D-I)。 */
  _classify?: (goal: string) => Promise<GoalClassification>;
  /**
   * 分类定稿回调 (判据轴证据钩子): 分类成功 (含降级 / fail-open / 探索型) 后**恰好调一次**,
   * 在 `_runDag` 与任何运行记录之前 —— 调用方可在此持久化探针裁决 (`acceptanceProbe`)。
   * 分类器抛错时**不调** (那时没有定稿的分类可持久化)。
   */
  onClassified?: (classified: GoalClassification) => void;
  /**
   * 契约段定稿回调 (#209 落盘证据钩子): 契约段收尾后**恰好调一次** —— 每条路都调, 包括
   * simple 档 / 无 agentRunner / 直通 / 复用 / 契约段抛错。调用方在此持久化 `SpecWrite`
   * (账本 `omd_dag_runs.spec_write`)。
   *
   * ⚠ **时机就是判据**: 它在 execute 段之前、worktree 还在的时候发。挪到整趟收尾之后
   * (或改成 `existsSync` 事后扫盘) 这一列在隔离档下会恒 NULL —— run-goal.spec-write.test.ts
   * 里那条"记录时盘上文件已不存在, 账本仍记 wrote"就是钉这一点的。
   */
  onContract?: (spec: SpecWrite) => void;
  /**
   * 注入式 DAG 执行 (测试传 fake; 默认 runExecutorDagWithPlan)。
   * **契约段与执行段共用这一个注入口** —— 两段都是一张单 conductor 节点的图 (D-F),
   * 靠 `plan.name` (`goal-contract` / `goal-execute`) 分辨是谁在调。
   */
  _runDag?: (plan: ConductorPlan, config: RunGoalConfig['dag']) => Promise<ExecutorDagResult>;
  /**
   * D-2 (SDD cairness-distill 2026-08-10): 写集对账的可注入面。写集 = plan 节点可选 `write_set`
   * 字段 (conductor-plan.ts); 本钩子在 execute 段跑完后把跑后 git diff 逐文件走归属阶梯
   * (write-set.ts 的 ①-⑤, orphan 红)。给 `_collectChangedFiles` = 注入 diff 收集 (测试 / 隔离档);
   * 缺省 git status --porcelain (照 rollback-anchor 的 git 惯例; 失败 → 闸缺席 fail-open, warn
   * 留痕, INV-1 不吞证据)。`globalExempt` / `intentional` 是阶梯 ②/④ 的清单。整 run 无节点声明
   * → verdict 'undeclared' (INV-3: 声明缺席 ≠ 违规, NULL≠0 —— 那正是 O-1 的声明覆盖率读数)。
   * `declared` = run 级声明写集面 (S-2, 裁「该不该写」, 与节点级阶梯正交): 缺省 write-set.ts 的
   * SDD_DECLARED_WRITE_SET (本 SDD run 的声明); 并发 run (写面互异) / 测试注入自己的面。
   */
  writeSet?: {
    _collectChangedFiles?: () => string[];
    globalExempt?: string[];
    intentional?: string[];
    declared?: DeclaredWriteSet;
  };
  /**
   * **D-2 散雾出口** (SDD 2026-08-11-control-plane-unification 切片 1) 的**可选注入面**:
   * 给了 map 句柄, 这趟 run 的未决/发现物/终态才落成 map 上的 suggested 票 (人 confirm 前不进前沿)。
   *
   * **不给 = 闸缺席**, 收尾一行不多跑 —— 无相关配置的 run 行为逐字节不变 (INV-1)。
   * 判据在 pathfinder/run-tickets.ts (纯核), 本文件只负责"拿到句柄就喂给它, 出事只留痕不掀桌"。
   */
  tickets?: {
    /** 目标地图 slug。 */
    slug: string;
    /** map 写入口 (`resolveBackend(cwd)` 的结果即可; 缺 `suggest` 实装 = 闸缺席)。 */
    sink: RunTicketSink;
    /** 票身 runId 锚 (G-2 票→runId→回执)。省略 = continuity.runId ?? dag.sessionId; 都没有则不开票。 */
    runId?: string;
    /** suggestionsLog 时间戳 (可重放); 省略 = 现在。 */
    at?: string;
    /** 读 spec 全文的注入口 (测试); 省略 = readFileSync(specPath)。 */
    _readSpec?: (path: string) => string;
  };
  /**
   * P4 设计审核触发接线: 给了 profile 名 (默认 'design-review'), execute 后写集与前端 glob
   * 相交时调度审核叶 (advisory, 不阻塞主流程); 审核失败/timeout → converged 逐位不变 (INV-3)。
   * 不给 = 整段缺席, 行为逐字节不变。
   */
  designReview?: {
    /** 岗位档案名 (默认 'design-review')。 */
    profile?: string;
    /** 项目提供的截图命令。给了才启用生产截图审核 runner; 省略严格走 diff-only。 */
    screenshotCommand?: string;
    /** 升档模型坐标。省略回落 dag.conductorEscalationModel; provider 不可解析时不升档。 */
    escalationSeat?: string;
    /** 注入式审核 runner (测试用); 给了压过生产截图 runner。 */
    _runReview?: (diff: string, cwd: string) => Promise<{ findings: ReviewFinding[]; usage: { in: number; out: number } }>;
    /** D-7 修复已尝试标志: true → 同指纹熔断/转票, 不再落账新 findings。 */
    repairAttempted?: boolean;
  };
 }

export interface RunGoalResult {
  goal: string;
  tier: GoalTier;
  /** D-I 验收分型 + 冻结的判卷标准 (执行型带可跑命令; 探索型带学习目标 + 可承受损失)。 */
  acceptance: AcceptanceSpec;
  stages: GoalStage[];
  /** spec 落盘路径 (simple 档 / 无 agentRunner → undefined)。 */
  specPath?: string;
  /** research 阶段真抓到正文的 URL (INV-GOAL-2 证据面)。 */
  sources: string[];
  /** 仓内勘察结论 (survey 阶段产出; 跳过则空串)。 */
  repoContext: string;
  /** execute 阶段是否收敛 (judge 判过)。 */
  converged: boolean;
  /** execute 阶段实跑轮数。 */
  rounds: number;
  /** 修复轮里被复用的节点 (INV-GOAL-3 可证面; 单轮收敛 = 空)。 */
  reusedNodes: string[];
  /**
   * **这一趟 goal 是怎么结束的** (N5, 2026-07-31)。词表与每格的下一步在 {@link RunOutcomeKind}。
   *
   * 与 `converged` 的关系: `converged` 只答"成没成"这一位, 而没成的那一侧此前要靠调用方
   * 自己去看 `blocked` / `budgetStopped` / `cancelled` 三个可选字段**有没有值**来拼 ——
   * 拼错的成本已经见过: 一次正确的 BLOCKED 被念成 failed。这一位把那次拼装收成一处。
   *
   * 恒等于最后那个 execute 阶段的 `outcome` (goal 就是以它收尾的)。
   */
  outcome: RunOutcomeKind;
  /**
   * **两条判据各自说了什么**(N9, 2026-07-31)。`judge` = 收敛判据(judge 判词);
   * `oracle` = 冻结判据(可执行验收命令的退出码;判据不是可执行式时恒 true)。
   *
   * 为什么要把两个布尔单独暴露, 而不是让调用方从 {@link outcome} 反推:**反推不出来**。
   * `judge` 是**观测位不是裁决位** (#148, 2026-08-17): 终态由环的结论 × oracle 定,
   * judge 的票不进算式 —— 于是「判据绿收敛而 judge 判没成」这一格在 outcome 上是 `success`,
   * 只有这两个布尔 (加 summary 里的 ⚠ judge 异议注记) 能把它读出来。
   *
   * 而那一格恰恰是「收敛判据可不可信」的另一半证据: 只看 `oracle-failed` 只能发现 judge 太松,
   * 发现不了 judge 太紧。两侧都要看得见, 这条轴才是对称的。
   *
   * 契约段就结束(没跑 execute)→ 缺席, 不编 —— 那时两条判据一条都没判过。
   */
  criteria?: { judge: boolean; oracle: boolean };
  /**
   * **BLOCKED 异步出口** (D-Q): 环判定"没有外部输入推不动"而提前退出的原因。
   * 与 `converged: false` 的区别是**该怎么办**: 未收敛 = 轮数用尽/judge 说没达标, 再给几轮可能就成;
   * blocked = 判据是确定性的 (环空转 / 检测者喊停), 再给多少轮都一样, 该由 owner 看一眼。
   * 恒与 `converged: false` 同时出现。
   */
  blocked?: string;
  /**
   * **环因预算停的** (2026-07-31, Loop Engineering 第四条停止轴)。与 `blocked` 分开的理由是
   * **下一步不一样**: blocked = 再多轮都一样, 该 owner 看; budgetStopped = 加预算 resume 很可能就成。
   * 恒与 `converged: false` 同时出现。
   */
  budgetStopped?: string;
  /**
   * **协作式取消** (D-P) 的原因。给了 = 这次是被叫停的, 不是跑完的 —— 已跑完的节点与轮次
   * 全在盘上, `dag_goal resume=<同一个 runId>` 接着跑。
   */
  cancelled?: string;
  /**
   * **D-1 mode 感知基线 delta** (SDD cairness-distill D-1): 批前基线 vs accept 节点实判的比对。
   * 缺席 = 非执行型 / 没配 commandRunner (fail-open) / 基线抛错 —— 闸缺席, 不是"零 delta"。
   * `red` = 本次跑批新引入了失败 (非零退出码语义; 老失败单列不红, INV-4 老段/新增段分开)。
   */
  verifyDelta?: DeltaReport;
  /**
   * **D-2 写集对账报告** (SDD cairness-distill D-2): 声明(事前) × touch(过程) × diff(事后) 三面对账。
   * 缺席 = 没配 writeSet 注入面 (闸缺席, 不是「零越界」); `verdict:'undeclared'` = 有对账但整 run
   * 无节点声明写集 (INV-3 NULL≠0)。`red` = 存在 orphan —— 非零退出码语义, 与引擎回归分开报 (INV-4)。
   */
  writeSet?: WriteSetReport;
  /**
   * **run 级声明写集面** (S-2): diff 逐文件裁 allowed / forbidden / outside —— 判据与 enforcement
   * 同一真源 (write-set.ts 的 classifyWriteScope + SDD_DECLARED_WRITE_SET)。与 writeSet 正交:
   * 节点阶梯裁「谁写的」, 声明写集裁「该不该写」。`forbidden` = 撞禁写面 (并发 run 的写面,
   * 并发越界样本, 非零退出码语义 —— 与 orphan 分开报, INV-4); `outside` = 声明面外 (INV-3:
   * 声明缺席 ≠ 违规, 读数不冒充零越界)。缺席 = 没配 writeSet 注入面 (闸缺席, fail-open)。
   */
  writeScope?: WriteScopeReport;
  /**
   * **S-46 缺片闸**: 分解表每一片的写集有没有真的落出东西。与 writeSet 严格正交 ——
   * writeSet 判「改了没声明的」(orphan), 本项判「声明了没改的」(缺片)。
   * 缺席 = 没配 writeSet 注入面, **或走的不是直通v2**(回落 conductor 铺图时切片不是执行单位)
   * —— 闸缺席不是「零缺片」。`red` = 存在零产出的片; `partial` 有产出, 告警不红。
   */
  sliceCoverage?: SliceCoverageReport;
  /** P4 设计审核结果 (advisory, 不参与收敛判定)。缺席 = 未启用设计审核。 */
  designReview?: DesignReviewResult;
}
export interface WriteScopeReport {
  /** 逐文件裁决 (allowed / forbidden / outside)。 */
  files: { file: string; kind: WriteScopeKind }[];
  /** 撞禁写面 (并发 run 的写面) 的文件 —— 红。 */
  forbidden: string[];
  /** 在声明允许面内的文件。 */
  allowed: string[];
  /** 声明面外的文件 (INV-3 读数面, 不红)。 */
  outside: string[];
}

/** kebab-case slug (spec 文件名用); 非字母数字折成 '-', 截断 48。 */
export function goalSlug(goal: string): string {
  const s = goal
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return s || 'goal';
}

/** RunOutcomeKind → board terminal outcome 的**四值投影** (S4)。细粒度留在 note, 粗态进 outcome。 */
export const BOARD_TERMINAL_OUTCOME: Record<RunOutcomeKind, 'converged' | 'failed' | 'cancelled' | 'not-converged'> = {
  success: 'converged',
  cancelled: 'cancelled',
  'not-converged': 'not-converged',
  // #165①: 交付达标 (判据复验绿) 但有红节点 —— 板上粗态按「没全绿」念, 细粒度在 outcome 词。
  'delivered-with-red': 'not-converged',
  'oracle-failed': 'failed',
  blocked: 'failed',
  'budget-exhausted': 'failed',
  'infra-error': 'failed',
  'missing-capability': 'failed',
  'not-needed': 'failed',
  'empty-result': 'failed',
  unclassified: 'failed',
};

/**
 * 终态 entry 构造 (S4, **纯函数面**): 内容可单测。为何需要它: appendBoard 追加 terminal 后,
 * run-board 的 compact 会立刻删掉**本 run 的全部条目 (含 terminal 行本身)** —— 板是协调介质
 * 不是真源 (D-3/INV-1), 事后读板读不到这条, 内容只能经这里验证。
 */
export function boardTerminalEntry(runId: string, outcome: RunOutcomeKind): BoardEntry {
  return {
    v: 1,
    ts: new Date().toISOString(),
    runId,
    event: 'terminal',
    outcome: BOARD_TERMINAL_OUTCOME[outcome],
    note: outcome,
  };
}
/** D-2 diff 面: 跑后 git 工作树相对 HEAD 的改动 (相对路径, 含未跟踪, 不含被忽略的)。非 git 仓/失败 → 抛 (调用方 fail-open)。 */
function collectChangedFiles(cwd: string): string[] {
  const r = Bun.spawnSync(['git', 'status', '--porcelain'], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (r.exitCode !== 0) {
    throw new Error(`git status 失败 (exit ${r.exitCode}): ${new TextDecoder().decode(r.stderr).trim()}`);
  }
  return new TextDecoder()
    .decode(r.stdout)
    .split('\n')
    .filter((l) => l.trim().length > 0)
    // porcelain v1: 'XY path'; 重命名 'R  old -> new' 取新路径; '!!' = 被忽略, 不进 diff 面。
    .map((l) => (l.includes(' -> ') ? l.slice(l.indexOf(' -> ') + 4) : l.slice(3)))
    .filter((p) => !p.startsWith('!!'));
}

type DesignReviewRunner = (
  diff: string,
  cwd: string,
) => Promise<{ findings: ReviewFinding[]; usage: { in: number; out: number } }>;

/** profile 叶只回结构化 finding; 指纹在边界重算, 不信模型自报。 */
function parseDesignReviewFindings(text: string): ReviewFinding[] {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim() ?? text.trim();
  const objectAt = fenced.indexOf('{');
  const arrayAt = fenced.indexOf('[');
  const starts = [objectAt, arrayAt].filter((n) => n >= 0);
  if (starts.length === 0) throw new Error('design-review 未返回 JSON');
  const start = Math.min(...starts);
  const isArray = fenced[start] === '[';
  const end = fenced.lastIndexOf(isArray ? ']' : '}');
  if (end < start) throw new Error('design-review JSON 不完整');
  const parsed = JSON.parse(fenced.slice(start, end + 1)) as unknown;
  const rows = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { findings?: unknown }).findings)
      ? (parsed as { findings: unknown[] }).findings
      : [];
  return rows.flatMap((raw): ReviewFinding[] => {
    if (!raw || typeof raw !== 'object') return [];
    const r = raw as Record<string, unknown>;
    const severity = typeof r.severity === 'string' ? r.severity.toLowerCase() : '';
    if (severity !== 'p0' && severity !== 'p1' && severity !== 'p2') return [];
    if (
      typeof r.where !== 'string' || !r.where.trim() ||
      typeof r.evidence !== 'string' || !r.evidence.trim() ||
      typeof r.suggestion !== 'string' || !r.suggestion.trim() ||
      typeof r.uncertainty !== 'string' || !r.uncertainty.trim()
    ) return [];
    return [{
      where: r.where,
      severity,
      evidence: r.evidence,
      suggestion: r.suggestion,
      uncertainty: r.uncertainty,
      fingerprint: fingerprintOf(r.where, r.evidence),
    }];
  });
}

function screenshotReviewPrompt(
  diff: string,
  screenshotCommand: string,
  severe?: ReviewFinding[],
): string {
  const recheck = severe?.length
    ? `\n\n初审 P0/P1, 只保留复核后仍成立的项:\n${JSON.stringify(severe)}`
    : '';
  return `执行项目截图命令并审查真实截图像素, 不从代码猜视觉质量。\n` +
    `截图命令(逐字执行): ${screenshotCommand}\n\n` +
    `前端写集/diff 输入:\n${diff}${recheck}\n\n` +
    '只输出 JSON: {"findings":[{"where":"文件或截图区域","severity":"p0|p1|p2",' +
    '"evidence":"像素证据","suggestion":"具体修法","uncertainty":"不确定性"}]}。无问题输出 {"findings":[]}。';
}

/**
 * 生产截图审核装配。无 screenshotCommand 故意不造 runner → maybeRunDesignReview 的 diff-only 路径;
 * 有命令才调 profile agent。初审无 P0/P1 时不碰升档座, provider 不可达也不冒充已升档。
 */
function productionDesignReviewRunner(
  config: RunGoalConfig,
  screenshotCommand: string | undefined,
  escalationSeat: string | undefined,
): DesignReviewRunner | undefined {
  const agentRunner = config.dag.agentRunner;
  if (!screenshotCommand || !agentRunner) return undefined;
  const profileName = config.designReview?.profile ?? 'design-review';
  const profile: LeafProfile | undefined = resolveProfile(profileName, config.cwd);
  if (!profile && config.designReview?.profile) {
    logger.warn(
      `Unknown profile "${profileName}"; running as ordinary leaf`,
      `Unknown profile "${profileName}"; running as ordinary leaf (未知 leaf profile; design-review fail-open)`,
    );
  }
  const initialModel = profile?.seat ?? config.dag.agentLeafModel ?? config.dag.leafModel;
  const call = async (model: string, prompt: string) => {
    const r = await agentRunner({ prompt, model, ...(profile ? { profile } : {}) });
    return { findings: parseDesignReviewFindings(r.text), usage: { in: r.usage.in, out: r.usage.out } };
  };
  return async (diff) => {
    const initial = await call(initialModel, screenshotReviewPrompt(diff, screenshotCommand));
    const severe = initial.findings.filter((f) => f.severity === 'p0' || f.severity === 'p1');
    if (!escalationSeat || severe.length === 0) return initial;
    const rechecked = await call(escalationSeat, screenshotReviewPrompt(diff, screenshotCommand, severe));
    return {
      findings: [...initial.findings.filter((f) => f.severity === 'p2'), ...rechecked.findings],
      usage: { in: initial.usage.in + rechecked.usage.in, out: initial.usage.out + rechecked.usage.out },
    };
  };
}
/** S-2 声明写集面摘要: 红 = 撞禁写面 (并发 run 写面); outside 是 INV-3 读数, 不冒充零越界。 */
function describeWriteScope(r: WriteScopeReport): string {
  if (r.forbidden.length > 0) return `撞禁写面 ${r.forbidden.length} [${r.forbidden.join(', ')}]`;
  if (r.outside.length > 0) return `声明面外 ${r.outside.length} (INV-3 读数)`;
  return '声明面内';
}

/**
 * **D-2 散雾出口的接线** (SDD 2026-08-11-control-plane-unification 切片 1): 这趟 run 的
 * 未决/发现物/终态 → map 上的 suggested 票 (G-1: 人 confirm 前不进前沿, 由 suggested 态本身保证)。
 *
 * 判据全在 `pathfinder/run-tickets.collectRunTickets` (纯核), 这里只做三件事: 取 runId 锚、
 * 读 spec 正文、把清单交给 map 句柄。
 *
 * **每一条不开票的路都留痕** (仓规第二条: fail-open 可以吞异常, 不许吞证据):
 *  - 没配 tickets → 静默 (闸根本没装, 不是失败)。
 *  - 配了但后端没 `suggest` / 取不到 runId / spec 读不出 / 落图抛错 → warn 一行, run 照常返回。
 * 尤其 runId: 取不到就**不开票** —— 一张回不去 run 的票违反 G-2, 比没有票更糟。
 */
function openRunTickets(result: RunGoalResult, exec: ExecutorDagResult, config: RunGoalConfig): void {
  const t = config.tickets;
  if (!t) return; // 闸缺席: 没给 map 句柄 (INV-1 逐字节不变的那条路)
  try {
    if (!t.sink.suggest) {
      logger.warn({ slug: t.slug }, '[run-goal] D-2 散雾出口: 后端未实装 suggest (S-1 面) → 不开票');
      return;
    }
    const runId = t.runId ?? config.dag.continuity?.runId ?? config.dag.sessionId;
    if (!runId) {
      logger.warn({ slug: t.slug }, '[run-goal] D-2 散雾出口: 取不到 runId 锚 → 不开票 (票回不去 run 违反 G-2)');
      return;
    }
    // ① 未决的料 = 落盘 spec 全文。读不到 → 该条出口缺席 (NULL≠0: 不冒充"零未决")。
    let specText: string | undefined;
    if (result.specPath) {
      try {
        specText = (t._readSpec ?? ((p: string) => readFileSync(p, 'utf8')))(result.specPath);
      } catch (err) {
        logger.warn({ specPath: result.specPath, err: String(err) }, '[run-goal] D-2 ①未决出口: spec 读不到 → 该条缺席 (不是零未决)');
      }
    }
    const drafts = collectRunTickets(result, {
      runId,
      ...(specText !== undefined ? { specText } : {}),
      ...(exec.verification ? { verification: exec.verification } : {}),
      ...(exec.blameRetry ? { blameRetry: exec.blameRetry } : {}),
    });
    if (drafts.length === 0) return; // 无未决无发现物无终态面 = 这趟没什么要人看的
    const res = t.sink.suggest(config.cwd, t.slug, drafts, { at: t.at ?? new Date().toISOString() });
    logger.info({ slug: t.slug, runId, drafts: drafts.length, summary: res.summary }, '[run-goal] D-2 散雾出口: run 产出 → suggested 票');
  } catch (err) {
    logger.warn({ slug: t.slug, err: String(err) }, '[run-goal] D-2 散雾出口开票失败 → 闸缺席 (fail-open, 不吞证据)');
  }
}

const todayStr = (): string => new Date().toISOString().slice(0, 10);

/**
 * 闸 C (2026-08-10) 的落盘状态: resume 同一 runId 且 goal 文本未变时, classify 与契约段
 * (survey/research/spec) 的产物直接复用, 不重跑。事故背景: 同一段 goal 被心跳续派重分类 117 遍
 * (平均 2.1M tokens/遍) —— 节点级 checkpoint 拦不住, conductor 子图逐轮重展开, D-O 输入面
 * 恒判"依赖输出已变"。状态键 = goal 全文 sha256: 文本动一个字就作废, "未变"是精确判据不是猜。
 */
interface GoalPhaseState {
  goalHash: string;
  classified: GoalClassification;
  contract?: { specPath?: string; evidence: string; repoContext: string; sources: string[] };
}

/**
 * 跑一个 goal 到底 (INV-GOAL-1)。
 *
 * @returns 每阶段的结论 + spec 路径 + 证据 URL + 收敛情况。**失败不抛** —— 阶段级失败记在
 *   stages 里往下走 (execute 阶段仍会拿到手上有的东西), 调用方按 stages 判要不要人接手。
 */
/**
 * S-37 下沉 (2026-08-17): 基线赦免闭包 (D-3, goal 层半) —— 由 `runGoal` 在
 * `baselineSide` 算出来后注入 `freezeCriterion.waiveRed`, 引擎在判红点 (D-K / 环内)
 * 调用。判据 = `extractFailSet(text)` 出失败名集: **非空 ∧ 全在基线** → 返注记;
 * **空集** (解析不出测试名 = 编译错/跑不起来/超时, INV-2) → null;
 * **任一新名字不在基线** → null (D-3 fail-closed)。
 *
 * 注记原文含被赦免名单 (INV-3 响亮): `存量红赦免 (S-37 下沉): N 条失败全在基线 — <names>`。
 * 这是 goal 层的**判断逻辑**: engine (dag 层) 不 import goal, 依赖方向不倒灌 (D-1)。
 */
export function makeBaselineWaiver(baselineFailSet: readonly string[]): (text: string) => string | null {
  const baselineSet = new Set(baselineFailSet);
  return (text: string): string | null => {
    const after = extractFailSet(text);
    if (after.length === 0) return null;
    for (const n of after) if (!baselineSet.has(n)) return null;
    return `存量红赦免 (S-37 下沉): ${after.length} 条失败全在基线 — ${after.join(', ')}`;
  };
}

export async function runGoal(goal: string, config: RunGoalConfig): Promise<RunGoalResult> {
  const stages: GoalStage[] = [];
  const sources: string[] = [];
  // 直通装载放在**一切之前** (G-2): 坏契约要在烧任何 token 之前被拒。
  const sdd = config.sddPath ? loadSddContract(config.sddPath) : undefined;
  let specPath: string | undefined = sdd?.path;
  let evidence = sdd?.text ?? '';
  let repoContext = '';
  // #209: 契约段这一位走的是**哪条路**。默认 simple 档 (下面 tier 分支各自改写它),
  // 契约段收尾时一次性发给 `onContract` —— 只有一个发射点, 于是新增分支漏发时 tsc/测试看得见。
  let specSource: SpecWriteSource = 'tier-simple';

  // ── S4: run 生命周期接线 (board = 协调介质, 不是真源; D-3/INV-1) ────────────────
  // 点火 → claimed (带声明写集, 相对路径, 与 sdd-direct 写集列同物); 终态 → terminal。
  // runId 锚与 D-2 散雾出口同一条解析序 (tickets → continuity → sessionId); 全缺 → 本跑
  // 自产一个 (claimed/terminal 仍配对, 只是没有外部回执锚)。写集与终态在别处都有真源
  // (SDD 声明 / RunGoalResult), 板只记指针 —— 不把历史唯一信息只写 board。
  // 异常抛 (classify/onClassified 这类引擎 bug) 不写 terminal: 那不是 run 的终态, 留下的
  // claimed 由 liveRuns 当活 run 显形 —— 板的工作是把它显出来, 不是替引擎撒谎。
  const boardRunId = config.tickets?.runId ?? config.dag.continuity?.runId ?? config.dag.sessionId ?? randomUUID();
  const boardDeclared = config.writeSet?.declared ?? SDD_DECLARED_WRITE_SET;
  // #160 D-1 (s1): 板根钉主仓状态锚。branch 档 run 的 config.cwd 是 worktree (产物树),
  // 板落那里 = 主仓 (生产侧 + ignition 预检 + readout 全读者) 看不到这张 run; 钉到
  // continuity.repoRoot → 主仓。head 档 (repoRoot 缺席或 = cwd) 行为逐字节不变 (INV-1)。
  const boardRoot = config.dag.continuity?.repoRoot ?? config.cwd;
  const emitBoard = (event: 'claimed' | 'terminal', outcome?: RunOutcomeKind): void => {
    try {
      const entry: BoardEntry =
        event === 'claimed'
          ? { v: 1, ts: new Date().toISOString(), runId: boardRunId, event, writeSet: [...boardDeclared.allowed] }
          : boardTerminalEntry(boardRunId, outcome!);
      appendBoard(boardRoot, entry);
    } catch (e) {
      // 板不是承重墙: 写板失败不掀桌, 留日志, run 照跑 (与 saveState 同款纪律)。
      console.error(`[run-goal] board ${event} 写失败 (不影响 run): ${String(e)}`);
    }
  };
  emitBoard('claimed');

  // ── 闸 C: 续跑状态读写 (无 continuity = 无 runId 可锚 → 闸不启用, 行为与从前逐字一致) ──
  const continuityRunId = config.dag.continuity?.runId;
  const statePath = continuityRunId ? join(config.cwd, '.omd', 'continuity', continuityRunId, 'goal-state.json') : undefined;
  const goalHash = createHash('sha256').update(goal).digest('hex');
  let prior: GoalPhaseState | undefined;
  if (statePath && existsSync(statePath)) {
    try {
      const j = JSON.parse(readFileSync(statePath, 'utf8')) as GoalPhaseState;
      if (j.goalHash === goalHash) prior = j;
    } catch (e) {
      // fail-open 但留证据 (本仓铁律 2): 读坏了照常重跑契约段, 不吞原因。
      console.error(`[run-goal] goal-state 读失败 (照常重跑契约段): ${String(e)}`);
    }
  }
  const saveState = (s: GoalPhaseState): void => {
    if (!statePath) return;
    try {
      mkdirSync(dirname(statePath), { recursive: true });
      writeFileSync(statePath, JSON.stringify(s));
    } catch (e) {
      console.error(`[run-goal] goal-state 写失败 (下次续跑将重跑契约段): ${String(e)}`);
    }
  };

  // ── S0/S-classify: 轻重路由 (D-5, 成本轴) + **验收分型** (D-I, 判据轴) ──────────
  //
  // 一次调用出两条轴。显式配置各自压过分类结果 —— 但 `tier` 只压成本轴, 压不到判据轴:
  // "我知道这活儿轻" 与 "我知道这活儿怎么判" 是两句不同的话, 说了前一句不等于说了后一句。
  // ⚠ `generate` 必须**回落到引擎的默认实现**, 不能只读 config.dag.generate ——
  // 后者是**注入口** (测试传 fake), 生产从来不设它 (`runExecutorDag` 自己 `?? makeDefaultGenerate`)。
  // 只读它的后果是: 生产每一次 dag_goal 都拿不到分类器 → 静默降级成探索型 → **D-I 的执行型验收
  // (那条强制可跑命令) 在真实路径上从未成立过**。2026-07-30 第一次 live 冒烟才看见这行:
  //   「验收分型未成立: 无分类器 (缺 generate/model)」
  // ——机制在、测试全绿、生产零生效, 正是这仓一直在杀的空旋钮形态, 而这次空掉的是防作弊的地基。
  // 闸 C: goal 未变的续跑直接用上次的分类 (探针首跑已验过; 重分类 = 重烧一遍还可能分出不同的判据轴)。
  const classified = prior
    ? prior.classified
    : await (config._classify ??
      ((g: string) =>
        classifyGoal(g, {
          generate: config.dag.generate ?? makeDefaultGenerate(config.dag.sessionId ?? randomUUID()),
          model: config.dag.conductorModel,
          // **空世界自检** (2026-07-31, G4): 活还没干之前先跑一遍判出的验收命令 —— 这时候就过 =
          // 它区分不了"做完了"与"还没做"。给不给 runner 决定这层加固在不在, 与 `generate` 那条
          // 教训同源: 只在测试里接、生产不接, 就是又一个"机制在、生产零生效"的空旋钮。
          ...(config.dag.commandRunner ? { runCommand: config.dag.commandRunner } : {}),
          // #204 (承 #199 D1): 判别力探针的反面世界要建成**真仓副本**才量得到判别力 —— 不给
          // repoRoot 它就退回空目录, 而空目录里任何仓内判据都必然失败 ⇒ 探针恒判「分得出」
          // (账本读数: 真跑过的 69 跑里它红过 0 次)。这一行就是那条 wire。
          repoRoot: config.cwd,
        })))(goal);
  // 探针裁决钩子: 分类定稿后恰好调一次 (含 fallback / 探索型), 进 `_runDag` 与任何运行记录之前。
  // `_classify` 抛错时这行到不了 → 天然不调, 不存在"抛错也硬调"的路径。
  config.onClassified?.(classified);
  const tier = config.tier ?? classified.tier;
  // ── 直通档判据来源 (2026-08-11, run 7d50fda2 修): 有 SDD 就从**它的 verify 列**推 ────────
  //
  // 分类器只看得见 goal 文本, 看不见 SDD —— 让它去编一条测试命令, 编出来的路径就是幻觉
  // (那次: SDD 写 `src/harness/board/run-board.test.ts`, 它编成 `src/harness/dag/…`)。
  // 而这条命令同时是 accept 节点、冻结判据 (freezeCriterion) 与基线 delta 的那一条,
  // 于是整个判据轴挂在一个 SDD 里根本不存在的路径上。SDD 已经写明这个 run 要跑哪些测试,
  // 判据就该从那儿来。显式 config.acceptance 仍压过一切 (调用方比 SDD 更知道自己在干嘛)。
  const sddAcceptance = sdd ? sddDerivedAcceptance(sdd) : undefined;
  const acceptance = config.acceptance ?? sddAcceptance ?? classified.acceptance;
  stages.push({
    stage: 'classify',
    // 判成执行型却拿不到可跑命令时, 分类器已降级成探索型 (acceptance.ts 的 fallbackExploratory)
    // 并把原因写进 learningGoal —— 这里把它抬成 stage 摘要, 别让降级只活在日志里。
    status: 'done',
    // 分类器降级 (判执行型却拿不到可跑命令) **不记 empty-result**: 它照样产出了一份可用的判据轴,
    // 只是换了一型。记成"空手而归"会让读数板把一次正常的探索型分类数成缺陷。
    outcome: 'success',
    summary:
      (acceptance.kind === 'executable'
        ? `tier=${tier} · 验收=执行型 \`${acceptance.command}\` (期望退出码 ${acceptance.expectExit})`
        : `tier=${tier} · 验收=探索型 · 学习目标: ${acceptance.learningGoal.slice(0, 120)}`) +
      // 判据换了来源要在摘要上看得见: 分类器编的那条与 SDD verify 列的差距, 正是 7d50fda2
      // 那次幻觉路径唯一能被人一眼看出的地方 (它当时只活在图里, 摘要上什么都没写)。
      (acceptance === sddAcceptance ? ' · 判据取自 SDD verify 列 (非分类器)' : '') +
      (prior ? ' · 复用续跑前分类 (goal 未变, 闸 C)' : ''),
  });
  // 闸 C: 分类一定稿就落状态 (契约段中途炸也不用重分类; 契约段成了再补 contract 字段)。
  if (!prior) saveState({ goalHash, classified });
  // 冻结的判卷标准: 同一份文本进 spec 起草与 execute 任务文本 (两处各写一份就会漂,
  // 而"判据漂了"正是作弊达标最舒服的入口)。
  const acceptanceBlock = renderAcceptance(acceptance);

  if (tier === 'complex') {
    // ── S0.5–S3 契约段 (D-G′, 2026-07-29): 勘察 → 调研 → 起草 **合成一个 `executor:'conductor'` 节点**。
    //
    // 推翻的是「预构造这三个节点」: 静态图表达不了"要不要先查外面"这个分支 —— 而 conductor 节点的
    // **展开调用本身**就是那次判断 (它看着 goal 与仓内情况决定吐哪几步), 分支不需要显式表达。
    // 更值钱的是**补调研**: `max_rounds > 1` 时环是**逐轮重展开**, 于是"契约写完发现证据不够"可以在
    // 第 2 轮长出一个第 1 轮压根没有的调研步 —— 不需要回边 (每轮都是一张全新的无环子图)。
    //
    // ⚠ **判卷标准刻意留在这个节点之外** (owner 定, 方案 A): 它由 classify 在环外算好, 冻进节点的
    // goal 当输入。放进子图就等于让**执行体自己的环**去产出判据 —— 而环每轮都重画, 判据也就跟着能变。
    // D-I 整套防作弊的地基就是那一句「判卷标准是执行体动不了的东西」, 判据进环这句话就没了。
    // (两条轴本来就是分开的: 成本轴"要不要接地"交给 conductor 判, 判据轴"成没成怎么判"绝不下放。)
    // 闸 C: 契约段产物在且 goal 未变 → 直接复用, 不重展开 conductor 子图。
    // specPath 记了但盘上文件没了 → 条件不成立, 掉进下面照常重跑 (状态不是真源, 盘上文件才是)。
    const priorContract = prior?.contract;
    if (sdd) {
      specSource = 'sdd-direct';
      // 直通 (G-1): 契约已结晶 —— 不勘察不调研不转录, SDD 全文 (含并行波形) 原样进 execute。
      stages.push({ stage: 'survey', status: 'skipped', outcome: 'not-needed', summary: 'SDD 直通: 契约已结晶, 不勘察' });
      stages.push({ stage: 'research', status: 'skipped', outcome: 'not-needed', summary: 'SDD 直通: 不调研' });
      stages.push({ stage: 'spec', status: 'done', outcome: 'success', summary: `SDD 直通 (零转录): ${sdd.path}` });
    } else if (priorContract && (!priorContract.specPath || existsSync(priorContract.specPath))) {
      specSource = 'reused';
      specPath = priorContract.specPath;
      evidence = priorContract.evidence;
      repoContext = priorContract.repoContext;
      sources.push(...priorContract.sources);
      stages.push({
        stage: 'survey',
        status: 'done',
        outcome: 'success',
        summary: `复用续跑前契约段 (闸 C): ${repoContext ? `${repoContext.split('\n').length} 行仓内事实` : '首跑无勘察输出'}`,
      });
      stages.push({ stage: 'research', status: 'skipped', outcome: 'not-needed', summary: '复用续跑前契约段 (闸 C): 不重新调研' });
      stages.push({ stage: 'spec', status: 'done', outcome: 'success', summary: specPath ?? '复用首跑契约正文 (spec 未落盘那次, 正文当契约)' });
    } else if (config.dag.agentRunner) {
      specSource = 'contract';
      const dir = config.specDir ?? join(config.cwd, 'docs', 'plan');
      const path = join(dir, `${(config._today ?? todayStr)()}-${goalSlug(goal)}.md`);
      const prepPlan: ConductorPlan = {
        name: 'goal-contract',
        nodes: {
          contract: {
            executor: 'conductor',
            ...(config.specRounds && config.specRounds > 1 ? { max_rounds: config.specRounds } : {}),
            goal: [
              `为下面这个目标产出一份**可执行的 SDD 契约**, 落盘到 ${path}。`,
              '',
              `## 目标\n${goal}`,
              '',
              '## 你要分解出的步骤 (按需, 不是必须全有)',
              '- **仓内勘察** (`executor:"agent"`, 只读): 找出目标在本仓的落点与既有实现, 输出逐行',
              '  `file:line — 事实`。没有这一步, 后面的调研与起草就是在不知道"我们已经有什么"的前提下进行。',
              '- **外部调研** (`executor:"research"`): **只在需要外部事实时才加** (选型 / 新机制 / 别人怎么做)。',
              '  仓内答得出来的问题别用它 —— 它抓不到一个真页面就会失败。',
              // researchRounds 是公开旋钮 (dag_goal 的入参)。合并成子图之后, 它只能经这句话传下去 ——
              // 不传就成了一个"配了但不生效"的空旋钮, 正是这仓一直在杀的形态。
              `  调研深度已定: 该节点必须写 \`"research": { "rounds": ${config.researchRounds ?? 1} }\`。`,
              '- **契约起草** (`executor:"agent"`, `template:"spec-author"`, `output_type:"file"`,',
              `  \`output_path:"${path}"\`): 必须用那张卡, 它带着契约骨架与防作弊条款。`,
              '  它要 depends_on 上面那些步骤 —— 拿不到事实就只能凭空写。',
              '',
              // D-I 方案 A: 判据在这里是**输入**, 不是待办。
              acceptanceBlock,
              '',
              '起草者的活是把上面这份判卷标准**原样写进契约的验收段**并据它拆实施步骤 ——',
              '**不是**重新发明一套自己够得着的判据。它在你开始之前就已经定死了。',
            ].join('\n'),
          },
        },
      } as ConductorPlan;
      try {
        // 独立 runId 后缀: 与 execute 段共用 runId 会让两张不同的图互相覆盖 `_dag.json`。
        // 后缀是确定性的 → `dag_goal resume=<runId>` 照样接得回这一段。
        const baseDagCfg = config.dag.continuity
          ? { ...config.dag, continuity: { ...config.dag.continuity, runId: `${config.dag.continuity.runId}-contract` } }
          : config.dag;
        // 实验臂 contract-distill (`.omd/experiments.json` 的 `contractFaninDistill`):
        // 只把契约段的 fan-in 摘要扇出闸收紧到 1 (原有字段透传, 不丢)。旗标 off/缺失/坏 JSON →
        // `readExperimentFlags()` 恒回 off, `dagCfg` 与 `baseDagCfg` 同一引用, 零字段增删 (INV-1)。
        const experimentFlags = readExperimentFlags();
        const dagCfg = experimentFlags.contractFaninDistill
          ? { ...baseDagCfg, faninSummary: { ...baseDagCfg.faninSummary, minFanout: 1 } }
          : baseDagCfg;
        const res = await (config._runDag ?? runExecutorDagWithPlan)(prepPlan, dagCfg);
        const leaf = res.results.contract;
        const touched = leaf?.filesTouched ?? [];
        const wrote = touched.some((f) => f.endsWith(`${goalSlug(goal)}.md`));
        specPath = wrote ? path : undefined;
        // 子节点里认出各段, 只为把结论如实抬进 stages (给人看的那一面不该因为合并成一个节点而变糊)。
        // **「压根没这一步」与「跑了但空手而归」要分开记** —— 合成一个 skipped 就把后者藏起来了,
        // 而后者才是需要人看一眼的那种 (勘察跑了却什么都没找到 ≠ 这次不需要勘察)。
        const kids = Object.entries(res.results).filter(([k]) => k.startsWith('contract::'));
        const researched = kids.filter(([, r]) => r.kind === 'research');
        sources.push(...researched.flatMap(([, r]) => r.sources ?? []));
        // 勘察步 = 有工具但没写文件的 agent 子节点 (起草步会写文件, 据此区分)。
        const surveyKid = kids.find(([, r]) => r.kind === 'agent' && !(r.filesTouched ?? []).length)?.[1];
        repoContext = surveyKid?.output?.trim() ?? '';
        evidence = leaf?.output ?? '';
        stages.push({
          stage: 'survey',
          status: !surveyKid ? 'skipped' : repoContext ? 'done' : 'failed',
          // N5 的原型对: 这两格 **status 都是"没成"那一侧, outcome 相反** ——
          // 「conductor 没分解出勘察步」= 它判定不需要 (什么都不用做);
          // 「勘察步跑了但空输出」= 需要人看一眼。旧的 skipped|failed 二选一恰好把这一对压扁过。
          outcome: !surveyKid ? 'not-needed' : repoContext ? 'success' : 'empty-result',
          summary: !surveyKid
            ? 'conductor 未分解出勘察步'
            : repoContext
              ? `${repoContext.split('\n').length} 行仓内事实`
              : '勘察步空输出 (跑了但什么都没找到 — 与"不需要勘察"不是一回事)',
        });
        stages.push({
          stage: 'research',
          status: researched.length === 0 ? 'skipped' : sources.length > 0 ? 'done' : 'failed',
          // 同上那一对: 「判无需外部调研」≠「调研跑了零来源」。后者在节点级是 no-sources,
          // 在 stage 级与勘察空输出同一个下一步 (重跑/换检索式) → 并进 empty-result。
          outcome: researched.length === 0 ? 'not-needed' : sources.length > 0 ? 'success' : 'empty-result',
          summary:
            researched.length === 0
              ? 'conductor 判定无需外部调研 (D-G′: 这个分支现在由它自己判)'
              : sources.length > 0
                ? `${sources.length} 个来源真抓到正文`
                : '零来源 — 无真抓取痕迹, 该结果不当证据用',
        });
        stages.push({
          stage: 'spec',
          // 没真写盘 = 只吐了文本 —— 记 failed 但不断流程 (下游拿正文当契约仍能跑)。
          status: wrote ? 'done' : 'failed',
          outcome: wrote ? 'success' : 'empty-result',
          summary: (wrote ? path : 'spec 未落盘 (契约段没产出文件), 下游改用其正文当契约') + (experimentFlags.contractFaninDistill ? ' · 实验臂: contract-distill' : ''),
        });
        // 闸 C: 有东西可复用才落状态 —— 全空的契约段 (evidence 空且没落盘) 下次续跑照常重跑。
        if (evidence || specPath) {
          saveState({ goalHash, classified, contract: { ...(specPath ? { specPath } : {}), evidence, repoContext, sources: [...sources] } });
        }
      } catch (err) {
        // 抛错 = 引擎自己出事, 与"契约写了但没达标"是两回事 (ERROR vs STALLED)。
        specSource = 'contract-error';
        stages.push({ stage: 'spec', status: 'failed', outcome: 'infra-error', summary: `契约段抛错: ${String(err).slice(0, 200)}` });
      }
    } else {
      specSource = 'no-agent-runner';
      // 缺件跳过与"不需要"跳过共用 status: 'skipped', 而下一步相反 (补配置 vs 什么都不用做)。
      stages.push({ stage: 'survey', status: 'skipped', outcome: 'missing-capability', summary: '无 agentRunner → 无仓内事实' });
      stages.push({ stage: 'research', status: 'skipped', outcome: 'missing-capability', summary: '无 agentRunner → 契约段整体跳过' });
      stages.push({ stage: 'spec', status: 'skipped', outcome: 'missing-capability', summary: '无 agentRunner → 不产 spec, 直接执行目标' });
    }
  } else {
    stages.push({ stage: 'research', status: 'skipped', outcome: 'not-needed', summary: 'simple 档: 直接 Execute→Verify (D-5)' });
    stages.push({ stage: 'spec', status: 'skipped', outcome: 'not-needed', summary: 'simple 档: 无需先定契约 (D-5)' });
  }

  // ── #209: 「契约段有没有产出 spec 文件」在**这一刻**记账 ──────────────────────────
  // 这一位的原料是执行期事实 (契约段那张图的 filesTouched → 上面的 `wrote` → specPath),
  // **不是** `existsSync`。隔离档跑完 worktree 就被清、分支合进 main 后新增也归零 ——
  // 事后再问这一位就只剩 NULL, 而 NULL 会被念成"没落盘" (#177 那次连错三次的根因)。
  // 回调不给 = 一行不多跑 (INV-1); 抛错只留痕不掀桌 —— 记账挂了不该让整趟 goal 陪葬。
  const specWrite = classifySpecWrite(specSource, specPath);
  try {
    config.onContract?.(specWrite);
  } catch (err) {
    logger.warn({ specWrite, err: String(err) }, '[run-goal] #209 spec 落盘记账回调抛错 → 该跑这一列留 NULL (不影响执行)');
  }

  // ── S5-S8 Execute + Verify + 1 轮修复: 内层 DAG 的外层 fixpoint。
  // task = spec 全文 (有则) 否则 goal 本身; 执行器读到的是契约, 不是对话。
  //
  // D-I: 判卷标准**无条件**附在任务文本末尾 —— 包括 simple 档 (它不产 spec, 判据没有别的落点)
  // 与 spec 未落盘的降级路径。conductor 据它把验收命令连成图里一个 executor:'command' 节点;
  // 探索型则据它知道"这次没有机器判据"从而不去伪造一个。
  const body = specPath
    ? sdd
      ? // 直通模式 (G-6 探针实测抓的洞): specPath 是**基座树**路径, 渲染进 prompt 会让 leaf
        // 把它当仓根 → 绝对路径写出隔离树 (bwrap 里自检还"成功", 产物闸才拦住)。
        // 改念执行根, 契约全文内联 —— leaf 的世界里只有 worktree。
        `按下面这份 SDD 契约实施 (执行根: ${config.cwd} —— 一切相对路径以它为准, 禁止写到执行根之外):\n\n${evidence}`
      : `按下面这份 SDD 契约实施 (契约全文已落盘 ${specPath}):\n\n${evidence}`
    : evidence
      ? `${goal}\n\n参考材料:\n${evidence}`
      : goal;
  const task = `${body}\n\n${acceptanceBlock}`;
  // 成因由**调用点**给, 不在这里按 summary 文本猜 —— 猜就是又一处会漂的独立判断 (P1 为它付过账)。
  const bail = (summary: string, outcome: RunOutcomeKind): RunGoalResult => {
    stages.push({ stage: 'execute', status: 'failed', outcome, summary });
    emitBoard('terminal', outcome);
    return { goal, tier, acceptance, stages, ...(specPath ? { specPath } : {}), sources, repoContext, converged: false, rounds: 0, reusedNodes: [], outcome };
  };
  // ── 内环 v2 切片 5 (SDD 2026-08-11-inner-loop-v2 D-1): 直通 v2 —— 分解表可编译时零 conductor ──
  // 平铺图 = 切片×(RED/实装/GREEN) + accept (D-4 定向 TDD); accept 命令 = 冻结判据同一条命令,
  // D-3 停止规则合一。仅执行型验收可平铺: 探索型没有确定性停机判据, 平铺图会跑完即止无人判。
  // 编译不过 → **响亮回落** v1 conductor 铺图 (warn + 摘要注记, 不静默): 直通 v1 的存量输入
  // (分解段无表 / verify 列是验收点引用而非命令) 今天都不可编译, 拒跑是无谓回归;
  // G-7 读数靠 plan 名分辨 (goal-execute-flat vs goal-execute)。
  let flatPlan: ConductorPlan | undefined;
  let flatFallback: string | undefined;
  let flatParallelism: string | undefined;
  /** S-46 缺片闸的判据面 —— 只在直通v2真编译成功时有值 (回落 conductor 铺图时切片不是执行单位)。 */
  let flatSlices: readonly SddSlice[] | undefined;
  if (sdd && acceptance.kind === 'executable') {
    try {
      const breakdown = parseBreakdown(sdd.text);
      const compiled = compileBreakdown(breakdown, {
        acceptCommand: acceptance.command,
        ...(acceptance.expectExit !== undefined ? { acceptExpectExit: acceptance.expectExit } : {}),
        name: 'goal-execute-flat',
      });
      // O-6 (2026-08-11 二发教训): RED 的前提是切片 verify 在**实装前是红的** —— 引用既有绿
      // 测试文件时结构性不成立 (旧测试全绿, RED 期望 1 得 0, 整图白跑一轮才发现)。有 commandRunner
      // 就逐片探一枪 (acceptance.ts 的 vacuous 纪律推广到切片级): 已绿 = 判据虚 **或** 活已干完,
      // 两种机械分不开, 都不该进平铺 —— 抛给回落 (v1 的冻结判据对"已完成"那半收敛最快)。
      // 没 runner = 闸缺席 (fail-open, 测试/无命令能力档), 行为同今天。
      if (config.dag.commandRunner) {
        for (const s of breakdown.slices) {
          const probe = await config.dag.commandRunner({ command: s.verify });
          if (probe.exitCode === 0) {
            throw new Error(
              `切片 ${s.id} 的 verify 实装前已绿 (\`${s.verify}\` → 0): RED 无法成立 —— ` +
                '判据虚 (换实装前天然红的命令, 如产物 grep) 或活已干完 (O-6 vacuous 探针)',
            );
          }
        }
      }
      // 编译器刻意不内联 SDD 全文 (token 注入由接线方裁, 见 sdd-compile 头注): 这里给每个
      // **切片实装节点**前置与 conductor 路径同源的契约上下文 (G-6 教训: 内联全文, 不引用
      // 基座路径); RED/GREEN/accept 是 command 节点, 不读文本, 不背这份 token。
      flatPlan = {
        ...compiled,
        nodes: Object.fromEntries(
          Object.entries(compiled.nodes).map(([id, n]) => [
            id,
            n.executor === 'agent' ? { ...n, goal: `${body}\n\n${n.goal}` } : n,
          ]),
        ),
      } as ConductorPlan;
      // 并行性 advisory (owner 2026-08-11): 只报不拒 —— 假串行点名给结晶期审问, 假并行归乱序闸。
      flatParallelism = describeParallelism(parallelismReadout(breakdown));
      // 赋值放在编译成功**之后**: 编译不过就回落 conductor 铺图, 那时切片只是给人读的,
      // 拿它去判缺片会对每一次回落都造一片假红。
      flatSlices = breakdown.slices;
    } catch (err) {
      flatFallback = String(err instanceof Error ? err.message : err).slice(0, 160);
      logger.warn(
        { sdd: sdd.path, err: flatFallback },
        '[run-goal] 直通v2: 分解表编译不过 → 回落 conductor 铺图 (v1, 不静默)',
      );
    }
  }
  const execPlan: ConductorPlan = flatPlan ?? {
    name: 'goal-execute',
    nodes: {
      execute: {
        executor: 'conductor',
        max_rounds: config.maxRounds ?? 2,
        // D-F 的兜底那一半: 撤了外层就没有别的层再问「整体目标成了吗」。这个开关让内环在
        // **最后一轮也判一次**, 裁决经 LeafResult.converged 出来 —— 否则 `dag_goal` 只能拿
        // "跑完了"当"成了", 那是谎报完成最舒服的入口。
        judge_final: true,
        goal: task,
      },
      // ── D-I 的冻结判据: **环外的确定性闸** (2026-07-30 第三次 live 冒烟补上) ──────────
      //
      // 此前判卷标准只进任务文本, 指望 conductor 把它连成图里一个 command 节点 —— 实测它没连:
      // 冻结的是 `grep -qx "hello omd" notes/hello.md`, 它自己画的验证步是 `cat notes/hello.md`。
      // 于是"执行型验收"这四个字在生产上从没被真跑过, D-J 整套防作弊的地基就只剩一句提醒。
      //
      // 放**环外**而不是让内环去跑, 是 D-I 方案 A 那条纪律的直接后果: 判卷标准必须是执行体动不了的
      // 东西。环每轮重画子图, 判据进环就跟着能变; 挂在环外这一个 command 节点上, 它由 runGoal 构造、
      // conductor 碰不到、内环 judge 也改不了它。
      //
      // 语义是**必要非充分**: 收敛 = 内环 judge 说成了 **且** 这条命令退出码对。judge 说成了而命令
      // 没过 = 正是 D-I 要抓的那种"作弊达标"; 命令过了而 judge 说没成 = 任务里还有命令覆盖不到的
      // 明确要求。两侧都 fail-closed。
      ...(acceptance.kind === 'executable'
        ? {
            accept: {
              executor: 'command',
              command: acceptance.command,
              expect_exit: acceptance.expectExit,
              depends_on: ['execute'],
              goal: '冻结判据 (环外确定性闸)',
            },
          }
        : {}),
    },
  } as ConductorPlan;
  // ── D-1 (SDD cairness-distill): mode 感知基线 delta —— 跑批前存基线、跑后比对 ──────────
  // 基线 = 批前用同一份 commandRunner 跑一次验收命令 (与 accept 节点同 runner、同白名单闸);
  // 只把「新引入失败」判红, 基线里就在的老失败 (unchanged-failure) 单列不红 (INV-4)。
  // fail-open: 没配 runner (测试/无 command 能力) → 闸缺席; 抛错也缺席, 但不吞证据 (INV-1)。
  // ⚠ S-37: 基线**只存退出码那一格是不够的** —— 基线红在本仓是常态, 而 fail→fail 判
  //   unchanged-failure 会把真回归一起赦免。所以同时存 `(fail)` 名字集, 判据降到一条测试。
  let baselineSide: AcceptSide | undefined;
  if (acceptance.kind === 'executable' && config.dag.commandRunner) {
    try {
      const bl = await config.dag.commandRunner({ command: acceptance.command });
      baselineSide = acceptSideOf(bl.exitCode === (acceptance.expectExit ?? 0) ? 'pass' : 'fail', bl.text);
    } catch (err) {
      logger.warn({ command: acceptance.command, err: String(err) }, '[run-goal] D-1 基线跑不起来 → 闸缺席 (fail-open)');
    }
  }
  let exec: ExecutorDagResult;
  try {
    // 护栏③: **只有可执行判据**才进环。非可执行判据的 `oracleOk` 恒 true, 给了它就等于第一轮必停。
    // 环外那个 `accept` 节点保留不动 —— 它仍是收尾时那次权威判定 (`oracleOk` 的取值源没变),
    // 环内这份只负责"能不能早点停", 两者判的是同一条命令, 不会给出相反的结论。
    // S-37 下沉 (D-3, goal 层半): baselineSide 算出来了就把闭包挂进 freezeCriterion.waiveRed,
    //   引擎在红点 (D-K 节点命令判红 / 环内冻结判据) 调用。缺席 → 闸缺席, 行为逐字节不变 (INV-1)。
    const waiveRed = baselineSide !== undefined ? makeBaselineWaiver(baselineSide.failSet) : undefined;
    const execCfg =
      acceptance.kind === 'executable'
        ? {
            ...config.dag,
            freezeCriterion: { command: acceptance.command, ...(acceptance.expectExit !== undefined ? { expectExit: acceptance.expectExit } : {}), ...(waiveRed ? { waiveRed } : {}) },
            // SDD 2026-08-22 「冻结判据在重规划轮里并不冻结」, C-3/INV-6:
            // 只在 flatPlan 编译成功**之后**挂上 `accept` 钉点 — 回落 conductor 铺图
            // 那条路上 accept 由 run-goal 自己构造在环外 (今天的 v1 行为, 不动)。
            // 这里 `flatUsed` 还**没**赋值(线 1008 才赋), 用 `flatPlan !== undefined` 等价判。
            ...(flatPlan !== undefined ? { frozenNodes: ['accept'] } : {}),
          }
        : config.dag;
    exec = await (config._runDag ?? runExecutorDagWithPlan)(execPlan, execCfg);
  } catch (err) {
    return bail(`execute 抛错: ${String(err).slice(0, 200)}`, 'infra-error');
  }
  const flatUsed = flatPlan !== undefined;
  const execLeaf = exec.results.execute;
  if (!execLeaf && !flatUsed) return bail('execute 节点无结果 (引擎没跑到它)', 'infra-error');
  // D-I 环外闸: 执行型才有这个节点。它**没跑**(引擎没走到 / 被 quorum 级联跳过)也算没过 ——
  // 冻结判据的意义就是"没被证明过就不算成", fail-closed 与 converged 缺席同一条纪律。
  const acceptLeaf = acceptance.kind === 'executable' ? exec.results.accept : undefined;
  // ── 判据的绿有「它是哪一轮量的」这个属性 (2026-08-21, run 58df6b9e 复盘) ──────────────
  //
  // P2 那跑的形状, 逐跳全部有盘上证据:
  //   05:25:50  accept 节点真跑真绿, 写下 checkpoint (accept.json, status:'done')
  //   ~05:28    verifier 否决 → 重规划 → 毒集丢绿 → 半回滚, **盘被改坏**
  //   第 2 轮    accept **不在毒集前向闭包里** → resume-skip 直接复用那份绿
  //   收尾      oracleOk = (status === 'done') = true → 终态 delivered-with-red + done
  //
  // 扎人的地方: 下面那道 #165① 收尾复验**只在 `!oracleOk` 时触发**, 而 oracleOk 已经被这份
  // **旧的**绿撑成 true —— **闸被自己要防的那个东西关上了**。P2 日志里确实没有任何 #165① 行。
  //
  // 所以判据要多问一句: 这份绿**属不属于最终这棵树**。两个条件都真才叫不属于 ——
  //   ① 它是 resume 复用来的 (`skipped === true`), 不是这一轮真量的;
  //   ② 本次 run 重规划过 (verifier 否决 → escalation), 也就是盘**可能**在那之后变过。
  // 少任一个都不判 stale: 只复用没重规划 = 盘没动过, 那份绿仍然作数 (别给每次 resume 都加
  // 一次全量测试的钱); 只重规划没复用 = accept 这一轮真跑过, 本来就算数。
  //
  // ⚠ `status === 'skipped'` (quorum 级联压死) 与 `skipped === true` (resume 复用) 是两个正交概念
  //   (见 LeafResult 那两个字段的注), 这里问的是后者。
  const acceptCheckpointGreen = acceptance.kind !== 'executable' ? true : acceptLeaf?.status === 'done';
  const replanned = exec.verification?.escalated === true || (exec.verification?.attempts ?? 1) > 1;
  const acceptStale = acceptance.kind === 'executable' && acceptCheckpointGreen && acceptLeaf?.skipped === true && replanned;
  // 复验一次。**两个触发条件合并在这一处** —— 分两处写就是两处会漂 (而这条闸的病正是"触发
  // 条件被另一个变量关掉"): ① 原 #165①: accept 压根没跑 (缺席 / 被级联压死), 复验绿只换终态词;
  // ② 新: 绿是陈旧的, 复验结果**直接顶替** oracleOk (它才是最终这棵树上的答案)。
  let oracleRecheckGreen = false;
  let oracleRecheckRan = false;
  if (
    acceptance.kind === 'executable' &&
    (!acceptCheckpointGreen || acceptStale) &&
    acceptLeaf?.status !== 'failed' &&
    config.dag.commandRunner
  ) {
    try {
      const rc = await config.dag.commandRunner({ command: acceptance.command });
      oracleRecheckGreen = rc.exitCode === (acceptance.expectExit ?? 0);
      oracleRecheckRan = true;
      logger.info(
        { command: acceptance.command, exitCode: rc.exitCode, green: oracleRecheckGreen, why: acceptStale ? 'stale-green' : 'accept-没跑' },
        acceptStale
          ? '[run-goal] 判据陈旧闸: accept 的绿是 resume 复用来的, 而本 run 重规划过 → 在最终这棵树上重量一次'
          : '[run-goal] #165① accept 没跑 (级联压死) → 冻结判据收尾复验',
      );
    } catch (err) {
      // fail-closed 不吞证据: 复验跑不起来时**不许**拿那份陈旧的绿冒充最终答案。
      logger.warn({ err: String(err), stale: acceptStale }, '[run-goal] 冻结判据复验跑不起来 → 维持原判 (fail-closed, 不吞证据)');
    }
  }
  // stale 时以复验为准; 复验没跑成 → 陈旧的绿**不作数** (fail-closed: 没在最终这棵树上证明过就不算成)。
  const oracleOk = acceptStale ? oracleRecheckRan && oracleRecheckGreen : acceptCheckpointGreen;
  if (acceptStale && !oracleOk) {
    logger.warn(
      { command: acceptance.command, recheckRan: oracleRecheckRan },
      '[run-goal] 判据陈旧闸: 复用的绿在最终这棵树上**不成立** → 判据判红 (原实装会拿它发 delivered 终态)',
    );
  }
  // `converged` 缺席 = 没人判过 → 一律**不算成** (judge_final 已保证它在, 缺席意味着引擎跑歪了)。
  // **裁决位 = 环自己的结论** (#148, 2026-08-17): 判据停时它是判据说的 (D-I 以判据为准),
  // judge 停时它是 judge 说的。此前这里让 judgeConverged **压过** converged —— 而那一位的类型
  // 契约 (LeafResult.judgeConverged) 明写「judge 的票只记录不决定, 单独带出去是给判据轴量的」。
  // 观测位当裁决位用的实测后果 (B0 run 6251afc4): 环记 stop.kind=success·判据绿, 回执判
  // not-converged, 指引「加轮数 resume」—— 而 resume 进环判据仍绿、round 1 再停, 是个不动点。
  // 平铺路径 (D-3): 没有 conductor 节点就没有 judge 投票 —— 停止规则唯一 = 冻结判据,
  // criteria.judge 恒等于 oracle, 「判词✅/判据❌打架」这个状态在平铺图上从型别消灭。
  const loopOk = flatUsed ? oracleOk : execLeaf!.converged === true;
  // judge 自己那一票 (判据轴观测位, 进 criteria.judge; 与裁决位分开 —— 「judge 太紧」那一格
  // 靠它才观测得到)。缺席 = 没走环内判据那条路, 环结论即 judge 说的。
  const judgeSaidOk = flatUsed ? oracleOk : ((execLeaf!.judgeConverged ?? execLeaf!.converged === true));
  // D-1 delta: after 侧 = accept 节点的实判 (done→pass / failed→fail / 没跑→缺席)。
  // 缺席 + 两侧都 full → 比对器判 new-failure (fail-closed, 与 oracleOk 同一条纪律:
  // 「没被证明过就不算成」—— 引擎没跑到 accept 节点, 覆盖就回退了)。
  let verifyDelta: DeltaReport | undefined;
  /** S-37 第 2 半:第一次读到、复跑没复现的失败(抖动证据,进判词不进判红)。 */
  let flakyFailures: string[] = [];
  if (baselineSide !== undefined && acceptance.kind === 'executable') {
    const acceptStatus = exec.results.accept?.status;
    const afterStatus: VerifyStepStatus | undefined =
      acceptStatus === 'done' ? 'pass' : acceptStatus === 'failed' ? 'fail' : undefined;
    let afterSide = acceptSideOf(afterStatus, exec.results.accept?.output ?? '');
    verifyDelta = buildAcceptDelta(baselineSide, afterSide);
    // ★ 一次红不算红(S-37 半 a:同 HEAD 两次的 fail 名字集实测不相交)。**只在要判红时**
    //   才付这次复跑 —— 绿的那条路一次都不多跑。复跑抛错 = 不改判(fail-closed:
    //   证不了它是抖动就按红算), 但留证据。
    const needsConfirm = verifyDelta.red && verifyDelta.newFailures.some((id) => id.startsWith(TEST_STEP_PREFIX));
    if (needsConfirm && config.dag.commandRunner) {
      try {
        const again = await config.dag.commandRunner({ command: acceptance.command });
        const againSet = acceptSideOf('fail', again.text).failSet;
        flakyFailures = unstableFailSet(afterSide.failSet, againSet);
        if (flakyFailures.length > 0) {
          logger.warn({ flaky: flakyFailures, command: acceptance.command }, '[run-goal] D-1 复跑未复现 → 不判红, 记抖动 (S-37)');
          afterSide = { status: afterSide.status, failSet: stableFailSet(afterSide.failSet, againSet) };
          verifyDelta = buildAcceptDelta(baselineSide, afterSide);
        }
      } catch (err) {
        logger.warn({ err: String(err) }, '[run-goal] D-1 复跑跑不起来 → 维持原判红 (fail-closed, 不吞证据)');
      }
    }
  }
  // ── D-2 (SDD cairness-distill): ex-ante 写集声明 + 跑后 diff 对账 (孤儿检测) ──────────
  // 声明面 = exec 图里真跑过 (done/failed) 的节点的 write_set; 在跑节点 = 同一集合 —— 本 run 的
  // 节点在收尾当下都算在跑, 历史 run 的声明根本不进输入 (G-4: 已完成节点不再授权后续改动,
  // 由构造保证, 不靠运行时猜)。diff 面 = 跑后 git 工作树改动 (可注入); 收集失败 → 闸缺席
  // (fail-open, 不吞证据)。touch 面 = touch ledger 的写事件, 由判定器的声明面承接 ——
  // 本文件不持 ledger 句柄, 有句柄的装配层经同一个 attributeWriteSet 接对账。
  // S-2: 同一份 diff 再走 run 级声明写集面 (allowed/forbidden/outside) —— 判据在 write-set.ts,
  // 本文件不重写; 两轴 (节点归属 / run 声明面) 分开报, 不混成一个红 (INV-4)。
  let writeSet: WriteSetReport | undefined;
  let writeScope: WriteScopeReport | undefined;
  let sliceCoverage: SliceCoverageReport | undefined;
  if (config.writeSet) {
    try {
      const diffFiles = config.writeSet._collectChangedFiles
        ? config.writeSet._collectChangedFiles()
        : collectChangedFiles(config.cwd);
      // S-46 缺片闸: 与上面两轴共用**同一份 diffFiles** (各收各的 = 两个判词能互相矛盾)。
      // 只在直通v2真用上时判 —— flatUsed 之外切片不是执行单位。
      if (flatUsed && flatSlices) sliceCoverage = coverSlices(flatSlices, diffFiles);
      // S-2 run 级声明写集面 (与节点级阶梯正交: 阶梯裁「谁写的」, 声明面裁「该不该写」)。
      // forbidden = 撞并发 run 的写面 (红, 非零退出码语义); outside = 声明面外 (INV-3 读数,
      // 声明缺席 ≠ 违规, 不红)。缺省面 = write-set.ts 的 SDD_DECLARED_WRITE_SET (本 SDD run);
      // 并发/其他 run 经 config.writeSet.declared 注入自己的面。
      const declared = config.writeSet.declared ?? SDD_DECLARED_WRITE_SET;
      const scopeFiles = diffFiles.map((file) => ({ file, kind: classifyWriteScope(file, declared) }));
      writeScope = {
        files: scopeFiles,
        forbidden: scopeFiles.filter((f) => f.kind === 'forbidden').map((f) => f.file),
        allowed: scopeFiles.filter((f) => f.kind === 'allowed').map((f) => f.file),
        outside: scopeFiles.filter((f) => f.kind === 'outside').map((f) => f.file),
      };
      const declarations: WriteSetDeclaration[] = Object.entries(exec.plan.nodes)
        .filter(([, n]) => Array.isArray(n.write_set))
        .filter(([id]) => {
          const st = exec.results[id]?.status;
          return st === 'done' || st === 'failed';
        })
        .map(([id, n]) => ({ nodeId: id, files: n.write_set ?? [], status: exec.results[id]!.status }));
      writeSet = attributeWriteSet({
        diffFiles,
        declarations,
        activeNodeIds: Object.keys(exec.results),
        ...(config.writeSet.globalExempt ? { globalExempt: config.writeSet.globalExempt } : {}),
        ...(config.writeSet.intentional ? { intentional: config.writeSet.intentional } : {}),
      });
    } catch (err) {
      logger.warn({ err: String(err) }, '[run-goal] D-2 写集对账起不来 → 闸缺席 (fail-open)');
    }
  }

  // ── P4 设计审核 (advisory, 不上关键路径) ────────────────────────────────────────
  // INV-3: 审核失败/timeout → converged 与无审核节点逐位相同。
  // INV-6 / G-4: 写集与前端 glob 不相交 → 零模型调用。
  let designReview: DesignReviewResult | undefined;
  if (config.designReview) {
    try {
      const reviewFiles = config.writeSet?._collectChangedFiles
        ? config.writeSet._collectChangedFiles()
        : collectChangedFiles(config.cwd);
      const requestedEscalation = config.designReview.escalationSeat ?? config.dag.conductorEscalationModel;
      const escalationSeat = escalationProviderReady(requestedEscalation) ? requestedEscalation : undefined;
      const runReview = config.designReview._runReview ??
        productionDesignReviewRunner(config, config.designReview.screenshotCommand, escalationSeat);
      designReview = await maybeRunDesignReview({
        cwd: config.cwd,
        changedFiles: reviewFiles,
        ...(config.designReview.profile ? { profile: config.designReview.profile } : {}),
        ...(runReview ? { runReview } : {}),
        ...(config.designReview.screenshotCommand ? { screenshotCommand: config.designReview.screenshotCommand } : {}),
        ...(escalationSeat ? { escalationSeat } : {}),
        ...(config.designReview.repairAttempted !== undefined
          ? { repairAttempted: config.designReview.repairAttempted }
          : {}),
      });
    } catch (err) {
      logger.warn({ err: String(err) }, '[run-goal] 设计审核起不来 → 闸缺席 (fail-open, INV-3)');
    }
  }
  // ── #165① 的复验**已上移**到 oracleOk 的定义处 (2026-08-21) ────────────────────────
  //
  // 原先它在这里, 而它的触发条件是 `!oracleOk` —— 于是 oracleOk 被一份**陈旧的**绿撑成 true 时,
  // 这道闸就再也不开火 (run 58df6b9e 的死法)。上移之后 oracleOk 在它的定义处就是可信的,
  // 下游一个字都不用改; 两个触发条件 (accept 没跑 / 绿是陈旧的) 也合并成一处, 不留两份会漂的判据。
  // 语义保持: #165① 那半复验绿仍然**不翻 converged** (见 `oracleRecheckGreen` 的下游用法),
  // 只把终态词从「交付没达标」换成 delivered-with-red。
  const converged = loopOk && oracleOk;
  // judge 异议 (判据绿收敛而 judge 判没成): **只报不翻终态** —— 这一格是判据轴「judge 太紧 /
  // 判据覆盖不够」的样本, 判词在 continuity 的 _loop-execute.json。翻终态的版本就是 #148。
  const judgeDissent = converged && !judgeSaidOk;
  // 平铺路径没有内环 —— rounds 恒 0 是事实不是缺数 (摘要有「直通v2平铺」注记, 不会读成"没跑")。
  const roundCount = execLeaf?.rounds ?? 0;
  // INV-GOAL-3 可证面: 复用现在全发生在**内环**里 (子节点内容寻址, 同 id ≡ 同规格 + 同祖先规格)。
  const reusedNodes = exec.reusedNodes ?? [];
  // D-Q / D-P: 两种"没跑完但不是失败"的收尾, 各自如实报 —— 都恒不算收敛 (fail-closed)。
  const blocked = execLeaf?.blocked;
  const budgetStopped = execLeaf?.budgetStopped;
  // **引擎自己出事**导致环提前退出 (今天唯一来源: judge 调不通)。与 blocked 分开的理由是
  // 下一步相反: blocked 要人给外部输入, 这个要**修引擎** —— 而它此前落 `not-converged`,
  // 于是读的人会去加轮数, 恰恰是最没用的那个动作。
  const infraStopped = execLeaf?.infraStopped;
  const cancelledReason = exec.cancelled?.reason;
  // 判词与 oracle **分开报**: 两者不一致时那句话本身就是结论 —— judge 说成了而冻结判据没过,
  // 正是 D-I 要抓的"作弊达标"; 反过来则是"任务里还有命令覆盖不到的明确要求"。
  const oracleNote =
    acceptance.kind !== 'executable'
      ? ''
      : oracleOk
        ? ' · 冻结判据 ✅'
        : ` · **冻结判据没过** (\`${acceptance.command}\` → ${acceptLeaf?.status ?? '没跑'})`;
  // ── N5: 终止原因**判一次, 两个消费者读同一份** ────────────────────────────────
  //
  // 此前这道阶梯只活在下面那句摘要文本里 —— 于是 `status` 那一位不得不用 `converged ? done : failed`
  // 独立再判一遍, 两处一漂就出现了 2026-07-31 live 那行「一次正确的 BLOCKED 被念成 failed」。
  // 阶梯顺序一字未改 (外部事件 > 资源轴 > 环的结论 > 判据分歧), 只是把它的结论抬成了一个词。
  // #165① 洞①: 走 outcome 细分路, 不走 verification 附注路 —— verification 附注路要动
  // `dag-record.ts:272/410/508/624` + `dag-tools.ts:247-274/272/350-352` +
  // `omd-readout.ts:952/961/1293/1348/1824-1866/2427` + `read-api.ts:22` 共 9+ 消费面, 并需
  // `ALTER omd_dag_runs` 存 attempts/escalated/circuitBroken; outcome 细分只扩
  // `run-goal.ts:1131-1147` 里已存在的 `delivered-with-red` 行为与测试, db schema 不变, 消费者改动面显著更小。
  // D-2 真值表: converged=true 不再无条件 success —— 图内有 status === 'failed' 的子节点 →
  // delivered-with-red (交付达标但有节点红, INV-2), 无红 → success (INV-1)。红节点检查只在
  // converged 真分支问 (converged=false 分支一字不动: 交付没达标优先, INV-3, 且保留既有
  // oracleRecheckGreen → delivered-with-red 复验分支)。
  const hasRedLeaf = Object.values(exec.results).some((n) => n.status === 'failed');
  const outcome: RunOutcomeKind = converged
    ? hasRedLeaf
      ? 'delivered-with-red'
      : 'success'
    : cancelledReason
      ? 'cancelled'
      : infraStopped
        ? 'infra-error'
        : budgetStopped
          ? 'budget-exhausted'
          : blocked
            ? 'blocked'
          // #165①: 复验绿排在环内结论细分之前 —— 交付真身已被独立判据证实, 「加轮数/看哪边错」
          // 的指引对它都是误导; 但排在外部事件/资源轴之后 (取消/引擎出事/预算停的止损动作更强)。
          : oracleRecheckGreen
            ? 'delivered-with-red'
          : loopOk && !oracleOk
            ? 'oracle-failed'
            : 'not-converged';
  stages.push({
    stage: 'execute',
    // ⚠ `status` 保持原样 (三态一字未动, 全仓 `=== 'done'` 的消费者行为不变) ——
    // 一次正确的 BLOCKED 在这一位上**仍然**是 failed。念对它是 `outcome` 的职责, 不是这一位的。
    status: converged ? 'done' : 'failed',
    outcome,
    summary:
      `${roundCount} 轮${
        outcome === 'success' ? '收敛'
        : outcome === 'cancelled' ? `被叫停 (${cancelledReason}) — 已跑完的保留, 同 runId 可 resume`
        : outcome === 'budget-exhausted' ? `预算停: ${budgetStopped!.slice(0, 300)}`
        : outcome === 'infra-error' ? `引擎侧停: ${infraStopped!.slice(0, 300)} —— **别加轮数**, 这是引擎该修的`
        : outcome === 'blocked' ? `阻塞: ${blocked!.slice(0, 300)}`
        : outcome === 'oracle-failed' ? '环说成了但冻结判据(环外)没过 (D-I: 以判据为准)'
        // 两条路都落 delivered-with-red, 摘要必须说清是哪一条 —— 混着念就是在编现场:
        // converged=true 那条 accept **真跑真绿**, 照抄「accept 被级联压死没跑」会让读的人
        // 去查一个不存在的级联。判据 = converged (复验路恒 false, 见上面 oracleRecheckGreen 分支)。
        : outcome === 'delivered-with-red' ? (converged
            ? `交付达标但有节点红 (#165①: 冻结判据 ✅ 而图内 ≥1 子节点红 — 人审红节点, 别整轮重跑)`
            : `交付达标但有节点红 (#165①: accept 被级联压死没跑, 冻结判据收尾复验绿 \`${acceptance.kind === 'executable' ? acceptance.command : ''}\` — 人审红节点, 别整轮重跑)`)
        : `未收敛 (${execLeaf?.status ?? '平铺图未过冻结判据'})`
      }${oracleNote}${judgeDissent ? ' · ⚠ judge 异议: 判据绿收敛而 judge 判没成 —— 判据轴「judge 太紧/判据覆盖不够」样本, 判词见 continuity _loop-execute.json' : ''}` +
      `${flatUsed ? ` · 直通v2平铺 (并行读数: ${flatParallelism})` : ''}${flatFallback ? ` · 直通v2回落: ${flatFallback}` : ''}` +
      `${reusedNodes.length ? ` · 复用 ${reusedNodes.length} 节点` : ''}` +
      `${exec.observations?.length ? ` · 图外观察 ${exec.observations.length} 条` : ''}` +
      `${verifyDelta ? ` · D-1 delta: ${summarizeDelta(verifyDelta)}` : ''}` +
      // S-37: 抖动**要写出来**。不写 = 「复跑一次就绿了所以放行」这件事在盘上没有痕迹,
      // 而那正是下一个人判断这条闸可不可信时唯一能拿到的证据。
      `${flakyFailures.length ? ` · 复跑未复现 ${flakyFailures.length} [${flakyFailures.join(', ')}]` : ''}` +
      `${writeSet ? ` · D-2 写集: ${describeWriteSet(writeSet)}` : ''}` +
      `${writeScope ? ` · D-2 声明面: ${describeWriteScope(writeScope)}` : ''}` +
      // S-46: 缺片必须**印在同一行**。P2 那跑判词齐全而「只做了 1/4」一个字都看不出来,
      // 就是因为没有任何一处印过「声明了几片、落了几片」。
      `${sliceCoverage ? ` · S-46 缺片: ${describeSliceCoverage(sliceCoverage)}` : ''}`,
  });

  const result: RunGoalResult = {
    goal,
    tier,
    acceptance,
    stages,
    outcome,
    ...(specPath ? { specPath } : {}),
    sources,
    repoContext,
    converged,
    criteria: { judge: judgeSaidOk, oracle: oracleOk },
    rounds: roundCount,
    reusedNodes,
    ...(blocked ? { blocked } : {}),
    ...(budgetStopped ? { budgetStopped } : {}),
    ...(cancelledReason ? { cancelled: cancelledReason } : {}),
    ...(verifyDelta ? { verifyDelta } : {}),
    ...(writeSet ? { writeSet } : {}),
    ...(writeScope ? { writeScope } : {}),
    ...(sliceCoverage ? { sliceCoverage } : {}),
    ...(designReview ? { designReview } : {}),
   };
  // D-2 散雾出口 (切片 1): 拿到 map 句柄才开票; 没配 = 这一行直接返回, 行为逐字节不变 (INV-1)。
  // 放在 result 成形之后: 票身要的原因/未决/发现物全从终态读, 不从中途状态猜。
  openRunTickets(result, exec, config);
  // #160 D-2 (s1): 终态前发 verified (判据真身, 不是 converged; INV-2)。
  // 只在 executable 验收时发 (非可执行没机器结论, 不编)。同一 fail-open 性格: 写板失败不掀桌,
  // run 照跑。verdict = oracleOk ∨ oracleRecheckGreen (#165①: 判据被级联压死没跑时, 复验绿也算 pass)，
  // note = 验收命令 + accept 节点 status 指纹 (板层 serializeEntry 自截 500B)。
  if (acceptance.kind === 'executable') {
    try {
      const verdict: 'pass' | 'fail' = oracleOk || oracleRecheckGreen ? 'pass' : 'fail';
      appendBoard(boardRoot, {
        v: 1,
        ts: new Date().toISOString(),
        runId: boardRunId,
        event: 'verified',
        verdict,
        note: `${acceptance.command} → ${acceptLeaf?.status ?? '没跑'}`,
      });
    } catch (e) {
      console.error(`[run-goal] board verified 写失败 (不影响 run): ${String(e)}`);
    }
  }
  emitBoard('terminal', outcome);
  return result;
}
