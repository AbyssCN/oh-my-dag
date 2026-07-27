/**
 * eval-diverge —— 跨家族发散 A/B eval v2 (owner 2026-07-27)。
 *
 * 修正 v1 的检索污染: 检索**只跑一次** (aggregate 全 provider 并行去重 + expander query 扩展 +
 * distiller 巨源蒸馏 + 尽量多爬), 把那份 groundTruth 原样喂两臂 → 只有模型分配变, corpus 逐字节相同。
 *
 * 两臂只在 synth + judge 一处不同 (单变量):
 *   A-mono : 检索/lens = mimo-v2.5; reduce/synth/judge/fusion/graft = mimo-v2.5-pro (全 mimo 分档)
 *   B-div  : 同 A, 但 synth 走发散池 (多族) · judge 走 judge 池 (多族) —— 智能只花在综合+评判
 * 跑: bun run scripts/eval-diverge.ts "<问题>" [--crawl N]
 */
import { researchFanout, type ResearchFanoutConfig } from '../src/harness/research/fanout';
import {
  assembleGroundTruth,
  DEFAULT_WEB_LENSES,
  DEFAULT_WEB_FRAMINGS,
  DEFAULT_WEB_JUDGES,
  DEFAULT_WEB_STABLE_PREFIX,
  LENS_DIVERGENCE_POOL,
  LENS_DIVERGENCE_WEIGHTS,
  JUDGE_PANEL_POOL,
} from '../src/harness/research/web-fanout';
import { retrieveWeb, createModelQueryExpander, createModelSourceDistiller, createWebStackFromEnv } from '../src/harness/web';
import { bootstrapModelRuntime } from '../src/model/bootstrap';
import { modelFamily } from '../src/model/channels';
import { mkdirSync, writeFileSync } from 'node:fs';

const question =
  process.argv[2]?.trim() ||
  'MCP (Model Context Protocol) 生态 2026 年中盘点: spec 演进、安全事件与攻击面、客户端与服务端采用格局。';
const crawlArg = process.argv.indexOf('--crawl');
const crawl = crawlArg >= 0 ? Number(process.argv[crawlArg + 1]) : 8;

const V25 = 'xiaomi-token-plan-ams:mimo-v2.5';
const PRO = 'xiaomi-token-plan-ams:mimo-v2.5-pro';

const stack = createWebStackFromEnv();
bootstrapModelRuntime();
const onStage = (s: string, d: string) => process.stderr.write(`  [${s}] ${d}\n`);

// ── 检索只跑一次 (aggregate + expander + distiller + 多爬) → 固定 corpus 喂两臂 ──
process.stderr.write('═══ 检索 (一次, 喂两臂) ═══\n');
const retrieval = await retrieveWeb(stack, question, {
  mode: 'aggregate', // 全 provider 并行去重 (稳 + 全), 非 rotate 轮转
  crawl, // 尽量多爬
  expander: createModelQueryExpander({ model: V25 }), // query 扩展 (召回)
  distiller: createModelSourceDistiller({ model: V25 }), // 巨源蒸馏
  onWarn: (m) => process.stderr.write(`  [warn] ${m}\n`),
});
const groundTruth = assembleGroundTruth(undefined, retrieval.markdown, []);
process.stderr.write(
  `  → 命中 ${retrieval.sources.length} · 抓取 ${retrieval.sources.filter((s) => s.body).length} · 语料 ${groundTruth.length} chars (两臂共用)\n`,
);

// arm.opts = 只放两臂差异 (synth+judge); 公共字段在 researchFanout 调用里统一给。
const arms: { name: string; opts: Partial<ResearchFanoutConfig> }[] = [
  { name: 'A-mono', opts: {} }, // synth/judge 走 base 默认 (mimo-v2.5-pro)
  {
    name: 'B-div',
    opts: {
      synthPool: LENS_DIVERGENCE_POOL, // synth M framing 走发散池 (多族)
      divergeWeights: LENS_DIVERGENCE_WEIGHTS,
      judgePool: JUDGE_PANEL_POOL, // judge K 维度走 3 族
    },
  },
];

const OUT = '/tmp/eval-diverge';
mkdirSync(OUT, { recursive: true });
const rows: string[] = [];
for (const arm of arms) {
  process.stderr.write(`\n═══ ${arm.name} ═══\n`);
  const t0 = Date.now();
  const res = await researchFanout({
    ...arm.opts, // 差异字段先铺 (不覆盖下面的必填/公共)
    question,
    stablePrefix: DEFAULT_WEB_STABLE_PREFIX,
    groundTruth,
    lenses: DEFAULT_WEB_LENSES,
    synthesisFramings: DEFAULT_WEB_FRAMINGS,
    judgeCriteria: DEFAULT_WEB_JUDGES,
    // 公共: 检索/lens = v2.5; reduce/synth/judge/fusion/graft = v2.5-pro (B 的 synth/judge 被上面池覆盖)
    lensModel: V25,
    reduceModel: PRO,
    reasonModel: PRO,
    judgeModel: PRO,
    fusionModel: PRO,
    graftModel: PRO,
    onStage,
  });
  const wall = ((Date.now() - t0) / 1000).toFixed(0);
  const famCalls = new Map<string, number>();
  for (const [coord, st] of Object.entries(res.costStats.perModel)) {
    const f = modelFamily(coord);
    famCalls.set(f, (famCalls.get(f) ?? 0) + (st as { calls: number }).calls);
  }
  const famStr = [...famCalls.entries()].map(([f, c]) => `${f}:${c}`).join(' ');
  writeFileSync(`${OUT}/${arm.name}.md`, res.final);
  rows.push(`${arm.name.padEnd(8)} | 墙钟 ${wall}s | leaf ${res.leafCount} | 终稿 ${res.final.length} chars | [${famStr}]`);
  process.stderr.write(`  → ${rows[rows.length - 1]}\n`);
}

process.stdout.write(`\n════════ 发散 A/B v2 (同 corpus ${groundTruth.length} chars, 只差 synth+judge) ════════\n`);
for (const r of rows) process.stdout.write(r + '\n');
process.stdout.write(`\n终稿: ${OUT}/{A-mono,B-div}.md — A=synth/judge 走 mimo-v2.5-pro; B=synth 发散池 + judge 3 族; 其余全同。\n`);
