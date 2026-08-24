/**
 * eval-council-e2e —— 跨家族发散在**整条 council 管线**上还剩多少 (owner 2026-07-27)。
 *
 * 矩阵 eval (eval-family-matrix) 量的是**生成段**的盲点覆盖: 多族并起来是不是看得更全。
 * 但 v2 那次的教训是: 生成段的差异可能在 reduce→synth→judge 里被洗掉 —— 终稿只有一份,
 * 冠军择优会把"只有一个族看见的点"直接丢掉。所以这一层必须单独量:
 *   A-mono : councilDeepPlan 原行为 (L×V gen + reduce + synth + judge panel 全走单族)
 *   B-div  : 同题同镜头, 只把 gen/synth/judge 的模型分配换成跨族池
 * 判分与矩阵同一把尺 (池外 gpt 判官 + 逐字引用回原文校验), 判的是**终稿**。
 *
 * 跑: bun run scripts/eval-council-e2e.ts <taskId> [--reps 1]
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { councilDeepPlan } from '../src/harness/plan/best-of-n';
import { bootstrapModelRuntime } from '../src/model/bootstrap';
import { modelFamily } from '../src/model/channels';
import { TASK_BY_ID, TASKS } from './eval-tasks/diverge-tasks';
import { gradeAnswer, GRADER } from './eval-tasks/grade';

const PRO = 'opencode-go:deepseek-v4-pro';
/** 跨族池: 与矩阵 eval 同一批坐标 (同一条 flat 渠道, 家族是唯一变量)。 */
const DIVERGE_POOL = [
  'opencode-go:deepseek-v4-pro',
  'opencode-go:glm-5.2',
  'opencode-go:kimi-k3',
  'opencode-go:minimax-m3',
  'opencode-go:qwen3.7-plus',
  'opencode-go:mimo-v2.5-pro',
];
const JUDGE_POOL = ['opencode-go:glm-5.2', 'opencode-go:minimax-m3', 'opencode-go:deepseek-v4-pro'];

const argv = process.argv.slice(2);
const taskId = argv.find((a) => !a.startsWith('--')) ?? TASKS[0]!.id;
const task = TASK_BY_ID.get(taskId);
if (!task) throw new Error(`未知题 ${taskId}; 可选: ${TASKS.map((t) => t.id).join(', ')}`);
const repsIdx = argv.indexOf('--reps');
const REPS = repsIdx >= 0 ? Number(argv[repsIdx + 1]) : 1;
const OUT = '/tmp/eval-council-e2e';

const log = (s: string): void => void process.stderr.write(s + '\n');

interface ArmRun {
  arm: string;
  rep: number;
  hits: number;
  hitIds: string[];
  leafCount: number;
  tokensOut: number;
  wallSec: number;
  families: string;
  finalChars: number;
}

bootstrapModelRuntime();
mkdirSync(`${OUT}/${task.id}`, { recursive: true });
const rows: ArmRun[] = [];

for (let rep = 0; rep < REPS; rep++) {
  for (const arm of ['A-mono', 'B-div'] as const) {
    log(`\n═══ ${task.id} · ${arm} · rep${rep} ═══`);
    const t0 = Date.now();
    const res = await councilDeepPlan(task.brief, {
      lensModel: PRO, // 两臂同题同镜头; mono 全 deepseek 族, div 只换分配
      reasonModel: PRO,
      ...(arm === 'B-div' ? { divergePool: DIVERGE_POOL, judgePool: JUDGE_POOL } : {}),
      onStage: (s, d) => log(`  [${s}] ${d}`),
    });
    const wallSec = (Date.now() - t0) / 1000;
    const famCalls = new Map<string, number>();
    let tokensOut = 0;
    for (const [coord, st] of Object.entries(res.costStats.perModel)) {
      const s = st as { calls: number; out?: number };
      famCalls.set(modelFamily(coord), (famCalls.get(modelFamily(coord)) ?? 0) + s.calls);
      tokensOut += s.out ?? 0;
    }
    const final = res.final;
    writeFileSync(`${OUT}/${task.id}/${arm}-rep${rep}.md`, final);
    let hits = new Set<string>();
    try {
      hits = (await gradeAnswer(task, final)).hits;
    } catch (e) {
      log(`  判分失败: ${(e as Error).message.slice(0, 100)}`);
    }
    rows.push({
      arm,
      rep,
      hits: hits.size,
      hitIds: [...hits],
      leafCount: res.leafCount,
      tokensOut,
      wallSec,
      families: [...famCalls.entries()].map(([f, c]) => `${f}:${c}`).join(' '),
      finalChars: final.length,
    });
    log(`  → 命中 ${hits.size}/${task.seeds.length} · leaf ${res.leafCount} · out-tok ${tokensOut} · ${wallSec.toFixed(0)}s · [${rows[rows.length - 1]!.families}]`);
  }
}

const N = task.seeds.length;
const byArm = (a: string): ArmRun[] => rows.filter((r) => r.arm === a);
const mean = (xs: number[]): number => (xs.length ? xs.reduce((x, y) => x + y, 0) / xs.length : 0);
const out = [
  `\n──────── e2e council ${task.id} · 金标 ${N} 点 · 判官 ${GRADER} ────────`,
  ...['A-mono', 'B-div'].map((a) => {
    const rs = byArm(a);
    return `${a.padEnd(7)} 覆盖 ${mean(rs.map((r) => r.hits)).toFixed(1)}/${N} (${rs.map((r) => r.hits).join(',')}) · out-tok ${Math.round(mean(rs.map((r) => r.tokensOut)))} · 墙钟 ${mean(rs.map((r) => r.wallSec)).toFixed(0)}s · 家族 [${rs[0]?.families ?? '-'}]`;
  }),
  `Δ 覆盖 = ${(mean(byArm('B-div').map((r) => r.hits)) - mean(byArm('A-mono').map((r) => r.hits))).toFixed(1)} 点 · Δ out-tok = ${Math.round(mean(byArm('B-div').map((r) => r.tokensOut)) - mean(byArm('A-mono').map((r) => r.tokensOut)))} · Δ 墙钟 = ${(mean(byArm('B-div').map((r) => r.wallSec)) - mean(byArm('A-mono').map((r) => r.wallSec))).toFixed(0)}s`,
  `A 命中集: ${[...new Set(byArm('A-mono').flatMap((r) => r.hitIds))].sort().join(', ')}`,
  `B 命中集: ${[...new Set(byArm('B-div').flatMap((r) => r.hitIds))].sort().join(', ')}`,
].join('\n');
process.stdout.write(out + '\n');
writeFileSync(`${OUT}/${task.id}/report.md`, out);
writeFileSync(`${OUT}/${task.id}/rows.json`, JSON.stringify(rows, null, 2));
log(`  → 存盘 ${OUT}/${task.id}/`);
