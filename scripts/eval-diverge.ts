/**
 * eval-diverge —— 跨家族发散 A/B eval (owner 2026-07-27)。
 *
 * 同一 question、同一检索 (靠 retrieveWeb 15min 缓存令 3 臂 corpus 对齐), 只变模型分配, 隔离"发散"变量:
 *   A-mono   : 全 mimo-v2.5 (单族基线, 现状)
 *   B-sol    : 多家族发散 (lens/synth 发散池 + judge 3 族) · fusion/graft = gpt-5.6-sol (强终笔)
 *   B-v2.5   : 同发散 · fusion/graft = mimo-v2.5-pro (测终笔要不要强)
 *
 * 三轴读: 质量 (终稿存盘, 人/judge 读) · 耗时 (墙钟) · 经济 (costStats.totalUsd + per-family 分布证明发散)。
 * 跑: bun run scripts/eval-diverge.ts "<研究问题>" [--crawl N]
 */
import { researchWebFanout } from '../src/harness/research/web-fanout';
import { createWebStackFromEnv } from '../src/harness/web';
import { bootstrapModelRuntime } from '../src/model/bootstrap';
import { modelFamily } from '../src/model/channels';
import { mkdirSync, writeFileSync } from 'node:fs';

const question =
  process.argv[2]?.trim() ||
  'MCP (Model Context Protocol) 生态 2026 年中盘点: spec 演进、安全事件与攻击面、客户端与服务端采用格局。';
const crawlArg = process.argv.indexOf('--crawl');
const crawl = crawlArg >= 0 ? Number(process.argv[crawlArg + 1]) : 3;

const MONO = 'xiaomi-token-plan-ams:mimo-v2.5'; // mimo 真订阅 (token-plan, cost0)
const arms: { name: string; opts: Record<string, unknown> }[] = [
  {
    name: 'A-mono-v2.5',
    opts: { divergePool: [MONO], judgePool: [MONO], lensModel: MONO, reasonModel: MONO, reduceModel: MONO, judgeModel: MONO, fusionModel: MONO, graftModel: MONO },
  },
  { name: 'B-sol', opts: { fusionModel: 'openai-codex:gpt-5.6-sol', graftModel: 'openai-codex:gpt-5.6-sol' } },
  { name: 'B-v2.5', opts: { fusionModel: 'xiaomi-token-plan-ams:mimo-v2.5-pro', graftModel: 'xiaomi-token-plan-ams:mimo-v2.5-pro' } },
];

const stack = createWebStackFromEnv();
bootstrapModelRuntime();
const OUT = '/tmp/eval-diverge';
mkdirSync(OUT, { recursive: true });

const rows: string[] = [];
for (const arm of arms) {
  process.stderr.write(`\n═══ ${arm.name} ═══\n`);
  const t0 = Date.now();
  const res = await researchWebFanout(stack, question, {
    crawl,
    council: false, // 固定 DEFAULT_WEB_LENSES (3 视角) → 3 臂可比; council 会引入分解噪声
    rounds: 1,
    onWarn: (m) => process.stderr.write(`  [warn] ${m}\n`),
    onStage: (s, d) => process.stderr.write(`  [${s}] ${d}\n`),
    ...arm.opts,
  });
  const wall = ((Date.now() - t0) / 1000).toFixed(0);
  const cs = res.fanout.costStats;
  // per-family 分布 (证明发散真发生)
  const famCalls = new Map<string, number>();
  for (const [coord, st] of Object.entries(cs.perModel)) {
    const f = modelFamily(coord);
    famCalls.set(f, (famCalls.get(f) ?? 0) + (st as { calls: number }).calls);
  }
  const famStr = [...famCalls.entries()].map(([f, c]) => `${f}:${c}`).join(' ');
  writeFileSync(`${OUT}/${arm.name}.md`, res.fanout.final);
  rows.push(
    `${arm.name.padEnd(13)} | 墙钟 ${wall}s | $${cs.totalUsd.toFixed(4)} | leaf ${res.fanout.leafCount} | 终稿 ${res.fanout.final.length} chars | 家族分布 [${famStr}]`,
  );
  process.stderr.write(`  → ${rows[rows.length - 1]}\n`);
}

process.stdout.write(`\n\n════════ 发散 A/B 对比 (question: ${question.slice(0, 40)}…) ════════\n`);
for (const r of rows) process.stdout.write(r + '\n');
process.stdout.write(`\n终稿存盘: ${OUT}/{A-mono-v2.5,B-sol,B-v2.5}.md — 质量对比请读三份终稿 (或喂 judge)。\n`);
process.stdout.write('读法: A vs B-sol = 发散+多族判优值不值; B-sol vs B-v2.5 = 终笔用强模型值不值。\n');
