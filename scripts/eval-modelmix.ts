#!/usr/bin/env bun
/**
 * scripts/eval-modelmix —— conductor-eval 的 model-mix sweep CLI 入口 (可复用 driver)。
 *
 * 跑 src/eval/oracles/conductor-modelmix 的网格: 每个 {conductorModel × leafModel} 格建 git-worktree、
 * 跑真 DAG build (fleet 照 spec+测试重建 3 个纯模块)、tsc+test 打分、按角色算成本 (R 次取均值)。
 * 串行 (INV-1: 并行争 provider 限流污染读数)。
 *
 *   bun --env-file="${FUSANG_HOME:-.}/.env" run scripts/eval-modelmix.ts [flags]
 *     --r N              每格重复次数 (默认 1; 真跑设 3 压 variance, SDD D3)
 *     --skip C1,C5       跳过 label 含这些子串的格 (如缺凭证的 C1 opus)
 *     --conductor <coord> --leaf <coord>   只跑这一个 ad-hoc 格 (覆盖网格; 用于单点复核)
 *     --fixture medium|large   任务规模 (默认 medium 3 模块; large 12 模块难度梯度, 高分辨率)
 *     --out <path>       报告落盘路径 (默认 /tmp/eval-modelmix-<ts>.md)
 *
 * 消费: stdout = leaderboard 表 (score=finalPass 质量排序键; detail 有 firstShot/heal/cost/unpriced/nodeCount);
 *   全文同步落 --out。stderr = 逐格进度。
 * ⚠ 烧钱烧时: 每格 R 次真 build (~5-8min/次); 4 格 × R=3 ≈ 1hr、$几十。先 `--r 1` 或单 `--conductor/--leaf` 冒烟。
 */
import '../src/harness/script-bootstrap';
import { bootstrapModelRuntime } from '../src/model/bootstrap';
import specFactory from '../src/eval/oracles/conductor-modelmix';
import { writeFileSync } from 'node:fs';

const flags: Record<string, string> = {};
const av = process.argv.slice(2);
for (let i = 0; i < av.length; i++) {
  const a = av[i]!;
  if (a.startsWith('--')) {
    const k = a.slice(2);
    const n = av[i + 1];
    if (n && !n.startsWith('--')) { flags[k] = n; i++; } else flags[k] = 'true';
  }
}

const r = flags.r ?? '1';
const outPath = flags.out ?? `/tmp/eval-modelmix-${Date.now()}.md`;

bootstrapModelRuntime();
const spec = specFactory({ r, skip: flags.skip ?? '', fixture: flags.fixture ?? 'medium', leafTimeout: flags['leaf-timeout'] ?? '' });

// --conductor + --leaf = ad-hoc 单格 (覆盖网格, 用于单点复核如 C5 重跑); 否则跑整网格。
const cells =
  flags.conductor && flags.leaf
    ? [{ label: `adhoc ${flags.conductor}/${flags.leaf}`, config: { conductorModel: flags.conductor, leafModel: flags.leaf } }]
    : spec.seed();

process.stderr.write(`[eval-modelmix] ${cells.length} 格 × R=${r}: ${cells.map((c) => c.label).join(' | ')}\n`);

const results: Array<{ label: string; score?: number; detail?: unknown; error?: string; sec: number }> = [];
for (const c of cells) {
  const t = Date.now();
  process.stderr.write(`[eval-modelmix] measuring ${c.label} ...\n`);
  try {
    const res = await spec.measure(c);
    results.push({ label: c.label, score: res.score, detail: res.detail, sec: Math.round((Date.now() - t) / 1000) });
    process.stderr.write(`  ✓ ${Math.round((Date.now() - t) / 1000)}s · score=${res.score.toFixed(3)}\n`);
  } catch (e) {
    results.push({ label: c.label, error: (e as Error).message, sec: Math.round((Date.now() - t) / 1000) });
    process.stderr.write(`  ✗ ${Math.round((Date.now() - t) / 1000)}s · ${(e as Error).message.slice(0, 140)}\n`);
  }
}

results.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
const body = [
  `# eval model-mix sweep (R=${r})`,
  '',
  '| cell | score | sec | detail |',
  '|---|---|---|---|',
  ...results.map(
    (x) => `| ${x.label} | ${x.score?.toFixed(3) ?? 'ERR'} | ${x.sec} | ${x.error ? `❌ ${x.error}` : JSON.stringify(x.detail)} |`,
  ),
].join('\n');
writeFileSync(outPath, body + '\n');
console.log(`📄 落盘: ${outPath}\n`);
console.log(body);
