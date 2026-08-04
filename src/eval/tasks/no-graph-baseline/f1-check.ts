#!/usr/bin/env bun
/**
 * F1 点位校验器 (r2 no-graph 基线, 设计 docs/plan/2026-08-04-r2-no-graph-baseline-design.md 片1)。
 *
 * 点位表从**真实迁移** 2de591f (t7 切片三) 的 diff 生成: 12 文件 × 26 点位。
 * 每点位两半判据: 旧名独立词归零 (dag_run_plan 保护) + 新名计数 == 参考答案计数。
 * 输出: `命中/总点位` (每半点各 0.5 权重取整两半都过才算命中 —— 简化为: 两半都过=1, 否则 0)。
 *
 * 用法: bun run f1-check.ts --dir <快照目录>   (退出码: 全命中=0, 否则=1)
 *       bun run f1-check.ts --selftest         (对基线/答案快照自检点位表)
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const F1_SNAPSHOT_BEFORE = '428dd3e044857f644ca95839d0b6ecfe28d49c0c';
export const F1_SNAPSHOT_AFTER = '2de591f4ebbfe55f2bf670952e538aabff631681';

export interface F1Point { file: string; old: string; new: string; expectedNew: number }

export const F1_POINTS: F1Point[] = [
  { file: 'client-skills/README.md', old: 'dag_run', new: 'run', expectedNew: 5 },
  { file: 'client-skills/README.md', old: 'path_map', new: 'map_open', expectedNew: 1 },
  { file: 'client-skills/README.md', old: 'path_add', new: 'map_add', expectedNew: 2 },
  { file: 'client-skills/README.md', old: 'path_tickets', new: 'map_tickets', expectedNew: 1 },
  { file: 'client-skills/README.md', old: 'path_rule', new: 'map_rule', expectedNew: 1 },
  { file: 'client-skills/README.md', old: 'path_deliver', new: 'map_deliver', expectedNew: 1 },
  { file: 'client-skills/README.md', old: 'path_prefetch', new: 'map_prefetch', expectedNew: 2 },
  { file: 'client-skills/omd-audit/SKILL.md', old: 'dag_run', new: 'run', expectedNew: 4 },
  { file: 'client-skills/omd-audit/SKILL.md', old: 'path_add', new: 'map_add', expectedNew: 1 },
  { file: 'client-skills/omd-contract/SKILL.md', old: 'path_add', new: 'map_add', expectedNew: 1 },
  { file: 'client-skills/omd-council/SKILL.md', old: 'path_rule', new: 'map_rule', expectedNew: 1 },
  { file: 'client-skills/omd-deliver/SKILL.md', old: 'path_deliver', new: 'map_deliver', expectedNew: 2 },
  { file: 'client-skills/omd-execute/SKILL.md', old: 'dag_run', new: 'run', expectedNew: 5 },
  { file: 'client-skills/omd-grill/SKILL.md', old: 'path_add', new: 'map_add', expectedNew: 1 },
  { file: 'client-skills/omd-grill/SKILL.md', old: 'path_rule', new: 'map_rule', expectedNew: 2 },
  { file: 'client-skills/omd-iterate/SKILL.md', old: 'dag_run', new: 'run', expectedNew: 3 },
  { file: 'client-skills/omd-path/SKILL.md', old: 'path_map', new: 'map_open', expectedNew: 4 },
  { file: 'client-skills/omd-path/SKILL.md', old: 'path_add', new: 'map_add', expectedNew: 1 },
  { file: 'client-skills/omd-path/SKILL.md', old: 'path_tickets', new: 'map_tickets', expectedNew: 2 },
  { file: 'client-skills/omd-path/SKILL.md', old: 'path_rule', new: 'map_rule', expectedNew: 1 },
  { file: 'client-skills/omd-path/SKILL.md', old: 'path_prefetch', new: 'map_prefetch', expectedNew: 1 },
  { file: 'client-skills/omd-path/SKILL.md', old: 'path_init', new: 'map_init', expectedNew: 5 },
  { file: 'client-skills/omd-resume/SKILL.md', old: 'dag_run', new: 'run', expectedNew: 7 },
  { file: 'client-skills/omd-rule/SKILL.md', old: 'path_rule', new: 'map_rule', expectedNew: 2 },
  { file: 'client-skills/omd-tickets/SKILL.md', old: 'path_tickets', new: 'map_tickets', expectedNew: 4 },
  { file: 'client-skills/omd-tickets/SKILL.md', old: 'path_prefetch', new: 'map_prefetch', expectedNew: 1 }
];

const count = (text: string, word: string, protectPlan: boolean): number => {
  const re = new RegExp(`\\b${word}\\b`, 'g');
  let n = 0;
  for (const m of text.matchAll(re)) {
    if (protectPlan && text.slice(m.index! + word.length, m.index! + word.length + 5) === '_plan') continue;
    n++;
  }
  return n;
};

/** 对目录算分: 每点位 = 旧名归零 && 新名计数达标。 */
export function scoreF1(dir: string): { hit: number; total: number; misses: string[] } {
  let hit = 0;
  const misses: string[] = [];
  for (const p of F1_POINTS) {
    let text = '';
    try {
      text = readFileSync(join(dir, p.file), 'utf8');
    } catch {
      misses.push(`${p.file}: 读不到`);
      continue;
    }
    const oldLeft = count(text, p.old, p.old === 'dag_run');
    const newGot = count(text, p.new, false);
    if (oldLeft === 0 && newGot === p.expectedNew) hit++;
    else misses.push(`${p.file} ${p.old}→${p.new}: 旧余 ${oldLeft}, 新 ${newGot}/${p.expectedNew}`);
  }
  return { hit, total: F1_POINTS.length, misses };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const dirIdx = argv.indexOf('--dir');
  if (argv.includes('--selftest')) {
    // 自检: 基线快照应大量未命中, 答案快照应全命中 (archive 到 tmp)。
    const { execSync } = await import('node:child_process');
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    for (const [name, sha, expectFull] of [['基线', F1_SNAPSHOT_BEFORE, false], ['答案', F1_SNAPSHOT_AFTER, true]] as const) {
      const d = mkdtempSync(join(tmpdir(), 'f1-'));
      execSync(`git archive ${sha} client-skills | tar -x -C ${d}`, { stdio: 'inherit' });
      const s = scoreF1(d);
      const full = s.hit === s.total;
      console.log(`${name} ${sha.slice(0, 8)}: ${s.hit}/${s.total}${full === expectFull ? ' ✓' : ' ✗ 点位表有毛病'}`);
      if (full !== expectFull) process.exit(2);
    }
    process.exit(0);
  }
  if (dirIdx < 0) {
    console.error('用法: f1-check.ts --dir <快照目录> | --selftest');
    process.exit(2);
  }
  const s = scoreF1(argv[dirIdx + 1]!);
  console.log(`F1: ${s.hit}/${s.total}`);
  for (const m of s.misses.slice(0, 10)) console.log(`  ✗ ${m}`);
  process.exit(s.hit === s.total ? 0 : 1);
}
