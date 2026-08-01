#!/usr/bin/env bun
/**
 * scripts/plan-doc-check —— 计划文档 (SDD) 的质量闸。**零 LLM, 零成本, 确定性**。
 *
 *   bun run plan-doc-check docs/plan/2026-07-28-omd-goal-engine.md
 *   bun run plan-doc-check docs/plan/*.md
 *   bun run plan-doc-check --strict docs/plan/x.md      # major 也算不过
 *   bun run plan-doc-check --json docs/plan/x.md        # 机器读
 *
 * 打分表 + 缺口表; **不过则 exit 1** —— 于是它能直接当 DAG `executor:'command'` 节点的 oracle
 * (承本仓那条纪律: 判据要"真的会跑", 不是写在 prompt 里请模型自己判)。
 *
 * 判据与阈值的真理源在 `src/harness/plan/plan-doc-score.ts` (纯函数, 有测试),
 * 缺口规则在 `src/harness/plan/plan-doc-gaps.ts`。本脚本只负责读盘 + 排版 + 定退出码。
 *
 * 退出码: 0 = 全过 · 1 = 有文档不过 · 2 = 用法错 / 文件读不到。
 */
import { existsSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import {
  DEFAULT_PLAN_DOC_THRESHOLDS,
  MIN_SAMPLE,
  scorePlanDoc,
  type MetricKey,
  type PlanDocScore,
} from '../src/harness/plan/plan-doc-score';
import { countGaps, findPlanDocGaps, type PlanDocGap } from '../src/harness/plan/plan-doc-gaps';

const USAGE = [
  'usage: bun run scripts/plan-doc-check.ts [--strict] [--json] <md 路径…>',
  '  计划文档 (SDD) 质量闸: 打分 + 找缺口, 纯静态解析零 LLM。',
  '  --strict  major 缺口也算不过 (默认只有 blocker 与分数不达标才拦)',
  '  --json    输出机器可读 JSON, 不排版',
  `  阈值默认: ${JSON.stringify(DEFAULT_PLAN_DOC_THRESHOLDS)}`,
  '  exit 0 = 全过 · 1 = 有文档不过 · 2 = 用法错/读不到文件',
].join('\n');

const argv = process.argv.slice(2);
if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
  console.log(USAGE);
  process.exit(argv.length === 0 ? 2 : 0);
}
const strict = argv.includes('--strict');
const asJson = argv.includes('--json');
const files = argv.filter((a) => !a.startsWith('--'));
if (files.length === 0) {
  console.error(USAGE);
  process.exit(2);
}

const repoRoot = resolve(import.meta.dir, '..');
/** 注入给 `findPlanDocGaps` 的存在性判定 —— 读盘的权力留在脚本, 库保持纯函数。 */
const fileExists = (p: string) => existsSync(resolve(repoRoot, p));

const SEV_MARK: Record<PlanDocGap['severity'], string> = {
  blocker: '⛔ blocker',
  major: '▲ major ',
  minor: '· minor  ',
};

function pct(v: number | null): string {
  return v === null ? '  n/a' : `${(v * 100).toFixed(0).padStart(4)}%`;
}

function renderScore(s: PlanDocScore): string[] {
  const out: string[] = ['  判据                当前      样本    阈值   判定'];
  for (const key of Object.keys(s.metrics) as MetricKey[]) {
    const r = s.metrics[key];
    const verdict =
      r.value === null
        ? '不适用'
        : !r.gated
          ? `样本 <${MIN_SAMPLE}, 只展示不判`
          : r.value + 1e-9 < s.thresholds[key]
            ? '✗ 未达标'
            : '✓';
    out.push(
      `  ${s.labels[key].padEnd(16)} ${pct(r.value)}   ${`${r.hit}/${r.total}`.padEnd(7)} ${pct(s.thresholds[key])}   ${verdict}`,
    );
  }
  for (const f of s.failures) {
    out.push(
      `    ✗ ${f.label}: ${(f.value * 100).toFixed(0)}% < ${(f.threshold * 100).toFixed(0)}%` +
        (f.offenders.length > 0 ? ` —— 拖后腿的: ${f.offenders.join('、')}` : ''),
    );
  }
  for (const flag of s.softFlags) out.push(`    ⚑ ${flag.message}`);
  return out;
}

function renderGaps(gaps: PlanDocGap[]): string[] {
  if (gaps.length === 0) return ['  缺口: 无'];
  const out: string[] = ['  缺口:'];
  for (const g of gaps) {
    out.push(`  ${SEV_MARK[g.severity]}  ${g.title}`);
    out.push(`             影响面: ${g.impact}`);
    out.push(`             修法:   ${g.fix}`);
    if (g.evidence.length > 0) out.push(`             点名:   ${g.evidence.join('、')}`);
  }
  return out;
}

interface Row {
  file: string;
  score: PlanDocScore;
  gaps: PlanDocGap[];
  ok: boolean;
}

const rows: Row[] = [];
for (const f of files) {
  let md: string;
  try {
    md = readFileSync(f, 'utf8');
  } catch (e) {
    console.error(`[plan-doc-check] 读不到 ${f}: ${(e as Error).message}`);
    process.exit(2);
  }
  const score = scorePlanDoc(md);
  const gaps = findPlanDocGaps(md, { fileExists });
  const n = countGaps(gaps);
  const ok = score.pass && n.blocker === 0 && (!strict || n.major === 0);
  rows.push({ file: relative(repoRoot, resolve(f)) || f, score, gaps, ok });
}

if (asJson) {
  console.log(
    JSON.stringify(
      rows.map((r) => ({
        file: r.file,
        ok: r.ok,
        pass: r.score.pass,
        metrics: r.score.metrics,
        thresholds: r.score.thresholds,
        failures: r.score.failures,
        softFlags: r.score.softFlags,
        gaps: r.gaps,
      })),
      null,
      2,
    ),
  );
} else {
  for (const r of rows) {
    console.log(`\n${r.ok ? '✅ PASS' : '❌ FAIL'}  ${r.file}`);
    console.log(renderScore(r.score).join('\n'));
    console.log(renderGaps(r.gaps).join('\n'));
  }
  const bad = rows.filter((r) => !r.ok).length;
  console.log(
    `\n—— ${rows.length} 份文档: ${rows.length - bad} 过 / ${bad} 不过` +
      (strict ? ' (--strict: major 也拦)' : ' (只有 blocker 与分数不达标会拦, major 用 --strict 拦)'),
  );
}

process.exit(rows.some((r) => !r.ok) ? 1 : 0);
