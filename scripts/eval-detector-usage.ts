/**
 * eval-detector-usage —— **conductor 会不会自发标 `detector`** (P3 D-Q, 2026-07-30)。
 *
 * 为什么要量这个: `detector` 是当天被迫进 conductor 明示形状的 —— 它只在 conductor 自己画的
 * 子图里有消费者, 而子图只有 conductor 画得出来, 不告诉它就等于没有生产者。**明示是手段不是
 * 目的**: 目的是"该用的时候真被用上"。而第一次 live 撞见的恰恰是反例 —— conductor 画出了正确的
 * fan-in 检查节点却**没标**那个字段, 于是它的判断照旧落不进环。
 *
 * 量法: 只打**展开那一次调用** (runConductorRound 的第 1 步), 不跑执行 —— 要量的是规划行为,
 * 跑执行只是给同一个读数加钱和噪声。三个数:
 *   - **使用率** (worthy 组): 该用的时候标了 `detector: true` 的比例;
 *   - **滥用率** (control 组): 不该用却标了的比例 (每张图多一个节点 = 多一次调用);
 *   - **形状率**: 画出了 fan-in 检查节点的比例 —— 它与使用率的**差**就是"形状对了但字段没标",
 *     也就是第一次 live 撞见的那个缺口。这个差比使用率本身更能说明该改什么:
 *     形状率高而使用率低 = prompt 位置/措辞的问题; 两个都低 = conductor 根本没想到要交叉检查。
 *
 * ⚠ 简化 (记账): 展开调用的真实 user 消息还含上游输出与上一轮失败原因, 这里只给 goal + 那句
 * 「不得再用 conductor/map」。测的是**第一轮、无上游**那种展开 —— 也是最常见的一种。
 *
 * 跑: bun --env-file=.env run scripts/eval-detector-usage.ts [--n 3] [--concurrency 4]
 */
import '../src/harness/script-bootstrap';
import { mkdirSync, writeFileSync } from 'node:fs';
import { bootstrapModelRuntime } from '../src/model/bootstrap';
import { send } from '../src/model/gateway';
import { conductorSystemPrompt, parsePlan, PLAN_BOUNDARY, type ConductorPlan } from '../src/harness/conductor-plan';
import { DETECTOR_GOAL_CASES, type DetectorGoalCase } from '../src/eval/tasks/detector-goals';
import { tryResolveSeatModel } from '../src/model/role-models';

const argv = process.argv.slice(2);
const opt = (n: string): string | undefined => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const N = Math.max(1, Number(opt('n') ?? '3'));
const CONCURRENCY = Math.max(1, Number(opt('concurrency') ?? '4'));
const OUT = opt('out') ?? '.omd/eval/detector-usage';
// 座位解析, **不硬编码** (2026-08-03 修, 与 eval-judge-artifacts 同一族缺陷):
// 变量名写着 CONDUCTOR_SEAT, 值却曾是 `deepseek:deepseek-v4-pro` —— 而生产 conductor 座
// 当时是 `openai-codex:gpt-5.6-sol`。⚠ 后果不止"标签错": **detector 那条 60% 天花板的基线
// 是在 v4-pro 上量的, 不是在生产 conductor 上**, 而 G6 换座位实验正要拿它当对照。
const conductorSeat = tryResolveSeatModel('conductor');
const CONDUCTOR_SEAT = opt('model') ?? conductorSeat?.model;
if (!CONDUCTOR_SEAT) {
  process.stderr.write('eval-detector-usage: `conductor` 座位解析不出模型, 且没给 --model\n');
  process.exit(2);
}

/**
 * 「这个读数属于哪个座位」的凭据 —— 起跑打一次, 且**写进 report.md**。
 * 只打 stderr 不够: 报告是留下来的那份, 而座位漂了正是从报告里看不出来的 (见 seat-sourced.test.ts)。
 */
const SEAT_PROVENANCE = opt('model') ? ' (--model 覆盖)' : ` (conductor 座 · 来源 ${conductorSeat?.source})`;

const log = (s: string): void => void process.stderr.write(s + '\n');

/** 与 runConductorRound 第 1 步同形的展开调用 (系统 prompt 逐字同源, 用户消息见文件头的简化说明)。 */
async function expandOnce(goal: string): Promise<{ plan: ConductorPlan | null; raw: string; err?: string }> {
  const sys = conductorSystemPrompt({ profile: 'full' });
  const r = await send({
    model: CONDUCTOR_SEAT,
    messages: [
      { role: 'system', content: sys },
      {
        role: 'user',
        content:
          `${PLAN_BOUNDARY}${goal}\n\n` +
          '注意: 本次分解出的节点**不得**再用 executor:"conductor" 或 executor:"map" —— ' +
          '你现在就是运行时展开, 已经知道清单了, 直接把步骤列出来即可。',
      },
    ],
    thinkingLevel: 'high',
    maxTokens: 32_768,
  });
  const text = r.text ?? '';
  const parsed = parsePlan(text, { knownTemplates: new Set() });
  return parsed.ok ? { plan: parsed.plan, raw: text } : { plan: null, raw: text, err: parsed.error };
}

/** 一张子图上的三个判定。 */
interface Verdict {
  /** 有节点标了 detector:true。 */
  marked: boolean;
  /**
   * 画出了**形状**: 依赖 ≥2 个兄弟, 且目标像"检查/核对/一致性"。
   *
   * ⚠ 这是**启发式**, 不是真值 —— 词表命中即算。它只用来算"形状对了但没标字段"这个差,
   * 差本身才是要看的信号; 别把这个数当成"conductor 有没有想到交叉检查"的精确测量。
   */
  shaped: boolean;
  nodes: number;
}

const CHECK_WORDS =
  /(一致|口径|冲突|交叉|核对|对照|比对|校验|检查|consisten|cross|verif|compar|reconcil|conflict|mismatch)/i;

function classify(plan: ConductorPlan): Verdict {
  const entries = Object.entries(plan.nodes);
  const marked = entries.some(([, n]) => (n as { detector?: unknown }).detector === true);
  const shaped = entries.some(([, n]) => {
    const node = n as { depends_on?: string[]; goal?: string };
    return (node.depends_on?.length ?? 0) >= 2 && CHECK_WORDS.test(node.goal ?? '');
  });
  return { marked, shaped, nodes: entries.length };
}

interface Row extends Verdict {
  case: string;
  kind: DetectorGoalCase['kind'];
  sample: number;
  parseError?: string;
}

async function main(): Promise<void> {
  await bootstrapModelRuntime();
  mkdirSync(OUT, { recursive: true });
  const jobs: Array<() => Promise<Row>> = [];
  for (const c of DETECTOR_GOAL_CASES) {
    for (let i = 0; i < N; i++) {
      jobs.push(async () => {
        const { plan, raw, err } = await expandOnce(c.goal);
        writeFileSync(`${OUT}/${c.id}-${i}.json`, JSON.stringify({ case: c.id, kind: c.kind, raw, plan }, null, 1));
        if (!plan) return { case: c.id, kind: c.kind, sample: i, marked: false, shaped: false, nodes: 0, parseError: err };
        return { case: c.id, kind: c.kind, sample: i, ...classify(plan) };
      });
    }
  }
  log(
    `跑 ${jobs.length} 次展开 (${DETECTOR_GOAL_CASES.length} 目标 × ${N} 采样, 并发 ${CONCURRENCY}) · ` +
      `座位 ${CONDUCTOR_SEAT}${SEAT_PROVENANCE}…`,
  );
  const rows: Row[] = [];
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, async () => {
      for (;;) {
        const i = cursor++;
        if (i >= jobs.length) return;
        try {
          const row = await jobs[i]!();
          rows.push(row);
          log(`  [${rows.length}/${jobs.length}] ${row.case}#${row.sample} marked=${row.marked} shaped=${row.shaped} nodes=${row.nodes}${row.parseError ? ` ⚠ ${row.parseError.slice(0, 60)}` : ''}`);
        } catch (e) {
          log(`  ✘ job ${i}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }),
  );

  const pct = (a: number, b: number): string => (b === 0 ? '—' : `${Math.round((a / b) * 100)}%`);
  const group = (kind: DetectorGoalCase['kind']): Row[] => rows.filter((r) => r.kind === kind);
  const lines: string[] = [
    '',
    '## detector 自发使用率 (展开调用, 不跑执行)',
    '',
    `座位 \`${CONDUCTOR_SEAT}\`${SEAT_PROVENANCE} · ${DETECTOR_GOAL_CASES.length} 目标 × ${N} 采样`,
    '',
  ];
  lines.push('| 组 | 样本 | 标了 detector | 画出检查形状 | **形状对了没标字段** |');
  lines.push('|---|---|---|---|---|');
  for (const kind of ['worthy', 'control'] as const) {
    const g = group(kind);
    const marked = g.filter((r) => r.marked).length;
    const shaped = g.filter((r) => r.shaped).length;
    const gap = g.filter((r) => r.shaped && !r.marked).length;
    lines.push(`| ${kind === 'worthy' ? '该用 (worthy)' : '不该用 (control)'} | ${g.length} | ${marked} (${pct(marked, g.length)}) | ${shaped} (${pct(shaped, g.length)}) | ${gap} (${pct(gap, g.length)}) |`);
  }
  lines.push('', '### 逐目标', '', '| 目标 | 组 | marked/样本 | shaped/样本 |', '|---|---|---|---|');
  for (const c of DETECTOR_GOAL_CASES) {
    const g = rows.filter((r) => r.case === c.id);
    lines.push(`| ${c.id} | ${c.kind} | ${g.filter((r) => r.marked).length}/${g.length} | ${g.filter((r) => r.shaped).length}/${g.length} |`);
  }
  const bad = rows.filter((r) => r.parseError).length;
  if (bad) lines.push('', `⚠ ${bad} 次展开没产出有效 plan (计入分母, 按"没标"算)。`);
  const report = lines.join('\n');
  writeFileSync(`${OUT}/report.md`, report + '\n');
  writeFileSync(`${OUT}/rows.json`, JSON.stringify(rows, null, 1));
  console.log(report);
  log(`\n原始 plan 与逐次读数落在 ${OUT}/`);
}

await main();
