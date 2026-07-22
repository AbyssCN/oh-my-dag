/**
 * review/run-dag —— DAG-native review 编排(runReviewDag)。
 *
 * SDD: docs/plan/2026-07-22-dag-native-review.md。runReview 的 executor-dag 内核:
 *   compileReviewPlan → runExecutorDagWithPlan(agent 叶读代码库)→ 映射回**冻结契约** RunReviewResult。
 *
 * REVIEW-1 契约冻结:返回型 = runReview,dag-review / dag-build 消费点无改。
 * REVIEW-3 结果映射:find_<dim> 节点 → ReviewFinding[];verify map 节点 output(JSON childResults:
 *   {key, item, output})→ item 给结构化字段 ⋈ output 给 verdict → VerifiedFinding[]。
 */
import { join } from 'node:path';
import { compileReviewPlan, VERIFY_NODE_ID, JUDGE_NODE_ID, FIND_PREFIX } from './review-plan';
import { screenFinding, DIMS_BY_GATE, SPEC_SKIPPED_NOTE, resolveReviewModel } from './index';
import type { ReviewFinding, RunReviewOpts, RunReviewResult } from './run';
import type { VerifiedFinding } from './verify';
import { findLatestSdd } from '../execute-extension';
import { runExecutorDagWithPlan } from '../executor-dag';
import { createAgentLeafRunner } from '../agent-leaf';
import { roleModelWithFallback } from '../../model/role-fallback';
import type { ExecutorDagResult } from '../executor-dag-types';
import type { ConductorPlan } from '../conductor-plan';

/** verify 子 verdict 词 → VerifiedFinding.verdict(UNCLEAR = fail-open 不静默丢真伤)。 */
function mapVerdict(text: string): VerifiedFinding['verdict'] {
  const m = text.match(/VERDICT:\s*(CONFIRMED|REJECTED|UNCLEAR)/i);
  const v = m?.[1]?.toUpperCase();
  if (v === 'REJECTED') return 'REFUTED';
  if (v === 'CONFIRMED') return 'CONFIRMED';
  return 'UNVERIFIED'; // UNCLEAR / 无裁决词 → fail-open
}

/** verify 子 output 取依据行(VERDICT 之后一句)。 */
function verdictReason(text: string): string {
  const after = text.split(/VERDICT:\s*\w+/i)[1]?.trim();
  return (after || text.trim()).slice(0, 400);
}

/** map 节点 output(JSON childResults)→ VerifiedFinding[]。解析失败 → 空(不炸)。 */
function mapVerified(mapOutput: string | undefined): VerifiedFinding[] {
  if (!mapOutput?.trim()) return [];
  let arr: { key: string; item: unknown; output: string }[];
  try {
    arr = JSON.parse(mapOutput) as typeof arr;
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  return arr.map((c) => {
    const it = (c.item ?? {}) as Partial<VerifiedFinding>;
    return {
      severity: it.severity === 'P0' ? 'P0' : 'P1',
      file: String(it.file ?? '?'),
      line: typeof it.line === 'number' ? it.line : undefined,
      claim: String(it.claim ?? ''),
      symbols: Array.isArray(it.symbols) ? it.symbols.map(String) : [],
      dimension: String(it.dimension ?? '?'),
      verdict: mapVerdict(c.output ?? ''),
      reason: verdictReason(c.output ?? ''),
    };
  });
}

/** 取节点 output(done 才有;failed/缺失 → 空串)。 */
function nodeOutput(res: ExecutorDagResult, id: string): string {
  const n = res.results[id];
  return n && n.status === 'done' ? n.output : '';
}

/** 组装 markdown 报告(收敛裁决 + 各维度全文)。 */
function renderReport(gate: string, scope: string, verified: VerifiedFinding[], findings: ReviewFinding[], judge: string): string {
  const doc: string[] = [`# DAG-native 对抗审查 [${gate}] ${scope.split('\n')[0]}`, ''];
  const c = verified.filter((v) => v.verdict === 'CONFIRMED').length;
  const r = verified.filter((v) => v.verdict === 'REFUTED').length;
  const u = verified.filter((v) => v.verdict === 'UNVERIFIED').length;
  doc.push('## ⚖️ 收敛层裁决', `> 提取 ${verified.length} · CONFIRMED ${c} · REFUTED ${r} · UNVERIFIED ${u}(finding≠ground truth, 调用方终裁)`, '');
  for (const v of verified) {
    doc.push(`- **${v.verdict}** [${v.severity}] [${v.dimension}] ${v.file}${v.line ? `:${v.line}` : ''} — ${v.claim}`, `  依据: ${v.reason}`);
  }
  doc.push('', '## 🧑‍⚖️ judge 收敛', judge || '(judge 无输出)', '', '## 各维度 find 全文');
  for (const f of findings) {
    doc.push(`\n===== [${f.dimension}]${f.skipped ? ' (跳过)' : ''} =====\n${f.text}`);
  }
  return doc.join('\n');
}

/**
 * DAG-native 对抗审查。providers 须已注册。返回冻结契约 RunReviewResult(与 runReview 一致)。
 * agent 叶读代码库真身 → 从源头自证伪 diff-盲误报;verify map 每 finding 深取证。
 */
export async function runReviewDag(opts: RunReviewOpts): Promise<RunReviewResult> {
  const env = opts.deps?.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  const dims = opts.dims ?? DIMS_BY_GATE[opts.gate];
  const findSdd = opts.deps?.findSdd ?? findLatestSdd;

  const findModel = roleModelWithFallback(
    opts.model ?? env.OMD_REVIEW_FIND_MODEL ?? resolveReviewModel(opts.gate, {}, env) ?? 'deepseek:deepseek-v4-pro',
    'review',
  );
  const verifyModel = roleModelWithFallback(opts.verifyModel ?? env.OMD_REVIEW_VERIFY_MODEL ?? findModel, 'review');

  // spec 轴 SDD 定位(spec ∈ dims 且找到 → find_spec 节点;否则 specSkipped)。
  const wantSpec = dims.includes('spec');
  const sdd = wantSpec ? findSdd(join(cwd, 'docs', 'plan')) : null;
  const specSkipped = wantSpec && !sdd;

  const plan: ConductorPlan = compileReviewPlan({
    diff: opts.diff, scope: opts.scope, gate: opts.gate, dims, extraFocus: opts.extraFocus,
    sdd, findModel, verifyModel,
  });

  const runDag = opts.deps?.runDag ?? runExecutorDagWithPlan;
  const res = await runDag(plan, {
    conductorModel: findModel, // 预构造路径不触 conductor; 仅类型必填
    leafModel: findModel,
    agentLeafModel: findModel,
    maxFanout: opts.maxFindings ?? 24,
    warmThenFanout: true,
    agentRunner: createAgentLeafRunner({ cwd }),
  });

  // ── 映射回冻结契约 ──
  const findings: ReviewFinding[] = [];
  for (const dim of dims) {
    if (dim === 'spec' && specSkipped) {
      findings.push({ dimension: 'spec', text: SPEC_SKIPPED_NOTE, likelySlop: false, hasRealSignal: false, skipped: true });
      continue;
    }
    const text = nodeOutput(res, `${FIND_PREFIX}${dim}`);
    const screen = screenFinding(text);
    findings.push({ dimension: dim, text, likelySlop: screen.likelySlop, hasRealSignal: screen.hasRealSignal });
  }

  const verified = opts.verify === false ? undefined : mapVerified(nodeOutput(res, VERIFY_NODE_ID));
  const judge = nodeOutput(res, JUDGE_NODE_ID);

  const tmpDir = (env.TMPDIR ?? '').trim().replace(/\/+$/, '') || '/tmp';
  const outPath = opts.outPath || `${tmpDir}/omd-review-dag-${opts.gate}-${process.pid}.md`;
  await Bun.write(outPath, renderReport(opts.gate, opts.scope, verified ?? [], findings, judge));

  return {
    findings,
    verified,
    outPath,
    model: findModel,
    sddPath: sdd?.path,
    specSkipped: specSkipped || undefined,
  };
}
