/**
 * review/review-plan —— DAG-native review 的**预构造 ConductorPlan** 工厂(零 conductor LLM)。
 *
 * SDD: docs/plan/2026-07-22-dag-native-review.md。镜像 harness/debug/debug-plan 的形状:
 *   find_<dim> (agent 叶, 读代码库) 并行 → verify (map over findings, 每 finding agent skeptic)
 *     → judge (去重 + 严重度排序 + CONFIRMED-only)
 *
 * 关键升级 vs 老 Promise.all runReview:
 *  · find 变 **agent 叶**(codegraph/read 访问代码库)→ 从源头掐"X 在 diff 外"整类误报(REVIEW #3)。
 *  · verify 用 **executor:'map'** over 运行时 findings(清单 find 跑完才知 → map 的教科书场景)。
 *
 * find goal 复用校准资产 buildReviewPrompt / buildSpecReviewPrompt(不重写); 只加一段代码库访问纪律。
 * ⚠️ find/verify 是**只读探查**: goal 避 producesFiles 强写信号(同 deepen/debug 回归守卫)。
 */
import { PlanSchema, type ConductorPlan } from '../conductor-plan';
import { buildReviewPrompt, buildSpecReviewPrompt, type ReviewDimension, type ReviewGate } from './index';

/** verify 收敛 map 节点固定 id。 */
export const VERIFY_NODE_ID = 'verify';
/** judge 节点固定 id(脚本收结果 + 测试锚它)。 */
export const JUDGE_NODE_ID = 'review_judge';
/** find 节点 id 前缀(find_<dim>)。 */
export const FIND_PREFIX = 'find_';

/** verify map 扇出硬顶(护量级; 一 finding 一 agent skeptic)。 */
const DEFAULT_MAX_FINDINGS = 24;

/** find agent 叶的代码库访问纪律(掐 diff-盲误报的核心;只读)。 */
const CODEBASE_ACCESS_NOTE = [
  '',
  '你可用 codegraph / read / grep 读**代码库真身**(不止这段 diff)。报 finding 前**先自证伪**:',
  '去 diff 视野外查涉及符号的定义/调用/守卫真身,推翻不了才报。三大系统性误报直接自查掉:',
  '① "X 未导出/未定义" → 先 grep X 真身(在 diff 外既有代码即证伪);',
  '② "缺权限守卫" → 先看查询是否以 JOIN/EXISTS 已带守卫;',
  '③ "可能/如果内部没校验" → 去读那个函数,禁推测性 P0。',
  '绝对只读,不改任何文件。',
].join('\n');

export interface ReviewPlanOptions {
  /** 改动 diff(审查依据,进 find goal)。 */
  diff: string;
  /** 审查范围描述(改动文件清单)。 */
  scope: string;
  gate: ReviewGate;
  /** 维度(默认由调用方按 gate 展开传入)。 */
  dims: ReviewDimension[];
  /** 额外对抗接缝。 */
  extraFocus?: readonly string[];
  /** spec 轴 SDD(调用方 findSdd 解析;null/缺 → 不发 find_spec 节点)。 */
  sdd?: { path: string; text: string } | null;
  /** verify 扇出上限(默认 24)。 */
  maxFindings?: number;
  /** find/lister 模型坐标(缺省 → 继承 executor-dag config)。 */
  findModel?: string;
  /** verify skeptic 子节点模型(跨模型证伪, 如 mimo;缺省 → 继承 config)。 */
  verifyModel?: string;
}

/** 可选把 model 坐标塞进节点(缺省则不设, 继承 executor-dag config 默认)。 */
function withModel(node: Record<string, unknown>, model: string | undefined): Record<string, unknown> {
  return model ? { ...node, model } : node;
}

/** 单维度 find agent 叶 goal:diff + 校准维度 prompt + 代码库访问纪律。 */
function findGoal(dimension: ReviewDimension, opts: ReviewPlanOptions): string {
  const diffBlock = `===== 改动 diff(审查依据)=====\n\`\`\`diff\n${opts.diff}\n\`\`\``;
  const prompt = buildReviewPrompt({ dimension, scope: opts.scope, gate: opts.gate, extraFocus: opts.extraFocus });
  return `${diffBlock}\n\n${prompt}${CODEBASE_ACCESS_NOTE}`;
}

/** spec 轴 find agent 叶 goal:diff + SDD 对照 prompt + 代码库访问纪律。 */
function specGoal(opts: ReviewPlanOptions & { sdd: { path: string; text: string } }): string {
  const diffBlock = `===== 改动 diff(审查依据)=====\n\`\`\`diff\n${opts.diff}\n\`\`\``;
  const prompt = buildSpecReviewPrompt({
    scope: opts.scope, gate: opts.gate, sddPath: opts.sdd.path, sddText: opts.sdd.text, extraFocus: opts.extraFocus,
  });
  return `${diffBlock}\n\n${prompt}${CODEBASE_ACCESS_NOTE}`;
}

/** verify map lister goal:从 upstream 各维度输出结构化提取每条 P0/P1(高召回,不裁决)。 */
const VERIFY_LISTER_GOAL = [
  '下面(见 upstream)是各维度对抗审查的原始输出。把其中**每一条** P0/P1 主张结构化提取出来。',
  '**不要判断真假、不要排除任何条目**(证伪是下游 skeptic 的事,这里只结构化);宁多提不漏提。',
  '为每条生成一个**短稳定 kebab id**(用 file 末段 + claim 关键词,如 `run-debug-maxfanout-drop`),',
  '同 file + 同主张前缀视为同一条(跨维度撞同一 bug 折叠成一条)。',
].join('\n');

/** 单 finding verify agent skeptic goal(refute-first, 全工具取证, 只读)。 */
const VERIFY_CHILD_GOAL = [
  '你是审查 finding 的**证伪裁决员**(skeptic)。默认此 finding 不成立,只有代码证据硬撑才 CONFIRMED。',
  '绝对只读,用 codegraph / read / grep 读**代码库真身**(finding 作者只看了 diff,你能看全仓)。',
  '',
  '待裁决 finding:',
  '- id: ${finding.id}',
  '- [${finding.severity}] ${finding.file}:${finding.line} [${finding.dimension}]',
  '- 主张: ${finding.claim}',
  '- 涉及符号: ${finding.symbols}',
  '',
  '取证步骤:去 ${finding.file} 及涉及符号的**定义/调用/守卫真身**(含 diff 外)读码。',
  '三大系统性误报直接查掉:① "X 未定义"→grep X 真身 ② "缺守卫"→看 JOIN/EXISTS ③ 推测性→读那函数。',
  '',
  '裁决(refute-first):证据表明主张不成立 → REJECTED;证据硬撑 → CONFIRMED;证据不足以判 → UNCLEAR。',
  '输出:首行 `VERDICT: CONFIRMED|REJECTED|UNCLEAR`,次行一句依据(引 file:line 证据)。',
].join('\n');

/** judge goal:跨维度去重 + 严重度排序 + CONFIRMED-only 出口。 */
const JUDGE_GOAL = [
  '你收到多条 finding 的证伪裁决(见 upstream)。做三件事:',
  '1. **去重**:同 file + 同主张前缀的多条(跨维度撞同一 bug)折叠成一条,保留证据最全的。',
  '2. **只留存活**:出口只放 CONFIRMED / UNCLEAR(= 真伤候选);REJECTED 单列一段留档(证伪也可能误判)。',
  '3. **按严重度排序**:P0 在前,每条一行 `[严重度][维度] file:line — 主张 · 依据`。',
  'finding ≠ ground truth,调用方(Aalto)终裁。不综合发散,只收敛裁决清单。',
].join('\n');

/**
 * 构造 DAG-native review 的预构造 plan:find_<dim>(agent)→ verify(map)→ judge(leaf)。
 * 返回前过 PlanSchema.parse —— 图形状坏在构造期炸,不流进执行器。
 * spec ∈ dims 但无 sdd → 不发 find_spec(调用方据此标 specSkipped)。
 */
export function compileReviewPlan(opts: ReviewPlanOptions): ConductorPlan {
  if (!opts.diff.trim()) throw new Error('compileReviewPlan: diff 不能为空');
  if (opts.dims.length === 0) throw new Error('compileReviewPlan: 至少 1 个维度');
  const maxFindings = opts.maxFindings ?? DEFAULT_MAX_FINDINGS;

  const nodes: Record<string, unknown> = {};
  const findIds: string[] = [];
  for (const dim of opts.dims) {
    if (dim === 'spec') {
      if (!opts.sdd) continue; // 无 SDD → spec 轴跳过(调用方标 specSkipped)
      const id = `${FIND_PREFIX}spec`;
      findIds.push(id);
      nodes[id] = withModel({
        executor: 'agent',
        goal: specGoal({ ...opts, sdd: opts.sdd }),
        persona: 'Spec 轴审查员(对照 SDD 契约查实装偏离,证据优先只读)',
      }, opts.findModel);
      continue;
    }
    const id = `${FIND_PREFIX}${dim}`;
    findIds.push(id);
    nodes[id] = withModel({
      executor: 'agent', // 读代码库真身 → 带工具; goal 已钉只读 + 自证伪纪律
      goal: findGoal(dim, opts),
      persona: `${dim} 维度对抗审查员(读全仓自证伪, 禁推测性 P0)`,
    }, opts.findModel);
  }
  if (findIds.length === 0) throw new Error('compileReviewPlan: 无可发的 find 节点(spec-only 且无 SDD)');

  nodes[VERIFY_NODE_ID] = {
    executor: 'map',
    depends_on: findIds,
    map: {
      lister: withModel({
        executor: 'leaf',
        goal: VERIFY_LISTER_GOAL,
        output_schema: {
          findings: [{ id: 'string', severity: 'P0|P1', file: 'string', line: 'number', claim: 'string', symbols: ['string'], dimension: 'string' }],
        },
      }, opts.findModel),
      over: 'findings',
      itemVar: 'finding',
      keyBy: 'id', // 稳定身份 → resume 只重跑变动 finding(INV-U2)
      maxItems: maxFindings, // 有界扇出(INV-U4)
      template: withModel({
        executor: 'agent', // skeptic 读全仓取证引 file:line → 带工具; goal 已钉只读
        goal: VERIFY_CHILD_GOAL,
        persona: 'finding 证伪裁决员(refute-first, 默认不成立除非代码证据硬撑)',
      }, opts.verifyModel), // 跨模型证伪(如 mimo,≠ find 层 deepseek)
    },
  };

  nodes[JUDGE_NODE_ID] = {
    executor: 'leaf', // 纯文本收敛
    goal: JUDGE_GOAL,
    depends_on: [VERIFY_NODE_ID],
    creative: true, // 裁决清单 prose → 关 caveman 压缩护质量
  };

  return PlanSchema.parse({
    name: 'dag-review',
    description: `DAG-native 对抗审查 [${opts.gate}]: ${findIds.length} 维度 agent 读全仓 → verify map(≤${maxFindings})→ 收敛`,
    nodes,
  });
}
