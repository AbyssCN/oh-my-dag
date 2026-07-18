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
 *   bun run scripts/dag-review.ts [--gate G2|G3] [--base main] [--staged] [--brief] [--no-verify]
 *                                 [--dims correctness,security,boundary,contract] [--model ds:..]
 *                                 [--extra "<额外对抗接缝>"] [--out path] [--paths "src,sql"]
 *   默认: gate=G2 (correctness/security/boundary), base=main 的 branch diff。--staged = 审暂存区。
 *   --paths = 逗号分隔 pathspec, 把 diff 限到指定目录/文件 (防部署产物/无关域污染)。
 *   收敛层默认开 (extract→仓库取证→证伪, 见 review/verify.ts; --no-verify 关):
 *   出口只放 CONFIRMED/UNVERIFIED, REFUTED 留档落盘。--brief = stdout 只出裁决清单 (~500t 护 ctx)。
 */
import '../src/harness/script-bootstrap';
import { runReview, type ReviewDimension, type ReviewGate } from '../src/harness/review';
import { bootstrapModelRuntime } from '../src/model/bootstrap';
import { $ } from 'bun';

const USAGE =
  'usage: bun run scripts/dag-review.ts [--gate G2|G3] [--base main] [--staged] [--brief] [--no-verify] [--dims correctness,security,boundary,contract] [--model ..] [--extra "<焦点>"] [--out path] [--paths "src,sql"]';

// ---- args ----
const BOOL = new Set(['staged', 'brief', 'no-verify', 'help']);
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
const gate = (flags.gate as ReviewGate) ?? 'G2';
const base = flags.base ?? 'main';
const dims: ReviewDimension[] | undefined = flags.dims
  ? (flags.dims.split(',').map((d) => d.trim()) as ReviewDimension[])
  : undefined;
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
const { findings, verified, outPath } = await runReview({
  diff,
  scope,
  gate,
  dims,
  extraFocus,
  model: flags.model,
  outPath: flags.out,
  verify: !flags['no-verify'],
});

console.log(`✅ oh-my-dag 对抗审查 [${gate}] 完成 → ${outPath}  (finding≠ground truth, 调用方终裁)`);
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
  console.log('');
  for (const r of findings) {
    console.log(`\n===== [${r.dimension}]${r.hasRealSignal ? ' (含 file:line/repro)' : r.likelySlop ? ' ⚠️疑似slop' : ''} =====`);
    console.log(r.text);
  }
}
