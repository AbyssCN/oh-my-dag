#!/usr/bin/env bun
/**
 * scripts/dag-research —— oh-my-dag 原生 web 研究路径 (派活专用)。
 *
 * 检索调研一条龙: 确定性搜+爬+清洗 (零丢失语料) → 喂 researchFanout 多-lens 综合 + K-judge 判优 → 终稿。
 *
 *   bun run scripts/dag-research.ts "<研究问题>" [--council] [--super] [--k 8] [--crawl 5]
 *                                               [--no-tier] [--lens-count N] [--conductor-model M]
 *                                               [--lens-model ds:..] [--reason-model ds:..] [--out path]
 *   --no-tier  = 关信源分档重排 (默认开: crawl 槽位优先一手/权威源, 农场域降权不删 —
 *                见 src/harness/web/source-tier.ts)
 *   --council  = 检索后让 conductor (authorFanoutSpec) 按语料自动分解 lens, 替代默认 3 视角
 *                (= 检索 + dag-council 的合体: 自动抓料 + 自动拆镜头 + fanout 综合判优)
 *   --lens-count N / --conductor-model M = council 旋钮
 *   产物: 终稿 + lens 冠军 + 成本 + **全文语料附录** 落盘; stdout 打印终稿 (这才是要的答案)。
 *
 * lens 三档: 默认通用 3 视角(证据/批判/实践) / --council conductor 自动分解 / 代码内传 lenses 显式指定。
 * 模型默认全 flash (reason 覆盖: --reason-model / OMD_REASON_MODEL)。
 */
import '../src/harness/script-bootstrap';
import { createWebStackFromEnv } from '../src/harness/web';
import { researchWebFanout } from '../src/harness/research/web-fanout';
import { bootstrapModelRuntime } from '../src/model/bootstrap';

const USAGE =
  'usage: bun run scripts/dag-research.ts "<研究问题>" [--council] [--super] [--k 8] [--crawl 5] [--no-tier] [--lens-count N] [--conductor-model M] [--lens-model ..] [--reason-model ..] [--out path]';

const BOOL = new Set(['super', 'council', 'no-tier', 'help']);
const flags: Record<string, string> = {};
const positionals: string[] = [];
const av = process.argv.slice(2);
for (let i = 0; i < av.length; i++) {
  const a = av[i]!;
  if (a.startsWith('--')) {
    const key = a.slice(2);
    if (BOOL.has(key)) flags[key] = 'true';
    else flags[key] = av[++i] ?? '';
  } else positionals.push(a);
}
if (flags.help) {
  console.log(USAGE);
  process.exit(0);
}
const question = positionals.join(' ').trim();
if (!question) {
  console.error(USAGE);
  process.exit(1);
}

/** 数字旗标校验: 缺省→undefined; 非整数或 <min→报错退出 (防 NaN 透传)。 */
function numFlag(name: string, min: number): number | undefined {
  const v = flags[name];
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min) {
    console.error(`[dag-research] --${name} 需 >=${min} 的整数 (得到 "${v}")`);
    process.exit(1);
  }
  return n;
}

let stack: ReturnType<typeof createWebStackFromEnv>;
try {
  stack = createWebStackFromEnv();
} catch (e) {
  console.error(`[dag-research] web stack 装配失败: ${(e as Error).message}`);
  process.exit(1);
}
bootstrapModelRuntime(); // bootstrap providers (从 .env), 否则 fanout callModel 无 provider

const res = await researchWebFanout(stack, question, {
  mode: flags.super ? 'aggregate' : undefined,
  k: numFlag('k', 1),
  crawl: numFlag('crawl', 0), // 0 = 只搜不抓
  tierRank: !flags['no-tier'],
  council: !!flags.council, // conductor 按语料自动分解 lens 替代默认 3 视角
  conductorModel: flags['conductor-model'],
  lensCount: numFlag('lens-count', 1),
  lensModel: flags['lens-model'],
  reasonModel: flags['reason-model'],
  onStage: (s, d) => process.stderr.write(`  [${s}] ${d}\n`),
});

const { retrieval: r, fanout: f } = res;

// ---- 落盘: 终稿 + 冠军 + 成本 + 全文语料附录 (零丢失) ----
const doc: string[] = [];
doc.push(`# 研究: ${question}`, '');
doc.push(`> ${f.leafCount} leaves · $${f.costStats.totalUsd.toFixed(4)} · 检索命中 ${r.sources.length} · 抓取 ${r.sources.filter((s) => s.body).length}`, '');
doc.push('## 终稿 (综合判优)', '', f.final, '');
doc.push('## Lens 冠军 (各视角最优)', '');
for (const c of f.lensChampions) doc.push(`### ${c.key}`, c.text, '');
doc.push('---', '', '## 检索语料附录 (零丢失, 综合的事实锚)', '', r.markdown);
const slug = question.toLowerCase().replace(/[^a-z0-9一-鿿]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'research';
const out = flags.out || `/tmp/dag-research-${slug}-${Date.now()}.md`;
await Bun.write(out, doc.join('\n'));

// ---- stdout: 终稿就是要的答案 (进调用方 context); 语料/冠军在文件 ----
process.stderr.write(`\n[dag-research] ${f.leafCount} leaves · $${f.costStats.totalUsd.toFixed(4)} (saved $${f.costStats.totalSavingsUsd.toFixed(4)}) → ${out}\n\n`);
console.log(f.final);
if (r.needsBrowserHarness.length) {
  console.log('\n---\n⚠️ 部分源全 provider 抓取失败 (未进语料, 需人工/浏览器接管):');
  r.needsBrowserHarness.forEach((u) => console.log(`   - ${u}`));
}
