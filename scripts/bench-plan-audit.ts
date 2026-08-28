/**
 * bench 图审计 (A1, 放量路线 §3) —— 「conductor 到底用了引擎能力面的哪些格」的机械读数。
 *
 * 吃一个 workbuddy 批目录 (results/<job>/<ts>/), 从每个 trial 的 agent/omd-state.tgz 里
 * 抽 plan JSON (continuity 下的 _dag.json + hud 下的 dag-⋆.json), 产:
 *   ① executor 分布 ② 能力字段使用计数 ③ 图规模分布 + 1 节点图占比 (serial-collapse 尺)。
 *
 * 首跑读数 (2026-08-29, N1 批): write_set 0 (→ B1 教学) · map/primitive 0 (→ B2 探针) ·
 * 1 节点图 5/14 (→ B3)。此后每个基线批跑一次, 与这张表 diff 就是接线票的验收尺。
 *
 * ⚠ 计数口径: `k in node && node[k] 非 null/[]/{}` —— **不许**用 truthy 判
 * (`expect_exit: 0` 是最常见的值, truthy 判会把它整列抹成 0; 首版审计当场踩过)。
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TRACKED_FEATURES = [
  'detector', 'expect_exit', 'expect_output', 'map', 'template', 'profile', 'tier', 'persona',
  'self_check', 'write_set', 'output_path', 'max_rounds', 'quorum', 'research', 'mcp',
  'primitive', 'cluster', 'judge_final',
] as const;

export interface PlanAudit {
  plans: number;
  nodeCounts: number[];
  singleNodeShare: number;
  executors: Record<string, number>;
  features: Record<string, number>;
}

/** 纯函数半: 一批 plan 对象 → 审计表。 */
export function auditPlans(planObjs: unknown[]): PlanAudit {
  const executors: Record<string, number> = {};
  const features: Record<string, number> = {};
  const nodeCounts: number[] = [];
  let plans = 0;
  for (const p of planObjs) {
    const nodes = (p as { nodes?: unknown })?.nodes ?? (p as { plan?: { nodes?: unknown } })?.plan?.nodes;
    if (nodes === null || typeof nodes !== 'object' || Array.isArray(nodes)) continue;
    plans++;
    const entries = Object.values(nodes as Record<string, unknown>);
    nodeCounts.push(entries.length);
    for (const n of entries) {
      if (n === null || typeof n !== 'object') continue;
      const node = n as Record<string, unknown>;
      const ex = typeof node.executor === 'string' ? node.executor : 'leaf(default)';
      executors[ex] = (executors[ex] ?? 0) + 1;
      for (const k of TRACKED_FEATURES) {
        const v = node[k];
        if (!(k in node) || v === null || v === undefined) continue;
        if (Array.isArray(v) && v.length === 0) continue;
        if (typeof v === 'object' && !Array.isArray(v) && Object.keys(v as object).length === 0) continue;
        features[k] = (features[k] ?? 0) + 1;
      }
    }
  }
  nodeCounts.sort((a, b) => a - b);
  const single = nodeCounts.filter((c) => c === 1).length;
  return { plans, nodeCounts, singleNodeShare: plans === 0 ? 0 : single / plans, executors, features };
}

export function renderAudit(a: PlanAudit): string {
  const lines = [
    `plans=${a.plans} · 图规模分布 [${a.nodeCounts.join(',')}] · 1节点图 ${(a.singleNodeShare * 100).toFixed(0)}%`,
    `executors: ${JSON.stringify(a.executors)}`,
    '| 能力 | 使用 |', '|---|---|',
    ...TRACKED_FEATURES.map((k) => `| ${k} | ${a.features[k] ?? 0} |`),
  ];
  return lines.join('\n');
}

if (import.meta.main) {
  const batchDir = process.argv[2];
  if (!batchDir || !statSync(batchDir, { throwIfNoEntry: false })?.isDirectory()) {
    console.error('用法: bun scripts/bench-plan-audit.ts <results/<job>/<批时间戳> 目录>');
    process.exit(1);
  }
  const planObjs: unknown[] = [];
  let trials = 0;
  for (const ent of readdirSync(batchDir, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue; // 批目录里混着 job.log 等文件; ENOTDIR 在 statSync 是抛不是 undefined
    const trial = ent.name;
    const tgz = join(batchDir, trial, 'agent', 'omd-state.tgz');
    if (!statSync(tgz, { throwIfNoEntry: false })?.isFile()) continue;
    trials++;
    const tmp = mkdtempSync(join(tmpdir(), 'plan-audit-'));
    try {
      // 只抽 plan 面; tar 抽不出 (损坏/空包) → 记一行照常继续, 不静默 (仓规: fail-open 不吞证据)。
      execFileSync('tar', ['-xzf', tgz, '-C', tmp, '--wildcards', '.omd/hud/dag-*.json', '.omd/continuity/*/_dag.json'], { stdio: 'pipe' });
      const found: string[] = [];
      const walk = (d: string): void => {
        for (const e of readdirSync(d, { withFileTypes: true })) {
          const p = join(d, e.name);
          if (e.isDirectory()) walk(p);
          else if (e.name === '_dag.json' || /^dag-.*\.json$/.test(e.name)) found.push(p);
        }
      };
      walk(tmp);
      for (const f of found) {
        try { planObjs.push(JSON.parse(readFileSync(f, 'utf8'))); }
        catch (e) { console.error(`[plan-audit] ${trial}: ${f} 解析失败 — ${(e as Error).message}`); }
      }
    } catch (e) {
      console.error(`[plan-audit] ${trial}: tgz 抽取失败 — ${(e as Error).message}`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
  console.log(`批目录: ${batchDir} · trial=${trials}`);
  console.log(renderAudit(auditPlans(planObjs)));
}
