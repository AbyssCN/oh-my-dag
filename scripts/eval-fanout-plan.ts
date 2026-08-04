#!/usr/bin/env bun
/**
 * eval-fanout-plan —— **引擎自己拆的图 vs 人拆的图**(FanOutQA 结构探针, 2026-08-05)。
 *
 * 交接 21 §七.0 的第一步:换尺子之后最便宜的那半 —— 只打 conductor 那一发,
 * **不跑执行、不下载语料、不用 judge**。为什么值钱见 `src/eval/tasks/fanoutqa/plan-shape.ts` 顶注:
 * 端到端读数分不开"拆错了"与"执行掉链子", 拆解那层单独量就分得开。
 *
 * ## 假设与判据(**动手前写死**, 仓规 Q4/四要素)
 *
 * H1: 在"先列清单、再逐实体查"的题上(FanOutQA 的全部形状), conductor 会选**运行时扇出**
 *     (`executor:'map'` 或 `'conductor'`), 而不是塌成单节点、串成链、或在规划期把实体名编出来。
 *
 * - **单一变量**: 只换任务文本(逐题), 座位/prompt 档/thinking 全用生产默认, 一次只跑一个座位。
 * - **成败信号**(五格分类见 plan-shape.ts):
 *     · H1 成立 = `runtime-fanout` ≥ **60%**
 *     · H1 塌   = `runtime-fanout` < **30%** 且 `static-parallel-unbound`/`collapsed` 占多数
 *     · 30–60% = **没读判据**, 只记读数不下结论(仓规: 别把没读判词当噪声)
 * - **对照基线**: 同一批题的金标形状(宽 mean 5.52 / 深 2, `--stats` 已量)。
 *     ⚠ **组内对照跑不成**: 本想用"需求 ≤2 那档"当对照(那里本不该扇出), 实测 dev 310 题里
 *     这样的只有 3 道 —— **FanOutQA 内部没有窄端**(经过见 plan-shape.ts 的 DEMAND_BUCKETS)。
 *     于是"它是不是总画 map"这个反问**本批答不了**, 只能靠窄档数据集(2Wiki `comparison`)另跑。
 * - **下一步收什么**: 不塌 → 进端到端(同一份 `fanoutTaskText`, 两臂同工具);
 *     塌 → 缺陷定位在**规划期**, 端到端先别跑(跑了也只是在量一个已知拆错的图)。
 *
 * ## ⚠ 四条诚实边界(照实写, 别让读者以为量的是全流程)
 *
 * 1. **只打首次规划那一发**, 不含 g1 档位闸拒回重问、不含 escalation 补丁轮。闸**会不会**拒
 *    仍逐题记下来(`g1闸` 列)—— 那正好是交接 21 §七.4 攒着的"g1 闸拒回率"。
 * 2. **不判答案对不对**, 只判图的形状。图对答案错是完全可能的, 反之亦然。
 * 3. 分类只读 `executor` 与 `depends_on`, **不读 goal 文本** —— 一个节点的 goal 里写没写实体名
 *    要靠词法猜, 那种判据自带噪声(本仓已在代理指标上栽过)。
 *    **代价明写**: `static-parallel-unbound` 那一格因此同时装着"编实体名"与"多视角并行调研"
 *    两种货, 结构分不开(见 plan-shape.ts 的那节)。要分得人读原始 plan。
 * 4. **无对照组**(见上)。所以本批只回答"它在宽题上用不用运行时扇出", **回答不了**
 *    "它是不是不分青红皂白都用"。
 *
 * 跑: bun --env-file=.env run scripts/eval-fanout-plan.ts [--n 20] [--seed S] [--concurrency 4]
 */
import '../src/harness/script-bootstrap';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bootstrapModelRuntime } from '../src/model/bootstrap';
import { send } from '../src/model/gateway';
import { conductorSystemPrompt, parsePlan, PLAN_BOUNDARY, type ConductorPlan } from '../src/harness/conductor-plan';
import { leafTierGateFindings } from '../src/harness/plan/leaf-tier-gate';
import { tryResolveSeatModel } from '../src/model/role-models';
import { dagShape, fanoutDemand, scoringPoints, type FanOutQuestion } from '../src/eval/tasks/fanoutqa/gold-dag';
import {
  bucketOf,
  classifyPlanShape,
  tally,
  DEMAND_BUCKETS,
  type PlanShapeClass,
} from '../src/eval/tasks/fanoutqa/plan-shape';
import { fanoutTaskText } from '../src/eval/tasks/fanoutqa/task-text';

const argv = process.argv.slice(2);
const opt = (n: string): string | undefined => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const N = Math.max(1, Number(opt('n') ?? '20'));
const SEED = Number(opt('seed') ?? '20260805');
const CONCURRENCY = Math.max(1, Number(opt('concurrency') ?? '4'));
const OUT = opt('out') ?? '.omd/eval/fanout-plan-shape';

// 座位解析不硬编码 (seat-sourced 闸): 这一发打的是**生产 conductor 座**, 换了座位读数就换了地基。
const conductorSeat = tryResolveSeatModel('conductor');
const SEAT = opt('model') ?? conductorSeat?.model;
if (!SEAT) {
  process.stderr.write('eval-fanout-plan: `conductor` 座位解析不出模型, 且没给 --model\n');
  process.exit(2);
}
/** 「这个读数属于哪个座位」的唯一凭据 —— 起跑打一次 + 写进 report.md (seat-provenance 闸)。 */
const SEAT_PROVENANCE = opt('model') ? ' (--model 覆盖)' : ` (conductor 座 · 来源 ${conductorSeat?.source})`;

const DATA = join(import.meta.dir, '..', 'src', 'eval', 'tasks', 'fanoutqa', 'data', 'fanout-final-dev.json');
const log = (s: string): void => void process.stderr.write(s + '\n');

/** 确定性洗牌 (同 seed 同结果 —— 不写 seed 的抽样等于没抽)。 */
function shuffled<T>(xs: readonly T[], seed: number): T[] {
  let s = seed >>> 0;
  const rnd = (): number => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/**
 * **按扇出需求分层抽样**(轴见 gold-dag.ts 的 `fanoutDemand`,分档理由见 plan-shape.ts 的
 * `DEMAND_BUCKETS` —— 那里记着"我本来想用金标宽度、跑第一题就发现它量的是人写得多细")。
 * 均匀随机抽会有 ~57% 落进需求 5-7 主峰, 两头各只占个位数。
 */
function stratify(qs: readonly FanOutQuestion[], n: number, seed: number): FanOutQuestion[] {
  const per = Math.max(1, Math.floor(n / DEMAND_BUCKETS.length));
  const picked: FanOutQuestion[] = [];
  const pool = shuffled(qs, seed);
  for (const b of DEMAND_BUCKETS) {
    picked.push(...pool.filter((q) => {
      const d = fanoutDemand(q);
      return d >= b.lo && d <= b.hi;
    }).slice(0, per));
  }
  // 分档取不满(小档题少)时用剩余池补齐, 免得 --n 20 悄悄变成 17。
  const have = new Set(picked.map((q) => q.id));
  for (const q of pool) {
    if (picked.length >= n) break;
    if (!have.has(q.id)) picked.push(q);
  }
  return picked.slice(0, n);
}

interface Row {
  id: string;
  question: string;
  goldWidth: number;
  goldDepth: number;
  goldNodes: number;
  /** 答案里的独立实体数(dict 键 / list 长度 / 标量 = 1)。 */
  answerKeys: number;
  /** 内在扇出需求下界 = max(goldWidth, answerKeys) —— 分档轴,理由见 gold-dag.fanoutDemand。 */
  demand: number;
  bucket: string;
  cls: PlanShapeClass | 'parse-failed';
  planNodes: number;
  planWidth: number;
  planDepth: number;
  runtimeFanoutNodes: string[];
  /** g1 leaf 档位闸**会不会**拒这张 plan(本探针不重问, 只记 —— 交接 21 §七.4 攒的那个数)。 */
  gateWouldReject: boolean;
  gateMessages: string[];
  parseError?: string;
}

async function planOnce(task: string): Promise<{ plan: ConductorPlan | null; raw: string; err?: string }> {
  // 与 planAndExecute 第 1 步逐字同源: 系统 prompt 走 'full' 档(生产默认), 用户消息 = 边界 + 任务。
  const sys = conductorSystemPrompt({ profile: 'full' });
  const r = await send({
    model: SEAT!,
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: `${PLAN_BOUNDARY}${task}` },
    ],
    thinkingLevel: 'high',
    maxTokens: 32_768,
  });
  const text = r.text ?? '';
  const parsed = parsePlan(text, { knownTemplates: new Set() });
  return parsed.ok ? { plan: parsed.plan, raw: text } : { plan: null, raw: text, err: parsed.error };
}

/**
 * 断点续跑 —— **一发 conductor 实测 ~7 分钟**(gpt-5.6-sol · thinking high), 20 题一批跑半小时。
 * 中途挂掉就整批重来的代价太高, 而每题的原始 plan 本来就逐题落盘了。
 *
 * ⚠ **缓存必须带座位**: 复用一份别的座位画的 plan, 报告上却写着当前座位, 那就是本仓
 * 「读数量在一个生产上不存在的座位上」那条老账的自动化版。座位不符 → 当没有缓存, 重打。
 * `--fresh` 强制全部重打。
 */
function cached(id: string): { plan: ConductorPlan | null; raw: string; err?: string } | null {
  if (argv.includes('--fresh')) return null;
  try {
    const j = JSON.parse(readFileSync(`${OUT}/${id}.json`, 'utf8')) as {
      seat?: string; raw?: string; plan?: ConductorPlan | null; parseError?: string;
    };
    if (j.seat !== SEAT) return null; // 含 seat 缺席(旧格式): 来源不可考 → 不复用
    if (typeof j.raw !== 'string') return null;
    return { plan: j.plan ?? null, raw: j.raw, ...(j.parseError ? { err: j.parseError } : {}) };
  } catch {
    return null; // 文件不存在/坏了都当没缓存 —— 这里的 fail-open 不吞证据(重打会留新证据)
  }
}

async function main(): Promise<void> {
  bootstrapModelRuntime();
  mkdirSync(OUT, { recursive: true });
  const dev = JSON.parse(readFileSync(DATA, 'utf8')) as FanOutQuestion[];
  const picked = stratify(dev, N, SEED);
  log(`跑 ${picked.length} 题 (分层抽样 seed ${SEED}, 并发 ${CONCURRENCY}) · 座位 ${SEAT}${SEAT_PROVENANCE}…`);

  const rows: Row[] = [];
  let cursor = 0;
  /** 复用了几题的旧 plan —— **必须进报告**: 缓存来源不写, 读者就分不清这批读数打了几发新的。 */
  let fromCache = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, picked.length) }, async () => {
      for (;;) {
        const i = cursor++;
        if (i >= picked.length) return;
        const q = picked[i]!;
        const gold = dagShape(q.decomposition ?? []);
        const demand = fanoutDemand(q);
        const base = {
          id: q.id,
          question: q.question,
          goldWidth: gold.width,
          goldDepth: gold.depth,
          goldNodes: gold.nodes,
          answerKeys: scoringPoints(q.answer),
          demand,
          bucket: bucketOf(demand),
        };
        try {
          const hit = cached(q.id);
          const { plan, raw, err } = hit ?? (await planOnce(fanoutTaskText(q.question)));
          if (hit) fromCache++;
          writeFileSync(
            `${OUT}/${q.id}.json`,
            JSON.stringify({ ...base, seat: SEAT, raw, plan, ...(err ? { parseError: err } : {}) }, null, 1),
          );
          if (!plan) {
            rows.push({ ...base, cls: 'parse-failed', planNodes: 0, planWidth: 0, planDepth: 0, runtimeFanoutNodes: [], gateWouldReject: false, gateMessages: [], parseError: err });
          } else {
            const v = classifyPlanShape(plan);
            const findings = leafTierGateFindings(plan);
            rows.push({
              ...base,
              cls: v.cls,
              planNodes: v.shape.nodes,
              planWidth: v.shape.width,
              planDepth: v.shape.depth,
              runtimeFanoutNodes: v.runtimeFanoutNodes,
              gateWouldReject: findings.length > 0,
              gateMessages: findings.map((f) => f.message),
            });
          }
          const r = rows[rows.length - 1]!;
          log(`  [${rows.length}/${picked.length}] 需求${r.demand} → ${r.cls} (引擎 ${r.planNodes} 节点/宽 ${r.planWidth}/深 ${r.planDepth})${r.gateWouldReject ? ' ⚠g1闸拒' : ''}${hit ? ' [缓存]' : ''}`);
        } catch (e) {
          // fail-open 可以吞异常, 不许吞证据 (仓规 3.2): 题号 + 错误原文都留下, 且计入分母。
          const msg = e instanceof Error ? e.message : String(e);
          rows.push({ ...base, cls: 'parse-failed', planNodes: 0, planWidth: 0, planDepth: 0, runtimeFanoutNodes: [], gateWouldReject: false, gateMessages: [], parseError: `调用失败: ${msg}` });
          log(`  ✘ ${q.id}: ${msg}`);
        }
      }
    }),
  );

  // ── 报告 ────────────────────────────────────────────────────────────────
  const ok = rows.filter((r) => r.cls !== 'parse-failed');
  const t = tally(ok.map((r) => ({ cls: r.cls as PlanShapeClass })));
  const pct = (a: number, b: number): string => (b === 0 ? '—' : `${Math.round((a / b) * 100)}%`);
  const runtimeRate = ok.length === 0 ? 0 : t['runtime-fanout'] / ok.length;
  // **判据在跑之前就写死了**(见文件头), 这里只是把读数往上一贴, 不许事后改线。
  const verdict =
    runtimeRate >= 0.6
      ? '**H1 成立**(runtime-fanout ≥ 60%)'
      : runtimeRate < 0.3 && t['static-parallel-unbound'] + t.collapsed > ok.length / 2
        ? '**H1 塌**(< 30% 且编清单/塌缩占多数)'
        : '**没读判据**(落在 30–60% 中间带, 或塌的形态不符)—— 记读数, 不下结论';

  const lines: string[] = [
    '',
    '# 引擎的 plan vs FanOutQA 金标 DAG(规划期结构探针)',
    '',
    `座位 \`${SEAT}\`${SEAT_PROVENANCE} · ${picked.length} 题(分层抽样 seed ${SEED}) · 只打首次规划那一发, 不跑执行`,
    `本次新打 ${picked.length - fromCache} 发 · 复用同座位旧 plan ${fromCache} 题(\`--fresh\` 全部重打)`,
    '',
    `## 判定: ${verdict}`,
    '',
    `runtime-fanout ${t['runtime-fanout']}/${ok.length} (${pct(t['runtime-fanout'], ok.length)})`,
    `${rows.length - ok.length} 题没产出有效 plan(计入分母之外, 逐题见下表 parseError)`,
    '',
    '## 分类分布',
    '',
    '| 格 | 题数 | 占比 |',
    '|---|---|---|',
  ];
  for (const [k, v] of Object.entries(t)) lines.push(`| \`${k}\` | ${v} | ${pct(v, ok.length)} |`);

  lines.push(
    '',
    '## 按扇出需求分档(轴 = max(金标宽, 答案键数), 理由见 gold-dag.fanoutDemand)',
    '',
    '⚠ 窄端那一档在 FanOutQA dev 全集里只有 3 题 —— **这个 benchmark 内部没有对照端**,',
    '窄档只能从 2Wiki `comparison` 来(交接 21 §五之三)。空档照样打印, 让"这里是空的"看得见。',
    '',
    '| 档 | 题数 | runtime-fanout | 引擎静态宽 mean | 需求 mean |',
    '|---|---|---|---|---|',
  );
  for (const b of DEMAND_BUCKETS) {
    const g = ok.filter((r) => r.bucket === b.label);
    if (g.length === 0) {
      lines.push(`| ${b.label} | 0 | — | — | — |`); // 空档也留行: 缺席 ≠ 0% (NULL≠0)
      continue;
    }
    const rf = g.filter((r) => r.cls === 'runtime-fanout').length;
    const mean = (xs: number[]): string => (xs.reduce((a, c) => a + c, 0) / xs.length).toFixed(2);
    lines.push(`| ${b.label} | ${g.length} | ${rf} (${pct(rf, g.length)}) | ${mean(g.map((r) => r.planWidth))} | ${mean(g.map((r) => r.demand))} |`);
  }

  // ── 规模响应: 题变宽的时候, 图跟着长吗 ──────────────────────────────────────
  //
  // 这一段比上面的分类占比更值钱, 因为它**自带阳性对照**: 同一批题、同一根轴,
  // 金标节点数与需求的相关系数就是"这根轴确实载得动信号"的证明。
  // 若金标那条高而引擎那条平, 差别就不可能是"轴不好"—— 只能是引擎不随需求长。
  // (承交接 21 §七.2: 别拿总分比, 要用分项的**定向**判据。)
  const corr = (xs: number[], ys: number[]): number => {
    const n = xs.length;
    if (n < 3) return Number.NaN; // 太少不算, 免得 2 个点永远给出 ±1
    const mx = xs.reduce((a, b) => a + b, 0) / n;
    const my = ys.reduce((a, b) => a + b, 0) / n;
    const cov = xs.reduce((a, x, i) => a + (x - mx) * (ys[i]! - my), 0);
    const sx = Math.sqrt(xs.reduce((a, x) => a + (x - mx) ** 2, 0));
    const sy = Math.sqrt(ys.reduce((a, y) => a + (y - my) ** 2, 0));
    return sx === 0 || sy === 0 ? Number.NaN : cov / (sx * sy);
  };
  const dem = ok.map((r) => r.demand);
  const fmt = (v: number): string => (Number.isNaN(v) ? '—' : v.toFixed(3));
  const meanOf = (xs: number[]): string => (xs.length ? (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2) : '—');
  lines.push(
    '',
    '## 规模响应: 题变宽的时候, 图跟着长吗',
    '',
    '| 与「扇出需求」的相关系数 | r | 读法 |',
    '|---|---|---|',
    `| **金标节点数**(阳性对照) | ${fmt(corr(dem, ok.map((r) => r.goldNodes)))} | 人的图随需求长 → **这根轴载得动信号** |`,
    `| 引擎 plan 节点数 | ${fmt(corr(dem, ok.map((r) => r.planNodes)))} | |`,
    `| 引擎 plan 静态宽 | ${fmt(corr(dem, ok.map((r) => r.planWidth)))} | |`,
    '',
    `需求 mean ${meanOf(dem)}(range ${Math.min(...dem)}–${Math.max(...dem)}) · ` +
      `引擎节点数 mean ${meanOf(ok.map((r) => r.planNodes))} · 引擎静态宽 mean ${meanOf(ok.map((r) => r.planWidth))} · ` +
      `金标节点数 mean ${meanOf(ok.map((r) => r.goldNodes))}`,
    '',
    '⚠ 每题只规划**一次**, 没有重复采样 → **没有方差估计**(交接 21 §五之一那条死穴)。',
    '阳性对照高而引擎那条平/负, 是"值得当假设"的强度, 不是"已证实"的强度。',
    '要坐实: 同题重复 ≥3 次规划再看 r 的分布。',
  );

  const gateHits = ok.filter((r) => r.gateWouldReject).length;
  lines.push('', `## g1 leaf 档位闸(顺手攒的数, 本探针只记不重问)`, '', `会被拒的 plan: ${gateHits}/${ok.length} (${pct(gateHits, ok.length)})`);

  lines.push('', '## 逐题', '', '| 题 | 需求 (宽/键) | 金标 宽/深/节点 | 引擎 宽/深/节点 | 格 | g1闸 |', '|---|---|---|---|---|---|');
  for (const r of rows.sort((a, b) => a.demand - b.demand)) {
    lines.push(
      `| \`${r.id.slice(0, 8)}\` ${r.question.slice(0, 60)}${r.question.length > 60 ? '…' : ''} | **${r.demand}** (${r.goldWidth}/${r.answerKeys}) | ${r.goldWidth}/${r.goldDepth}/${r.goldNodes} | ${r.planWidth}/${r.planDepth}/${r.planNodes} | \`${r.cls}\`${r.parseError ? ` (${r.parseError.slice(0, 40)})` : ''} | ${r.gateWouldReject ? '拒' : '过'} |`,
    );
  }

  const report = lines.join('\n');
  writeFileSync(`${OUT}/report.md`, report + '\n');
  writeFileSync(`${OUT}/rows.json`, JSON.stringify(rows, null, 1));
  console.log(report);
  log(`\n原始 plan 与逐题读数落在 ${OUT}/`);
}

await main();
