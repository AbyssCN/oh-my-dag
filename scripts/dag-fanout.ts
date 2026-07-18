#!/usr/bin/env bun
/**
 * dag-fanout — 调用方手写 lens-spec → oh-my-dag fleet researchFanout 并发探索 → 打印 final+champions。
 *
 * 角色: 调用方 (conductor) 只写 lens 规格 + groundTruth, fleet 并发跑 L×V leaves + judge + synth,
 *       调用方在 final/champions 上终裁。**不再手动派 N 个 subagent**。
 *
 *   bun run scripts/dag-fanout.ts <spec.json>
 * spec.json: { question, groundTruth, lenses:[{key,persona,subAngles:[...]}], synthesisFramings, judgeCriteria,
 *              lensModel?, reasonModel? }  (model 默认 flash/pro, 走 .env)
 */
import '../src/harness/script-bootstrap';
import { researchFanout } from '../src/harness/research/fanout';
import { bootstrapModelRuntime } from '../src/model/bootstrap';
import { readFileSync, writeFileSync } from 'node:fs';

const USAGE = 'usage: bun run scripts/dag-fanout.ts <spec.json>\n' +
  '  spec.json: { question, groundTruth, lenses:[{key,persona,subAngles:[...]}], synthesisFramings?, judgeCriteria?, lensModel?, reasonModel? }';

const specPath = process.argv[2];
if (specPath === '--help') { console.log(USAGE); process.exit(0); }
if (!specPath) { console.error(USAGE); process.exit(1); }
const spec = JSON.parse(readFileSync(specPath, 'utf8'));

/** question/spec 名 → 文件名 slug (对齐 dag-council /tmp 命名)。 */
function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9一-鿿]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

bootstrapModelRuntime(); // bootstrap providers (从 .env)

const res = await researchFanout({
  question: spec.question,
  groundTruth: spec.groundTruth,
  lenses: spec.lenses,
  synthesisFramings: spec.synthesisFramings ?? [{ key: 'default', framing: '综合各 lens 冠军, 给可执行裁决建议' }],
  judgeCriteria: spec.judgeCriteria ?? [{ key: 'correctness', criterion: '事实/工程正确性' }, { key: 'actionable', criterion: '可直接转实装/测试' }],
  lensModel: spec.lensModel ?? process.env.OMD_LENS_MODEL ?? 'deepseek:deepseek-v4-flash',
  reasonModel: spec.reasonModel ?? process.env.OMD_REASON_MODEL ?? 'deepseek:deepseek-v4-pro',
  onStage: (s, d) => process.stderr.write(`  [${s}] ${d}\n`),
});

process.stderr.write(`\n[dag-fanout] ${res.leafCount} leaves · $${res.costStats.totalUsd.toFixed(4)} (saved $${res.costStats.totalSavingsUsd.toFixed(4)})\n\n`);

// 全文落盘 (零丢失, 每 run 独立路径 — 固定路径会被并发/历史 run 覆盖) + stdout 首行=路径
const sections = [
  '===== LENS CHAMPIONS =====',
  ...res.lensChampions.map((c) => `\n## ${c.key}\n${c.text}`),
  '\n===== FINAL (synth) =====\n' + res.final,
].join('\n');
const artifactPath = `/tmp/dag-fanout-${slugify(String(spec.question ?? specPath))}-${Date.now()}.md`;
writeFileSync(artifactPath, `<!-- dag-fanout zero-loss artifact · ${new Date().toISOString()} -->\n\n${sections}\n`);
console.log(`📄 全文落盘: ${artifactPath}`);
console.log(sections);
