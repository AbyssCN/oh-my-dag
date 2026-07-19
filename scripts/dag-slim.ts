#!/usr/bin/env bun
/**
 * scripts/dag-slim —— oh-my-dag 过度工程专审 (只删不修; ponytail-review 方法论的引擎 DAG 版)。
 *
 * 与 dag-review 分工: dag-review 找 bug (correctness/security/...), dag-slim 找**该删的**。
 * 两遍纪律, **全局遍先行** (-50% 的赢面在系统视野, 不在逐行抠):
 *   Pass 1 GLOBAL: 一个 reviewer (更强模型槽) 吃整个改动面 → dedup / collapse / layer / couple。
 *   Pass 2 LOCAL: diff 按文件切 chunk → 程序化预构造 ConductorPlan (每文件一个 inproc leaf +
 *     synth 去重) → runExecutorDagWithPlan 并发 → delete / stdlib / native / yagni。
 * 每条 prompt 注入 PONYTAIL_DISCIPLINE + DESIGN_VOCAB (design-vocab 单一真相源)。
 * 护栏: 文档化 DEFER/契约面/刻意 seam ≠ finding · 少行数永不少 case。
 *
 *   bun run scripts/dag-slim.ts [--base main] [--staged] [--paths "a,b"] [--model M]
 *                               [--global-model M] [--no-global|--no-local] [--verify] [--out p]
 *
 * 出口: 一条 finding 一行 `<kind>: <file:line> — cut <what>, replace with <what>`, Global 组在前;
 * 全文落盘 /tmp/omd-slim-<ts>.md (--out 覆盖), stdout 只出单行清单。空 diff → exit 2。
 * --verify = 复用 review/verify 证伪收敛层 (REFUTED 留档, 出口只放 CONFIRMED/UNVERIFIED)。
 * 模型: 局部 --model > OMD_SLIM_MODEL > OMD_LEAF_MODEL > ds-flash;
 *       全局 --global-model > OMD_SLIM_GLOBAL_MODEL > OMD_REVIEW_FIND_MODEL > ds-pro (更强槽)。
 * finding≠ground truth, 调用方终裁。
 */
import '../src/harness/script-bootstrap';
import { buildGlobalPrompt, GLOBAL_KINDS, LOCAL_KINDS } from '../src/harness/slim/prompts';
import { splitDiffByFile, buildLocalPlan, SYNTH_NODE_ID } from '../src/harness/slim/local-plan';
import { extractFindingLines, formatReport } from '../src/harness/slim/findings';
import { runExecutorDagWithPlan } from '../src/harness/executor-dag';
import { verifyFindings } from '../src/harness/review/verify';
import { bootstrapModelRuntime } from '../src/model/bootstrap';
import { send } from '../src/model/gateway';
import { $ } from 'bun';

const USAGE =
  'usage: bun run scripts/dag-slim.ts [--base main] [--staged] [--paths "a,b"] [--model M] [--global-model M] [--no-global|--no-local] [--verify] [--out p]\n' +
  '  过度工程专审 (只删不修): Pass1 全局 (dedup/collapse/layer/couple, 先跑) + Pass2 局部 per-file (delete/stdlib/native/yagni)。\n' +
  '  bug 审查走 dag-review; 行为倾向走 skills/ponytail; 债务台账走 scripts/omd-debt.ts。';

// ---- args (dag-review 同款 idiom) ----
const BOOL = new Set(['staged', 'no-global', 'no-local', 'verify', 'help']);
const flags: Record<string, string> = {};
const av = process.argv.slice(2);
for (let i = 0; i < av.length; i++) {
  const a = av[i]!;
  if (a.startsWith('--')) {
    const key = a.slice(2);
    if (BOOL.has(key)) flags[key] = 'true';
    else flags[key] = av[++i] ?? '';
  }
}
if (flags.help) {
  console.log(USAGE);
  process.exit(0);
}
const wantGlobal = !flags['no-global'];
const wantLocal = !flags['no-local'];
if (!wantGlobal && !wantLocal) {
  console.error('[dag-slim] --no-global 与 --no-local 同给 = 无事可做。');
  process.exit(1);
}

// ---- diff (dag-review 同款) ----
const base = flags.base ?? 'main';
const paths = flags.paths ? flags.paths.split(',').map((p) => p.trim()).filter(Boolean) : [];
const diff = flags.staged
  ? await $`git diff --cached -- ${paths}`.text()
  : await $`git diff ${base}...HEAD -- ${paths}`.text();
const files = flags.staged
  ? await $`git diff --cached --name-only -- ${paths}`.text()
  : await $`git diff ${base}...HEAD --name-only -- ${paths}`.text();
if (!diff.trim()) {
  console.error(`[dag-slim] 无 diff (${flags.staged ? '--staged' : base + '...HEAD'})。无可审。`);
  process.exit(2);
}
const scope = `${flags.staged ? '暂存区' : `${base}...HEAD`}${paths.length ? ` (限 ${paths.join(',')})` : ''} 改动文件:\n${files.trim()}`;
const diffBlock = `===== 改动 diff (审查依据) =====\n\`\`\`diff\n${diff}\n\`\`\``;

bootstrapModelRuntime();
// 模型槽: 全局 = 更强槽 (一发吃全图), 局部 = leaf 槽 (并发 fan-out 省成本)。
const globalModel =
  flags['global-model'] ?? process.env.OMD_SLIM_GLOBAL_MODEL ?? process.env.OMD_REVIEW_FIND_MODEL ?? 'deepseek:deepseek-v4-pro';
const localModel =
  flags.model ?? process.env.OMD_SLIM_MODEL ?? process.env.OMD_LEAF_MODEL ?? 'deepseek:deepseek-v4-flash';
process.stderr.write(`[dag-slim] diff=${diff.length}chars global=${wantGlobal ? globalModel : 'off'} local=${wantLocal ? localModel : 'off'}\n`);

// ---- Pass 1 GLOBAL (先跑 — 系统视野的 -50% 赢面) ----
let globalText = '';
let globalLines: string[] = [];
if (wantGlobal) {
  const res = await send({
    model: globalModel,
    messages: [{ role: 'user', content: `${diffBlock}\n\n${buildGlobalPrompt({ scope })}` }],
    thinkingLevel: 'high',
  });
  globalText = res.text;
  globalLines = extractFindingLines(globalText, GLOBAL_KINDS);
}

// ---- Pass 2 LOCAL (per-file chunk 并发, 预构造 plan 走 D-7 入口) ----
let synthText = '';
let localLines: string[] = [];
let chunkSections: string[] = [];
if (wantLocal) {
  const chunks = splitDiffByFile(diff);
  if (chunks.length === 0) {
    process.stderr.write('[dag-slim] diff 无法按文件切分 → 局部遍跳过\n');
  } else {
    const plan = buildLocalPlan(chunks);
    const dag = await runExecutorDagWithPlan(plan, {
      conductorModel: localModel, // 仅 escalation 语义占位; 预构造路径不走 conductor
      leafModel: localModel,
      // 不设上限时 executor-dag 的 pool cap = 全节点数 → 大 diff (几十个文件) 一次齐发几十个
      // LLM 请求, 限流/成本直接爆。8 与 dag-build 默认对齐。
      maxFanout: 8,
      cavemanLevel: 'off', // finding 行本身即交付物, 不许压缩叙述
    });
    const synth = dag.results[SYNTH_NODE_ID];
    synthText = synth?.output ?? '';
    localLines = extractFindingLines(synthText, LOCAL_KINDS);
    if (synth?.status !== 'done' || localLines.length === 0) {
      // synth 挂/漏 → 直接从各 leaf 输出兜提取 (去重靠 Set; 宁重复不静默丢)。
      const union = new Set<string>(localLines);
      for (const [id, r] of Object.entries(dag.results)) {
        if (id === SYNTH_NODE_ID) continue;
        for (const l of extractFindingLines(r.output, LOCAL_KINDS)) union.add(l);
      }
      localLines = [...union];
    }
    chunkSections = Object.entries(dag.results)
      .filter(([id]) => id !== SYNTH_NODE_ID)
      .map(([id, r]) => `### ${id} [${r.status}]\n\n${r.output}`);
    process.stderr.write(`[dag-slim] local: ${chunks.length} chunks · leaves in=${dag.usage.leavesIn} out=${dag.usage.leavesOut}\n`);
  }
}

// ---- 可选 verify 收敛层 (复用 review/verify 证伪机器, 原样 import 不改) ----
let verified: Awaited<ReturnType<typeof verifyFindings>> | undefined;
if (flags.verify && (globalLines.length > 0 || localLines.length > 0)) {
  const dimTexts: { dimension: string; text: string }[] = [];
  if (globalLines.length > 0) dimTexts.push({ dimension: 'slim-global', text: globalLines.join('\n') });
  if (localLines.length > 0) dimTexts.push({ dimension: 'slim-local', text: localLines.join('\n') });
  verified = await verifyFindings(dimTexts, { model: globalModel });
}

// ---- 落盘 (零丢失) + terse stdout ----
const sections = [
  ...(wantGlobal ? [{ title: `Global (系统视野, ${GLOBAL_KINDS.map((k) => k.kind).join('/')})`, lines: globalLines }] : []),
  ...(wantLocal ? [{ title: `Local (per-hunk, ${LOCAL_KINDS.map((k) => k.kind).join('/')})`, lines: localLines }] : []),
];
const report = formatReport(sections);

const doc: string[] = [`# dag-slim 过度工程专审 ${scope.split('\n')[0]}`, '', `> global=${wantGlobal ? globalModel : 'off'} · local=${wantLocal ? localModel : 'off'} · ${new Date().toISOString()}`, ''];
doc.push('## 单行清单 (Global 前 / Local 后)', '', report, '');
if (verified) {
  doc.push('## ⚖️ verify 收敛层 (出口只放 CONFIRMED/UNVERIFIED, REFUTED 留档)', '');
  for (const v of verified) {
    doc.push(`- **${v.verdict}** [${v.dimension}] ${v.file}${v.line ? `:${v.line}` : ''} — ${v.claim}`, `  依据: ${v.reason}`);
  }
  if (verified.length === 0) doc.push('- (extract 未产出可裁决的 finding)');
  doc.push('');
}
if (wantGlobal) doc.push('## Global 遍原文', '', globalText, '');
if (wantLocal) doc.push('## Local 遍 synth 原文', '', synthText, '', '## Local 遍 per-chunk 原文', '', ...chunkSections, '');
const outPath = flags.out ?? `/tmp/omd-slim-${Date.now()}.md`;
await Bun.write(outPath, doc.join('\n'));

console.log(`✂️ dag-slim 完成 → ${outPath}  (finding≠ground truth, 调用方终裁)`);
console.log('');
console.log(report);
if (verified) {
  const survive = verified.filter((v) => v.verdict !== 'REFUTED');
  const refuted = verified.filter((v) => v.verdict === 'REFUTED');
  console.log('');
  console.log(`⚖️ verify: 提取 ${verified.length} · ${survive.length} 存活 · ${refuted.length} 证伪留档`);
  for (const v of survive) console.log(`  ${v.verdict === 'UNVERIFIED' ? '❓' : '✂️'} ${v.file}${v.line ? `:${v.line}` : ''} — ${v.claim}`);
  for (const v of refuted) console.log(`  ⚪ REFUTED ${v.file}${v.line ? `:${v.line}` : ''} — ${v.claim}`);
}
