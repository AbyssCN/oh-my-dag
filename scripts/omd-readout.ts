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
        nearMiss: nearMiss.map(([h, c]) => ({ outputHash: h, commands: [...c] })), exactRepeat, writeNodes, unreported, totalWrites, totalNoop, noopNodes, median, anomalyFactor: ANOMALY_FACTOR, anomalies },
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
