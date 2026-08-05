#!/usr/bin/env bun
/**
 * omd-readout —— **确定性读数板** (2026-07-31, 承 LangChain 四层栈第 4 层的 report-only 版)。
 *
 * ## 它是什么, 更要紧的是它**不是**什么
 *
 * LangChain 的第 4 层 (hill-climbing) 是「分析 agent 读 trace → 改 harness 配置」。本脚本
 * **刻意只做前半句的确定性版本**: 读 `.omd/dag-runs.db`, 出一组算得出来的数, 零模型调用、
 * 零建议、零改动。
 *
 * 两条理由, 后一条比前一条硬:
 *
 * ① Loop Engineering §7.5 的三重嵌套 (agent 编码循环 / **开发者反馈循环** / 外部反馈循环):
 *    「越往外层, 验证越依赖人的判断」。L4 要自动化的正是中间那一层, 而那一层是内层唯一的方向
 *    校正源。自动化它 = 校正器与被校正者合成同一台机器 —— §4.1「运动员不能当自己的裁判」在更大
 *    尺度上的同一条错误, 只是它自证的不是"我做完了", 是"我该往哪改"。
 *
 * ② §10.1「复杂度是挣来的: 每多加一层机制, 都应该对应一个**已经真实发生**的问题」。
 *    L4 解决的是「从 trace 提炼建议」的**吞吐**。我们的手工版一直在跑 (detector prompt v2→v3→v4、
 *    judgeArtifacts on/off、S1 语料 4→9 段), 而它上一程的结论是**饱和**: 8%→50%→60%→60%,
 *    后两步在噪声内。瓶颈是 prompt 在这个座位上的天花板, **不是分析吞吐**。几十次 live + 9 段语料
 *    一个人读得完, 自动分析在这个数据量上买不到东西, 只会引进第三个没人审的判断者 (D-13)。
 *
 * **什么时候回来重开 L4**: 读数多到一个人读不完 —— 具体化 = live 跑次数过 100 或语料过 30 段。
 * 在那之前, 分析 agent 是在解一个还没发生的问题。
 *
 * ## 它同时兑现了什么
 *
 * S0 把留痕接回生产路径之后, `.omd/dag-runs.db` 至今**零消费者** —— 按七态词表那是 `Wired`
 * 而非 `Exercised`, 与 A1 抓出的空预算轴同一个形状。本脚本就是那个消费者。
 *
 * ## 统一契约 (2026-08-02): readout() 是唯一读数实现, CLI 是薄壳
 *
 * 导出纯函数 `readout(opts)` → `ReadoutResult` (src/harness/omd-readout.test.ts 钉死的契约):
 * 所有统计**先按 entry 隔离、再按 run_id 归并** (一次 goal 两段图合成一笔账); NULL 与 0
 * 严格分开 (没记 ≠ 记了 0); criteria 出四格 + 两个风险格 (每级一行 executed/not_executed,
 * 只统计带 command 的节点; agent/inproc 只进四格)。所有消费者 import 本导出, 禁止另起
 * 读数实现。
 *
 * ⚠ 读取语义: CLI 打开真库用 `new Database(path, { readonly: true })` + `PRAGMA query_only = ON`,
 * 绝不经过 recorder / migrate / schema-bump 路径; `readout()` 自己只 SELECT (不建表/不迁移/
 * 不写 pragma), 表不存在 = 空世界 (合法, exit 0)。
 * 退出码: 0 成功 (空库合法) · 2 参数错 · 3 DB 不可读 · 1 内部错。
 * `import.meta.main` 守卫 (先例 scripts/omd-path.ts): import 本模块只拿 readout/ReadoutResult,
 * 不执行 CLI 顶层 (那会去读真库)。
 *
 * ## 跑法
 *
 *   bun run scripts/omd-readout.ts                      # 默认 .omd/dag-runs.db, 最近 20 次运行
 *   bun run scripts/omd-readout.ts --db <path> --limit 50
 *   bun run scripts/omd-readout.ts --json               # 机器可读 (给以后的 A/B 用)
 */
import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { commandRiskTier, RISK_TIER_ORDER, type CommandRiskTier } from '../src/harness/command-leaf';
import { TOOL_RENAMES } from '../src/mcp/tool-renames';
import { readdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { parseMapMarkdown } from '../src/harness/pathfinder/map-store';
import { computeCost } from '../src/model/cost-ledger';
import { capsFor } from '../src/harness/../model/model-caps';
import { CheckpointManager } from '../src/harness/continuity/checkpoint-manager';
import type { NodeLoopJournal } from '../src/harness/continuity/types';
import type { DagRunNode } from '../src/harness/dag-record';
import type { AcceptanceProbe } from '../src/harness/goal/acceptance';
import { FAILURE_KIND_INFO, FAILURE_KIND_ORDER, type NodeFailureKind } from '../src/harness/node-failure';
import { RUN_OUTCOME_INFO, RUN_OUTCOME_ORDER, type RunOutcomeKind, type SpendBucket } from '../src/harness/run-outcome';

// ══════════════════════════════════════════════════════════════════════════════
// 统一契约 (src/harness/omd-readout.test.ts 钉死): readout() 是**唯一读数实现**, CLI 只做
// 参数解析 + 打印。所有统计先按 entry 隔离、再按 run_id 归并; NULL(没记) 与 0(记了且为零)
// 严格分开; criteria 出四格 + 两个风险格 (每级一行 executed/not_executed)。消费者一律
// import 本导出, 禁止复制逻辑或另起实现。
// ══════════════════════════════════════════════════════════════════════════════

/** 归并后一次 run 的读数 (同 runId 的全部记录合成一笔账; 没记 run_id 的老行按主键自成一组)。 */
export interface RunReadout {
  run_id: string;
  /** 该 run 的记录条数 (一次 goal 两段图 = 2)。 */
  attempts: number;
  first_at: number;
  last_at: number;
  /** run 级终止原因 (词表 = run-outcome.ts 全量, 不塌成 success/failure); 整组都没记 → `未记`。 */
  status: RunOutcomeKind | '未记';
  /** 五字段独立求和; 整组记录都没记 usage → null (不是 0)。 */
  usage: {
    conductorIn: number;
    conductorOut: number;
    leavesIn: number;
    leavesOut: number;
    leavesCacheHit: number;
  } | null;
  /** 该 run 里 usage 为 NULL 的记录条数 (没记的, 不是 0)。 */
  usage_unmeasured_attempts: number;
  /** 复用计数求和; 整组都没记 → null (没记 ≠ 0; 记了 0 仍是 0)。 */
  reused: number | null;
  /** 入口 (2026-08-02 入口轴); 没记 → `未记` (不编 'unknown')。 */
  entry: string;
  /** 冻结判据两位 (goal 级回填, 同 runId 各记录同份); 缺席 → null (不编 false/false)。 */
  criteria: { judge: boolean; oracle: boolean } | null;
  /** 冻结契约的验收探针结局 (仅 dag_goal 记); 解析失败/词表外 → null = 没记, 不编桶。 */
  acceptanceProbe: AcceptanceProbe | null;
}

/** 统一契约的完整读数 (测试钉死的形状)。 */
export interface ReadoutResult {
  meta: { db: string; limit: number; readonly: true };
  /**
   * S-1 片d (2026-08-04): 建议接受率 — 扫 docs/plan/pathfinder/*.md 的 suggestionsLog 聚合。
   * rate = (accepted+edited)/decided, decided = accepted+edited+rejected (人的处置);
   * deduped 单列 (机器去重不是人的决定, 混进分母会虚高接受率)。
   * null = 没给 mapsCwd 或没有任何处置史 (「没数据」≠ 0%)。
   */
  suggestion_acceptance: {
    decided: number;
    accepted: number;
    edited: number;
    rejected: number;
    deduped: number;
    /** t3: 图上当前待确认的 suggested 票数 (雾中带存量)。 */
    pending: number;
    rate: number | null;
    /** t3 重跑重复率: deduped / (deduped + decided + pending) — 建议管线的去重扣住了多少比例的车轱辘话。
     *  高 = 上游在重复发现 (或阈值太紧); 一直 0 = 没有重跑压力或去重失效 — 两头都值得看。 */
    dedupe_rate: number | null;
  } | null;
  runs: RunReadout[];
  /** 按 run 去重 (一个 run 多 attempt 只计一次); total = 本窗口 distinct run 数 (含 `未记`)。 */
  outcome_distribution: Record<RunOutcomeKind, number> & { 未记: number; total: number };
  /** 按 entry 分组 (每个 run 只算一次), 顺序 = 首次出现 (first_at)。 */
  entry_distribution: { entry: string; runs: number; attempts: number }[];
  /**
   * cost-per-success, 按 entry 分层 (原任务 ①): usage 先按 runId 归并 (mergeRun 已做),
   * 组内对**已记 usage** 的 run 求和, ÷ 该组 status='success' 的 run 数 (按 run 去重数, 不按行数)。
   * NULL 纪律同上: usage 没记的 run 进 unmeasured_runs 而不是被当 0 加进 tokens;
   * success_runs=0 → tokens_per_success=null (算不出 ≠ 0)。顺序与 entry_distribution 一致。
   */
  /**
   * **注意力轴** (LoopX 对照, 2026-08-05) —— 引擎花掉的**owner 的时间**。
   *
   * 来源是 LoopX 的 `project_reward = f(quantity, quality, token_cost, user_attention_cost)`。
   * 本仓此前四轴(判据/效率/诚实/停止)量的全是**引擎侧**;owner 这一侧的消耗一格没量,
   * 而它恰恰是「这个 loop 值不值得继续开着」的主要成本 —— token 便宜, 人的注意力不便宜。
   *
   * ⚠ **只放今天真有数据源的格**。LoopX 那份模型里的 `avoidable_reasks`(到达 owner 的重复
   * 提问)在本仓**没有数据源**:`deduped` 量的是**被机器挡下的**重复建议, 挡不住而真的问到
   * owner 面前的那些, 账本里一条都没有。所以这里不给它留一个恒 null 的字段 —— 那是空旋钮,
   * 本仓专门有闸在猎它。要量它得先有产生它的记录, 那是另一件事。
   */
  attention_axis: {
    /** 环把球踢回给 owner 的次数(outcome=blocked 的 run 数)。 */
    blocked_runs: number;
    /** 分母 = 本窗口 distinct run 数(含「未记」)。 */
    total_runs: number;
    /** blocked_runs ÷ total_runs。**多大比例的跑最后要 owner 出手。** total=0 → null。 */
    handback_rate: number | null;
    /**
     * 图上待 owner 确认的建议票(存量)。
     *
     * ⚠ null 有**三种**成因(继承自 {@link suggestion_acceptance},此处不另立口径):没给
     * `mapsCwd` · 没有 `docs/plan/pathfinder` 目录 · 有图但既无处置史也无 suggested 存量。
     * 三者今天在同一个 null 里 —— 这一格**分不出来**,别把它读成「图上没有票」。
     */
    pending_tickets: number | null;
    /** owner 真处置过的建议数(accepted+edited+rejected)。null 的三种成因同上。 */
    decided_tickets: number | null;
    /** 其中被拒的 —— **看了、花了时间、没换来东西**的那部分。 */
    rejected_tickets: number | null;
    /**
     * rejected ÷ decided:owner 的处置里有多大比例是白看的。
     * 高 = 建议管线在拿 owner 当过滤器。decided=0 → null。
     */
    wasted_review_share: number | null;
  };
  /**
   * **消耗口径** (LoopX 对照, 2026-08-05): 把 token 按 {@link SpendBucket} 分桶,
   * 于是「每次成功要花多少」这个数问的是**引擎效率**, 而不是引擎效率 + 环境噪声的混合。
   *
   * 移植自 LoopX 的 quota 纪律 (`spend-slot` 只在验证 + 写回之后调用, 静默 skip /
   * preflight 失败 / dry-run 不消耗额度)。omd 没有额度制, 对应物就是这里的分母口径。
   *
   * ⚠ **两个口径并排给, 老的一个字不动**。仓规「加尺子必然让数难看」的记法: 新口径会让
   * `tokens_per_success` 变小 (分子剔掉了 overhead), 只留新数会读成"引擎突然变便宜了"。
   * 差额本身才是读数 —— 它等于 {@link overhead_share} 那部分钱。
   *
   * ⚠ 口径与 {@link cost_per_success} 一样取**展示窗口** (`shown`) 而非全量: 两个数要能
   * 直接相减, grain 不同就没法比。这不是闸的判据, 所以不适用「闸的数一律全量」那条。
   */
  spend_discipline: {
    /** 每桶: run 数 / token 求和 / usage 没记的 run 数 (不进求和, 不当 0)。 */
    buckets: Record<SpendBucket | '未记', { runs: number; tokens: number; unmeasured_runs: number }>;
    /** 四桶 + 未记的 token 总和 (= 老口径的分子)。 */
    total_tokens: number;
    /** success run 数 (两个口径共用的分母)。 */
    success_runs: number;
    /** **老口径**: 全部 token ÷ success。改动前 `cost_per_success` 用的就是这个算法。 */
    tokens_per_success_all: number | null;
    /** **新口径**: 只有 delivery 桶 ÷ success。success=0 → null (算不出 ≠ 0)。 */
    tokens_per_success_delivery: number | null;
    /** overhead ÷ total。**多少钱花在了根本没在试图达成目标的跑上**。total=0 → null。 */
    overhead_share: number | null;
    /** blocked ÷ total。高 = 环经常被外部挡住 —— 那是 owner 注意力的账, 不是引擎的账。 */
    blocked_share: number | null;
  };
  cost_per_success: {
    entry: string;
    runs: number;
    success_runs: number;
    /** usage 为 null 的 run 数 (没记, 不是 0) —— 它们不进 tokens 求和。 */
    unmeasured_runs: number;
    tokens: { conductorIn: number; conductorOut: number; leavesIn: number; leavesOut: number; leavesCacheHit: number };
    /** (conductorIn+conductorOut+leavesIn+leavesOut) ÷ success_runs; cacheHit 是折扣标记不是开销, 不进分子。 */
    tokens_per_success: number | null;
  }[];
  criteria_grid: {
    /** 四格互相独立、标签不合并; 和 = DAG 节点全集 (同 id 跨记录并集, 不按记录求和)。 */
    four_grid: { executed_success: number; executed_failure: number; reused_success: number; 未记: number };
    /**
     * 风险维度自成一个执行/未执行二分, **独立**于四格 (不并入四格、不折叠风险级), 每级一行。
     * ⚠ 只统计带 command 的节点 (agent/inproc 不入格, 但四格里照数, 不许静默丢);
     *   not_executed 只含记录为 reused 的节点; 缺席一律归四格「未记」, 不混进 not_executed。
     */
    two_grid_risk: { risk_level: CommandRiskTier; executed: number; not_executed: number }[];
  };
  /** 判据轴 {judge, oracle} 四格, 按 runId 去重数 (不按行数); 缺席单列 unrecorded (不编 false/false)。 */
  criteria_consistency: {
    agree: number;
    oracleFailed: number;
    wastedRounds: number;
    agreeFail: number;
    unrecorded: number;
    recorded: number;
  };
  /** 分子 = 记录为 reused 的节点 (并集); 分母 = DAG 全量节点 (含 `未记`); total_nodes=0 → rate null。 */
  /**
   * G4 采样 (冻结契约 §5): 分母 = **全量** entry='solve' (旧 'dag_goal' 归一后同) 且 acceptance_probe 非 NULL 的 run
   * (2026-08-03 起不再受展示窗口截断 —— 闸的判据不搭展示的车, 理由见计算处的注)。
   * 老行/未接探针的 run (NULL) 不进分母, 不编 'unknown'; exploratory 是派生数
   * (= demoted + skipped + exploratory 三条 kind 之和)。
   */
  g4_sampling: {
    denominator: number;
    passedBoth: number;
    vacuityOnly: number;
    demoted: number;
    skipped: number;
    exploratory: number;
  };
  /**
   * **闸的分母** (2026-08-03) —— 全量, **不受展示窗口截断**。
   *
   * 为什么单列一格: 上线闸里 G3 要「20 次 live」、G4 要「采样 ≥10 次」, 而这块板的 run 表
   * 按冻结契约只显示**最早 limit 个**。两者搭在一起的后果是: 历史 run 一超过 limit,
   * **以后每跑一次都落在窗口外**, 闸的分母永远停在同一个数 —— 而板上看不出它停了。
   * 2026-08-03 连跑三次 live, `--limit 20` 下 entry 分布一动不动, `--limit 40` 才看得见。
   *
   * `ledgerGap` = **跑了但没记上**的条数: 在 run 注册表 (`runs.db`) 里有、而在留痕库
   * (`dag-runs.db`) 里没有的 run。S-12 的写穿失败就长这样 —— 那次跑烧了钱、交付了正确产物,
   * 却在留痕库里零行, 于是它在板上**和"没跑"长得一模一样**。分母的缺口不等于"少跑了几次"。
   * ⚠ 读不到注册表 (路径不在 / 打不开) → `null` = **不知道**, 不编 0 (编 0 就是把"没查"
   * 说成"没有")。
   */
  gate_denominators: {
    /** G3: 带 `entry` 的 distinct run (全量)。 */
    g3LiveRuns: number;
    /** G4: entry='solve' (含归一的旧 'dag_goal') 且探针非空的 distinct run (全量, = g4_sampling.denominator)。 */
    g4Samples: number;
    /**
     * 跑了但留痕库里没有的条数; null = 注册表读不到, **不知道**。
     *
     * ⚠ **`total` 里混着合法缺席**, 别直接当缺陷数读: 一次在跑到 DAG 之前就失败的 run
     * 本来就没有留痕可记, 一个 `running` 的孤儿也还没有终态。**可行动的是 `done`** ——
     * 注册表说它跑完了, 留痕库里却一行都没有, 那是量具真漏了一次 (S-12 那条的形状)。
     * 2026-08-03 首测: total 5 / done 3 (t3a · t5a · t9b), 也就是说这个缺口**不是偶发**。
     */
    ledgerGap: { total: number; done: number } | null;
  };
  reuse_rate: { reused_nodes: number; total_nodes: number; rate: number | null };
  /**
   * 「声称 vs 引擎记录」检出器的活体读数(2026-08-05)。report-only 那条判据要不要升成硬拦,
   * 就看这一段:① 活体基率 ② 活体误伤(靠 `samples` 里的原句逐条人工核对)。
   *
   * ⚠ **分母只算 `claim_check` 非空的跑**。这个口径错过一次:那条判据原本只活在 conductor 内环,
   * 而 `dag_run` 那条路整张图可以一个 conductor 都没有 —— 判据结构上够不着,而当时账本记出来的
   * `observations: []` 与"查过零检出"逐字相同,于是约一半流量进错分母,基率被算低近一倍。
   * ⚠ 两面**宽度不同,不许相加**:conductor 含产物内容读盘,flat 只有 output+facts。
   * ⚠ 样本不够时**不许下结论** —— 见 `CLAIM_CHECK_MIN_NODES`。这一位是 2026-08-05 在**数据到达
   *   之前**钉的:那之前这段在 N=2 个节点时也照样印「检出 0 条 [0.0%]」,而那个 0% 没有信息量。
   */
  claim_check: {
    /** 记了这一位的跑数(判据够得着 → 进分母)。 */
    recordedRuns: number;
    /** 没记这一位的跑数(早于该列 → **不进分母**,不是零检出)。 */
    unrecordedRuns: number;
    conductor: { rounds: number; nodes: number; findings: number; rate: number | null };
    flat: { nodes: number; findings: number; rate: number | null };
    /** 检出原句样本(拨闸靠逐条读它判是不是误伤)。 */
    samples: { runId: string | null; message: string }[];
    /** 两面各自「够不够下结论」。**分开算** —— 一面够了不代表另一面够了。 */
    sufficiency: { conductor: FaceSufficiency; flat: FaceSufficiency };
  };
}

/** 单面的样本充分性(`enough=false` 时这一面的比例**不许当结论读**)。 */
export interface FaceSufficiency {
  nodes: number;
  /** 还差多少个节点(已够 → 0)。读数板直接印它,免得靠人心算。 */
  short: number;
  enough: boolean;
}

/**
 * 一面要多少节点才谈得上读「基率」—— **在数据到达之前钉死**(2026-08-05)。
 *
 * 依据是 rule of three:0 检出 / N 节点时,真实基率的 95% 上界 ≈ 3/N。60 → **5%**。
 *
 * 为什么门槛取 5% 而不是 1%:按 ⑧ 段同一套比价(误拦一次掐死一个本可收敛的 run,漏报一次
 * 只赔一两轮),**1% 的基率本来就不值得上硬拦** —— 所以要分辨的是「0% 还是 5%」,不是
 * 「0% 还是 1%」。1% 需要 N≥300,按 flat 面每跑 2~5 个节点算是 60~150 跑,被动攒够不着;
 * 那是拿一个够不着的门槛换一份用不上的精度。
 *
 * ⚠ 这个数**先于数据**写下来才有意义。等数攒起来再定"多少算够" = 事后编判据,
 *   本仓 §五 第 1 条治的就是这个。要改它,改前先说清为什么,别改完再补理由。
 */
export const CLAIM_CHECK_MIN_NODES = 60;

/** 单面充分性判定(纯函数 —— 读数板与闸共用同一处,两处各算一份必漂)。 */
export function faceSufficiency(nodes: number): FaceSufficiency {
  return { nodes, short: Math.max(0, CLAIM_CHECK_MIN_NODES - nodes), enough: nodes >= CLAIM_CHECK_MIN_NODES };
}

interface ReadoutRow {
  id: string;
  created_at: number;
  run_id: string | null;
  entry: string | null;
  levels: string;
  nodes: string;
  usage: string;
  outcome: string | null;
  reused: number | null;
  criteria: string | null;
  claim_check: string | null;
  observations: string | null;
  acceptance_probe: string | null;
}

interface ParsedRow {
  id: string;
  createdAt: number;
  runId: string | null;
  entry: string | null;
  levelIds: string[];
  nodes: DagRunNode[];
  usage: Usage | null;
  outcome: string | null;
  reused: number | null;
  criteria: { judge: boolean; oracle: boolean } | null;
  acceptanceProbe: AcceptanceProbe | null;
}

/** 词表校验 (老库可能有词表之外的字面量 → 归 unclassified, 同 ⑦ 段的三态纪律)。 */
const OUTCOME_KINDS = new Set<string>(RUN_OUTCOME_ORDER);

function zeroOutcomeDistribution(): ReadoutResult['outcome_distribution'] {
  const d = Object.fromEntries(RUN_OUTCOME_ORDER.map((k) => [k, 0])) as ReadoutResult['outcome_distribution'];
  d['未记'] = 0;
  d.total = 0;
  return d;
}

function zeroTwoGridRisk(): ReadoutResult['criteria_grid']['two_grid_risk'] {
  return (Object.keys(RISK_TIER_ORDER) as CommandRiskTier[])
    .sort((a, b) => RISK_TIER_ORDER[a] - RISK_TIER_ORDER[b])
    .map((risk_level) => ({ risk_level, executed: 0, not_executed: 0 }));
}

/** 空世界 (表不存在或零记录): 合法, 各分布全零, 不是错误。 */
function emptyWorld(meta: ReadoutResult['meta']): ReadoutResult {
  return {
    meta,
    runs: [],
    outcome_distribution: zeroOutcomeDistribution(),
    entry_distribution: [],
    // 空世界: 没有跑也没有图 —— 五个"不知道"全是 null, **不编 0**(0 次踢回 ≠ 没量过)。
    attention_axis: { blocked_runs: 0, total_runs: 0, handback_rate: null, pending_tickets: null, decided_tickets: null, rejected_tickets: null, wasted_review_share: null },
    // 空世界: 五桶全 0, 三个比率全 null —— **算不出 ≠ 0%**(同 tokens_per_success 那条纪律)。
    spend_discipline: computeSpendDiscipline([]),
    cost_per_success: [],
    criteria_grid: { four_grid: { executed_success: 0, executed_failure: 0, reused_success: 0, 未记: 0 }, two_grid_risk: zeroTwoGridRisk() },
    criteria_consistency: { agree: 0, oracleFailed: 0, wastedRounds: 0, agreeFail: 0, unrecorded: 0, recorded: 0 },
    g4_sampling: { denominator: 0, passedBoth: 0, vacuityOnly: 0, demoted: 0, skipped: 0, exploratory: 0 },
    suggestion_acceptance: null,
    reuse_rate: { reused_nodes: 0, total_nodes: 0, rate: null },
    claim_check: {
      recordedRuns: 0, unrecordedRuns: 0,
      conductor: { rounds: 0, nodes: 0, findings: 0, rate: null },
      flat: { nodes: 0, findings: 0, rate: null },
      samples: [],
      sufficiency: { conductor: faceSufficiency(0), flat: faceSufficiency(0) },
    },
    // 空世界: 闸分母全 0, ledgerGap 记 null = **不知道** (空留痕库不代表没跑过, 只代表这里没有)。
    gate_denominators: { g3LiveRuns: 0, g4Samples: 0, ledgerGap: null },
  };
}

interface NodeInfo {
  executed: boolean;
  everDone: boolean;
  firstExecAt: number;
  command: string | null;
}
const freshNodeInfo = (): NodeInfo => ({ executed: false, everDone: false, firstExecAt: Number.POSITIVE_INFINITY, command: null });
/** criteria 两位布尔按形状校验 (同 usage 的五字段 every 校验): 缺位/坏值 → null —— 归 unrecorded,
 * 不编 false/false, 坏行也不炸整块板 (审查 F2/F5)。 */
function parseCriteria(raw: string | null): { judge: boolean; oracle: boolean } | null {
  if (raw === null) return null;
  try {
    const c = JSON.parse(raw) as Partial<{ judge: boolean; oracle: boolean }>;
    if (c && typeof c === 'object' && typeof c.judge === 'boolean' && typeof c.oracle === 'boolean') {
      return { judge: c.judge, oracle: c.oracle };
    }
  } catch {
    /* 解析失败 = 没记 */
  }
  return null;
}


/** acceptance_probe 只认五条终局的**确切形状** (见 src/harness/goal/acceptance.ts 的 AcceptanceProbe):
 * 解析失败 / JSON null / 词表外 kind / 多余键 / why 非字符串 → null (= 没记, 不编桶, 不炸整块板)。
 * 同 dag-record 的读取纪律: 坏值不是 'unknown', 也不是某个新桶。 */
function parseAcceptanceProbe(raw: string | null): AcceptanceProbe | null {
  if (raw === null) return null;
  let p: unknown;
  try {
    p = JSON.parse(raw);
  } catch {
    return null; // 解析失败 = 没记
  }
  if (typeof p !== 'object' || p === null) return null;
  const o = p as Record<string, unknown>;
  const keys = Object.keys(o);
  switch (o.kind) {
    case 'passed-both':
      return keys.length === 1 ? { kind: 'passed-both' } : null;
    case 'exploratory':
      return keys.length === 1 ? { kind: 'exploratory' } : null;
    case 'vacuity-only':
      // why 缺席合法 (探针没原话); 在就必须是字符串, 不许是 null。
      if (keys.length === 1) return { kind: 'vacuity-only' };
      return keys.length === 2 && typeof o.why === 'string' ? { kind: 'vacuity-only', why: o.why } : null;
    case 'demoted':
      return keys.length === 2 && typeof o.why === 'string' ? { kind: 'demoted', why: o.why } : null;
    case 'skipped':
      return keys.length === 2 && typeof o.why === 'string' ? { kind: 'skipped', why: o.why } : null;
    default:
      return null; // 词表外的 kind = 没记 (schema 漂移, 不发明新桶)
  }
}

/**
 * 读数板**唯一实现** (纯函数)。只读: 只 SELECT, 不建表、不迁移、不写 pragma —— 注入的 db
 * 可以是留痕器正活着的连接 (测试夹具), 读后行数与 schema 原样。CLI 打开真库用
 * `{ readonly: true }` + query_only (见 main)。
 */
/**
 * 「跑了但没记上」—— 在 run 注册表 (`runs.db`) 里有、而留痕库 (`dag-runs.db`) 里没有的条数。
 *
 * S-12 的写穿失败就长这样: 那次跑烧了钱、交付了正确产物, 却在留痕库里**零行** ——
 * 于是它在读数板上**和"没跑"长得一模一样**, 而两者对 G3 的含义完全不同
 * (一个是"还差几次", 一个是"量具漏了几次")。
 *
 * ⚠ 全程 fail-open 且**不编 0**: 注册表不在 / 打不开 / 表结构不认 → 返回 `null` = **不知道**。
 * 返回 0 会把"没查成"说成"没有", 那正是本仓 S-12 那条纪律禁止的。
 */
function countLedgerGap(
  dagDbPath: string | null,
  knownRunIds: Set<string>,
): { total: number; done: number } | null {
  if (!dagDbPath || dagDbPath === '(injected)') return null; // 注入夹具没有盘上的兄弟库
  try {
    const regPath = join(dirname(dagDbPath), 'runs.db');
    if (!existsSync(regPath)) return null;
    const reg = new Database(regPath, { readonly: true });
    try {
      const rows = reg.query('SELECT run_id, status FROM omd_runs').all() as { run_id: string; status: string }[];
      const missing = rows.filter((r) => r.run_id && !knownRunIds.has(r.run_id));
      return { total: missing.length, done: missing.filter((r) => r.status === 'done').length };
    } finally {
      try { reg.close(); } catch { /* 关不上不值得抛 */ }
    }
  } catch {
    return null; // 表不在 / 库坏 / 权限 —— 一律"不知道"
  }
}

/** entry 词表归一 (t7): 旧词折新词, 表外原样, NULL 原样 (「没记」≠ 任何入口)。 */
function normalizeEntry(e: string | null): string | null {
  return e === null ? null : (TOOL_RENAMES[e] ?? e);
}

/** S-1 片d: 扫图聚合建议处置台账 (纯读; 图目录缺失/空 → null)。 */
export function aggregateSuggestionAcceptance(mapsCwd: string): ReadoutResult['suggestion_acceptance'] {
  const dir = `${mapsCwd}/docs/plan/pathfinder`;
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.md'));
  } catch {
    return null;
  }
  const acc = { decided: 0, accepted: 0, edited: 0, rejected: 0, deduped: 0, pending: 0, rate: null as number | null, dedupe_rate: null as number | null };
  let any = false;
  for (const f of files) {
    let parsed;
    try {
      parsed = parseMapMarkdown(readFileSync(`${dir}/${f}`, 'utf8'));
    } catch {
      continue; // 单图损坏不拖垮读数板 (与账本行解析同款容错)
    }
    // t3: pending = 图上仍待确认的 suggested 票 (有存量也算有建议史)。
    const pendingHere = parsed.tickets.filter((t) => t.status === 'suggested').length;
    if (pendingHere > 0) any = true;
    acc.pending += pendingHere;
    for (const e of parsed.suggestionsLog ?? []) {
      any = true;
      if (e.outcome === 'deduped' || e.outcome === 'deduped-semantic') acc.deduped++;
      else {
        acc.decided++;
        if (e.outcome === 'accepted') acc.accepted++;
        else if (e.outcome === 'edited') acc.edited++;
        else acc.rejected++;
      }
    }
  }
  if (!any) return null;
  acc.rate = acc.decided > 0 ? (acc.accepted + acc.edited) / acc.decided : null;
  const denom = acc.deduped + acc.decided + acc.pending;
  acc.dedupe_rate = denom > 0 ? acc.deduped / denom : null;
  return acc;
}

export function readout(opts: { db: Database; limit?: number; dbPath?: string; mapsCwd?: string }): ReadoutResult {
  const limit = opts.limit ?? 20;
  const meta: ReadoutResult['meta'] = { db: opts.dbPath ?? '(injected)', limit, readonly: true };
  const db = opts.db;
  const hasTable = db.query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'omd_dag_runs'`).get() != null;
  if (!hasTable) return emptyWorld(meta);

  // 老库可能缺后加的列 → 查一次 pragma 再拼, 缺的列补 NULL (正是"这批记录没记"那一格,
  // 与"记了但为空"分开数; 同 CLI ⑦ 段的做法, 不另起一套)。
  const haveCols = (db.query(`PRAGMA table_info(omd_dag_runs)`).all() as { name: string }[]).map((c) => c.name);
  const optionalCol = (name: string) => (haveCols.includes(name) ? `, ${name}` : `, NULL AS ${name}`);
  const rows = db
    .query(
      `SELECT id, created_at, run_id, levels, nodes, usage${optionalCol('observations')}${optionalCol('entry')}${optionalCol('outcome')}${optionalCol('reused')}${optionalCol('criteria')}${optionalCol('claim_check')}${optionalCol('acceptance_probe')}` +
        ` FROM omd_dag_runs ORDER BY created_at ASC`,
    )
    .all() as ReadoutRow[];
  if (rows.length === 0) return emptyWorld(meta);

  const parsed: ParsedRow[] = rows.map((r) => {
    // usage 列恒 NOT NULL, 但防御: 记坏了按没记处理 (不编 0 —— 那会把"没记"读成"零用量")。
    let usage: Usage | null = null;
    try {
      const u = JSON.parse(r.usage) as Partial<Usage>;
      if (
        u &&
        typeof u === 'object' &&
        [u.conductorIn, u.conductorOut, u.leavesIn, u.leavesOut, u.leavesCacheHit].every((v) => typeof v === 'number')
      ) {
        usage = u as Usage;
      }
    } catch {
      /* 解析失败 = 没记 */
    }
    // levels/nodes 同 usage 的防御: 坏行不炸整块板, 按"这批节点没记"处理 (归四格「未记」, 审查 F2)。
    let levelIds: string[] = [];
    try {
      const l = JSON.parse(r.levels) as unknown;
      if (Array.isArray(l)) levelIds = (l as string[][]).flat();
    } catch {
      /* 解析失败 = 没记 */
    }
    let nodes: DagRunNode[] = [];
    try {
      const n = JSON.parse(r.nodes) as unknown;
      if (Array.isArray(n)) nodes = n as DagRunNode[];
    } catch {
      /* 解析失败 = 没记 */
    }
    return {
      id: r.id,
      createdAt: r.created_at,
      runId: r.run_id,
      // entry 词表归一 (t7, 2026-08-04): 历史行的旧词 (dag_run/dag_goal/path_deliver) 折进新词
      // (run/solve/map_deliver) —— 同一入口不因改名在分布里裂成两行。真源 = TOOL_RENAMES 同一张表。
      entry: normalizeEntry(r.entry),
      levelIds,
      nodes,
      usage,
      outcome: r.outcome,
      reused: r.reused,
      criteria: parseCriteria(r.criteria),
      acceptanceProbe: parseAcceptanceProbe(r.acceptance_probe),
    };
  });

  // ── ① run_id 归并 (账本主体) ────────────────────────────────────────────────
  const byRun = new Map<string, ParsedRow[]>();
  for (const r of parsed) {
    // 没记 run_id 的老行/图外调用各自成组 (用主键当键) —— 并进同一个 "null" 组会把无关的
    // 运行加在一起, 那是**编出来的**一笔账 (同 CLI ① 段)。
    const key = r.runId ?? `(no-runid):${r.id}`;
    const group = byRun.get(key);
    if (group) group.push(r);
    else byRun.set(key, [r]);
  }
  const allRuns: RunReadout[] = [...byRun.entries()]
    .map(([runId, recs]) => mergeRun(runId, recs))
    .sort((a, b) => a.first_at - b.first_at || (a.run_id < b.run_id ? -1 : a.run_id > b.run_id ? 1 : 0));
  const shown = allRuns.slice(0, limit);

  // ── ② DAG 节点全集 + 复用推断 (四格 / 风险格 / 复用率的数据前提) ───────────────
  // 节点全集 = 各记录 `levels` 的并集 (topoLevels 的全 plan 节点 id; :memory: 夹具没有 repo
  // 可扫, levels 是留痕层唯一全量拓扑)。
  //
  // ⚠ 「**哪些**节点被复用」留痕层只存了计数 (reused 列), 节点 id 按可证语义推:
  //   记录 R 声明了复用 (reused > 0) ∧ 节点在 R 的 plan 里但不在 R 的执行结果里 ∧ 该节点在
  //   更早的记录里执行过 → 那才是跨轮复用 (复用 = 零 LLM 拿上轮结果接住, 不可能接一个
  //   没跑过的节点; z 那样在 plan 里但从未执行的 = 缺席, 不是复用)。
  const universe = new Map<string, NodeInfo>();
  for (const r of parsed) {
    for (const id of r.levelIds) {
      if (!universe.has(id)) universe.set(id, freshNodeInfo());
    }
    for (const n of r.nodes) {
      const info = universe.get(n.id) ?? freshNodeInfo();
      if (!info.executed || r.createdAt < info.firstExecAt) {
        info.executed = true;
        info.firstExecAt = r.createdAt;
        // command 只在**首次实际执行**分支记 (审查 F4): 后写覆盖会把早跑过 X、后来换 Y 重跑的
        // 节点按 Y 分级, 而 Y 可能从没跑过 —— 风险级按真跑过的那个算。
        if (n.command) info.command = n.command;
      }
      if (n.status === 'done') info.everDone = true;
      universe.set(n.id, info);
    }
  }
  const reused = new Set<string>();
  for (const r of parsed) {
    if (r.reused === null || r.reused <= 0) continue;
    const execIds = new Set(r.nodes.map((n) => n.id));
    for (const id of r.levelIds) {
      if (execIds.has(id)) continue;
      const info = universe.get(id);
      if (info?.executed && info.firstExecAt < r.createdAt) reused.add(id);
    }
  }

  // ── ③ 四格 + 两个风险格 ──────────────────────────────────────────────────────
  // 四格: reused 优先于 executed 归类 (x 在 run-B 第一段执行过、第二段被复用 → 只算 reused 一格)。
  const four_grid: ReadoutResult['criteria_grid']['four_grid'] = { executed_success: 0, executed_failure: 0, reused_success: 0, 未记: 0 };
  const riskCount = new Map<CommandRiskTier, { executed: number; not_executed: number }>(
    (Object.keys(RISK_TIER_ORDER) as CommandRiskTier[]).map((t) => [t, { executed: 0, not_executed: 0 }]),
  );
  for (const [id, info] of universe) {
    if (reused.has(id)) {
      four_grid.reused_success++;
      if (info.command) riskCount.get(commandRiskTier(info.command))!.not_executed++;
    } else if (info.executed) {
      if (info.everDone) four_grid.executed_success++;
      else four_grid.executed_failure++;
      if (info.command) riskCount.get(commandRiskTier(info.command))!.executed++;
    } else {
      four_grid['未记']++;
    }
  }
  const two_grid_risk: ReadoutResult['criteria_grid']['two_grid_risk'] = (Object.keys(RISK_TIER_ORDER) as CommandRiskTier[])
    .sort((a, b) => RISK_TIER_ORDER[a] - RISK_TIER_ORDER[b])
    .map((risk_level) => ({ risk_level, ...riskCount.get(risk_level)! }));

  // ── ④ 分布 / 判据轴 / 复用率 ─────────────────────────────────────────────────
  const outcome_distribution = zeroOutcomeDistribution();
  for (const run of shown) outcome_distribution[run.status]++;
  outcome_distribution.total = shown.length;

  const byEntry = new Map<string, { runs: number; attempts: number; firstAt: number }>();
  for (const run of shown) {
    const e = byEntry.get(run.entry) ?? { runs: 0, attempts: 0, firstAt: run.first_at };
    e.runs++;
    e.attempts += run.attempts;
    byEntry.set(run.entry, e);
  }
  const entry_distribution = [...byEntry.entries()]
    .sort((a, b) => a[1].firstAt - b[1].firstAt)
    .map(([entry, v]) => ({ entry, runs: v.runs, attempts: v.attempts }));

  // cost-per-success (原任务 ①): 分子只加已记 usage 的 run (缺席 ≠ 0), 分母 = 该组 success run 数。
  const cost_per_success = entry_distribution.map(({ entry }) => {
    const group = shown.filter((run) => run.entry === entry);
    const tokens = { conductorIn: 0, conductorOut: 0, leavesIn: 0, leavesOut: 0, leavesCacheHit: 0 };
    let unmeasured_runs = 0;
    for (const run of group) {
      if (run.usage === null) {
        unmeasured_runs++;
        continue;
      }
      tokens.conductorIn += run.usage.conductorIn;
      tokens.conductorOut += run.usage.conductorOut;
      tokens.leavesIn += run.usage.leavesIn;
      tokens.leavesOut += run.usage.leavesOut;
      tokens.leavesCacheHit += run.usage.leavesCacheHit;
    }
    const success_runs = group.filter((run) => run.status === 'success').length;
    const spent = tokens.conductorIn + tokens.conductorOut + tokens.leavesIn + tokens.leavesOut;
    return {
      entry,
      runs: group.length,
      success_runs,
      unmeasured_runs,
      tokens,
      tokens_per_success: success_runs > 0 ? spent / success_runs : null,
    };
  });

  const spend_discipline = computeSpendDiscipline(shown);

  const criteria_consistency: ReadoutResult['criteria_consistency'] = { agree: 0, oracleFailed: 0, wastedRounds: 0, agreeFail: 0, unrecorded: 0, recorded: 0 };
  for (const run of shown) {
    const c = run.criteria;
    if (!c) continue;
    criteria_consistency.recorded++;
    if (c.judge && c.oracle) criteria_consistency.agree++;
    else if (c.judge && !c.oracle) criteria_consistency.oracleFailed++;
    else if (!c.judge && c.oracle) criteria_consistency.wastedRounds++;
    else criteria_consistency.agreeFail++;
  }
  criteria_consistency.unrecorded = shown.length - criteria_consistency.recorded;

  // ── G4 采样 (冻结契约 §5): 分母 = entry 为 solve (旧 dag_goal 已归一) 且 acceptance_probe 非 NULL 的 run ──
  // NULL (老行 / 非 dag_goal / 解析失败) 一律不进分母 —— 没记 ≠ 失败, 不编 'unknown'。
  //
  // ⚠ **走 `allRuns` 不走 `shown`** (2026-08-03 修): 展示窗口取的是**最早 limit 个**
  // (冻结契约刻意钉死的截断端), 而这是**闸的判据** —— G4 收尾判据要「采样 ≥10 次」。
  // 搭窗口的车会让历史 run 一超 limit 之后, **以后每跑一次都落在窗口外**, 分母永远停在同一个数,
  // 而板上看不出它停了。同一个坑当天先咬了 G3 的分母一次 (见 gate_denominators 的注)。
  // **展示归展示, 判据归判据**: 窗口只管那张 run 表, 闸的数一律全量。
  const g4_sampling: ReadoutResult['g4_sampling'] = { denominator: 0, passedBoth: 0, vacuityOnly: 0, demoted: 0, skipped: 0, exploratory: 0 };
  for (const run of allRuns) {
    if (run.entry !== 'solve' || run.acceptanceProbe === null) continue;
    g4_sampling.denominator++;
    switch (run.acceptanceProbe.kind) {
      case 'passed-both':
        g4_sampling.passedBoth++;
        break;
      case 'vacuity-only':
        g4_sampling.vacuityOnly++;
        break;
      case 'demoted':
        g4_sampling.demoted++;
        g4_sampling.exploratory++;
        break;
      case 'skipped':
        g4_sampling.skipped++;
        g4_sampling.exploratory++;
        break;
      case 'exploratory':
        g4_sampling.exploratory++;
        break;
    }
  }

  // ── 闸的分母 (2026-08-03): 全量, 不搭展示窗口的车 —— 见 gate_denominators 的注 ──
  const g3LiveRuns = allRuns.filter((r) => r.entry !== null && r.entry !== '未记').length;
  const gate_denominators: ReadoutResult['gate_denominators'] = {
    g3LiveRuns,
    g4Samples: g4_sampling.denominator,
    // 「跑了但没记上」: 注册表里有、留痕库里没有。读不到 → null (不知道), **不编 0**。
    ledgerGap: countLedgerGap(opts.dbPath ?? null, new Set(allRuns.map((r) => r.run_id))),
  };

  const total_nodes = universe.size;
  const reused_nodes = reused.size;

  // ⑧.5 检出器活体读数 —— **只有这一处算**, CLI 从这里渲染 (两处各算一份必漂)。
  let ccRecorded = 0;
  let ccUnrecorded = 0;
  const ccAcc = { condRounds: 0, condNodes: 0, condFindings: 0, flatNodes: 0, flatFindings: 0 };
  const ccSamples: { runId: string | null; message: string }[] = [];
  for (const r of rows) {
    if (!r.claim_check) {
      ccUnrecorded++;
    } else {
      ccRecorded++;
      try {
        const v = JSON.parse(r.claim_check) as {
          conductor?: { rounds?: number; nodes?: number; findings?: number };
          flat?: { nodes?: number; findings?: number };
        };
        ccAcc.condRounds += v.conductor?.rounds ?? 0;
        ccAcc.condNodes += v.conductor?.nodes ?? 0;
        ccAcc.condFindings += v.conductor?.findings ?? 0;
        ccAcc.flatNodes += v.flat?.nodes ?? 0;
        ccAcc.flatFindings += v.flat?.findings ?? 0;
      } catch {
        // 坏 JSON 不该让整块读数崩; 它已计进 recordedRuns, 差额自然显示为算不出。
      }
    }
    if (!r.observations) continue;
    try {
      for (const o of JSON.parse(r.observations) as { kind: string; message?: string }[]) {
        if (o.kind === 'unsupported-claim' && o.message && ccSamples.length < 20) {
          ccSamples.push({ runId: r.run_id, message: o.message });
        }
      }
    } catch {
      /* 同上 */
    }
  }
  /** 每节点检出率。分母 0 → null(**算不出 ≠ 0**,同 tokens_per_success 那条纪律)。 */
  const ccRate = (findings: number, nodes: number): number | null => (nodes > 0 ? findings / nodes : null);

  // 注意力轴 (LoopX 对照): blocked 来自 outcome 分布 (引擎侧记录), 票的三个数来自 suggestionsLog
  // (owner 侧记录) —— 两个来源不重叠, 各自的缺席各自报 null, 不互相填。
  const sa = opts.mapsCwd !== undefined ? aggregateSuggestionAcceptance(opts.mapsCwd) : null;
  const attention_axis: ReadoutResult['attention_axis'] = {
    blocked_runs: outcome_distribution.blocked,
    total_runs: outcome_distribution.total,
    handback_rate: outcome_distribution.total > 0 ? outcome_distribution.blocked / outcome_distribution.total : null,
    pending_tickets: sa?.pending ?? null,
    decided_tickets: sa?.decided ?? null,
    rejected_tickets: sa?.rejected ?? null,
    wasted_review_share: sa && sa.decided > 0 ? sa.rejected / sa.decided : null,
  };

  return {
    meta,
    runs: shown,
    claim_check: {
      recordedRuns: ccRecorded,
      unrecordedRuns: ccUnrecorded,
      conductor: { rounds: ccAcc.condRounds, nodes: ccAcc.condNodes, findings: ccAcc.condFindings, rate: ccRate(ccAcc.condFindings, ccAcc.condNodes) },
      flat: { nodes: ccAcc.flatNodes, findings: ccAcc.flatFindings, rate: ccRate(ccAcc.flatFindings, ccAcc.flatNodes) },
      samples: ccSamples,
      sufficiency: { conductor: faceSufficiency(ccAcc.condNodes), flat: faceSufficiency(ccAcc.flatNodes) },
    },
    outcome_distribution,
    entry_distribution,
    attention_axis,
    spend_discipline,
    cost_per_success,
    criteria_grid: { four_grid, two_grid_risk },
    criteria_consistency,
    g4_sampling,
    suggestion_acceptance: sa,
    gate_denominators,
    reuse_rate: { reused_nodes, total_nodes, rate: total_nodes > 0 ? reused_nodes / total_nodes : null },
  };
}

/**
 * 消耗分桶 (LoopX 对照)。桶的归属**只从 {@link RUN_OUTCOME_INFO} 读**, 这里不另写一份映射 ——
 * 词表加新格时忘了同步的那种漂移, 是本仓 S-1/S-15 的同一族。
 *
 * `未记` (outcome 列 NULL, 早于 2026-07-31 的老行) 单列第五桶: 它不是 `unclassified`
 * (那格是「引擎跑完了但没交代」), 是「这条记录压根没有这个字段」。两者的下一步不同 ——
 * 前者去补引擎的标注, 后者只能等新数据。**编成同一桶就再也分不开。**
 */
function computeSpendDiscipline(shown: RunReadout[]): ReadoutResult['spend_discipline'] {
  const zero = () => ({ runs: 0, tokens: 0, unmeasured_runs: 0 });
  const buckets: ReadoutResult['spend_discipline']['buckets'] = {
    delivery: zero(),
    blocked: zero(),
    overhead: zero(),
    unclassified: zero(),
    未记: zero(),
  };
  for (const run of shown) {
    const key: SpendBucket | '未记' = run.status === '未记' ? '未记' : RUN_OUTCOME_INFO[run.status].spendBucket;
    const b = buckets[key];
    b.runs++;
    if (run.usage === null) {
      // 缺席 ≠ 0: 不加进 tokens, 单独计数。同 cost_per_success 的 unmeasured_runs。
      b.unmeasured_runs++;
      continue;
    }
    b.tokens += run.usage.conductorIn + run.usage.conductorOut + run.usage.leavesIn + run.usage.leavesOut;
  }
  const total_tokens = Object.values(buckets).reduce((a, b) => a + b.tokens, 0);
  const success_runs = shown.filter((run) => run.status === 'success').length;
  const share = (n: number): number | null => (total_tokens > 0 ? n / total_tokens : null);
  return {
    buckets,
    total_tokens,
    success_runs,
    tokens_per_success_all: success_runs > 0 ? total_tokens / success_runs : null,
    tokens_per_success_delivery: success_runs > 0 ? buckets.delivery.tokens / success_runs : null,
    overhead_share: share(buckets.overhead.tokens),
    blocked_share: share(buckets.blocked.tokens),
  };
}

/** 同 runId 的全部记录合成一笔账 (goal 一次两段图 = 一笔)。 */
function mergeRun(runId: string, recs: ParsedRow[]): RunReadout {
  const attempts = recs.length;
  const first_at = Math.min(...recs.map((r) => r.createdAt));
  const last_at = Math.max(...recs.map((r) => r.createdAt));

  // 状态: 任一条记了 success → success (一段成了就是成了); 一条都没记 → 未记 (没记 ≠ failure);
  // 否则取最后一条记录的终止原因 (那是这跑最终怎么结束的)。
  const withOutcome = recs.filter((r) => r.outcome !== null);
  let status: RunOutcomeKind | '未记' = '未记';
  if (withOutcome.length > 0) {
    if (withOutcome.some((r) => r.outcome === 'success')) status = 'success';
    else {
      const last = withOutcome[withOutcome.length - 1]!.outcome!;
      status = (OUTCOME_KINDS.has(last) ? last : 'unclassified') as RunOutcomeKind;
    }
  }

  // usage: 五字段各自独立求和; 整组都没记 → null (有 ≥1 条记了 0 → 求和可为 0, 不转 null)。
  let usage_unmeasured_attempts = 0;
  let anyMeasured = false;
  const usage = { conductorIn: 0, conductorOut: 0, leavesIn: 0, leavesOut: 0, leavesCacheHit: 0 };
  for (const r of recs) {
    if (r.usage === null) {
      usage_unmeasured_attempts++;
      continue;
    }
    anyMeasured = true;
    usage.conductorIn += r.usage.conductorIn;
    usage.conductorOut += r.usage.conductorOut;
    usage.leavesIn += r.usage.leavesIn;
    usage.leavesOut += r.usage.leavesOut;
    usage.leavesCacheHit += r.usage.leavesCacheHit;
  }

  // reused: 记了的值求和 (0 保持 0, 两段 0+1=1); 整组都没记 → null。
  let reused: number | null = null;
  for (const r of recs) if (r.reused !== null) reused = (reused ?? 0) + r.reused;

  return {
    run_id: runId,
    attempts,
    first_at,
    last_at,
    status,
    usage: anyMeasured ? usage : null,
    usage_unmeasured_attempts,
    reused,
    entry: recs.find((r) => r.entry !== null)?.entry ?? '未记',
    criteria: recs.find((r) => r.criteria !== null)?.criteria ?? null,
    acceptanceProbe: recs.find((r) => r.acceptanceProbe !== null)?.acceptanceProbe ?? null,
  };
}

/** 契约读数的人类可读版 (CLI 用; 测试只认 JSON 形状)。 */
function printReadoutHuman(r: ReadoutResult, dbPath: string): void {
  console.log(`\n⑫ 统一契约读数 (${dbPath} · runId 归并 · NULL≠0 · criteria 四格 + 两风险格)`);
  if (r.runs.length === 0) {
    console.log('   空世界: 一条记录都没有 —— 合法空态, 不是错误。');
    return;
  }
  // 统计口径标注 (审查 F3): 一份报告两个宇宙, 不标读者会以为同一窗口 —— 节点统计是全量,
  // run 统计是窗口 (最早 limit 个, 按 first_at; 冻结契约钉死的截断端, 不许两头都读成"最近")。
  console.log(`   统计口径: 节点统计 (四格/风险格/复用率) = 全量记录; run 统计 (分布/判据/entry) = 窗口 (最早 ${r.meta.limit} 个 run, 按 first_at)。`);
  console.log('   run                 attempts   first_at→last_at        status           entry         reused');
  for (const run of r.runs) {
    console.log(
      `   ${run.run_id.padEnd(19)} ${String(run.attempts).padStart(4)}   ${String(run.first_at).padStart(8)} → ${String(run.last_at).padStart(8)}   ${run.status.padEnd(15)} ${run.entry.padEnd(9)} ${run.reused === null ? '未记' : String(run.reused)}`,
    );
  }
  const oc = r.outcome_distribution;
  const recordedKinds = RUN_OUTCOME_ORDER.filter((k) => oc[k] > 0).map((k) => `${k}=${oc[k]}`);
  console.log(`   outcome: ${recordedKinds.join(' · ')}${recordedKinds.length ? ' · ' : ''}未记=${oc['未记']}  (total ${oc.total})`);
  console.log(`   entry:   ${r.entry_distribution.map((e) => `${e.entry} ${e.runs}run/${e.attempts}attempts`).join(' · ')}`);
  for (const cs of r.cost_per_success) {
    const spent = cs.tokens.conductorIn + cs.tokens.conductorOut + cs.tokens.leavesIn + cs.tokens.leavesOut;
    console.log(
      `   cost/success[${cs.entry}]: ${cs.success_runs}/${cs.runs} success · 已记 tokens ${spent}` +
        `${cs.unmeasured_runs > 0 ? ` (另 ${cs.unmeasured_runs} run 没记 usage, 不在和里)` : ''}` +
        ` · 每 success ${cs.tokens_per_success === null ? '算不出 (0 success)' : Math.round(cs.tokens_per_success).toString()}`,
    );
  }
  const aa = r.attention_axis;
  const n = (x: number | null): string => (x === null ? '没数据' : String(x)); // 三种成因合一, 见 attention_axis 注
  console.log(
    `   注意力轴: 踢回 owner ${aa.blocked_runs}/${aa.total_runs} 跑 (${aa.handback_rate === null ? '算不出' : `${(aa.handback_rate * 100).toFixed(1)}%`})` +
      ` · 票: 待确认 ${n(aa.pending_tickets)} / 已处置 ${n(aa.decided_tickets)} / 其中拒 ${n(aa.rejected_tickets)}` +
      ` (白看 ${aa.wasted_review_share === null ? '算不出' : `${(aa.wasted_review_share * 100).toFixed(1)}%`})`,
  );
  console.log('             ⚠ 「到达 owner 的重复提问」这一格**没有数据源** —— deduped 量的是被机器挡下的那些。');
  const sd = r.spend_discipline;
  const pct = (x: number | null): string => (x === null ? '算不出' : `${(x * 100).toFixed(1)}%`);
  const per = (x: number | null): string => (x === null ? '算不出 (0 success)' : Math.round(x).toString());
  console.log(
    `   消耗口径: ${(['delivery', 'blocked', 'overhead', 'unclassified', '未记'] as const)
      .map((k) => `${k} ${sd.buckets[k].runs}run/${sd.buckets[k].tokens}tok${sd.buckets[k].unmeasured_runs > 0 ? `(+${sd.buckets[k].unmeasured_runs}没记)` : ''}`)
      .join(' · ')}`,
  );
  console.log(
    `             每 success: 老口径(全部) ${per(sd.tokens_per_success_all)} → 新口径(只 delivery) ${per(sd.tokens_per_success_delivery)}` +
      ` · overhead 占 ${pct(sd.overhead_share)} · blocked 占 ${pct(sd.blocked_share)}`,
  );
  const g = r.criteria_grid.four_grid;
  console.log(`   四格:   executed_success ${g.executed_success} · executed_failure ${g.executed_failure} · reused_success ${g.reused_success} · 未记 ${g['未记']} (= ${g.executed_success + g.executed_failure + g.reused_success + g['未记']})`);
  console.log(`   风险格: ${r.criteria_grid.two_grid_risk.map((t) => `${t.risk_level} ${t.executed}/${t.not_executed}`).join(' · ')}`);
  const c = r.criteria_consistency;
  console.log(`   criteria: agree ${c.agree} · oracleFailed ${c.oracleFailed} · wastedRounds ${c.wastedRounds} · agreeFail ${c.agreeFail} · recorded ${c.recorded} · unrecorded ${c.unrecorded}`);
  const gd = r.gate_denominators;
  console.log(
    `   闸分母 (全量, **不受上面那张表的窗口截断**): G3 live run ${gd.g3LiveRuns}/20 · G4 采样 ${gd.g4Samples}/10 · ` +
      `跑了但没记上 ${
        gd.ledgerGap === null
          ? '不知道 (注册表读不到)'
          : `${gd.ledgerGap.done} 条 done 无留痕 (另有 ${gd.ledgerGap.total - gd.ledgerGap.done} 条未跑到留痕就终止, 属合法缺席)`
      }`,
  );
  const g4 = r.g4_sampling;
  console.log(
    `   G4 采样 (分母 = entry 为 solve 且 acceptance_probe 非 NULL 的 run, 共 ${g4.denominator} 个): ` +
      `passed-both ${g4.passedBoth} · vacuity-only ${g4.vacuityOnly} · demoted ${g4.demoted} · skipped ${g4.skipped} · exploratory ${g4.exploratory}` +
      (g4.denominator === 0 ? '  (这批没有探针记录 —— 老数据或还没接 acceptance_probe)' : '  (exploratory = demoted + skipped + exploratory)'),
  );
  const sa = r.suggestion_acceptance;
  if (sa !== null) {
    // S-1 片d: 接受率是「要不要全自动」的判据 (交接 18 S-1 立项理由); deduped 单列不进分母。
    console.log(
      `   建议接受率: ${sa.accepted + sa.edited}/${sa.decided} (accepted ${sa.accepted} · edited ${sa.edited} · rejected ${sa.rejected})` +
        `${sa.rate === null ? '' : ` = ${(sa.rate * 100).toFixed(0)}%`} · 待确认 ${sa.pending}` +
        ` · 重复率 ${sa.deduped}/${sa.deduped + sa.decided + sa.pending}${sa.dedupe_rate === null ? '' : ` = ${(sa.dedupe_rate * 100).toFixed(0)}%`} (机器去重扣住的车轱辘话)`,
    );
  }
  const rr = r.reuse_rate;
  console.log(`   复用率: ${rr.reused_nodes}/${rr.total_nodes} 节点${rr.rate === null ? ' (分母 0, 算不出)' : ` = ${(rr.rate * 100).toFixed(1)}%`}`);
}


interface Row {
  id: string;
  created_at: number;
  plan_name: string;
  node_count: number;
  run_id: string | null;
  nodes: string;
  usage: string;
  observations: string | null;
  outcome: string | null;
  verification: string | null;
  reused: number | null;
  criteria: string | null;
  claim_check: string | null;
}
interface Usage {
  conductorIn: number;
  conductorOut: number;
  leavesIn: number;
  leavesOut: number;
  leavesCacheHit: number;
}

/** 一次 goal 的账 = 同 runId 的全部记录求和 (goal 一次跑两段图, 各落一条)。 */
interface RunTotals {
  runId: string;
  createdAt: number;
  plans: string[];
  nodes: number;
  leavesIn: number;
  leavesOut: number;
  cacheHit: number;
  /** 缓存命中率 = leavesCacheHit / leavesIn。leavesIn=0 → null (没跑过 leaf, 不是 0%)。 */
  cacheRate: number | null;
  failed: number;
  /** 本次跑里出现过的模型坐标 (N9 定价的前提)。空集 = 这批记录没记坐标 (老数据)。 */
  models: Set<string>;
  /** 跨轮复用的节点数。null = 没记 (**不是** 0)。 */
  reused: number | null;
}

if (import.meta.main) {
  const flags = parseFlags(Bun.argv.slice(2));
  const dbPath = String(flags.db ?? '.omd/dag-runs.db');
  const limit = Number(flags.limit ?? 20);
  // 参数错 → exit 2 (契约 §2): 老 CLI 会把 NaN limit 直接喂给 SQLite 崩掉; 裸 --limit (无值) 会被
  // parseFlags 记成 true → Number(true)=1, 静默只读 1 个 run —— 同样是参数错, 拒掉 (审查 F6)。
  if (typeof flags.limit === 'boolean' || !Number.isInteger(limit) || limit <= 0) {
    console.error(`--limit 需正整数, 收到 ${String(flags.limit)}`);
    process.exit(2);
  }

  // --factor 同 --limit: 裸 --factor (无值) → parseFlags 记成 true → Number(true)=1, 静默把异常
  // 阈值压到中位数 1 倍 —— 参数错, exit 2 (审查 F6)。提前到开库前校验: 空表早退 (exit 0) 不能把它掩掉。
  const ANOMALY_FACTOR = Number(flags.factor ?? 3);
  if (typeof flags.factor === 'boolean' || !Number.isFinite(ANOMALY_FACTOR) || ANOMALY_FACTOR <= 0) {
    console.error(`--factor 需正数, 收到 ${String(flags.factor)}`);
    process.exit(2);
  }

  let db: Database;
  let hasTable = false;
  try {
    db = new Database(dbPath, { readonly: true });
    // 只读会话加固 (契约 §1): 打开即 readonly, 再钉 query_only —— 不经过任何建表/迁移/写 pragma 的路径。
    db.run('PRAGMA query_only = ON');
    // bun:sqlite 是懒打开: 文件在但**不是 sqlite** (截断/文本文件) 时 open 不报, 首个查询才炸。
    // 契约 §退出码: DB 不可读 = 3 —— 不许未捕获异常把退出码砸成 1 (审查 F2)。
    hasTable = db.query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'omd_dag_runs'`).get() != null;
  } catch (e) {
    console.error(`读不到留痕库 ${dbPath} — ${(e as Error).message}`);
    console.error('（还没跑过带 runId 的 dag_run / dag_goal 就是空的，这不是错误。）');
    process.exit(3);
  }

  // 表不存在 = 一笔记录都没有 (合法空态, 契约要求 exit 0; 老 CLI 会在这里 SELECT 崩掉)。
  if (!hasTable) {
    const contract = readout({ db, limit, dbPath, mapsCwd: process.cwd() });
    if (flags.json) console.log(JSON.stringify({ dbPath, readout: contract }, null, 2));
    else {
      console.log(`留痕库 ${dbPath} 里还没有 omd_dag_runs 表 —— 一次记录都没有 (合法空态, exit 0)。`);
      printReadoutHuman(contract, dbPath);
    }
    db.close();
    process.exit(0);
  }
  const contract = readout({ db, limit, dbPath, mapsCwd: process.cwd() });

  // 老库没有 observations / outcome 列 → 整条 SELECT 会崩。列在不在是**运行期事实**, 查一次 pragma
  // 再拼 (缺的那列补 NULL —— 正是"这批记录没记"那一格, 与"记了但是空的"分开数)。
  const haveCols = (db.query(`PRAGMA table_info(omd_dag_runs)`).all() as { name: string }[]).map((c) => c.name);
  const optionalCol = (name: string) => (haveCols.includes(name) ? `, ${name}` : `, NULL AS ${name}`);
  const rows = db
    .query(
      `SELECT id, created_at, plan_name, node_count, run_id, nodes, usage${optionalCol('observations')}${optionalCol('outcome')}${optionalCol('verification')}${optionalCol('reused')}${optionalCol('criteria')}` +
        ` FROM omd_dag_runs ORDER BY created_at DESC LIMIT ?`,
    )
    .all(limit * 3) as Row[]; // ×3: 一次 goal 最多两条, 留余量再按 runId 截

  if (rows.length === 0 && !flags.json) {
    console.log(`留痕库 ${dbPath} 里一条记录都没有。`);
    printReadoutHuman(contract, dbPath);
    process.exit(0);
  }

  // ── ① 每次运行的账 (按 runId 归组) ───────────────────────────────────────────
  const byRun = new Map<string, RunTotals>();
  // runId 为 null 的老行 / 图外调用: 各自成组, 用主键当键 —— 归到同一个 "null" 组会把无关的运行
  // 加在一起, 那是**编出来的**一笔账, 比缺这笔账坏。
  for (const r of rows) {
    const key = r.run_id ?? `(no-runid):${r.id}`;
    const u = JSON.parse(r.usage) as Usage;
    const nodes = JSON.parse(r.nodes) as DagRunNode[];
    const cur = byRun.get(key) ?? {
      runId: key,
      createdAt: r.created_at,
      plans: [],
      nodes: 0,
      leavesIn: 0,
      leavesOut: 0,
      cacheHit: 0,
      cacheRate: null,
      failed: 0,
      models: new Set<string>(),
      reused: null,
    };
    cur.plans.push(r.plan_name);
    cur.nodes += r.node_count;
    cur.leavesIn += u.leavesIn;
    cur.leavesOut += u.leavesOut;
    cur.cacheHit += u.leavesCacheHit;
    cur.failed += nodes.filter((n) => n.status === 'failed').length;
    for (const n of nodes) if (n.model) cur.models.add(n.model);
    // goal 一次两段图各落一条 → 两条的复用数相加; 全都没记才是 null。
    if (r.reused !== null) cur.reused = (cur.reused ?? 0) + r.reused;
    cur.createdAt = Math.max(cur.createdAt, r.created_at);
    byRun.set(key, cur);
  }
  const runs = [...byRun.values()]
    .map((r) => ({ ...r, cacheRate: r.leavesIn > 0 ? r.cacheHit / r.leavesIn : null }))
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit);

  // ── ② 命令风险级分布 (R1 · 只报不拦) ──────────────────────────────────────────
  const tierCount: Record<CommandRiskTier, number> = { read_only: 0, scoped_write: 0, approval_required: 0, never: 0 };
  const tierSamples = new Map<CommandRiskTier, Set<string>>();
  let commandNodes = 0;
  /** `never` 里**被闸正确拒掉**的那部分(节点非 done)—— 它不是缺陷, 是闸在干活。 */
  let neverButBlocked = 0;
  /** **闸拒次数** (G5 建议 A 的最小实现): 书 §4.4 里这才是 BLOCKED 的教科书触发条件, 而我们今天
   *  把它降格成"节点 failed"。先把它数出来 —— 「连续几轮找不到合法命令」那个 K 才有依据可定。 */
  let gateRejections = 0;
  let neverAndRan = 0;
  let neverUnknown = 0;
  for (const r of rows) {
    for (const n of JSON.parse(r.nodes) as DagRunNode[]) {
      if (!n.command) continue;
      commandNodes++;
      const tier = commandRiskTier(n.command);
      tierCount[tier]++;
      // ⚠ `never` 有**两种成因, 后果完全相反**(2026-07-31 第二次 live 撞出来的):
      //   ① 闸正确拒了它 (bin 不在白名单 → 节点 failed) —— 系统工作正常, **不该报警**
      //   ② bin 登记漏了却真跑成了 (节点 done) —— 分级表与白名单不同步, **该报警**
      // 第一版把两者合成一条"不同步"告警, 于是第一次真读数就报了一条假警, 会把人支去修一个
      // 不存在的问题。这正是 A5「sensor 措辞普查」要治的那类 —— 发现对不对之外, 还得问
      // "它的读者拿它做得了什么"。
      // ⚠ 2026-07-31 第四跑修: 「节点非 done」有**两种**成因, 后续动作相反 ——
      //   闸拒 (exitCode < 0): Harness 拒了这个操作, 再试也没用 (书 §4.4 的 BLOCKED 定义)
      //   普通失败 (exit ≠ want): 断言没成立, 再试一轮可能就好了 (STALLED)
      // 第一版拿 `status !== 'done'` 当"闸已拒"的判据, 于是把 `grep -qx "3000"` (无任何元字符,
      // 只是没匹配上) 标成了闸拒 —— **这是本轮第四次把两种成因合成一条**。判据换成 exitCode。
      const gateRejected = typeof n.exitCode === 'number' && n.exitCode < 0;
      // **三态直接数, 不用补集** —— 补集会把"不知道"算进某一侧, 而本文件已经为这条栽过两次
      // (第一次 writeCounts 缺席 vs [0,0]; 第二次这里)。三个计数器互不相减。
      if (tier === 'never') {
        if (n.status === 'done') neverAndRan++;        // 未登记的 bin **真跑成了** → 分级表与白名单不同步, 该修
        else if (gateRejected) neverButBlocked++;      // 闸正确拒了 → 系统在干活
        else neverUnknown++;                           // 老记录无 exitCode → **不知道**, 明说
      }
      // 三态标记, 缺 exitCode 的老记录用 `[未通过]` —— 不知道就说不知道, 别猜成闸拒。
      const mark = n.status === 'done' ? '' : gateRejected ? '[闸已拒] ' : typeof n.exitCode === 'number' ? `[失败 exit=${n.exitCode}] ` : '[未通过] ';
      const s = tierSamples.get(tier) ?? new Set<string>();
      if (s.size < 5) s.add(`${mark}${n.command.length > 60 ? `${n.command.slice(0, 57)}…` : n.command}`);
      tierSamples.set(tier, s);
      if (gateRejected) gateRejections++;
    }
  }

  // ── ④ 效果指标 (§8.5): 写调用里有多少是 no-op ────────────────────────────────
  // 这一段回答的是"要不要把它从**报**升成**判**": 若 no-op 写常年 0%, 那把它做成闸就是给一个
  // 不存在的问题加关卡; 若成规模, 那产物闸今天正放过一整类静默失败。
  // **缺席 ≠ [0,0]** —— 分开数, 否则"没记"会被读成"跑了但没写"。
  let writeNodes = 0; // 报了 writeCounts 的节点数
  let unreported = 0; // 该报而没报的 (agent 节点但无 writeCounts = 早于本次改动的记录)
  let totalWrites = 0;
  let totalNoop = 0;
  const noopNodes: { id: string; total: number; noop: number }[] = [];
  for (const r of rows) {
    for (const n of JSON.parse(r.nodes) as DagRunNode[]) {
      if (!n.writeCounts) {
        if (n.kind === 'agent') unreported++;
        continue;
      }
      writeNodes++;
      const [total, noop] = n.writeCounts;
      totalWrites += total;
      totalNoop += noop;
      if (total > 0 && noop === total) noopNodes.push({ id: n.id, total, noop });
    }
  }

  // ── ⑤ detector 标注率 (D-Q): conductor 在**真跑**上标了几个 ────────────────────
  // 此前这个数只有 `eval-detector-usage.ts` 量得到, 而它量的是**规划期 prompt 上标没标**。
  // "60% 天花板在生产上兑现成 0/N" 这句话此前每次都要人去读日志重数一遍。
  let conductorChildren = 0; // 内容寻址子节点 (id 含 '::') = conductor 展开出来的
  let detectorNodes = 0;
  for (const r of rows) {
    for (const n of JSON.parse(r.nodes) as DagRunNode[]) {
      if (!n.id.includes('::')) continue; // 只看子图里的点; 顶层节点不是 conductor 画的
      conductorChildren++;
      if (n.detector) detectorNodes++;
    }
  }

  // ── ⑥ 熔断 near-miss (§8.4 的键该不该改) ─────────────────────────────────────
  // 熔断的键是「命令 + 逐字相同的失败」。2026-07-31 live 显示 conductor 会把同一个断言重写一遍
  // (单引号换双引号) → 「同一条命令」凑不齐第二次。
  // 直觉改法「只看输出」是**错的**: `grep -q` 失败无输出, 所有静默失败会指纹成同一条。
  // 所以先量: **输出逐字相同、命令文本不同** 有多少组 —— 那才是改键能多抓到的population。
  const byOutput = new Map<string, Set<string>>();
  for (const r of rows) {
    for (const n of JSON.parse(r.nodes) as DagRunNode[]) {
      if (!n.outputHash || !n.command) continue;
      const set = byOutput.get(n.outputHash) ?? new Set<string>();
      set.add(n.command.trim());
      byOutput.set(n.outputHash, set);
    }
  }
  const nearMiss = [...byOutput.entries()].filter(([, cmds]) => cmds.size > 1);
  const exactRepeat = [...byOutput.values()].filter((c) => c.size === 1).length;

  // ── ⑦ 没过的成因分布 (P1 词表细化的**唯一证据面**) ───────────────────────────
  // 这一段回答的就是"细化值不值": 若所有失败常年只落在一两格里, 那这个词表是镀金;
  // 若它照出「闸拒 / 心跳停摆 / 产物闸判空」各占一块, 那此前那个 `failed` 一直在把
  // **三种后续动作相反**的东西混着报给同一个读者。
  //
  // **三态直接数, 不用补集** (本仓为这条纪律付过五次账):
  //   · 归了类的 → 各自计数
  //   · `unclassified` → 引擎里还有一条没交代自己的失败路径 (**缺陷**, 该去补标注)
  //   · 字段整个缺席 → 早于 2026-07-31 的记录 (**老数据**, 不是缺陷)
  // 后两者读上去都像"不知道", 但结论相反, 所以是两个计数器不是一个。
  const failureKindCount: Record<NodeFailureKind, number> = Object.fromEntries(
    FAILURE_KIND_ORDER.map((k) => [k, 0]),
  ) as Record<NodeFailureKind, number>;
  let notDoneNodes = 0;
  /** status≠done 但字段缺席 = 这批记录早于本次改动。**不是** unclassified。 */
  let failureKindUnrecorded = 0;
  const kindSamples = new Map<NodeFailureKind, Set<string>>();
  for (const r of rows) {
    for (const n of JSON.parse(r.nodes) as DagRunNode[]) {
      if (n.status === 'done') continue;
      notDoneNodes++;
      if (!n.failureKind) {
        failureKindUnrecorded++;
        continue;
      }
      // 老库里可能有本词表之外的字面量 (schema 会漂) → 不静默丢, 归 unclassified 并留样本。
      const kind = (n.failureKind in failureKindCount ? n.failureKind : 'unclassified') as NodeFailureKind;
      failureKindCount[kind]++;
      const s = kindSamples.get(kind) ?? new Set<string>();
      if (s.size < 3) s.add(n.id);
      kindSamples.set(kind, s);
    }
  }

  // ── ⑧ 图外观察者命中分布 (G5 正解「产物没变」定 K 用) ─────────────────────────
  // 这一段的用处是**具体的**: 「产物没变」检测器今天只报不拦, 要不要升成 BLOCKED、K 取几,
  // 取决于它在真跑上多久命中一次。不记就又要靠人去读日志重数一遍。
  // ⚠ 「这批记录没有 observations 列/字段」与「跑了但一条观察都没有」是两件事, 分开数。
  const obsCount = new Map<string, number>();
  let runsWithObs = 0; // 记了 observations 的记录数 (哪怕是空数组)
  let runsUnrecordedObs = 0; // 早于 2026-07-31 的记录: 这一位压根没记
  for (const r of rows) {
    if (r.observations === null) {
      runsUnrecordedObs++;
      continue;
    }
    runsWithObs++;
    for (const o of JSON.parse(r.observations) as { kind: string }[]) {
      obsCount.set(o.kind, (obsCount.get(o.kind) ?? 0) + 1);
    }
  }

  // ⑧.5 的聚合**在 readout() 里**(纯函数那一份), 这里只渲染 —— 两处各算一份必漂,
  // 而"读数板说 A、执行期说 B"比没有读数板更坏。
  const cc = contract.claim_check;

  // ── ⑨ run 级终止原因分布 (N5 · 五态在上层的证据面) ───────────────────────────
  // ⑦ 数的是**节点**为什么没过, 这一段数的是**整跑**怎么结束的 —— 两张表回答的不是同一个问题:
  // 一跑里九个节点全灭而成因各异, 在 ⑦ 里是九笔账, 在这里只有一笔 (`infra-error`), 而那一笔
  // 才是"这次 run 该怎么办"的答案。
  // 同 ⑦ 的三态数法: 归了类的各自计数 · `unclassified` 是缺陷 · 字段缺席是老数据 (两个计数器)。
  const outcomeCount: Record<RunOutcomeKind, number> = Object.fromEntries(
    RUN_OUTCOME_ORDER.map((k) => [k, 0]),
  ) as Record<RunOutcomeKind, number>;
  let runsUnrecordedOutcome = 0;
  const outcomeSamples = new Map<RunOutcomeKind, Set<string>>();
  for (const r of rows) {
    if (!r.outcome) {
      runsUnrecordedOutcome++;
      continue;
    }
    // 老库里可能有本词表之外的字面量 → 不静默丢, 归 unclassified 并留样本 (同 ⑦)。
    const kind = (r.outcome in outcomeCount ? r.outcome : 'unclassified') as RunOutcomeKind;
    outcomeCount[kind]++;
    const set = outcomeSamples.get(kind) ?? new Set<string>();
    if (set.size < 3) set.add(r.plan_name);
    outcomeSamples.set(kind, set);
  }
  const outcomeRecorded = rows.length - runsUnrecordedOutcome;

  // ── ⑩ 四轴试算 (N9 · score 维度在**便宜的板子上**先试) ────────────────────────
  // 为什么先在这儿试而不是直接往 Langfuse 推 score: 维度定错, 后面所有对比都建在错的坐标上,
  // 而这块板是确定性的、重跑不花钱。这一段的产出**不只是四个数**, 更是"哪条轴今天根本没有
  // 数据源" —— 那件事在推 score 之前知道, 比之后知道便宜得多。
  //
  // 四轴逐条的覆盖度各自报, 不合并成一个总分: 合并会让"这条轴没数据"被另一条轴的数掩盖。

  // 判据轴 —— 收敛判据(judge) 与 冻结判据(验收命令) **不一致**的那两格才是它的全部意义。
  //
  // ⚠ 这条轴**不能用 `outcome` 算** (2026-07-31 起飞前检查抓到的):
  //   ① `oracle-failed` 只活在 goal 级 (`RunGoalResult.outcome`), 而本表的 `outcome` 列是
  //      `deriveRunOutcome` 按**每张图**算的 —— `NODE_TO_RUN` 里没有任何成因映射到那一格,
  //      它在这张表里**永远不会出现**;
  //   ② 更要命的是反方向那格在**词表上就不存在**: goal 的 outcome 算式里 judge 为假就一律落
  //      `not-converged`, **不管冻结判据过没过**。两个布尔算完就被扔了。
  //   所以改用 `criteria` 两位布尔。它是 goal 级的 → **按 runId 去重再数**, 按行数会把一次 goal 数成两次。
  const critSeen = new Map<string, { judge: boolean; oracle: boolean }>();
  let critNoVerif = 0;
  for (const r of rows) {
    if (!r.run_id) continue;
    if (r.criteria === null) continue;
    critSeen.set(r.run_id, JSON.parse(r.criteria) as { judge: boolean; oracle: boolean });
  }
  // 分母 = 有 criteria 的 goal 次数; 没有的那些单独报 (不是 0, 是没记)。
  const critRuns = [...new Set(rows.map((r) => r.run_id).filter((x): x is string => !!x))];
  critNoVerif = critRuns.length - critSeen.size;
  let critAgree = 0;          // 两条判据都说成了
  let critOracleFailed = 0;   // judge 说成了, 冻结判据没过 —— 判据说了不算 (judge 太松)
  let critWastedRounds = 0;   // judge 说没成, 冻结判据却过了 —— 白转了几轮 (judge 太紧)
  let critAgreeFail = 0;      // 两条都说没成 (一致, 只是没成)
  for (const c of critSeen.values()) {
    if (c.judge && c.oracle) critAgree++;
    else if (c.judge && !c.oracle) critOracleFailed++;
    else if (!c.judge && c.oracle) critWastedRounds++;
    else critAgreeFail++;
  }
  const critRecorded = critSeen.size;

  // 效率轴 —— $ / cacheHit / 复用率 / 轮数。四格里今天只有前三格有数据源。
  // 定价口径诚实说明: 节点坐标记的是**叶子**的; conductor 自己不是节点, 它的坐标没记 ——
  // 所以这里算的是「叶子那部分的钱」, 不是整跑的钱。混合座位 (一次跑里多个坐标) 不定价,
  // 因为 usage 是聚合的、分不到各坐标头上 —— 硬按其中一个算等于**编一笔账**。
  let pricedRuns = 0;
  let mixedSeatRuns = 0;
  let noCoordRuns = 0;
  let leafUsd = 0;
  let unpricedCoordRuns = 0;
  for (const r of runs) {
    if (r.models.size === 0) { noCoordRuns++; continue; }
    if (r.models.size > 1) { mixedSeatRuns++; continue; }
    const coord = [...r.models][0]!;
    const c = computeCost({ in: r.leavesIn, out: r.leavesOut, cacheHit: r.cacheHit }, coord);
    if (c.unpriced) { unpricedCoordRuns++; continue; }
    pricedRuns++;
    leafUsd += c.costUsd;
  }
  const reuseRuns = runs.filter((r) => r.reused !== null);
  const reusedTotal = reuseRuns.reduce((a, r) => a + (r.reused ?? 0), 0);
  const reuseNodeBase = reuseRuns.reduce((a, r) => a + r.nodes, 0);

  // 诚实轴 —— 引擎有没有在**报告自己做砸了/不知道**。两个率都是"越低越好"但成因不同:
  // empty-artifact 高 = 节点谎报完工被产物闸抓住; unclassified 高 = 归因面自己有洞。
  const emptyArtifact = failureKindCount['empty-artifact'] ?? 0;
  const nodeUnclassified = failureKindCount.unclassified ?? 0;
  const runUnclassified = outcomeCount.unclassified;

  // 停止轴 —— 「blocked 与 not-converged 分不分得开」就是 G5 的后半句。
  // 分得开的判据不是"两个数都非零"那么松: 只要有一格恒为 0, 这个区分在生产上就没兑现。
  const stopBlocked = outcomeCount.blocked;
  const stopNotConverged = outcomeCount['not-converged'];
  const stopSeparable = stopBlocked > 0 && stopNotConverged > 0;

  // ── ⑪ 内环 journal (N9 第二处数据源) ─────────────────────────────────────────
  // 轮数与「凭什么停的」**只活在 continuity 的 journal 里** —— 留痕库存的是每张图跑完的结果,
  // 环转了几轮、停在哪一格, 那张表一个字都没有。所以这块板从"读一张表"变成"读两处"。
  //
  // ⚠ 两处的生命周期**不一样长**: 留痕库是永久的, journal 跟着 `.omd/continuity/<runId>/` 走,
  //   清理掉就没了。于是「这一跑没有内环数据」有三种成因, 后续动作不同, 分开数:
  //     ① 这次跑压根没有带内环的节点 (最常见, 不是缺陷)
  //     ② 有 journal 但没有 `stop` 字段 —— 早于 N6 的记录 (老数据)
  //     ③ journal 目录被清了 / 换了机器 —— 观测边界够不着 (Unobserved, 不是 Missing)
  //   ②③ 从这块板上分不开 (都表现为"读不到"), 所以合成一格并**如实说它是合的**, 不假装分得清。
  const cm = new CheckpointManager(String(flags.repo ?? process.cwd()));
  const loopStopCount = new Map<string, number>();
  const loopStopSamples = new Map<string, { evidence: string; atRound: number }>();
  let loopJournals = 0;
  let loopJournalsNoStop = 0;
  let runsWithLoop = 0;
  let runsNoLoopData = 0;
  let roundsTotal = 0;
  for (const r of runs) {
    if (r.runId.startsWith('(no-runid):')) { runsNoLoopData++; continue; }
    const js: NodeLoopJournal[] = cm.listNodeLoopJournals(r.runId);
    if (js.length === 0) { runsNoLoopData++; continue; }
    runsWithLoop++;
    for (const j of js) {
      loopJournals++;
      roundsTotal += j.completedRounds ?? 0;
      if (!j.stop) { loopJournalsNoStop++; continue; }
      loopStopCount.set(j.stop.kind, (loopStopCount.get(j.stop.kind) ?? 0) + 1);
      if (!loopStopSamples.has(j.stop.kind)) {
        loopStopSamples.set(j.stop.kind, { evidence: j.stop.evidence, atRound: j.stop.atRound });
      }
    }
  }
  const loopStopRecorded = loopJournals - loopJournalsNoStop;

  // ── ③ 单轮成本异常 (§8.6): 偏离历史中位数 N 倍 ────────────────────────────────
  // 用中位数而非均值: 一次异常本身会把均值抬起来, 于是"异常"检测不出下一次异常。
  // ANOMALY_FACTOR 的解析与参数校验在 main 开头 (与 --limit 同处, exit 2 契约) —— 空表早退不能把它掩掉。
  const leafIns = runs.map((r) => r.leavesIn).filter((n) => n > 0).sort((a, b) => a - b);
  const median = leafIns.length ? leafIns[Math.floor(leafIns.length / 2)]! : 0;
  const anomalies = median > 0 ? runs.filter((r) => r.leavesIn > median * ANOMALY_FACTOR) : [];

  if (flags.json) {
    console.log(
      JSON.stringify(
        { dbPath, readout: contract,
          statWindows: '节点统计 (four_grid/风险格/复用率) = 全量记录; run 统计 (分布/判据/entry) = 窗口 (最早 limit 个 run, 按 first_at)',
          runs, tierCount, neverButBlocked, neverAndRan, neverUnknown, gateRejections, commandNodes, conductorChildren, detectorNodes,
          nearMiss: nearMiss.map(([h, c]) => ({ outputHash: h, commands: [...c] })), exactRepeat, writeNodes, unreported, totalWrites, totalNoop, noopNodes, median, anomalyFactor: ANOMALY_FACTOR, anomalies,
          notDoneNodes, failureKindCount, failureKindUnrecorded,
          observations: Object.fromEntries(obsCount), runsWithObs, runsUnrecordedObs,
          claimCheck: cc,
          outcomeCount, runsUnrecordedOutcome, outcomeRecorded,
          axes: {
            criteria: { agree: critAgree, oracleFailed: critOracleFailed, wastedRounds: critWastedRounds, agreeFail: critAgreeFail, unrecorded: critNoVerif, recorded: critRecorded },
            efficiency: { pricedRuns, mixedSeatRuns, noCoordRuns, unpricedCoordRuns, leafUsd, reusedTotal, reuseNodeBase, reuseRuns: reuseRuns.length },
            honesty: { emptyArtifact, nodeUnclassified, runUnclassified, notDoneNodes },
            stop: { blocked: stopBlocked, notConverged: stopNotConverged, separable: stopSeparable,
              innerLoop: { journals: loopJournals, withoutStop: loopJournalsNoStop, byKind: Object.fromEntries(loopStopCount), runsWithLoop, runsNoLoopData, roundsTotal } },
          } },
        null,
        2,
      ),
    );
    process.exit(0);
  }

  // ── 输出 ──────────────────────────────────────────────────────────────────────
  const pct = (n: number | null) => (n === null ? '  —  ' : `${(n * 100).toFixed(1)}%`);
  const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

  console.log(`\n═══ omd 读数板 · ${dbPath} · 最近 ${runs.length} 次运行 ═══\n`);

  console.log('① 每次运行的账 (按 runId 归组; goal 一次两段图算一次)');
  console.log('   时间              节点  leafIn   leafOut  cacheHit  失败  plan');
  for (const r of runs) {
    const t = new Date(r.createdAt).toISOString().slice(5, 16).replace('T', ' ');
    const plans = [...new Set(r.plans)].join('+');
    console.log(
      `   ${t}  ${String(r.nodes).padStart(4)}  ${k(r.leavesIn).padStart(7)}  ${k(r.leavesOut).padStart(7)}  ${pct(r.cacheRate).padStart(8)}  ${String(r.failed).padStart(4)}  ${plans}`,
    );
  }

  console.log(`\n② 命令风险级分布 (R1 · 只报不拦; 共 ${commandNodes} 次 command 节点执行)`);
  if (commandNodes === 0) {
    console.log('   留痕里没有 command 节点。⚠ 也可能是这批记录早于「记录命令」那次改动 —— ');
    console.log('     两种情况读上去一模一样, 别把「没记」读成「没跑过」。');
  } else {
    for (const tier of (Object.keys(tierCount) as CommandRiskTier[]).sort((a, b) => RISK_TIER_ORDER[a] - RISK_TIER_ORDER[b])) {
      const n = tierCount[tier];
      const bar = '█'.repeat(Math.round((n / commandNodes) * 30));
      console.log(`   ${tier.padEnd(18)} ${String(n).padStart(4)}  ${pct(n / commandNodes)}  ${bar}`);
      for (const s of tierSamples.get(tier) ?? []) console.log(`       · ${s}`);
    }
    if (neverButBlocked > 0) {
      console.log(`   ℹ never 里有 ${neverButBlocked} 条是**闸正确拒掉**的 —— 系统在干活, 不是缺陷。`);
    }
    if (neverUnknown > 0) {
      console.log(`   ? never 里有 ${neverUnknown} 条**判不出成因**(老记录无 exitCode)—— 不知道就是不知道, 别当缺陷也别当正常。`);
    }
    console.log(`   **闸拒 ${gateRejections} 次** (G5: 书 §4.4 里"Harness 拒绝了某个操作"正是 BLOCKED 的定义,`);
    console.log(`     而我们今天把它降格成节点 failed。攒 K 值用的就是这个数。)`);
    if (neverAndRan > 0) {
      console.log(`   ⚠ never 里有 ${neverAndRan} 条**跑成了**(节点 done)—— 那才是分级表与白名单不同步, 该修。`);
    }
  }

  console.log(`\n③ 单轮成本异常 (§8.6 · leafIn > 中位数 ${k(median)} × ${ANOMALY_FACTOR})`);
  if (median === 0) {
    console.log('   还没有非零的 leafIn, 算不出中位数。');
  } else if (anomalies.length === 0) {
    console.log('   无。');
  } else {
    for (const a of anomalies) {
      console.log(`   ${new Date(a.createdAt).toISOString().slice(5, 16).replace('T', ' ')}  leafIn=${k(a.leavesIn)}  (${(a.leavesIn / median).toFixed(1)}× 中位数)  ${[...new Set(a.plans)].join('+')}`);
    }
  }

  console.log(`\n④ 效果指标 (§8.5 · 写调用成功 ≠ 真的改了)`);
  if (writeNodes === 0) {
    console.log(`   没有节点报过 writeCounts。${unreported > 0 ? `⚠ 其中 ${unreported} 个 agent 节点**该报而没报** — 那是早于 2026-07-31 的记录, 不是"它们没写文件"。` : ''}`);
  } else {
    const rate = totalWrites > 0 ? totalNoop / totalWrites : null;
    console.log(`   报了的节点 ${writeNodes} 个${unreported > 0 ? ` (另有 ${unreported} 个 agent 节点该报未报 — 旧记录)` : ''}`);
    console.log(`   写调用 ${totalWrites} 次, 其中 no-op ${totalNoop} 次 = ${pct(rate)}`);
    if (noopNodes.length > 0) {
      console.log(`   ⚠ **全部写都是 no-op** 的节点 ${noopNodes.length} 个 —— 「看起来做了」, 而产物闸看不见:`);
      for (const n of noopNodes.slice(0, 8)) console.log(`       · ${n.id}  (${n.noop}/${n.total})`);
    }
    console.log(`   判据: no-op 率长期贴近 0 → 别为它建闸; 成规模 → 产物闸正放过一整类静默失败。`);
  }

  console.log(`\n⑤ detector 标注率 (D-Q · conductor 在真跑上标了几个)`);
  if (conductorChildren === 0) {
    console.log('   留痕里没有 conductor 子节点 (这批 run 没走内环, 或早于「记 detector」那次改动)。');
  } else {
    console.log(`   子节点 ${conductorChildren} 个, 标了 detector 的 ${detectorNodes} 个 = ${pct(detectorNodes / conductorChildren)}`);
    console.log(`   对照: eval 上的**规划期**使用率天花板是 60% (v3/v4 同分, 噪声内)。`);
    // ⚠ 第三次踩同一个坑了 (前两次: writeCounts 缺席 vs [0,0]; never 闸拒 vs 未登记)。
    // `detector` 在**早于 2026-07-31 的记录**里恒缺席 —— 那个 0 是"没记"不是"没标"。
    // 用 unreported (agent 节点没报 writeCounts) 当同批老记录的判据: 两个字段同一次改动加的。
    if (unreported > 0) {
      console.log(`   ⚠ 这批里有 ${unreported} 个 agent 节点是**旧格式**记录 —— 它们的 detector 恒缺席,`);
      console.log(`     所以上面这个比率**只在新记录上可信**。别把「没记」读成「没标」。`);
    } else if (detectorNodes === 0) {
      console.log('   ⚠ 0 个 (记录是新格式, 这个 0 可信) —— 「60% 天花板在生产上兑现成 0」再加一次读数。');
    }
  }

  console.log(`\n⑥ 熔断 near-miss (§8.4 的键该不该从「命令+输出」改成别的)`);
  if (byOutput.size === 0) {
    console.log('   留痕里没有失败的 command 节点 (或早于「记 outputHash」那次改动)。');
  } else {
    console.log(`   失败输出指纹 ${byOutput.size} 种; 其中**同输出不同命令** ${nearMiss.length} 组`);
    for (const [h, cmds] of nearMiss.slice(0, 3)) {
      console.log(`     · ${h}: ${cmds.size} 条不同命令 —— 现行键漏掉的正是这一组`);
      for (const c of [...cmds].slice(0, 2)) console.log(`         ${c.slice(0, 64)}`);
    }
    console.log(`   判据: near-miss 长期为 0 → 现行「命令+输出」键就够, 别动它;`);
    console.log(`         成规模 → 才值得为它设计一个更宽的键(⚠ 但不是"只看输出" —— grep -q 失败无输出, 会误熔断)。`);
  }

  console.log(`\n⑦ 没过的成因分布 (P1 · 此前这 ${notDoneNodes} 个节点在读数上全叫 "failed")`);
  if (notDoneNodes === 0) {
    console.log('   这批记录里没有 status≠done 的节点。');
  } else {
    const classified = notDoneNodes - failureKindUnrecorded;
    if (classified === 0) {
      console.log(`   ${notDoneNodes} 个没过的节点**全部是旧格式记录**(无 failureKind) —— 那是「没记」,`);
      console.log('     不是「归不了类」。跑一次新的 dag_run / dag_goal 才有这段读数。');
    } else {
      for (const kind of FAILURE_KIND_ORDER) {
        const n = failureKindCount[kind];
        if (n === 0) continue;
        const info = FAILURE_KIND_INFO[kind];
        const bar = '█'.repeat(Math.round((n / classified) * 24));
        const state = info.loopState ?? '—';
        const retry = info.retryable === null ? '重试?' : info.retryable ? '可重试' : '**别重试**';
        console.log(`   ${kind.padEnd(19)} ${String(n).padStart(4)}  ${pct(n / classified).padStart(6)}  ${state.padEnd(8)} ${retry.padEnd(10)} ${bar}`);
        console.log(`       判据: ${info.evidence}`);
        console.log(`       下一步: ${info.nextAction}`);
        const s = kindSamples.get(kind);
        if (s?.size) console.log(`       节点: ${[...s].join(', ')}`);
      }
      if (failureKindCount.unclassified > 0) {
        console.log(`   ⚠ **${failureKindCount.unclassified} 个归不了类** —— 引擎里还有一条失败路径没交代自己是怎么回事,`);
        console.log('     那正是该去补标注的地方。(这个数该趋近 0; 它不为 0 就是缺陷本身。)');
      }
    }
    if (failureKindUnrecorded > 0) {
      console.log(`   ? 另有 ${failureKindUnrecorded} 个没过的节点**没记**成因(早于 2026-07-31 的记录)——`);
      console.log('     与上面的 unclassified 不是一回事: 那个是缺陷, 这个是老数据。别并起来数。');
    }
    console.log('   判据: 若失败常年只落一两格 → 这个词表是镀金, 该收回去;');
    console.log('         若 gate-rejected / stall / empty-artifact 各占一块 → 此前那个 `failed`');
    console.log('         一直在把三种**后续动作相反**的东西报给同一个读者。');
  }

  console.log(`\n⑧ 图外观察者命中 (G5 正解「产物没变」的定 K 依据)`);
  if (runsWithObs === 0) {
    console.log(`   这批 ${runsUnrecordedObs} 条记录**都没记** observations (早于 2026-07-31)。`);
    console.log('     ⚠ 那是「没记」不是「一条都没命中」—— 跑一次新的才有这段读数。');
  } else {
    console.log(`   记了的运行 ${runsWithObs} 次${runsUnrecordedObs > 0 ? ` (另有 ${runsUnrecordedObs} 次是旧格式, 不计入)` : ''}`);
    if (obsCount.size === 0) {
      console.log('   一条观察都没有 —— 这个 0 可信 (记了, 只是没命中)。');
    } else {
      for (const [kind, n] of [...obsCount].sort((a, b) => b[1] - a[1])) {
        console.log(`   ${kind.padEnd(26)} ${String(n).padStart(4)} 次  (${(n / runsWithObs).toFixed(2)} 次/运行)`);
      }
    }
    const noMove = obsCount.get('loop-no-artifact-change') ?? 0;
    console.log(`   ▸ **loop-no-artifact-change ${noMove} 次** —— 它是 D-AD 那条死路的绕法:`);
    console.log('     旧的三个"卡住"检测器全键在「agent 重复自己」上, 而 LLM conductor 每轮重画,');
    console.log('     从不逐字重复 → 在 live 上恒 0。这一条改键在「盘上有没有位移」, 才可能真命中。');
    console.log('   判据 (写死在这儿, 免得下次凭感觉定):');
    console.log('     · 长期 0 次 → 连这条也够不着, 那 G5 的问题不在判据在别处, 别再加检测器;');
    console.log('     · 命中了但那些 run 后来**自己收敛了** → 说明"没位移"不蕴含"卡死", 维持只报;');
    console.log('     · 命中且此后再没位移直到轮数耗尽 → 才谈升 BLOCKED, K 取"连续几轮"的众数。');
    console.log('   ⚠ 现在**只报不拦**: max_rounds ≤ 4, 误拦一次掐死一个本可收敛的 run,');
    console.log('     漏报一次只赔一两轮。这个比价下, 0 读数就上硬闸是拿大风险换小收益。');
  }

  console.log(`\n⑧.5 「声称 vs 引擎记录」检出器 (report-only —— 拨不拨闸就看这段)`);
  if (cc.recordedRuns === 0) {
    console.log(`   这批 ${cc.unrecordedRuns} 条记录**都没记** claim_check (早于 2026-08-05)。`);
    console.log('     ⚠ 那是「没记」不是「零检出」, 也不是「判据够不着」—— 跑一次新的才有这段读数。');
    console.log('     ⚠ 若刚改过引擎却仍然没记: **先怀疑 MCP daemon 跑的是旧代码**, 别先怀疑代码。');
  } else {
    console.log(`   判据够得着的运行 ${cc.recordedRuns} 次${cc.unrecordedRuns > 0 ? ` (另有 ${cc.unrecordedRuns} 次没记这一位, **不进分母**)` : ''}`);
    const fmt = (r: number | null): string => (r === null ? '算不出 (分母 0)' : `${(r * 100).toFixed(1)}%`);
    console.log(`   conductor 面 (output+facts+产物内容): ${cc.conductor.nodes} 节点 / ${cc.conductor.rounds} 轮 → 检出 ${cc.conductor.findings} 条  [${fmt(cc.conductor.rate)}]`);
    console.log(`   flat 面      (output+facts, 不读产物): ${cc.flat.nodes} 节点            → 检出 ${cc.flat.findings} 条  [${fmt(cc.flat.rate)}]`);
    console.log('   ⚠ 两面**不许相加**: 宽度不同 (一个读盘一个不读), 加起来的比例没有意义。');
    // 样本够不够 —— 门槛先于数据钉死 (CLAIM_CHECK_MIN_NODES 上面那段写了为什么是 60)。
    for (const [face, s] of [['conductor', cc.sufficiency.conductor], ['flat', cc.sufficiency.flat]] as const) {
      console.log(
        s.enough
          ? `   ${face.padEnd(9)} 样本**够了** (${s.nodes} ≥ ${CLAIM_CHECK_MIN_NODES} 节点) → 上面那个比例可以当结论读`
          : `   ${face.padEnd(9)} 样本**不足**, 还差 ${s.short} 个节点 (${s.nodes}/${CLAIM_CHECK_MIN_NODES}) → 上面那个比例**不是结论**`,
      );
    }
    if (!cc.sufficiency.conductor.enough && !cc.sufficiency.flat.enough) {
      console.log('     两面都不足 = 现在**还不到拨闸的时候**, 继续被动攒 (正常使用即可, 不必专门发跑)。');
    }
  }
  if (cc.samples.length > 0) {
    console.log(`   检出原句 (前 ${cc.samples.length} 条 —— **拨闸靠逐条读它判是不是误伤**):`);
    for (const smp of cc.samples) console.log(`     · [${smp.runId ?? '无 runId'}] ${smp.message.slice(0, 150)}`);
  }
  console.log('   判据 (写死在这儿, 免得事后编):');
  console.log(`     · **先过样本关**: 该面 ≥ ${CLAIM_CHECK_MIN_NODES} 节点才谈得上读基率 (rule of three:`);
  console.log('       0 检出 / 60 节点 → 真实基率 95% 上界 5%)。不够就是不够, 不许"看着差不多";');
  console.log('     · 活体误伤 = 0 (逐条人工核对) **且** 扩语料全绿 → 才谈得上拨成硬拦;');
  console.log('     · 活体基率 ≈ 0 (真跑里几乎没有伪造声称) → **维持 report-only 是合法结论**,');
  console.log('       那是"这条闸没有值得付的对象", 记下来收尾, 不是拖延。');
  console.log('     ⚠ report-only ≠ 零影响: 三条出口里只有账本是真零影响, judge 视图那一路仍会改判词。');

  console.log(`\n⑨ run 级终止原因 (N5 · 此前这一层只有 plan_name + 一堆节点状态, 没有"这跑怎么结束的")`);
  if (outcomeRecorded === 0) {
    console.log(`   这批 ${rows.length} 条记录**都没记** outcome (早于 2026-07-31) —— 那是「没记」,`);
    console.log('     不是「归不了类」。跑一次新的 dag_run / dag_goal 才有这段读数。');
  } else {
    for (const kind of RUN_OUTCOME_ORDER) {
      const n = outcomeCount[kind];
      if (n === 0) continue;
      const info = RUN_OUTCOME_INFO[kind];
      const bar = '█'.repeat(Math.round((n / outcomeRecorded) * 24));
      const resume = info.resumable === null ? 'resume?' : info.resumable ? '可原样 resume' : '**别原样 resume**';
      console.log(`   ${kind.padEnd(19)} ${String(n).padStart(4)}  ${pct(n / outcomeRecorded).padStart(6)}  ${(info.loopState ?? '—').padEnd(9)} ${resume.padEnd(16)} ${bar}`);
      console.log(`       判据: ${info.evidence}`);
      console.log(`       下一步: ${info.nextAction}`);
      const set = outcomeSamples.get(kind);
      if (set?.size) console.log(`       图: ${[...set].join(', ')}`);
    }
    if (outcomeCount.unclassified > 0) {
      console.log(`   ⚠ **${outcomeCount.unclassified} 跑归不了类** —— 收尾路径里还有一条没交代自己是怎么回事。`);
    }
    if (runsUnrecordedOutcome > 0) {
      console.log(`   ? 另有 ${runsUnrecordedOutcome} 条**没记**终止原因(早于 2026-07-31)—— 老数据, 不是缺陷。`);
    }
    console.log('   判据 (与 ⑦ 分开看, 两段各答各的):');
    console.log('     · blocked 与 not-converged 长期分得开 → G5「触发并被正确读」那半格才算真站住;');
    console.log('     · infra-error 常年占一块 → 该修的是引擎, 不是 prompt (那是五态里此前上层空着的格);');
    console.log('     · 若 99% 都落 not-converged → 这张表在上层是镀金, 该收回去。');
  }

  // ── ⑩ 四轴 ──────────────────────────────────────────────────────────────────
  console.log('\n⑩ score 四轴试算 (N9 · 先在这块板上试, 别急着推 Langfuse)');
  console.log('   四条轴各报各的覆盖度, **不合成总分** —— 合了以后"这条轴没数据"会被别条的数盖住。\n');

  console.log('   判据轴 —— 收敛判据(judge) 与 冻结判据(验收命令) 说的是不是一回事');
  if (critRecorded === 0) {
    console.log(`     ${critRuns.length} 次运行里**没有一次**记了两条判据。`);
    console.log('     成因有两种, 后续动作不同: ① 这些是 dag_run —— 它没有 judge / 冻结判据这两条判据,');
    console.log('     这条轴对它本来就不适用; ② 是 goal 但早于 2026-07-31。跑一次 dag_goal 才有这段读数。');
  } else {
    console.log(`     两条都说成了                  ${String(critAgree).padStart(4)}  ${pct(critAgree / critRecorded)}`);
    console.log(`     judge 说成了·判据没过         ${String(critOracleFailed).padStart(4)}  ${pct(critOracleFailed / critRecorded)}   ← judge 太**松**`);
    console.log(`     judge 说没成·判据却过了       ${String(critWastedRounds).padStart(4)}  ${pct(critWastedRounds / critRecorded)}   ← judge 太**紧**, 白转了几轮`);
    console.log(`     两条都说没成                  ${String(critAgreeFail).padStart(4)}  ${pct(critAgreeFail / critRecorded)}`);
    if (critNoVerif > 0) console.log(`     ? 另有 ${critNoVerif} 次没记两条判据 (dag_run 不适用 / 老数据) —— 不进分母。`);
    console.log('     读法: 中间两格是**对称的两种病**, 而此前只有上面那格有名字 (`oracle-failed`) ——');
    console.log('           于是"judge 太紧"这一侧一直看不见。两格都长期接近 0, judge 才当得起准绳。');
  }
  console.log('\n   效率轴 —— $ / cacheHit / 复用率 / 轮数');
  const allCache = runs.map((r) => r.cacheRate).filter((x): x is number => x !== null);
  const cacheAvg = allCache.length ? allCache.reduce((a, b) => a + b, 0) / allCache.length : null;
  console.log(`     cacheHit (${allCache.length} 跑均值)        ${pct(cacheAvg)}`);
  // 有座位属于**已知不报缓存**的家族时, 这个均值是**系统性偏低**的: `leavesCacheHit` 把"没报"
  // 与"零命中"加在了同一个分子上。不说的话读的人会以为命中率真的这么低, 去优化一个不存在的问题。
  const mutedRuns = runs.filter((r) => [...r.models].some((m) => capsFor(m.split(':').pop() ?? m)?.reportsCacheHit === false));
  if (mutedRuns.length) {
    const coords = [...new Set(mutedRuns.flatMap((r) => [...r.models]).filter((m) => capsFor(m.split(':').pop() ?? m)?.reportsCacheHit === false))];
    console.log(`     ⚠ 其中 ${mutedRuns.length} 跑含**已知不报缓存**的座位 (${coords.join(' · ')}) —— 上面那个均值偏低,`);
    console.log('       它把"这家不报"和"零命中"加进了同一个分子。这半边算不出来是**已知**, 不是引擎漏记。');
  }
  if (pricedRuns > 0) {
    console.log(`     $ 叶子部分 (${pricedRuns} 跑合计)      $${leafUsd.toFixed(4)}   均 $${(leafUsd / pricedRuns).toFixed(4)}/跑`);
  } else {
    console.log('     $ 叶子部分                    —— 没有一跑定得出价');
  }
  const skipped = [
    mixedSeatRuns ? `${mixedSeatRuns} 跑混合座位(usage 是聚合的, 分不到各坐标头上, 硬算等于编账)` : '',
    noCoordRuns ? `${noCoordRuns} 跑没记模型坐标(老数据)` : '',
    unpricedCoordRuns ? `${unpricedCoordRuns} 跑坐标不在价表里` : '',
  ].filter(Boolean);
  if (skipped.length) console.log(`     ? 未计价: ${skipped.join(' · ')}`);
  console.log('     ⚠ 这是**叶子那部分**的钱, 不是整跑的钱 —— conductor 自己不是节点, 它的坐标没记。');
  if (reuseRuns.length > 0) {
    console.log(`     复用率 (${reuseRuns.length} 跑)            ${reusedTotal}/${reuseNodeBase} 节点  ${pct(reuseNodeBase ? reusedTotal / reuseNodeBase : null)}`);
  } else {
    console.log('     复用率                        整批都没记 (2026-07-31 才加的位)');
  }
  if (runsWithLoop > 0) {
    console.log(`     轮数 (${runsWithLoop} 跑 · ${loopJournals} 个内环)  合计 ${roundsTotal} 轮  均 ${(roundsTotal / loopJournals).toFixed(1)} 轮/内环`);
  } else {
    console.log('     轮数                          这批里没有一跑读得到内环 journal (见停止轴末尾的三态)');
  }

  console.log('\n   诚实轴 —— 引擎有没有在报告自己做砸了 / 不知道');
  if (notDoneNodes === 0) {
    console.log('     这批记录里没有一个没过的节点 —— 分母是 0, 这两个率**算不出来**(不是 0%)。');
  } else {
    console.log(`     empty-artifact                ${String(emptyArtifact).padStart(4)}/${notDoneNodes}  ${pct(emptyArtifact / notDoneNodes)}   谎报完工被产物闸抓住`);
    console.log(`     节点级 unclassified           ${String(nodeUnclassified).padStart(4)}/${notDoneNodes}  ${pct(nodeUnclassified / notDoneNodes)}   归因面自己的洞`);
  }
  console.log(`     run 级 unclassified           ${String(runUnclassified).padStart(4)}${outcomeRecorded ? `/${outcomeRecorded}  ${pct(runUnclassified / outcomeRecorded)}` : ''}`);
  console.log('     读法: 两个 unclassified 是**缺陷计数**不是分布 —— 它们该趋近 0, 不该"稳定在某个比例"。');

  console.log('\n   停止轴 —— blocked 与 not-converged 分不分得开 (= G5 的后半句)');
  console.log(`     blocked        ${String(stopBlocked).padStart(4)}`);
  console.log(`     not-converged  ${String(stopNotConverged).padStart(4)}`);
  if (outcomeRecorded === 0) {
    console.log('     整批都没记终止原因 —— 这条轴今天读不出来。');
  } else if (stopSeparable) {
    console.log('     → 两格都有量: 这个区分在生产上**兑现了**。');
  } else {
    console.log('     → 有一格恒为 0: 区分**还没在生产上兑现**。判据不是"两个数都非零"那么松 ——');
    console.log('       只要一格空着, 「blocked 被念成 not-converged」这条就还没被证伪。');
  }
  console.log('');
  console.log('     内环那一层 (NodeLoopJournal.stop) —— 从 continuity journal 读:');
  if (loopStopRecorded === 0) {
    console.log(`       ${loopJournals} 个内环里没有一个记了 stop` + (loopJournalsNoStop ? ` (${loopJournalsNoStop} 个是早于 N6 的老 journal)` : ''));
  } else {
    for (const [kind, n] of [...loopStopCount].sort((a, b) => b[1] - a[1])) {
      const sample = loopStopSamples.get(kind)!;
      console.log(`       ${kind.padEnd(18)} ${String(n).padStart(3)}  ${pct(n / loopStopRecorded)}  停在第 ${sample.atRound} 轮`);
      console.log(`         判词原文: ${sample.evidence.slice(0, 96)}${sample.evidence.length > 96 ? '…' : ''}`);
    }
    if (loopJournalsNoStop > 0) console.log(`       ? 另有 ${loopJournalsNoStop} 个内环没记 stop (早于 N6) —— 不算进分母。`);
    console.log('       ★ 这一层与 run 级的 blocked/not-converged **是同一套词表** (N6 刻意借的 N5 词表) ——');
    console.log('         两层若长期说不同的话, 那本身就是读数: 环里判 blocked 而整跑报 not-converged,');
    console.log('         正是 N5 治的那个病在下一层复发。');
  }
  console.log(`       覆盖: ${runsWithLoop} 跑读到了内环 · ${runsNoLoopData} 跑读不到`);
  console.log('       ⚠ "读不到"是**合并格**: 这次没有带内环的节点(最常见, 不是缺陷) / journal 目录被清了');
  console.log('         两者在这块板上分不开 —— 留痕库永久而 journal 跟着 .omd/continuity 走。不假装分得清。');

  printReadoutHuman(contract, dbPath);
  console.log(`\n诚实边界: 本板读**两处** —— 留痕库 (永久) + continuity journal (跟着 .omd/continuity 走,`);
  console.log(`清掉就没了)。**它算不出的**: 单节点耗时 (没记)、judge 判词原文 (只存了停止那一条)、`);
  console.log(`conductor 那部分的 $ (它不是节点, 坐标没记 —— ⑩ 里算的是叶子那部分)。`);
  console.log(`不要因为这里没有就当它不存在 —— 那是 \`Unobserved\` 不是 \`Missing\`。\n`);

  db.close();
}


function parseFlags(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[key] = next;
      i++;
    } else out[key] = true;
  }
  return out;
}
