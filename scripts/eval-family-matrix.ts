/**
 * eval-family-matrix —— council/grill 的"跨家族发散到底值不值"矩阵 eval (owner 2026-07-27)。
 *
 * 核心省法: **不按臂跑, 按矩阵跑**。
 *   跑一次 (6 persona × 6 家族 = 36 leaf), 然后所有臂都从同一份矩阵**推导**出来:
 *     - mono_f  臂 = 家族 f 的那一行 (6 个 persona 全同族)
 *     - div     臂 = 每 persona 取不同族的一个双射 (6! = 720 种, 全枚举)
 *   → A/B 不再各跑一遍, token 砍半以上, 且 div 臂拿到的是 720 次的**分布**而不是 1-2 个样本,
 *     "赢了是真的还是运气" 直接从分布读出来。
 *
 * 量的是**盲点覆盖**: 每题事前由题库作者 (Claude, 不在任何臂的池里) 埋 N 个非显然金标点, 对生成体全隐藏;
 * 跑完由**池外家族** (gpt-5.6-sol) 逐点判命中并要求原文引用 → 覆盖率 = 这一臂"没瞎的比例"。
 * 单变量: persona/题面/温度/输出上限两臂逐字相同, 只有"这个 persona 由哪个家族跑"变。
 *
 * 跑: bun run scripts/eval-family-matrix.ts [taskId ...] [--conc 8] [--out DIR]
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { send } from '../src/model/gateway';
import { bootstrapModelRuntime } from '../src/model/bootstrap';
import { modelFamily } from '../src/model/channels';
import { parallel } from '../src/harness/primitives';
import { TASKS, TASK_BY_ID, PERSONAS, buildGenPrompt, type EvalTask } from './eval-tasks/diverge-tasks';
import { gradeAnswer, GRADER } from './eval-tasks/grade';

/**
 * 每族一个"上镜头的代表坐标"。尽量同一条 flat 渠道 (opencode-go) → 家族是唯一变量;
 * 两处偏离都是实测逼出来的, 记在这里免得下次再踩 (跨族发散的**运维税**, 不是免费的):
 *  - kimi: `opencode-go:kimi-k3` 一带 temperature/topP 就 400 (裸调可以) → 换真订阅渠道 `kimi-coding:k3`,
 *    同为 flat 订阅, 成本≈0 不变。
 *  - deepseek: `deepseek-v4-pro` 的 reasoning token 与正文共用同一预算, 默认档会把 8k 顶吃光→正文为空
 *    (2200 顶时全灭)。thinkingLevel=low 实测 3/3 出正文。
 */
const FAMILY_SEATS: { coord: string; thinkingLevel?: 'low' }[] = [
  { coord: 'opencode-go:deepseek-v4-pro', thinkingLevel: 'low' },
  { coord: 'opencode-go:glm-5.2' },
  { coord: 'kimi-coding:k3' },
  { coord: 'opencode-go:minimax-m3' },
  { coord: 'opencode-go:qwen3.7-plus' },
  { coord: 'opencode-go:mimo-v2.5-pro' },
];
const GRADER_CONC = 3; // sol 三座
/** 噪声抽检用的第二判官 (与部分臂同族, 只标误差棒不计分)。--grader2 off 关掉。 */
const GRADER2 = process.env.EVAL_GRADER2 || 'opencode-go:glm-5.2';
/**
 * 输出上限。**8000 是 2026-07-28 修掉的测量偏差**: 当时以为"同一个数 = 单变量", 实际上顶只咬话多的族 ——
 * 三题 54 格里 minimax 撞顶 4 次、qwen 3 次、deepseek 2 次, 而 kimi/glm/mimo 一次都没撞。
 * 截断只伤被截的一方 → 那个"公平的顶"系统性偏袒简短家族。
 * 32768 高于各族实测自然长度 (最长 minimax 平均 6.5k), 让每一族都写到自己想停的地方才是真单变量。
 */
const GEN_MAX_TOKENS = Number(process.env.EVAL_GEN_MAX_TOKENS) || 32_768;

const argv = process.argv.slice(2);
const flag = (name: string, dflt: string): string => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? (argv[i + 1] ?? dflt) : dflt;
};
const GEN_CONC = Number(flag('conc', '8'));
const OUT = flag('out', '/tmp/eval-family-matrix');
const taskIds = argv.filter((a) => !a.startsWith('--') && TASK_BY_ID.has(a));
const tasks = taskIds.length ? taskIds.map((id) => TASK_BY_ID.get(id)!) : [...TASKS];

const log = (s: string): void => void process.stderr.write(s + '\n');

interface Cell {
  persona: string;
  coord: string;
  family: string;
  ok: boolean;
  text: string;
  tokensIn: number;
  tokensOut: number;
  ms: number;
  hits: Set<string>;
  graded: boolean;
  quotes: Record<string, string>;
}

async function runTask(task: EvalTask): Promise<void> {
  log(`\n═══ 题 ${task.id} (${task.kind}) · ${PERSONAS.length} persona × ${FAMILY_SEATS.length} 家族 · ${task.seeds.length} 金标点 ═══`);

  // 1) 矩阵生成 (36 leaf)。
  const jobs: (() => Promise<Cell>)[] = [];
  for (const p of PERSONAS) {
    for (const seat of FAMILY_SEATS) {
      jobs.push(async () => {
        const t0 = Date.now();
        const base: Cell = {
          persona: p.id,
          coord: seat.coord,
          family: modelFamily(seat.coord),
          ok: false,
          text: '',
          tokensIn: 0,
          tokensOut: 0,
          ms: 0,
          hits: new Set<string>(),
          graded: false,
          quotes: {},
        };
        // 一格失败 = 整族失去资格 (usable 闸), 代价太大 → 重试一次再判死。
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const r = await send({
              model: seat.coord,
              messages: [{ role: 'user', content: buildGenPrompt(task, p) }],
              temperature: p.temperature,
              topP: p.topP,
              maxTokens: GEN_MAX_TOKENS,
              ...(seat.thinkingLevel ? { thinkingLevel: seat.thinkingLevel } : {}),
              meta: { role: 'eval-matrix-gen' },
            });
            const text = r.text.trim();
            if (!text) throw new Error('空正文');
            log(`  gen ${p.id.padEnd(16)} ${base.family.padEnd(9)} ${text.length} chars ${((Date.now() - t0) / 1000).toFixed(0)}s`);
            return { ...base, ok: true, text, tokensIn: r.usage.in, tokensOut: r.usage.out, ms: Date.now() - t0 };
          } catch (e) {
            log(`  gen ${p.id.padEnd(16)} ${base.family.padEnd(9)} ${attempt === 0 ? 'retry' : 'FAIL'} ${(e as Error).message.slice(0, 160)}`);
          }
        }
        return { ...base, ms: Date.now() - t0 };
      });
    }
  }
  const cells = (await parallel(jobs, { concurrency: GEN_CONC })).filter((c): c is Cell => c !== null);

  // 2) 判分 (池外家族, 逐点 + 逐字引用)。
  log(`  ── 判分 (${GRADER}) ──`);
  const gradeJobs = cells
    .filter((c) => c.ok)
    .map((c) => async () => {
      try {
        const g = await gradeAnswer(task, c.text);
        c.hits = g.hits;
        c.quotes = g.quotes;
        c.graded = true;
        log(`  grade ${c.persona.padEnd(16)} ${c.family.padEnd(9)} 命中 ${c.hits.size}/${task.seeds.length}`);
      } catch (e) {
        log(`  grade ${c.persona.padEnd(16)} ${c.family.padEnd(9)} FAIL ${(e as Error).message.slice(0, 200)}`);
      }
    });
  await parallel(gradeJobs, { concurrency: GRADER_CONC });

  // 2b) 判官噪声估计: 抽样用**第二家族判官**重判, 报一致率。
  // 只用来标误差棒, 不参与打分 (grader2 与部分臂同族, 不能当计分尺)。
  const sample = cells.filter((c) => c.graded).filter((_, i) => i % 5 === 0);
  let agree = 0;
  let total = 0;
  if (GRADER2 && sample.length) {
    log(`  ── 判官噪声抽检 (${GRADER2}, ${sample.length} 格) ──`);
    await parallel(
      sample.map((c) => async () => {
        try {
          const g2 = await gradeAnswer(task, c.text, GRADER2);
          for (const s of task.seeds) {
            total++;
            if (c.hits.has(s.id) === g2.hits.has(s.id)) agree++;
          }
        } catch {
          /* 抽检失败不影响主结果 */
        }
      }),
      { concurrency: 3 },
    );
    log(`  判官逐点一致率 ${total ? ((agree / total) * 100).toFixed(0) : '-'}% (${agree}/${total})`);
  }

  // 3) 从矩阵推导所有臂。
  const seedIds = task.seeds.map((s) => s.id);
  const bit = new Map(seedIds.map((id, i) => [id, i]));
  const mask = (c: Cell): number => [...c.hits].reduce((m, id) => m | (1 << (bit.get(id) ?? 31)), 0);
  const popcount = (m: number): number => m.toString(2).split('1').length - 1;

  const families = [...new Set(cells.map((c) => c.family))];
  const at = new Map<string, Cell>();
  for (const c of cells) at.set(`${c.persona}|${c.family}`, c);
  const cellMask = (persona: string, family: string): number => {
    const c = at.get(`${persona}|${family}`);
    return c && c.graded ? mask(c) : 0;
  };
  const usable = families.filter((f) => PERSONAS.every((p) => at.get(`${p.id}|${f}`)?.graded));
  if (usable.length < 2) {
    log(`  ⚠ 可用家族仅 ${usable.length} 个 (需 ≥2), 跳过推导`);
    return;
  }

  // mono 臂: 一族跑满 6 个 persona。
  const mono = usable
    .map((f) => {
      const m = PERSONAS.reduce((acc, p) => acc | cellMask(p.id, f), 0);
      const per = PERSONAS.map((p) => popcount(cellMask(p.id, f)));
      const toks = PERSONAS.reduce((s, p) => s + (at.get(`${p.id}|${f}`)?.tokensOut ?? 0), 0);
      return { family: f, union: popcount(m), unionMask: m, perCellMean: per.reduce((a, b) => a + b, 0) / per.length, tokensOut: toks };
    })
    .sort((a, b) => b.union - a.union);

  // div 臂: persona→家族 双射全枚举 (usable! 种)。
  const divUnions: number[] = [];
  const permute = (rest: string[], acc: string[]): void => {
    if (acc.length === PERSONAS.length) {
      divUnions.push(popcount(PERSONAS.reduce((m, p, i) => m | cellMask(p.id, acc[i]!), 0)));
      return;
    }
    for (let i = 0; i < rest.length; i++) permute([...rest.slice(0, i), ...rest.slice(i + 1)], [...acc, rest[i]!]);
  };
  if (usable.length >= PERSONAS.length) permute(usable, []);
  else {
    // 家族少于 persona: 轮转铺满 (rotateFamilies 的语义), 枚举所有起始序的排列。
    const perms: string[][] = [];
    const gen = (rest: string[], acc: string[]): void => {
      if (acc.length === usable.length) return void perms.push(acc);
      for (let i = 0; i < rest.length; i++) gen([...rest.slice(0, i), ...rest.slice(i + 1)], [...acc, rest[i]!]);
    };
    gen(usable, []);
    for (const order of perms) {
      divUnions.push(popcount(PERSONAS.reduce((m, p, i) => m | cellMask(p.id, order[i % order.length]!), 0)));
    }
  }
  divUnions.sort((a, b) => a - b);
  const q = (p: number): number => divUnions[Math.min(divUnions.length - 1, Math.floor(p * divUnions.length))]!;
  const divMean = divUnions.reduce((a, b) => a + b, 0) / divUnions.length;
  const bestMono = mono[0]!;
  const monoMeanUnion = mono.reduce((s, m) => s + m.union, 0) / mono.length;
  // 分布判决: 随机一个跨族分配打赢/打平"最好的单族"的概率 (事前你并不知道哪族最好)。
  const beatBest = divUnions.filter((u) => u > bestMono.union).length / divUnions.length;
  const tieOrBeatBest = divUnions.filter((u) => u >= bestMono.union).length / divUnions.length;

  // 互补性: 每个金标点被几个族抓到 (1 = 只有一个族看见 → 单族必瞎)。
  const perSeed = seedIds.map((id) => {
    const fams = usable.filter((f) => PERSONAS.some((p) => at.get(`${p.id}|${f}`)?.hits.has(id)));
    return { id, families: fams, n: fams.length };
  });
  const soleFamily = perSeed.filter((s) => s.n === 1);
  const missedByAll = perSeed.filter((s) => s.n === 0);

  const N = task.seeds.length;
  const pct = (x: number): string => `${((x / N) * 100).toFixed(0)}%`;
  const lines = [
    `\n──────── ${task.id} (${task.kind}) · 金标 ${N} 点 ────────`,
    `mono 臂 (单族跑满 6 persona) 并集覆盖:`,
    ...mono.map((m) => `  ${m.family.padEnd(10)} ${String(m.union).padStart(2)}/${N} (${pct(m.union)})  单 persona 均值 ${m.perCellMean.toFixed(1)}  out-tok ${m.tokensOut}`),
    `  mono 平均并集 ${monoMeanUnion.toFixed(1)}/${N} · 最好单族 = ${bestMono.family} ${bestMono.union}/${N}`,
    `div 臂 (每 persona 换族, 全枚举 ${divUnions.length} 种分配) 并集覆盖:`,
    `  均值 ${divMean.toFixed(1)}/${N} (${((divMean / N) * 100).toFixed(0)}%) · p10 ${q(0.1)} · 中位 ${q(0.5)} · p90 ${q(0.9)} · min ${divUnions[0]} · max ${divUnions[divUnions.length - 1]}`,
    `判决:`,
    `  div均值 − mono均值 = ${(divMean - monoMeanUnion).toFixed(1)} 点 (${(((divMean - monoMeanUnion) / N) * 100).toFixed(0)}pp)`,
    `  div均值 − 最好单族 = ${(divMean - bestMono.union).toFixed(1)} 点 · 随机跨族分配 > 最好单族 的概率 ${(beatBest * 100).toFixed(0)}% (≥ 则 ${(tieOrBeatBest * 100).toFixed(0)}%)`,
    `  调用数两臂相同 (6 leaf), 故覆盖差 = 同 token 下的净质量差`,
    `判官噪声: 逐点一致率 ${total ? `${((agree / total) * 100).toFixed(0)}% (${GRADER2} 抽检 ${sample.length} 格)` : '未抽检'}`,
    `互补性:`,
    `  只有 1 个族抓到的金标点 ${soleFamily.length}/${N}${soleFamily.length ? ` → ${soleFamily.map((s) => `${s.id}(${s.families[0]})`).join(', ')}` : ''}`,
    `  全族皆瞎 ${missedByAll.length}/${N}${missedByAll.length ? ` → ${missedByAll.map((s) => s.id).join(', ')}` : ''}`,
  ];
  const report = lines.join('\n');
  process.stdout.write(report + '\n');

  mkdirSync(`${OUT}/${task.id}`, { recursive: true });
  writeFileSync(
    `${OUT}/${task.id}/matrix.json`,
    JSON.stringify(
      {
        task: task.id,
        kind: task.kind,
        grader: GRADER,
        seeds: seedIds,
        cells: cells.map((c) => ({ ...c, hits: [...c.hits], text: undefined })),
        mono,
        div: { count: divUnions.length, mean: divMean, p10: q(0.1), median: q(0.5), p90: q(0.9), min: divUnions[0], max: divUnions[divUnions.length - 1] },
        beatBest,
        tieOrBeatBest,
        perSeed,
      },
      null,
      2,
    ),
  );
  writeFileSync(`${OUT}/${task.id}/report.md`, report);
  for (const c of cells) if (c.ok) writeFileSync(`${OUT}/${task.id}/gen-${c.persona}-${c.family}.md`, c.text);
  log(`  → 落盘 ${OUT}/${task.id}/`);
}

bootstrapModelRuntime();
for (const t of tasks) await runTask(t);
