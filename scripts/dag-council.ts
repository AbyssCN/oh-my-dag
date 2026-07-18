#!/usr/bin/env bun
/**
 * scripts/dag-council.ts — headless driver: conductor-authored fanout spec → researchFanout.
 *
 * 替代手写 lens-spec 的 dag-fanout.ts。Conductor 按 goal+groundTruth 自动 author 出
 * 领域专家 ResearchFanoutConfig, 再跑 researchFanout 并发探索。
 *
 * 用法:
 *   bun run scripts/dag-council.ts <goal-and-groundtruth.json>
 *
 * 输入 JSON 格式:
 *   { goal, groundTruth, conductorModel?, lensCount?, lensModel?, reasonModel? }
 *
 * 输出:
 *   1. stderr: conductor authored 的 lens keys + personas (验证分解对不对) + 进度。
 *   2. stdout: 首行 = 落盘路径, 然后 lens champions + candidates + final (标记段落,
 *      下游 split 依赖此格式, 勿改 marker)。
 *   3. **全文落盘 /tmp/dag-council-<slug>-<ts>.md (零丢失, 每 run 独立路径)** —
 *      教训: 固定路径会被并发/历史 run 覆盖, 消费别 run 的产出。
 */
import '../src/harness/script-bootstrap';
import { authorFanoutSpec } from '../src/harness/research/author-spec';
import { researchFanout } from '../src/harness/research/fanout';
import { bootstrapModelRuntime } from '../src/model/bootstrap';
import { readFileSync, writeFileSync } from 'node:fs';

const USAGE = 'usage: bun run scripts/dag-council.ts <goal-and-groundtruth.json>\n' +
  '  输入 JSON: { goal, groundTruth, conductorModel?, lensCount?, lensModel?, reasonModel? }';

/** goal → 文件名 slug (对齐 dag-fanout 的 /tmp 命名模式)。 */
function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9一-鿿]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

type Input = {
  goal: string;
  groundTruth: string;
  conductorModel?: string;
  lensCount?: number;
  lensModel?: string;
  reasonModel?: string;
};

const specPath = process.argv[2];
if (specPath === '--help') {
  console.log(USAGE);
  process.exit(0);
}
if (!specPath) {
  console.error(USAGE);
  process.exit(1);
}

const raw: Input = JSON.parse(readFileSync(specPath, 'utf8'));
if (!raw.goal || !raw.groundTruth) {
  console.error('输入 JSON 需要 goal + groundTruth 字段');
  process.exit(1);
}

bootstrapModelRuntime(); // bootstrap providers (从 .env)

// ── Step 1: conductor author 出 lens spec ──
process.stderr.write('[conductor] authoring fanout spec...\n');
const config = await authorFanoutSpec({
  goal: raw.goal,
  groundTruth: raw.groundTruth,
  conductorModel: raw.conductorModel,
  lensCount: raw.lensCount,
});

// 打印 conductor 分解出的 lens keys + personas (让调用方验证分解对不对)
process.stderr.write(`\n[conductor] authored ${config.lenses.length} lenses:\n`);
for (const lens of config.lenses) {
  process.stderr.write(`  • ${lens.key} (${lens.subAngles.length} sub-angles)\n`);
  process.stderr.write(`    persona: ${lens.persona.slice(0, 120)}${lens.persona.length > 120 ? '…' : ''}\n`);
}
process.stderr.write(`\n[conductor] synthesisFramings: ${config.synthesisFramings.map(f => f.key).join(', ')}\n`);
process.stderr.write(`[conductor] judgeCriteria: ${config.judgeCriteria.map(c => c.key).join(', ')}\n`);

// 应用 CLI 提供的模型覆盖 (如有)
if (raw.lensModel) config.lensModel = raw.lensModel;
if (raw.reasonModel) config.reasonModel = raw.reasonModel;

// ── Step 2: researchFanout (与 dag-fanout.ts 同一引擎) ──
process.stderr.write('\n[council] researchFanout 启动...\n');
const res = await researchFanout({
  ...config,
  onStage: (s, d) => process.stderr.write(`  [${s}] ${d}\n`),
});

process.stderr.write(`\n[council] ${res.leafCount} leaves · $${res.costStats.totalUsd.toFixed(4)} (saved $${res.costStats.totalSavingsUsd.toFixed(4)})\n\n`);

// ── Step 3: 全文落盘 (先于 stdout — 即使消费方截断 stdout 也零丢失) ──
const sections = [
  '===== LENS CHAMPIONS =====',
  ...res.lensChampions.map((c) => `\n## ${c.key}\n${c.text}`),
  '\n===== SYNTHESIS CANDIDATES =====',
  ...res.synthCandidates.map((s) => `\n## ${s.key}\n${s.text}`),
  '\n===== FINAL =====\n' + res.final,
].join('\n');

const artifactPath = `/tmp/dag-council-${slugify(raw.goal)}-${Date.now()}.md`;
writeFileSync(
  artifactPath,
  `<!-- dag-council zero-loss artifact · ${new Date().toISOString()} -->\n` +
  `<!-- goal: ${raw.goal.slice(0, 200).replace(/\n/g, ' ')} -->\n` +
  `<!-- lenses: ${config.lenses.map((l) => l.key).join(', ')} · leaves: ${res.leafCount} · cost: $${res.costStats.totalUsd.toFixed(4)} -->\n\n` +
  sections + '\n',
);

// ── Step 4: stdout (首行=路径; marker 段落格式勿改 — 下游 split 依赖) ──
console.log(`📄 全文落盘: ${artifactPath}`);
console.log(sections);
