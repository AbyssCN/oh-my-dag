/**
 * review/run-single —— arm C:**单 pi agent review(不分解、不走 DAG)**。
 *
 * 实验臂,回答"review 到底要不要 DAG 分解"。一个带工具的 pi agent 在**一个连贯 context**里
 * 看全 diff + 读全仓 + 跑实测,综合所有维度出 finding 清单 → 确定性 verifyFindings(mimo judge)。
 * 与 arm B(run-dag,分解 find)唯一差别 = find 不分解;verify 两臂共用(变量隔离)。
 *
 * SDD: docs/plan/2026-07-22-dag-native-review.md(§9 Phase 边界之外的探索臂)。
 * 契约冻结:返回 RunReviewResult,与 runReview 一致。
 */
import { join } from 'node:path';
import { buildGateReview, buildSpecReviewPrompt, screenFinding, DIMS_BY_GATE } from './index';
import { resolveReviewModels, type ReviewFinding, type RunReviewOpts, type RunReviewResult } from './run';
import { verifyFindings as realVerifyFindings } from './verify';
import { findLatestSdd } from '../execute-extension';
import { createAgentLeafRunner } from '../agent-leaf';

type ReviewEffort = 'off' | 'low' | 'medium' | 'high' | 'xhigh';

/** 强制 oracle 纪律(实测挣来:$.cwd 类外部 API 幻觉,agent 本可跑却选择推理 → 强制实测)。 */
const RUN_ORACLE_DISCIPLINE = [
  '**涉及库/runtime API 行为的主张**("X 抛异常"/"$.foo 不是函数"/"启动即崩溃"/"类型不存在")',
  '→ **禁纯推理**,必须 `bun -e "<最小复现>"` 或跑相关命令(tsc/脚本 --help)**实测**;',
  '跑不出复现证据的 API/runtime 主张 **不许上报**(反 $.cwd 类幻觉)。',
].join('\n');

/** agent 的代码库访问 + 强制 oracle 纪律(掐 diff-盲 + 外部 API 两类误报;只读)。 */
const CODEBASE_ACCESS_NOTE = [
  '',
  '你可用 codegraph / read / grep / bash 读**代码库真身 + 跑实测**(不止这段 diff)。报 finding 前**先自证伪**:',
  '去 diff 视野外查涉及符号的定义/调用/守卫真身,推翻不了才报。三大系统性误报直接自查掉:',
  '① "X 未导出/未定义" → 先 grep X 真身(在 diff 外既有代码即证伪);',
  '② "缺权限守卫" → 先看查询是否以 JOIN/EXISTS 已带守卫;',
  '③ "可能/如果内部没校验" → 去读那个函数,禁推测性 P0。',
  RUN_ORACLE_DISCIPLINE,
  '绝对只读,不改任何文件。',
].join('\n');

/**
 * 单 agent review。一个 pi agent 综合所有维度 + 读全仓 + 实测 → verifyFindings。
 * providers 须已注册。返回冻结契约 RunReviewResult。
 */
export async function runReviewSingle(opts: RunReviewOpts): Promise<RunReviewResult> {
  const env = opts.deps?.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  const dims = opts.dims ?? DIMS_BY_GATE[opts.gate];
  const findSdd = opts.deps?.findSdd ?? findLatestSdd;

  const { findModel, verifyModel } = resolveReviewModels(opts, env); // find→review 角色, verify→verifier 角色
  const verifyEffort = (env.OMD_REVIEW_VERIFY_EFFORT as ReviewEffort) || undefined;

  const wantSpec = dims.includes('spec');
  const sdd = wantSpec ? findSdd(join(cwd, 'docs', 'plan')) : null;
  const specSkipped = wantSpec && !sdd;

  // 单 prompt:diff + 所有维度镜头(buildGateReview 复用校准资产)+ spec 对照 + 代码库/oracle 纪律。
  const diffBlock = `===== 改动 diff(审查依据)=====\n\`\`\`diff\n${opts.diff}\n\`\`\``;
  const dimPrompts = buildGateReview(opts.gate, opts.scope, opts.extraFocus).join('\n\n---\n\n');
  const specBlock = sdd
    ? `\n\n---\n\n${buildSpecReviewPrompt({ scope: opts.scope, gate: opts.gate, sddPath: sdd.path, sddText: sdd.text, extraFocus: opts.extraFocus })}`
    : '';
  const goal = [
    diffBlock,
    '',
    '你是资深对抗式代码审查员。**在一个连贯的审查里综合覆盖下列所有维度**,别漏任一维度的镜头:',
    dimPrompts + specBlock,
    CODEBASE_ACCESS_NOTE,
    '',
    '统一输出所有维度的 finding 清单(每条:严重度 P0/P1 + file:line + 一句主张 + 涉及符号)。宁缺毋滥但**别漏真 bug**。',
  ].join('\n');

  const runner = opts.deps?.agentRun ?? createAgentLeafRunner({ cwd, tools: ['read', 'bash'] });
  const { text } = await runner({ prompt: goal, model: findModel });

  const screen = screenFinding(text);
  const findings: ReviewFinding[] = [
    { dimension: 'correctness', text, likelySlop: screen.likelySlop, hasRealSignal: screen.hasRealSignal },
  ];

  const verifyFindings = opts.deps?.verifyFindings ?? realVerifyFindings;
  const verified = opts.verify === false
    ? undefined
    : await verifyFindings([{ dimension: 'all', text }], { model: verifyModel, cwd, verdictEffort: verifyEffort, send: opts.deps?.send });

  const tmpDir = (env.TMPDIR ?? '').trim().replace(/\/+$/, '') || '/tmp';
  const outPath = opts.outPath || `${tmpDir}/omd-review-single-${opts.gate}-${process.pid}.md`;
  const doc: string[] = [`# 单-agent 对抗审查 [${opts.gate}] ${opts.scope.split('\n')[0]}`, ''];
  if (verified) {
    doc.push('## ⚖️ 收敛层裁决', `> 提取 ${verified.length} · CONFIRMED ${verified.filter((v) => v.verdict === 'CONFIRMED').length} · REFUTED ${verified.filter((v) => v.verdict === 'REFUTED').length} · UNVERIFIED ${verified.filter((v) => v.verdict === 'UNVERIFIED').length}`, '');
    for (const v of verified) doc.push(`- **${v.verdict}** [${v.severity}] [${v.dimension}] ${v.file}${v.line ? `:${v.line}` : ''} — ${v.claim}`, `  依据: ${v.reason}`);
  }
  doc.push('', '## 单 agent find 全文', text);
  await Bun.write(outPath, doc.join('\n'));

  return { findings, verified, outPath, model: findModel, sddPath: sdd?.path, specSkipped: specSkipped || undefined };
}
