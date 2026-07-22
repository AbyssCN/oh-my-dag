#!/usr/bin/env bun
/**
 * scripts/dag-review —— oh-my-dag 对抗式代码审查 (派活专用; 复用内部 review 方法论模块)。
 *
 * 不重造审查 prompt: 直接用 `src/harness/review` 的校准资产 —
 *   buildReviewPrompt (多维度证伪镜头 + 内嵌 anti-slop ACCEPT/REJECT 准则 + "finding≠truth" 纪律)
 *   · screenFinding (软筛疑似 slop) · resolveReviewModel (model 路由) · ROUND_CAPS (1 轮 doctrine)。
 * 组合: 取 diff → 每维度一条对抗 prompt (共享 diff 前缀→缓存) → parallel callModel → screen → 打印 P0/P1。
 * **不综合不 graft** (review 要去重 finding 清单, 不要一个答案) · **不刷轮** (ROUND_CAPS=1) ·
 * finding≠ground truth, 调用方终裁。
 *
 *   bun run scripts/dag-review.ts [--gate G0|G1|G2|G3] [--base main] [--staged] [--brief] [--no-verify]
 *                                 [--spec] [--no-spec] [--dims correctness,security,boundary,contract,spec]
 *                                 [--model ds:..] [--extra "<额外对抗接缝>"] [--out path] [--paths "src,sql"]
 *   Gate 阶梯 (双轴 Matt Pocock): G0 免审 (docs/机械, 短路 exit 0) · G1=[contract,boundary]
 *   · G2=[correctness,security,boundary] · G3=G2+contract+**spec 强制** (Spec 轴 = diff 对照
 *   docs/plan 最新 SDD; 无 SDD → 轴跳过非失败; 模型可 OMD_REVIEW_SPEC_MODEL 单独路由)。
 *   --spec 任意 gate 强制加 spec 轴; --no-spec 排除 (G3 报错, spec 在 G3 不可免)。
 *   默认: gate=G2, base=main 的 branch diff。--staged = 审暂存区。
 *   --paths = 逗号分隔 pathspec, 把 diff 限到指定目录/文件 (防部署产物/无关域污染)。
 *   收敛层默认开 (extract→仓库取证→证伪, 见 review/verify.ts; --no-verify 关), **两轴共用**:
 *   出口只放 CONFIRMED/UNVERIFIED, REFUTED 留档落盘。--brief = stdout 只出裁决清单 (~500t 护 ctx)。
 */
import '../src/harness/script-bootstrap';
import { runReview, DIMS_BY_GATE, SPEC_SKIPPED_NOTE, type ReviewDimension, type ReviewGate } from '../src/harness/review';
import { bootstrapModelRuntime } from '../src/model/bootstrap';
import { $ } from 'bun';

const USAGE =
  'usage: bun run scripts/dag-review.ts [--gate G0|G1|G2|G3] [--base main] [--staged] [--brief] [--no-verify] [--spec] [--no-spec] [--dims correctness,security,boundary,contract,spec] [--model ..] [--extra "<焦点>"] [--out path] [--paths "src,sql"]';

// ---- args ----
const BOOL = new Set(['staged', 'brief', 'no-verify', 'spec', 'no-spec', 'single', 'help']);
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

// ---- gate 阶梯 ----
const gateRaw = flags.gate ?? 'G2';
if (!['G0', 'G1', 'G2', 'G3'].includes(gateRaw)) {
  console.error(`[dag-review] 未知 gate: ${gateRaw}\n${USAGE}`);
  process.exit(1);
}
if (gateRaw === 'G0') {
  // G0 短路: 免审档 (纯 docs/机械改动), 不取 diff 不发模型。
  console.log('G0 免审 (docs/机械)');
  process.exit(0);
}
const gate = gateRaw as ReviewGate;
if (flags.spec && flags['no-spec']) {
  console.error('[dag-review] --spec 与 --no-spec 互斥。');
  process.exit(1);
}
if (flags['no-spec'] && gate === 'G3') {
  console.error('[dag-review] G3 的 spec 轴强制 (release 闸必对照 SDD), --no-spec 不可用。降 gate 或去掉 --no-spec。');
  process.exit(1);
}
const base = flags.base ?? 'main';
let dims: ReviewDimension[] = flags.dims
  ? (flags.dims.split(',').map((d) => d.trim()) as ReviewDimension[])
  : [...DIMS_BY_GATE[gate]];
if (flags.spec && !dims.includes('spec')) dims = [...dims, 'spec']; // --spec: 任意 gate 强制加 Spec 轴
if (flags['no-spec']) dims = dims.filter((d) => d !== 'spec'); // 非 G3 才走得到这里
const extraFocus = flags.extra ? [flags.extra] : undefined;

// ---- diff ----
const paths = flags.paths ? flags.paths.split(',').map((p) => p.trim()).filter(Boolean) : [];
const diff = flags.staged
  ? await $`git diff --cached -- ${paths}`.text()
  : await $`git diff ${base}...HEAD -- ${paths}`.text();
const files = flags.staged
  ? await $`git diff --cached --name-only -- ${paths}`.text()
  : await $`git diff ${base}...HEAD --name-only -- ${paths}`.text();
if (!diff.trim()) {
  console.error(`[dag-review] 无 diff (${flags.staged ? '--staged' : base + '...HEAD'})。无可审。`);
  process.exit(2);
}
const scope = `${flags.staged ? '暂存区' : `${base}...HEAD`}${paths.length ? ` (限 ${paths.join(',')})` : ''} 改动文件:\n${files.trim()}`;

bootstrapModelRuntime();
process.stderr.write(`[dag-review] gate=${gate} diff=${diff.length}chars\n`);

// ---- 编排走单一真理源 runReview (与 dag-build 内嵌 review 共用) ----
// 收敛层默认开 (--no-verify 关); --brief = stdout 只出裁决清单, 全文看落盘。
const { findings, verified, outPath, sddPath, specSkipped } = await runReview({
  diff,
  scope,
  gate,
  dims,
  extraFocus,
  model: flags.model,
  outPath: flags.out,
  verify: !flags['no-verify'],
  single: flags.single ? true : undefined, // --single: 单 agent 深审(读全仓 + 实测 → 确定性 verify)
});

console.log(`✅ oh-my-dag 对抗审查 [${gate}] 完成 → ${outPath}  (finding≠ground truth, 调用方终裁)`);
if (dims.includes('spec')) {
  console.log(specSkipped ? `📐 Spec 轴: ${SPEC_SKIPPED_NOTE}` : `📐 Spec 轴: 对照 SDD ${sddPath}`);
}
if (verified) {
  const confirmed = verified.filter((v) => v.verdict !== 'REFUTED');
  const refutedList = verified.filter((v) => v.verdict === 'REFUTED');
  console.log(`⚖️ 收敛层: 提取 ${verified.length} · ${confirmed.length} 存活 (CONFIRMED/UNVERIFIED) · ${refutedList.length} 已证伪留档`);
  for (const v of confirmed) {
    console.log(`  ${v.verdict === 'UNVERIFIED' ? '❓' : '🔴'} [${v.severity}] ${v.file}${v.line ? `:${v.line}` : ''} — ${v.claim}`);
    console.log(`     ${v.reason}`);
  }
  // REFUTED 也在 brief 一行一条(证伪可能误判 → 敏感 diff 一眼扫过);详情看落盘。
  for (const v of refutedList) {
    console.log(`  ⚪ REFUTED [${v.severity}] ${v.file}${v.line ? `:${v.line}` : ''} — ${v.claim}`);
  }
  if (refutedList.length > 0) {
    console.log(`  ↳ REFUTED 由 verify 判,可能误驳;安全/authz 敏感 diff 请读全量:${outPath}`);
  }
}
if (!flags.brief) {
  // 双轴分段: Standards 轴 (代码写得对不对) / Spec 轴 (做的是不是 SDD 说该做的事)。
  const standards = findings.filter((f) => f.dimension !== 'spec');
  const specAxis = findings.filter((f) => f.dimension === 'spec');
  console.log('\n## Standards 轴');
  for (const r of standards) {
    console.log(`\n===== [${r.dimension}]${r.hasRealSignal ? ' (含 file:line/repro)' : r.likelySlop ? ' ⚠️疑似slop' : ''} =====`);
    console.log(r.text);
  }
  if (dims.includes('spec')) {
    console.log('\n## Spec 轴');
    console.log(specSkipped ? `(${SPEC_SKIPPED_NOTE})` : `(对照 SDD: ${sddPath})`);
    for (const r of specAxis) {
      if (r.skipped) continue;
      console.log(`\n===== [spec]${r.hasRealSignal ? ' (含 file:line/repro)' : r.likelySlop ? ' ⚠️疑似slop' : ''} =====`);
      console.log(r.text);
    }
  }
}
