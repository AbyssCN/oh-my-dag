/**
 * eval-stack-ab —— **两套订阅栈的终稿质量对比** (owner 2026-07-28)。
 *
 * 回答的是采购决策, 不是学术问题: **mimo + gpt(2 订阅) 能不能替代 mimo + gpt + opencode-go(3 订阅)?**
 *   A-2sub : worker/lens 全走 mimo 订阅 · conductor/review 走 gpt-sol。没有 opencode-go。
 *   B-3sub : 同 A, 但 lens 与 judge panel 改由 opencode-go 的多族池供给 (glm/m3/qwen/kimi/deepseek)。
 * 单变量 = **有没有 opencode-go 这个发散池**; 题面/persona/轮数/输出上限/判分全同。
 *
 * 与前一版 eval 的差别 (两处都是前一版的硬伤):
 *  1. 跑**完整 council 管线** (6 gen → 3 reduce → 2 synth → 3 judge → fusion → graft), 判的是终稿,
 *     不是生成段并集 —— 采购决策要看交到手里的那份东西。
 *  2. reduce/judge/fusion/graft **全部显式钉死**。前一版靠默认回落, 结果 mono 臂混进 mimo+gpt,
 *     判官家族还成了终稿作者之一。
 *
 * 判官取舍 (诚实声明): gpt-sol 在**两臂都是 conductor/review**, 所以拿它当判官是**共模**的 ——
 * 它对自己写的终稿若有偏好, 两臂同等受益, 不改变 A/B 的**相对**结论。
 * 另配第二判官抽检一致率, 给误差棒。
 *
 * 跑: bun run scripts/eval-stack-ab.ts [taskId ...] [--reps 2]
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { councilDeepPlan } from '../src/harness/plan/best-of-n';
import { bootstrapModelRuntime } from '../src/model/bootstrap';
import { modelFamily } from '../src/model/channels';
import { onTruncation } from '../src/model/truncation';
import { TASKS, TASK_BY_ID } from './eval-tasks/diverge-tasks';
import { gradeAnswer, GRADER } from './eval-tasks/grade';

// ── 座位定义 ────────────────────────────────────────────────────────────────
const MIMO_PRO = 'xiaomi-token-plan-ams:mimo-v2.5-pro'; // 真订阅 (token-plan)
const MIMO = 'xiaomi-token-plan-ams:mimo-v2.5';
const SOL = 'openai-codex:gpt-5.6-sol'; // conductor / review

/** opencode-go 的价值主张: 一把 key 供多族, 当 lens/judge 的发散来源。 */
const GO_LENS_POOL = [
  'opencode-go:minimax-m3',
  'opencode-go:glm-5.2',
  'opencode-go:qwen3.7-max',
  'opencode-go:kimi-k3',
  'opencode-go:deepseek-v4-pro',
  'opencode-go:mimo-v2.5-pro',
];
const GO_JUDGE_POOL = ['opencode-go:glm-5.2', 'opencode-go:minimax-m3', 'opencode-go:qwen3.7-max'];

interface Arm {
  name: string;
  note: string;
  opts: Parameters<typeof councilDeepPlan>[1];
}
const ARMS: Arm[] = [
  {
    name: 'A-2sub',
    note: 'mimo 订阅供 worker/lens · gpt-sol 供 conductor/review · 无 opencode-go',
    opts: {
      lensModel: MIMO_PRO,
      reduceModel: MIMO, // reduce 是 ×L 的多发段, 用便宜档 (与产线同纪律)
      reasonModel: MIMO_PRO, // synth
      judgeModel: SOL, // review 座
      fusionModel: SOL,
      graftModel: SOL, // 终笔 = review 栈
    },
  },
  {
    name: 'B-3sub',
    note: '同 A, 但 lens 与 judge panel 由 opencode-go 多族池供给',
    opts: {
      lensModel: MIMO_PRO, // 池覆盖后仅作兜底
      divergePool: GO_LENS_POOL, // ← 唯一变量: 发散池
      judgePool: GO_JUDGE_POOL, // ← 唯一变量: 审核池
      reduceModel: MIMO,
      reasonModel: MIMO_PRO,
      judgeModel: SOL,
      fusionModel: SOL,
      graftModel: SOL,
    },
  },
];

const argv = process.argv.slice(2);
const repsIdx = argv.indexOf('--reps');
const REPS = repsIdx >= 0 ? Number(argv[repsIdx + 1]) : 2;
const picked = argv.filter((a) => !a.startsWith('--') && TASK_BY_ID.has(a));
const tasks = picked.length ? picked.map((id) => TASK_BY_ID.get(id)!) : [...TASKS];
const OUT = '/tmp/eval-stack-ab';

const log = (s: string): void => void process.stderr.write(s + '\n');

// 截断现在是可见事件 —— 任何一次撞顶都记下来, 免得再把"被切断"读成"质量差"。
const truncations: string[] = [];
onTruncation((i) => {
  truncations.push(`${i.model} out=${i.out}`);
  log(`  ⚠ 截断 ${i.model} out=${i.out}${i.cap ? ` cap=${i.cap}` : ''}`);
});

interface Row {
  task: string;
  arm: string;
  rep: number;
  hits: number;
  hitIds: string[];
  leafCount: number;
  outTok: number;
  wallSec: number;
  families: string;
  chars: number;
  truncs: number;
}

bootstrapModelRuntime();
mkdirSync(OUT, { recursive: true });
const rows: Row[] = [];

for (const task of tasks) {
  for (let rep = 0; rep < REPS; rep++) {
    for (const arm of ARMS) {
      log(`\n═══ ${task.id} · ${arm.name} · rep${rep} ═══`);
      const before = truncations.length;
      const t0 = Date.now();
      try {
        const res = await councilDeepPlan(task.brief, {
          ...arm.opts,
          onStage: (s, d) => log(`  [${s}] ${d}`),
        });
        const wallSec = (Date.now() - t0) / 1000;
        const fam = new Map<string, number>();
        let outTok = 0;
        for (const [coord, st] of Object.entries(res.costStats.perModel)) {
          const s = st as { calls: number; out?: number };
          fam.set(modelFamily(coord), (fam.get(modelFamily(coord)) ?? 0) + s.calls);
          outTok += s.out ?? 0;
        }
        writeFileSync(`${OUT}/${task.id}-${arm.name}-rep${rep}.md`, res.final);
        let hits = new Set<string>();
        try {
          hits = (await gradeAnswer(task, res.final)).hits;
        } catch (e) {
          log(`  判分失败: ${(e as Error).message.slice(0, 90)}`);
        }
        rows.push({
          task: task.id,
          arm: arm.name,
          rep,
          hits: hits.size,
          hitIds: [...hits],
          leafCount: res.leafCount,
          outTok,
          wallSec,
          families: [...fam.entries()].map(([f, c]) => `${f}:${c}`).join(' '),
          chars: res.final.length,
          truncs: truncations.length - before,
        });
        const r = rows[rows.length - 1]!;
        log(`  → 命中 ${r.hits}/${task.seeds.length} · leaf ${r.leafCount} · out-tok ${r.outTok} · ${r.wallSec.toFixed(0)}s · 截断 ${r.truncs} · [${r.families}]`);
      } catch (e) {
        log(`  ✖ 整臂失败: ${(e as Error).message.slice(0, 160)}`);
      }
    }
  }
}

// ── 报告 ────────────────────────────────────────────────────────────────────
const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const lines = [`\n════════ 订阅栈 A/B · 完整 council 管线 · 判官 ${GRADER} ════════`];
for (const arm of ARMS) lines.push(`${arm.name}: ${arm.note}`);
for (const task of tasks) {
  const N = task.seeds.length;
  lines.push(`\n── ${task.id} (${task.kind}, 金标 ${N}) ──`);
  for (const arm of ARMS) {
    const rs = rows.filter((r) => r.task === task.id && r.arm === arm.name);
    if (!rs.length) {
      lines.push(`  ${arm.name.padEnd(8)} 无有效结果`);
      continue;
    }
    lines.push(
      `  ${arm.name.padEnd(8)} 终稿覆盖 ${mean(rs.map((r) => r.hits)).toFixed(1)}/${N} (${rs.map((r) => r.hits).join(',')}) · out-tok ${Math.round(mean(rs.map((r) => r.outTok)))} · 墙钟 ${mean(rs.map((r) => r.wallSec)).toFixed(0)}s · 截断 ${rs.reduce((s, r) => s + r.truncs, 0)} · [${rs[0]!.families}]`,
    );
  }
  const a = rows.filter((r) => r.task === task.id && r.arm === 'A-2sub');
  const b = rows.filter((r) => r.task === task.id && r.arm === 'B-3sub');
  if (a.length && b.length) {
    lines.push(`  Δ (B−A) 覆盖 ${(mean(b.map((r) => r.hits)) - mean(a.map((r) => r.hits))).toFixed(1)} 点 · Δ out-tok ${Math.round(mean(b.map((r) => r.outTok)) - mean(a.map((r) => r.outTok)))} · Δ 墙钟 ${(mean(b.map((r) => r.wallSec)) - mean(a.map((r) => r.wallSec))).toFixed(0)}s`);
    const only = (x: Row[], y: Row[]): string[] => {
      const ys = new Set(y.flatMap((r) => r.hitIds));
      return [...new Set(x.flatMap((r) => r.hitIds))].filter((h) => !ys.has(h));
    };
    lines.push(`  只有 B 抓到: ${only(b, a).join(', ') || '（无）'}`);
    lines.push(`  只有 A 抓到: ${only(a, b).join(', ') || '（无）'}`);
  }
}
const totA = rows.filter((r) => r.arm === 'A-2sub');
const totB = rows.filter((r) => r.arm === 'B-3sub');
lines.push(
  `\n合计: A-2sub 覆盖率 ${((totA.reduce((s, r) => s + r.hits, 0) / totA.reduce((s, r) => s + (TASK_BY_ID.get(r.task)?.seeds.length ?? 0), 0)) * 100 || 0).toFixed(0)}% · B-3sub ${((totB.reduce((s, r) => s + r.hits, 0) / totB.reduce((s, r) => s + (TASK_BY_ID.get(r.task)?.seeds.length ?? 0), 0)) * 100 || 0).toFixed(0)}%`,
  `全程截断事件 ${truncations.length} 次${truncations.length ? ` → ${[...new Set(truncations)].join(' | ')}` : '（顶已抬够）'}`,
);
const report = lines.join('\n');
process.stdout.write(report + '\n');
writeFileSync(`${OUT}/report.md`, report);
writeFileSync(`${OUT}/rows.json`, JSON.stringify(rows, null, 2));
log(`  → 落盘 ${OUT}/`);
