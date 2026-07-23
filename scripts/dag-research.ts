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
 *   --no-expand = 关 query 扩展 (默认开: 检索前一次 flash 改写 → 原+改写多轮搜 → URL 去重 →
 *                扩召回; 爬取槽数不变 = 成本天花板不变; 改写失败退回单 query 不断链)
 *   --expand-model M = 改写模型 (默认 OMD_EXPAND_MODEL → deepseek-v4-flash)
 *   --council  = 检索后让 conductor (authorFanoutSpec) 按语料自动分解 lens, 替代默认 3 视角
 *                (= 检索 + dag-council 的合体: 自动抓料 + 自动拆镜头 + fanout 综合判优)
 *   --lens-count N / --conductor-model M = council 旋钮
 *   产物: 终稿 + lens 冠军 + 成本 + **全文语料附录** 落盘; stdout 打印终稿 (这才是要的答案)。
 *
 * lens 三档: 默认通用 3 视角(证据/批判/实践) / --council conductor 自动分解 / 代码内传 lenses 显式指定。
 * 模型默认全 flash (reason 覆盖: --reason-model / OMD_REASON_MODEL)。
 */
import '../src/harness/script-bootstrap';
import { createWebStackFromEnv, createModelQueryExpander, createModelSourceDistiller } from '../src/harness/web';
import { researchWebFanout } from '../src/harness/research/web-fanout';
import { CHILDREN_INSTRUCTION, writeResultAtomic } from '../src/harness/pathfinder/result-format';
import { bootstrapModelRuntime } from '../src/model/bootstrap';

const USAGE =
  'usage: bun run scripts/dag-research.ts "<研究问题>" [--council] [--super] [--k 8] [--crawl 5] [--no-tier] [--no-expand] [--expand-model M] [--no-distill] [--distill-model M] [--distill-threshold N] [--lens-count N] [--conductor-model M] [--lens-model ..] [--reason-model ..] [--children] [--out path]';

const BOOL = new Set(['super', 'council', 'no-tier', 'no-expand', 'no-distill', 'children', 'help']);
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
  // 未传 --crawl → numFlag 返 undefined → retrieveWeb 走分层感知预算 (按候选 tier-A 数定爬数);
  // 显式 --crawl N 覆盖 (N=0 = 只搜不抓, 尊重用户)。
  crawl: numFlag('crawl', 0),
  tierRank: !flags['no-tier'],
  // query 扩展 (增益非链路): 检索前一次 flash 改写 → 多轮搜索 URL 去重。--no-expand 关 (A/B 对照)。
  expander: flags['no-expand'] ? undefined : createModelQueryExpander({ model: flags['expand-model'] }),
  // per-source 蒸馏 (增益非链路 · 零丢失): 清洗后正文 > 阈值的巨源, 喂 lens 的语料换精简视图 (原文全量
  // 留附录)。默认开 (阈值门控 = 无巨源时零调用零成本); --no-distill 关 (A/B 对照)。
  distiller: flags['no-distill'] ? undefined : createModelSourceDistiller({ model: flags['distill-model'] }),
  distillThreshold: numFlag('distill-threshold', 1),
  onWarn: (m) => process.stderr.write(`  [warn] ${m}\n`),
  council: !!flags.council, // conductor 按语料自动分解 lens 替代默认 3 视角
  conductorModel: flags['conductor-model'],
  lensCount: numFlag('lens-count', 1),
  lensModel: flags['lens-model'],
  reasonModel: flags['reason-model'],
  // --children (pathfinder D-10 opt-in): 终稿末尾按共享契约附 `## children` 段 → afk-hook 自展开子票。
  ...(flags.children ? { finalExtraInstruction: CHILDREN_INSTRUCTION } : {}),
  onStage: (s, d) => process.stderr.write(`  [${s}] ${d}\n`),
});

const { retrieval: r, fanout: f } = res;

// 爬取预算留痕: 分层感知算出还是显式指定 (stderr, 不进答案 context)。
process.stderr.write(`  [budget] ${r.crawlBudget}\n`);

// 蒸馏留痕: 哪个源被蒸馏 + 原长→蒸馏后长 (stderr, 不进答案 context)。
for (const d of r.distilled) {
  process.stderr.write(`  [distill] ${d.url} — 原文 ${d.origLen} → extract ${d.extractLen} chars (lens 语料精简; 原文全文进附录)\n`);
}

// ---- 落盘: 终稿 + 冠军 + 成本 + 全文语料附录 (零丢失) ----
const doc: string[] = [];
doc.push(`# 研究: ${question}`, '');
doc.push(`> ${f.leafCount} leaves · $${f.costStats.totalUsd.toFixed(4)} · 检索命中 ${r.sources.length} · 抓取 ${r.sources.filter((s) => s.body).length}`, '');
doc.push('## 终稿 (综合判优)', '', f.final, '');
doc.push('## Lens 冠军 (各视角最优)', '');
for (const c of f.lensChampions) doc.push(`### ${c.key}`, c.text, '');
// 附录用 fullCorpus (永不蒸馏, 零丢失红线): 每源原文全文都在, 与喂 lens 的 r.markdown 分离。
doc.push('---', '', '## 检索语料附录 (零丢失, 综合的事实锚)', '', r.fullCorpus);
const slug = question.toLowerCase().replace(/[^a-z0-9一-鿿]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'research';
const out = flags.out || `/tmp/dag-research-${slug}-${Date.now()}.md`;
// 原子落盘 (tmp+rename, result-format 共享契约): pathfinder afk-hook 以文件存在为就绪信号,
// 直写最终路径会被 4s 轮询读到半截并把票永久定格成截断裁决。
writeResultAtomic(out, doc.join('\n'));

// ---- stdout: 终稿就是要的答案 (进调用方 context); 语料/冠军在文件 ----
process.stderr.write(`\n[dag-research] ${f.leafCount} leaves · $${f.costStats.totalUsd.toFixed(4)} (saved $${f.costStats.totalSavingsUsd.toFixed(4)}) → ${out}\n\n`);
console.log(f.final);
if (r.needsBrowserHarness.length) {
  console.log('\n---\n⚠️ 部分源全 provider 抓取失败 (未进语料, 需人工/浏览器接管):');
  r.needsBrowserHarness.forEach((u) => console.log(`   - ${u}`));
}
