/**
 * 引用完整性的**活体基率** (issue #25 的升闸判据基线, 2026-08-14)。
 *
 * owner 裁决 B→A: 悬空依赖先 report-only, 等实际发生率的读数出来再按来源分流。这个脚本就是
 * 那个读数 —— 零 LLM、零网络, 把仓里能拿到的 plan 全取出来跑一遍新加的三条确定性检查。
 *
 * ⚠ **按来源分开记, 不给合并数** (本仓 CLAUDE.md「加尺子必然让数难看」那一条): 历史 run 的
 * plan 与仓内夹具是两把不同的尺子, 合并数会让"某类缺陷第一次被看见"读成"引擎变差了"。
 *
 * 跑法: `bun run scripts/probes/plan-ref-integrity.ts`
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { findGraphCycle } from '../../src/harness/plan/graph-cycle';
import { staticLintPlan } from '../../src/harness/plan/static-lint';
import type { ConductorPlan } from '../../src/harness/conductor-plan';

/** 本次要量的三条 (其余 kind 不是这一笔的事)。 */
const KINDS = ['dangling-dependency', 'truncated-dependency', 'impossible-quorum'] as const;

interface Tally {
  plans: number;
  nodes: number;
  plansWithCycle: number;
  plansWith: Record<string, number>;
  findings: Record<string, number>;
  examples: string[];
}

const emptyTally = (): Tally => ({
  plans: 0,
  nodes: 0,
  plansWithCycle: 0,
  plansWith: Object.fromEntries(KINDS.map((k) => [k, 0])),
  findings: Object.fromEntries(KINDS.map((k) => [k, 0])),
  examples: [],
});

function measure(t: Tally, plan: ConductorPlan, where: string): void {
  t.plans++;
  t.nodes += Object.keys(plan.nodes ?? {}).length;
  if (findGraphCycle(plan.nodes ?? {})) {
    t.plansWithCycle++;
    t.examples.push(`cycle · ${where}`);
  }
  // fileExists 省略 = 不做 missing-input (那条要文件系统, 与本次无关); knownExternal 空 ——
  // 顶层图没有"图外真节点"这回事, 任何未知引用都是候选缺陷。
  const found = staticLintPlan(plan, {}).filter((f) => (KINDS as readonly string[]).includes(f.kind));
  const kinds = new Set(found.map((f) => f.kind));
  for (const k of kinds) t.plansWith[k] = (t.plansWith[k] ?? 0) + 1;
  for (const f of found) {
    t.findings[f.kind] = (t.findings[f.kind] ?? 0) + 1;
    if (t.examples.length < 12) t.examples.push(`${f.kind} · ${where} · ${f.nodes.join(',')}`);
  }
}

/** 递归找文件 (不用 glob 依赖)。 */
function walk(dir: string, match: (p: string) => boolean, out: string[] = [], depth = 0): string[] {
  if (depth > 6) return out;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e);
    let s;
    try {
      s = statSync(p);
    } catch {
      continue;
    }
    if (s.isDirectory()) walk(p, match, out, depth + 1);
    else if (match(p)) out.push(p);
  }
  return out;
}

const isPlan = (v: unknown): v is ConductorPlan =>
  !!v && typeof v === 'object' && typeof (v as ConductorPlan).nodes === 'object' && (v as ConductorPlan).nodes !== null;

// ── 源①: 历史 run 写入磁盘的 plan (.omd/continuity/**/_dag.json 的 plan 字段) ──────────
const live = emptyTally();
for (const f of walk('.omd/continuity', (p) => p.endsWith('_dag.json'))) {
  try {
    const d = JSON.parse(readFileSync(f, 'utf8')) as { plan?: unknown; runId?: string };
    if (isPlan(d.plan)) measure(live, d.plan, d.runId?.slice(0, 8) ?? f);
  } catch {
    /* 坏文件跳过 —— 这是读数脚本, 不是校验器 */
  }
}

// ── 源②: 仓内夹具/eval 语料里的 plan JSON ────────────────────────────────────────
const fixture = emptyTally();
for (const f of walk('.omd/eval', (p) => p.endsWith('.json'))) {
  try {
    const d: unknown = JSON.parse(readFileSync(f, 'utf8'));
    if (isPlan(d)) measure(fixture, d as ConductorPlan, f.split('/').pop() ?? f);
    else if (isPlan((d as { plan?: unknown }).plan)) measure(fixture, (d as { plan: ConductorPlan }).plan, f.split('/').pop() ?? f);
  } catch {
    /* 同上 */
  }
}

const pct = (n: number, d: number): string => (d === 0 ? 'n/a (分母为 0 ≠ 0%)' : `${((n / d) * 100).toFixed(1)}%`);

const report = (label: string, t: Tally): void => {
  console.log(`\n── ${label} ──`);
  console.log(`plan 数: ${t.plans} · 节点总数: ${t.nodes}`);
  console.log(`有环的 plan: ${t.plansWithCycle} (${pct(t.plansWithCycle, t.plans)})`);
  for (const k of KINDS) {
    console.log(`${k}: ${t.findings[k]} 条, 分布在 ${t.plansWith[k]} 份 plan (${pct(t.plansWith[k]!, t.plans)})`);
  }
  if (t.examples.length) console.log('样本:', t.examples.slice(0, 8).join(' | '));
};

report('源① 历史 run 写入磁盘的 plan (.omd/continuity/**/_dag.json)', live);
report('源② eval 语料 (.omd/eval/**/*.json)', fixture);
console.log('\n⚠ 两栏刻意不合并 —— 不同来源是不同的尺子, 合并数读不出"缺陷第一次被看见"与"引擎变差了"的区别。');
