/**
 * src/harness/goal/orchestrating-loop —— solve 的默认执行形态 = **编排循环** (P3 契约 S6b, 2026-09-02;
 * D-1 / D-3 / D-14 / D-17 / D-20 / D-22)。
 *
 * 一句话: lead (conductor 本人) 作为**一个 agent 节点**主上下文连续到底, 手里握着七张封闭派工卡
 * (`src/harness/lead/tools/*`); 每张卡 `compile` 出的子图**经引擎入口**当一次嵌套 run 执行
 * (`runExecutorDagWithPlan` → `executePlan(applyPlanFilters(…))`, INV-3: 写竞争串行化 / 命令链合并 /
 * oracle 过滤照走, 闸 / checkpoint / blame 全部照走); 图上另有一个机械 oracle 节点 (`accept`, 冻结判据原文),
 * 收尾由 run-goal 打**恰一次**跨家族 verifier (D-14 / INV-7)。
 *
 * ## 这里只做三件事, 各自单一
 *
 * 1. `compileOrchestratingLoop` —— 出那张两节点的 plan。**不进** `GRAPH_SHAPES` 卡表 (D-1): 卡表是 conductor
 *    画图的菜单, 这条路模型没有选择权; 路径身份记 `RunGoalResult.path`。
 * 2. `createLeadRuntimeTools` —— 把七张卡 (`LeadTool`, zod + compile) 适配成 agent 叶能调的 `AnyOmdTool`:
 *    zod 拒 / `help:true` / 编译拒 → 拒因 + 该卡完整 manual 走 **tool result** (D-3, manual 永不进 system prompt);
 *    编译过 → `runChild(plan)` 跑子图 → 返回 fan-in 摘要 (节点状态 / 产出尾 / 尾块 / 验收台账)。
 * 3. `buildLeadFace` —— lead 节点的整副面: 只读手 (read / ls / grep / bash, D-20: 无 write / edit) + 七张卡 +
 *    常驻 lead prompt (S5, ≤8000)。由 run-goal 经 `ExecutorDagConfig.leafFace` 只对 `lead` 这一个 id 下发。
 *
 * ## 诚实边界 (与契约措辞的偏离, 记进进度表)
 *
 * - 子单元是**嵌套 run** (同 sessionId, 派生 runId `<runId>:d<n>`), 不是同一 run 内的子图: 引擎今天没有
 *   「在一个 agent 工具调用里执行一批子节点」的内部接缝 (`runConductorRound` 的展开→局部调度是内联的),
 *   拆它超出本片。代价: 父 run 的 checkpoint 不含子节点 (父 lead 节点自己有 checkpoint; 子 run 各自有);
 *   收益: 子图零新机制, 闸链与 `run`/`solve` 逐字节同一条。
 * - `work(resume_of)` 今天 = **同 id 重派** (fresh context), 不是续同一会话: 引擎没有按节点 id 续 agent 会话的
 *   机制 (全仓 resume 只有 checkpoint 复用)。owner 2026-09-02 裁 2-C: 上一次同 id 子 run 的结果 (状态 / 文件 /
 *   验收台账 / 尾块 / 报告尾) 由**运行时机械 append 进 goal** (`injectPriorResult`), 不指望 lead 复制进 brief —
 *   丢的只是工具调用历史。真续会话 (pi session / SDK sessionId 按 `${runId}:${nodeId}` 留住) 留作单变量实验。
 *
 * 证伪方式 (orchestrating-loop.test.ts): 删掉 `runChild` 那一跳 → 卡调用不再产生嵌套 run 即红; 把 manual 拼进
 * face.systemPrompt → INV-8 长度闸红; `accept` 节点丢掉 `depends_on: ['lead']` → 拓扑测试红。
 */
import { Type } from '@sinclair/typebox';
import { z } from 'zod';
import type { AnyOmdTool } from '../agent-tools';
import type { ConductorPlan } from '../conductor-plan';
import type { ExecutorDagResult, LeafResult } from '../dag/types';
import type { LeafFace } from '../leaf-runners';
import { buildLeadSystemPrompt, LEAD_PROMPT_RESIDENT_MAX, type LeadFacts } from '../lead/lead-prompt';
import { createLeadTools, formatRejection, invokeLeadTool } from '../lead/tools/index';
import type { LeadCtx, LeadTool } from '../lead/types';
import { logger } from '../logger';

/** plan 名 —— run-goal 的 `_runDag` 注入口与测试靠它认路径 (与 `goal-execute` / `goal-execute-flat` 同一约定)。 */
export const ORCHESTRATING_LOOP_PLAN_NAME = 'goal-orchestrating-loop';
/** lead 节点 id。`leafFace` 钩子只对它返回值; 回灌锚也只挂它。 */
export const LEAD_NODE_ID = 'lead';
/** 机械 oracle 节点 id —— 与 v1 路径同名, 让 run-goal 既有的 `exec.results.accept` 消费者零改动。 */
export const LOOP_ACCEPT_NODE_ID = 'accept';
/**
 * lead 的只读哨兵写集 (与 `lead/tools/explore.ts` 的 READONLY_SENTINEL 同一手法): 声明一条仓内不存在
 * 的路径使 `writeAllow.length > 0`, 写域闸真下发; lead 面上没有 write/edit, 这条闸对它天然成立 (D-20),
 * bash 重定向写盘会被写集对账 (writeset/write-set.ts) 在收尾抓到。
 */
export const LEAD_READONLY_SENTINEL = '.omd/lead-readonly-sentinel';
/** lead 的只读手 (D-20: 无 write / edit)。bash 的边界 = 危险命令闸 + git 写闸 + 收尾写集对账, 不是首词白名单 (D-7)。 */
export const LEAD_HAND_TOOLS = ['read', 'ls', 'grep', 'bash'] as const;

/**
 * lead 节点**基建类**败因 (2026-09-03, code80-p3 首批 09:22 停批的根因形态): MiniMax 529 → lead 首发即 failed →
 * 终审对着空产物判红 → D-14 回灌 → 再 529 → `verifier-rejected`。基建失败不许被标成语义否决:
 * 这一集里的败因既不回灌 (再派只是再撞一次 529), 终态也走 infra-error 那一格 (下一步 = 修引擎/换池, 别加轮数)。
 * 不含 empty-artifact / assert-failed 等**语义类**败因 —— 那些正是回灌该处理的。
 */
export const LEAD_INFRA_FAILURE_KINDS: ReadonlySet<string> = new Set(['infra-error', 'timed-out', 'missing-capability', 'stall', 'spin-fused']);

/** 回灌锚的固定首行 —— 测试与人读日志都靠它认「这一发是回灌」。 */
export const REINJECT_ANCHOR_HEAD = '[verifier 打回 · 回灌 1 次 (D-14: 之后终态由机械 oracle 定, 终审不复审)]';

export interface OrchestratingLoopInput {
  goal: string;
  acceptance?: { command: string; expect_exit: number };
  ctx: LeadCtx;
}

/**
 * 编排循环的 plan: `lead` (agent, 只读哨兵写集) → `accept` (command, 冻结判据原文; 无判据时缺席)。
 * 只经 `executePlan(applyPlanFilters(…))` 执行 (D-5 / INV-3); 这里不调 parsePlan —— 它是格式闸, 编译产物
 * 恒过它 (测试钉这一点), 运行期再过一遍是冗余。
 */
export function compileOrchestratingLoop(input: OrchestratingLoopInput): ConductorPlan {
  const nodes: ConductorPlan['nodes'] = {
    [LEAD_NODE_ID]: {
      executor: 'agent',
      goal: input.goal,
      write_set: [LEAD_READONLY_SENTINEL],
    },
  };
  if (input.acceptance) {
    nodes[LOOP_ACCEPT_NODE_ID] = {
      executor: 'command',
      command: input.acceptance.command,
      expect_exit: input.acceptance.expect_exit,
      depends_on: [LEAD_NODE_ID],
      goal: '冻结判据 (环外确定性闸)',
    };
  }
  return { name: ORCHESTRATING_LOOP_PLAN_NAME, nodes } as ConductorPlan;
}

/**
 * D-14 回灌: verifier finding 原文 append 到 **同一 lead 节点 id** 的 goal 末尾, 其它节点逐字不动。
 * 用新对象替换 (不原地改): 与 engine.ts 的 blameAnchor 同一条纪律 —— 原地写会污染上一轮 plan 的引用。
 */
export function withReinjectedFinding(plan: ConductorPlan, finding: string): ConductorPlan {
  const lead = plan.nodes[LEAD_NODE_ID];
  if (!lead) return plan;
  return {
    ...plan,
    nodes: {
      ...plan.nodes,
      [LEAD_NODE_ID]: { ...lead, goal: `${lead.goal ?? ''}\n\n---\n${REINJECT_ANCHOR_HEAD}\n${finding}\n` },
    },
  } as ConductorPlan;
}

/** 子图节点 id 加派发前缀 (`d3.explore-1`): 同一 run 里两次 explore 都出 `explore-1`, 不加前缀事件面与 checkpoint 会撞。 */
export function prefixPlanIds(plan: ConductorPlan, prefix: string): ConductorPlan {
  const rename = (id: string): string => (/^d\d+\./.test(id) ? id : `${prefix}.${id}`);
  const nodes: ConductorPlan['nodes'] = {};
  for (const [id, n] of Object.entries(plan.nodes)) {
    nodes[rename(id)] = {
      ...n,
      ...(n.depends_on ? { depends_on: n.depends_on.map(rename) } : {}),
    };
  }
  return { ...plan, nodes } as ConductorPlan;
}

const OUTPUT_TAIL_CHARS = 1500;

function tail(text: string, n: number): string {
  return text.length > n ? `…${text.slice(-n)}` : text;
}

function describeAcceptance(a: LeafResult['acceptance']): string {
  if (a === undefined) return '';
  if (a === null) return ' · acceptance: 派了判据但叶子没报 (通道截断)';
  if (!a.ran) return ' · acceptance: 派了判据, 叶子没跑 run_acceptance';
  const last = a.last;
  const verdict = last
    ? last.kind === 'blocked'
      ? `blocked (${last.reason.slice(0, 80)})`
      : `${last.verdict} exit ${last.exitCode ?? 'null'}${last.why ? ` (${last.why.slice(0, 80)})` : ''}`
    : '(无最后一次记录)';
  return ` · acceptance: 跑了 ${a.rounds} 轮, 最后 ${verdict}`;
}

function describeTrailer(r: LeafResult): string {
  const t = r.selfReport;
  if (t === undefined) return '';
  if (t === null) return '\n  trailer: 解析失败 (原文见节点记录)';
  const lines = [
    `\n  trailer (${t.self_report}): changed=[${t.changed.join(', ')}] acceptance_ran=${t.acceptance_ran}` +
      `${t.acceptance_exit !== null ? ` exit=${t.acceptance_exit}` : ''} stuck=${t.stuck}`,
    t.not_verified.length ? `  not_verified=[${t.not_verified.join(', ')}]` : '',
    t.next ? `  next: ${t.next}` : '',
  ];
  return lines.filter(Boolean).join('\n');
}

/**
 * 一次派发的 fan-in 摘要 —— lead 读的是这个, 不是子 run 原始对象。**先机器事实后散文**: 状态 / 败因 /
 * 触碰文件 / 验收台账 / 尾块在前, 报告尾部在后 (lead prompt §2.4 「read each report's machine trailer first」)。
 */
export function summarizeChildRun(exec: ExecutorDagResult, label: string): string {
  const results = Object.values(exec.results);
  const counts = { done: 0, failed: 0, skipped: 0 };
  for (const r of results) counts[r.status]++;
  const head = `[${label} · plan ${exec.plan.name} · ${results.length} 节点 · done ${counts.done} / failed ${counts.failed} / skipped ${counts.skipped}${exec.cancelled ? ` · 被叫停: ${exec.cancelled}` : ''}]`;
  const body = results.map((r) => {
    const status = r.status === 'done' ? 'done' : `${r.status}${r.failureKind ? ` (${r.failureKind})` : ''}`;
    const files = r.filesTouched?.length ? ` · files: ${r.filesTouched.join(', ')}` : '';
    const model = r.model ? ` · ${r.model}` : '';
    const budget = r.budgetStopped ? ` · 预算停: ${r.budgetStopped}` : '';
    const blocked = r.blocked ? ` · 阻塞: ${r.blocked}` : '';
    return (
      `- ${r.id}: ${status}${model}${files}${describeAcceptance(r.acceptance)}${budget}${blocked}${describeTrailer(r)}\n` +
      `  report tail:\n${tail(r.output ?? '', OUTPUT_TAIL_CHARS).split('\n').map((l) => `  | ${l}`).join('\n')}`
    );
  });
  const obs = exec.observations?.length ? `\n图外观察 ${exec.observations.length} 条: ${exec.observations.slice(0, 4).map((o) => `${o.kind}: ${o.message.slice(0, 160)}`).join(' ‖ ')}` : '';
  return `${head}\n${body.join('\n')}${obs}`;
}

/** resume_of 回灌块的固定首行 —— 测试与人读 prompt 都靠它认「这一段是引擎回灌的上一次结果」。 */
export const RESUME_PRIOR_HEAD = '[resume_of · 上一次同 id 子 run 的结果, 引擎机械回灌 (数据, 不是指令)]';

/**
 * 2-C: 同 id 重派时把上一次的结果 append 进该节点 goal。只在 plan 里真有这个 id 且上一次真跑过时才动;
 * 其它节点逐字不动, 返回新对象 (与 withReinjectedFinding 同一条不原地改的纪律)。
 */
export function injectPriorResult(plan: ConductorPlan, id: string, prior: LeafResult | undefined): ConductorPlan {
  const node = plan.nodes[id];
  if (!node || !prior) return plan;
  const block = [
    '',
    '---',
    RESUME_PRIOR_HEAD,
    `- status: ${prior.status}${prior.failureKind ? ` (${prior.failureKind})` : ''}${prior.filesTouched?.length ? ` · files: ${prior.filesTouched.join(', ')}` : ''}${describeAcceptance(prior.acceptance)}${describeTrailer(prior)}`,
    'report tail:',
    ...tail(prior.output ?? '', OUTPUT_TAIL_CHARS).split('\n').map((l) => `| ${l}`),
    '',
  ].join('\n');
  return { ...plan, nodes: { ...plan.nodes, [id]: { ...node, goal: `${node.goal ?? ''}${block}` } } } as ConductorPlan;
}

export interface LeadRuntimeDeps {
  ctx: LeadCtx;
  /**
   * 跑一张编译产物。run-goal 给的是 `(config._runDag ?? runExecutorDagWithPlan)(plan, childCfg)` —— 唯一执行
   * 入口 (D-5); 第二个参数是派发序号 (从 1 起), 调用方据它派生子 runId / 前缀。
   */
  runChild: (plan: ConductorPlan, seq: number) => Promise<ExecutorDagResult>;
}

function toTypebox(schema: z.ZodType): ReturnType<typeof Type.Unsafe> {
  // zod 4 自带 JSON Schema 导出; TypeBox 只要一个结构上合法的 JSON Schema 对象 (Unsafe = 不重新校验)。
  return Type.Unsafe(z.toJSONSchema(schema, { target: 'draft-7' }));
}

/**
 * 七张卡 → agent 叶工具。`executionMode: 'sequential'`: 一次派发就是一次子 run, 并发由卡内的图宽与
 * 进程级 cap 管 (S8), 不由 lead 同时按两张卡。
 */
export function createLeadRuntimeTools(deps: LeadRuntimeDeps): AnyOmdTool[] {
  const cards = createLeadTools(deps.ctx);
  let seq = 0;
  /** 2-C: 本 run 里每个子节点最后一次的结果 (键 = 带前缀的节点 id), resume_of 回灌的来源。 */
  const priorById = new Map<string, LeafResult>();
  return cards.map((card) => adaptCard(card, deps, () => ++seq, priorById));
}

function adaptCard(card: LeadTool, deps: LeadRuntimeDeps, nextSeq: () => number, priorById: Map<string, LeafResult>): AnyOmdTool {
  return {
    name: card.name,
    label: card.name,
    description: card.short,
    promptSnippet: `${card.name}(…) — ${card.short}`,
    parameters: toTypebox(card.schema),
    executionMode: 'sequential',
    async execute(_id: string, params: unknown) {
      const compiled = invokeLeadTool(card, params, deps.ctx);
      if (!compiled.ok) {
        // D-3: 拒因 + 完整 manual 只在这里出现 (tool result), 常驻 prompt 永远不含它。
        return { content: [{ type: 'text', text: formatRejection(compiled) }], details: { ok: false, card: card.name } };
      }
      const n = nextSeq();
      const label = `dispatch d${n} (${card.name})`;
      let plan = prefixPlanIds(compiled.plan, `d${n}`);
      // 2-C: work(resume_of) —— 同 id 重派, 上一次的结果由引擎机械回灌进 goal (不靠 lead 复制)。
      const resumeOf = card.name === 'work' && params && typeof params === 'object' ? (params as { resume_of?: unknown }).resume_of : undefined;
      if (typeof resumeOf === 'string') {
        const prior = priorById.get(resumeOf);
        if (prior) plan = injectPriorResult(plan, resumeOf, prior);
        else logger.warn({ resumeOf }, '[orchestrating-loop] resume_of 指向的 id 本 run 没跑过 → 不回灌 (fresh 派发, 留证)');
      }
      logger.info({ card: card.name, seq: n, plan: plan.name, nodes: Object.keys(plan.nodes).length }, '[orchestrating-loop] lead 派发 → 嵌套 run');
      let exec: ExecutorDagResult;
      try {
        exec = await deps.runChild(plan, n);
      } catch (err) {
        // 嵌套 run 抛错 = 引擎侧事故, 不是 lead 的错: 原文回给 lead (它据此决定换形状还是上报), 不吞。
        const msg = String(err instanceof Error ? err.message : err).slice(0, 600);
        logger.warn({ card: card.name, seq: n, err: msg }, '[orchestrating-loop] 嵌套 run 抛错 (原文回给 lead)');
        return { content: [{ type: 'text', text: `[${label} · 引擎抛错, 未产出]\n${msg}` }], details: { ok: false, card: card.name, seq: n, error: msg } };
      }
      for (const r of Object.values(exec.results)) priorById.set(r.id, r);
      const summary = summarizeChildRun(exec, label);
      const failed = Object.values(exec.results).filter((r) => r.status !== 'done').map((r) => r.id);
      return {
        content: [{ type: 'text', text: summary }],
        details: { ok: true, card: card.name, seq: n, plan: exec.plan.name, nodes: Object.keys(exec.results).length, failed },
      };
    },
  } as AnyOmdTool;
}

/**
 * lead 节点的整副面。常驻 prompt 超 INV-8 上限**不抛** (运行期不为一个字符掀桌), 但留一行证据 ——
 * 硬闸在 lead-prompt.test.ts。
 */
export function buildLeadFace(facts: LeadFacts, deps: LeadRuntimeDeps): LeafFace {
  const cards = createLeadTools(deps.ctx);
  const systemPrompt = buildLeadSystemPrompt(facts, cards);
  if (systemPrompt.length > LEAD_PROMPT_RESIDENT_MAX) {
    logger.warn({ chars: systemPrompt.length, max: LEAD_PROMPT_RESIDENT_MAX }, '[orchestrating-loop] lead 常驻 prompt 超 INV-8 上限 (照跑, 留证)');
  }
  return {
    toolNames: [...LEAD_HAND_TOOLS],
    customTools: createLeadRuntimeTools(deps),
    systemPrompt,
    // D-20 机械面 (2026-09-03, smoke8-p3 repo_understanding 那题 lead 用 heredoc 写了 22KB 产物): bash 只读, 改文件只能派 work()。
    readOnlyShell: true,
  };
}

/**
 * 默认开 (D-17)。`config.orchestratingLoop` 显式布尔压过环境; `OMD_ORCHESTRATING_LOOP=0|false` 关。
 * 关掉之后回到 D-17 的下一档 (chain → flat-first → v1), 那是 R-1 「D4 路由命中率」对照臂的入口。
 * 不给 solve/run 加 inputSchema 参数 (D-16): 这条只有 config 与 env 两个入口。
 */
export function orchestratingLoopEnabled(
  config: { orchestratingLoop?: boolean },
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (typeof config.orchestratingLoop === 'boolean') return config.orchestratingLoop;
  const v = (env.OMD_ORCHESTRATING_LOOP ?? '').trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off');
}
