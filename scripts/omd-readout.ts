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
import type { DagRunNode } from '../src/harness/dag-record';

interface Row {
  id: string;
  created_at: number;
  plan_name: string;
  node_count: number;
  run_id: string | null;
  nodes: string;
  usage: string;
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

const rows = db
  .query(`SELECT id, created_at, plan_name, node_count, run_id, nodes, usage FROM omd_dag_runs ORDER BY created_at DESC LIMIT ?`)
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
  };
  cur.plans.push(r.plan_name);
  cur.nodes += r.node_count;
  cur.leavesIn += u.leavesIn;
  cur.leavesOut += u.leavesOut;
  cur.cacheHit += u.leavesCacheHit;
  cur.failed += nodes.filter((n) => n.status === 'failed').length;
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
    if (tier === 'never' && n.status !== 'done') neverButBlocked++;
    const s = tierSamples.get(tier) ?? new Set<string>();
    if (s.size < 5) s.add(`${n.status === 'done' ? '' : '[闸已拒] '}${n.command.length > 60 ? `${n.command.slice(0, 57)}…` : n.command}`);
    tierSamples.set(tier, s);
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

// ── ③ 单轮成本异常 (§8.6): 偏离历史中位数 N 倍 ────────────────────────────────
// 用中位数而非均值: 一次异常本身会把均值抬起来, 于是"异常"检测不出下一次异常。
const ANOMALY_FACTOR = Number(flags.factor ?? 3);
const leafIns = runs.map((r) => r.leavesIn).filter((n) => n > 0).sort((a, b) => a - b);
const median = leafIns.length ? leafIns[Math.floor(leafIns.length / 2)]! : 0;
const anomalies = median > 0 ? runs.filter((r) => r.leavesIn > median * ANOMALY_FACTOR) : [];

if (flags.json) {
  console.log(
    JSON.stringify(
      { dbPath, runs, tierCount, neverButBlocked, commandNodes, writeNodes, unreported, totalWrites, totalNoop, noopNodes, median, anomalyFactor: ANOMALY_FACTOR, anomalies },
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
  const neverAndRan = tierCount.never - neverButBlocked;
  if (neverButBlocked > 0) {
    console.log(`   ℹ never 里有 ${neverButBlocked} 条是**闸正确拒掉**的(节点非 done)—— 系统在干活, 不是缺陷。`);
  }
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

console.log(`\n诚实边界: 本板只读留痕库。**它算不出的**: 单节点耗时 (没记)、$ (只有 token,`);
console.log(`价目表在模型侧)、judge 判词、轮数 (在 _loop-<nodeId>.json 里, 不在这张表)。`);
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
