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
 * ## 跑法
 *
 *   bun run scripts/omd-readout.ts                      # 默认 .omd/dag-runs.db, 最近 20 次运行
 *   bun run scripts/omd-readout.ts --db <path> --limit 50
 *   bun run scripts/omd-readout.ts --json               # 机器可读 (给以后的 A/B 用)
 */
import { Database } from 'bun:sqlite';
import { commandRiskTier, RISK_TIER_ORDER, type CommandRiskTier } from '../src/harness/command-leaf';
import { computeCost } from '../src/model/cost-ledger';
import { CheckpointManager } from '../src/harness/continuity/checkpoint-manager';
import type { NodeLoopJournal } from '../src/harness/continuity/types';
import type { DagRunNode } from '../src/harness/dag-record';
import { FAILURE_KIND_INFO, FAILURE_KIND_ORDER, type NodeFailureKind } from '../src/harness/node-failure';
import { RUN_OUTCOME_INFO, RUN_OUTCOME_ORDER, type RunOutcomeKind } from '../src/harness/run-outcome';

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

const flags = parseFlags(Bun.argv.slice(2));
const dbPath = String(flags.db ?? '.omd/dag-runs.db');
const limit = Number(flags.limit ?? 20);

let db: Database;
try {
  db = new Database(dbPath, { readonly: true });
} catch (e) {
  console.error(`读不到留痕库 ${dbPath} — ${(e as Error).message}`);
  console.error('（还没跑过带 runId 的 dag_run / dag_goal 就是空的，这不是错误。）');
  process.exit(1);
}

// 老库没有 observations / outcome 列 → 整条 SELECT 会崩。列在不在是**运行期事实**, 查一次 pragma
// 再拼 (缺的那列补 NULL —— 正是"这批记录没记"那一格, 与"记了但是空的"分开数)。
const haveCols = (db.query(`PRAGMA table_info(omd_dag_runs)`).all() as { name: string }[]).map((c) => c.name);
const optionalCol = (name: string) => (haveCols.includes(name) ? `, ${name}` : `, NULL AS ${name}`);
const rows = db
  .query(
    `SELECT id, created_at, plan_name, node_count, run_id, nodes, usage${optionalCol('observations')}${optionalCol('outcome')}${optionalCol('verification')}${optionalCol('reused')}` +
      ` FROM omd_dag_runs ORDER BY created_at DESC LIMIT ?`,
  )
  .all(limit * 3) as Row[]; // ×3: 一次 goal 最多两条, 留余量再按 runId 截

if (rows.length === 0) {
  console.log(`留痕库 ${dbPath} 里一条记录都没有。`);
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
// ⚠ 一半早就在 ⑨ 的词表里: `oracle-failed` 的定义就是「judge 判收敛, 而环外冻结判据没过」。
//   缺的是**反方向** —— judge 判未收敛而验收其实过了 (= 白转了几轮), 那格靠 `verification` 列才看得见。
let critAgree = 0;          // success: 两者都说好
let critOracleFailed = 0;   // judge 说收敛, 判据没过 (词表已有格)
let critWastedRounds = 0;   // judge 说没收敛, 判据却过了 (**新列才看得见**)
let critOtherWithVerif = 0; // 其余终止原因 + 记了 verification
let critNoVerif = 0;        // 没记 verification (老行, 或这次压根没跑验收)
for (const r of rows) {
  if (r.verification === null) {
    critNoVerif++;
    continue;
  }
  const v = JSON.parse(r.verification) as { pass: boolean };
  if (r.outcome === 'success') critAgree++;
  else if (r.outcome === 'oracle-failed') critOracleFailed++;
  else if (r.outcome === 'not-converged' && v.pass) critWastedRounds++;
  else critOtherWithVerif++;
}
const critRecorded = rows.length - critNoVerif;

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
const ANOMALY_FACTOR = Number(flags.factor ?? 3);
const leafIns = runs.map((r) => r.leavesIn).filter((n) => n > 0).sort((a, b) => a - b);
const median = leafIns.length ? leafIns[Math.floor(leafIns.length / 2)]! : 0;
const anomalies = median > 0 ? runs.filter((r) => r.leavesIn > median * ANOMALY_FACTOR) : [];

if (flags.json) {
  console.log(
    JSON.stringify(
      { dbPath, runs, tierCount, neverButBlocked, neverAndRan, neverUnknown, gateRejections, commandNodes, conductorChildren, detectorNodes,
        nearMiss: nearMiss.map(([h, c]) => ({ outputHash: h, commands: [...c] })), exactRepeat, writeNodes, unreported, totalWrites, totalNoop, noopNodes, median, anomalyFactor: ANOMALY_FACTOR, anomalies,
        notDoneNodes, failureKindCount, failureKindUnrecorded,
        observations: Object.fromEntries(obsCount), runsWithObs, runsUnrecordedObs,
        outcomeCount, runsUnrecordedOutcome, outcomeRecorded,
        axes: {
          criteria: { agree: critAgree, oracleFailed: critOracleFailed, wastedRounds: critWastedRounds, other: critOtherWithVerif, unrecorded: critNoVerif, recorded: critRecorded },
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
  console.log(`     整批 ${rows.length} 条**都没记** verification —— 这一位是 2026-07-31 才加的。`);
  console.log('     跑一次新的 dag_run / dag_goal 才有这段读数。');
} else {
  console.log(`     两者一致 (success)            ${String(critAgree).padStart(4)}  ${pct(critAgree / critRecorded)}`);
  console.log(`     judge 说收敛·判据没过         ${String(critOracleFailed).padStart(4)}  ${pct(critOracleFailed / critRecorded)}   ← 判据说了不算`);
  console.log(`     judge 说没收敛·判据却过了     ${String(critWastedRounds).padStart(4)}  ${pct(critWastedRounds / critRecorded)}   ← 白转了几轮`);
  console.log(`     其余终止原因                  ${String(critOtherWithVerif).padStart(4)}  ${pct(critOtherWithVerif / critRecorded)}`);
  if (critNoVerif > 0) console.log(`     ? 另有 ${critNoVerif} 条没记 verification (老行 / 这次没跑验收) —— 不算进上面的分母。`);
  console.log('     读法: 中间两格**加起来**才是「收敛判据可不可信」的答案。两格长期都接近 0 →');
  console.log('           judge 可以当准绳; 任一格常年有量 → 那一侧的判据得改, 而不是加轮数。');
}

console.log('\n   效率轴 —— $ / cacheHit / 复用率 / 轮数');
const allCache = runs.map((r) => r.cacheRate).filter((x): x is number => x !== null);
const cacheAvg = allCache.length ? allCache.reduce((a, b) => a + b, 0) / allCache.length : null;
console.log(`     cacheHit (${allCache.length} 跑均值)        ${pct(cacheAvg)}`);
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

console.log(`\n诚实边界: 本板读**两处** —— 留痕库 (永久) + continuity journal (跟着 .omd/continuity 走,`);
console.log(`清掉就没了)。**它算不出的**: 单节点耗时 (没记)、judge 判词原文 (只存了停止那一条)、`);
console.log(`conductor 那部分的 $ (它不是节点, 坐标没记 —— ⑩ 里算的是叶子那部分)。`);
console.log(`不要因为这里没有就当它不存在 —— 那是 \`Unobserved\` 不是 \`Missing\`。\n`);

db.close();

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
