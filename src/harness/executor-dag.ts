/**
 * src/harness/executor-dag —— omd 本体的**内部 executor-DAG**(现场 fan-out, ⊥ 宿主宏观引擎 宏观 PG DAG)。
 *
 * 这是 omd agent **本体 runtime 底层**自包含的编排循环 (Nick 2026-06-01 锁定「两者都要, 先 in-process」):
 *   task ──conductor──▶ plan(leaves + deps) ──executor──▶ 现场 fan-out ──▶ results
 *
 * 设计锁 (Nick): 无硬默认 (conductorModel/leafModel 必填) · model-agnostic (经 src/model callModel) ·
 *   不碰 PG/conduct()/claude -p · 现场 in-process (leaves 经 primitives.parallel, 不落宿主宏观 workflow 表)。
 *
 * T2#5 (2026-06-23): 682行 god-file 按簇拆 4 文件 —— 契约类型→executor-dag-types, 默认/prompt 常量→
 *   executor-dag-defaults, 纯 helper(topoLevels/buildLeafPrompt/addUsage)→executor-dag-planner; 本文件留
 *   引擎 (ExecOnce/planAndExecute/runExecutorDag) + barrel re-export 公共面 (30+ 消费方 import './executor-dag' 不变)。
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { ModelUsage } from '../model/gateway';
import { escalationProviderReady } from './verifier';
import {
  conductorSystemPrompt,
  conductorPatchSystemPrompt,
  parsePlan,
  PLAN_BOUNDARY,
  type ConductorPlan,
} from './conductor-plan';
// S3.6 escalation patch 模式: 补丁解析 + 程序化 merge (未补丁节点字节不动 → D-21 复用按构造成立)。
import { parsePlanPatch, applyPlanPatch } from './plan-patch';
import { hashArtifact, hashText, computeDagGeneration } from './continuity/checkpoint-manager';
import type { NodeCheckpoint } from './continuity/types';
// noun-gate 接缝(INV-X3):宿主注入(上游宿主传 memory-hub checkNouns);包不依赖 memory-hub。
type NounGateFn = (args: { text: string; material: string; repoRoot: string; annotate: boolean }) => { novelNouns: string[] };
let _nounGate: NounGateFn | null = null;
export function setNounGate(fn: NounGateFn | null): void { _nounGate = fn; }
import { cavemanRule, leafCavemanLevel } from './caveman';
import { leafCostReward } from './model-router';
import { logger } from './logger';
// ── T2#5 按簇拆出的兄弟文件 (引擎消费) ──
import type { GenerateFn, ExecutorDagConfig, LeafResult, ExecutorDagResult } from './executor-dag-types';
import { makeDefaultGenerate, LEAF_SYSTEM_PREFIX, PONYTAIL_LEAF_DISPOSITION } from './executor-dag-defaults';
import { topoLevels, buildLeafPrompt, addUsage, filterOracleCommandNodes } from './executor-dag-planner';
import { loadAgentTemplates, templateRoster, type AgentTemplate } from './agent-templates';
import { expandMapNode, mapSpecHash } from './plan/map-expand';
// SDD 0013 S1 约束选择: primitive 节点 → compile(复用 primitives.ts)→ run。
import { compilePrimitive, type PrimitiveCtx } from './primitive-registry';
// fan-in 定向摘要 (扇出≥2 → 摘要替全文注入, 见 fanin-summary.ts)。
import {
  normalizeFaninConfig,
  runFaninSummary,
  composeFaninView,
  DEFAULT_FANIN_SCHEMA,
} from './fanin-summary';
// D-21 escalation 跨轮复用: 语义 Merkle 指纹 + 前驱闭包匹配 (semantic-key 单一真源)。
import { computeReuse, merkleFingerprints } from './plan-passes/semantic-key';
import { expandConductorNode, subgraphWarnings } from './plan/conductor-expand';
import { renderRoundForJudge, splitNamedIds, type JudgeChildView } from './plan/conductor-judge';
import { makeLlmConvergenceJudge } from './plan/llm-judge';
import { send } from '../model/gateway';
// D-14v2 多模态媒体管道 (S4): attach_media 执行期从直接前驱输出解析图片 → ContentPart 注入。
import { collectDepMedia } from './leaf-media';
import type { ContentPart } from '../model/gateway';

/** 上一轮 plan+results (escalation 重规划轮传入, D-21 跨轮复用的匹配源)。 */
import type { PriorExec } from './executor-dag-types';

// ── barrel re-export: 保持 ./executor-dag 公共面稳定 (importer-closure, 消费方零改) ──
export type { GenerateFn, ExecutorDagConfig, ExecutorDagResult, LeafResult, DagNodeEvent } from './executor-dag-types';
export { topoLevels } from './executor-dag-planner';
export { loadAgentTemplates, templateRoster, AGENT_TEMPLATE_DIR } from './agent-templates';
export type { AgentTemplate } from './agent-templates';
export { PONYTAIL_LEAF_DISPOSITION } from './executor-dag-defaults';

/** 一轮 plan+execute 的产物 (verify/升级编排在 runExecutorDag 外层组装)。 */
interface ExecOnce {
  plan: ConductorPlan;
  levels: string[][];
  results: Record<string, LeafResult>;
  /** 本轮 D-21 复用命中的节点 id (结果面 reusedNodes 的来源)。 */
  reusedNodes: string[];

  conductorUsage: ModelUsage;
  leavesIn: number;
  leavesOut: number;
  leavesCacheHit: number;
}

/**
 * 单轮: conductor 规划 (显式 conductorModel) → 现场 fan-out leaves → results。
 * 升级时本函数被重复调用 (换 conductorModel + 注入失败原因的 task)。
 */
async function planAndExecute(
  task: string,
  config: ExecutorDagConfig,
  conductorModel: string,
  generate: GenerateFn,
  maxPlanRetries: number,
  templates: ReadonlyMap<string, AgentTemplate>,
  prior?: PriorExec,
): Promise<ExecOnce> {
  // ── 1. conductor: 单结构化调用规划 (显式可换) ──────────────────────────────
  // 模板注册表进规划 prompt (每卡一行 description); parsePlan 校验 template 引用 (TPL-2 规划层拒)。
  // prompt 档位: config > env OMD_CONDUCTOR_PROMPT > 'full' (弱 conductor 教练全量; 'lean' 给顶级模型)。
  const promptProfile =
    config.conductorPromptProfile ?? (process.env.OMD_CONDUCTOR_PROMPT === 'lean' ? 'lean' : 'full');
  const sys = conductorSystemPrompt({
    agents: config.agents,
    templates: templateRoster(templates),
    profile: promptProfile,
  });
  let plan: ConductorPlan | null = null;
  let conductorUsage: ModelUsage = { in: 0, out: 0 };
  let lastErr = '';
  // conductor 输出预算 (2026-07-25 实证修): plan JSON 随任务规模涨, thinking 模型 (k3) 的推理还可能
  // 计入 completion 预算 — transport 默认 4096 必截断 (Unterminated string 重试耗尽整轮报废)。
  // 默认 8192 = deepseek 系安全顶 (同 fanout SYNTH_MAX 语义); k3 等高容量 conductor 经 config/env 升。
  const conductorMaxTokens =
    config.conductorMaxTokens ?? (Number(process.env.OMD_CONDUCTOR_MAX_TOKENS) || 32_768);
  for (let attempt = 1; attempt <= maxPlanRetries + 1; attempt++) {
    const correction = attempt === 1 ? '' : `\n\n上次回复不是有效 plan (${lastErr})。只回 JSON 对象, 别的不要。`;
    const { text, usage } = await generate({
      messages: [{ role: 'system', content: sys }, { role: 'user', content: `${PLAN_BOUNDARY}${task}${correction}` }],
      model: conductorModel,
      // S-T 优先序: config 显式 > 座位档 (auto-assign 给 decomposer 座的档) > 硬默认。
      thinkingLevel: config.conductorThinkingLevel ?? config.seatThinking?.(conductorModel) ?? 'high',
      maxTokens: conductorMaxTokens,
    });
    conductorUsage = addUsage(conductorUsage, usage);
    const parsed = parsePlan(text, { knownTemplates: new Set(templates.keys()) });
    if (parsed.ok) {
      plan = parsed.plan;
      break;
    }
    lastErr = parsed.error;
  }
  if (!plan) throw new Error(`executor-dag: conductor (${conductorModel}) 未产出有效 plan: ${lastErr}`);

  // pass 管线 (SDD v2): oracle 过滤 + planFilters (prune→dedup→stamp, 接线层组装)。
  // conductor 之后, 下游执行机器与 plan 来源无关 → 交 executePlan (D-7 预构造入口共用同一机器)。
  return executePlan(applyPlanFilters(plan, config), task, config, generate, conductorUsage, templates, prior);
}

/**
 * SDD v2 pass 管线: oracle 等价节点过滤 → config.planFilters 依序应用 (prune → dedup → stamp,
 * 链由接线层组装, 见 plan-passes/)。确定性纯函数链; 抛错上抛 fail-closed (坏 pass 不静默跳过)。
 * conductor 首轮与 escalation 重规划轮都过同一管线 (planAndExecute 每轮调用)。
 */
function applyPlanFilters(plan: ConductorPlan, config: ExecutorDagConfig): ConductorPlan {
  let p = config.oracleCmd ? filterOracleCommandNodes(plan, config.oracleCmd) : plan;
  for (const f of config.planFilters ?? []) p = f(p);
  return p;
}

/**
 * S3.6 escalation patch 模式 (D-21/G-21 强化, 信任反转): 重规划 conductor 只输出节点补丁 JSON
 * ({改哪些节点: 新字段}), 引擎程序化 merge 到上轮 plan — 未补丁节点**字节不动** → 语义指纹复用
 * 按构造成立, 不再指望 LLM「逐字保留」(S3.5 实证跨轮重措辞, 4 采样 1 中)。
 * 补丁解析/校验失败 → exec:null, 调用方回退现行整图重规划 (SDD 钉死 fail-open);
 * usage 始终返回 (补丁尝试烧掉的 conductor token 不丢账 — 成功时已折进 exec.conductorUsage)。
 */
async function tryPatchReplan(
  task: string,
  reason: string,
  prior: PriorExec,
  config: ExecutorDagConfig,
  conductorModel: string,
  generate: GenerateFn,
  maxPlanRetries: number,
  templates: ReadonlyMap<string, AgentTemplate>,
): Promise<{ exec: ExecOnce | null; usage: ModelUsage }> {
  const sys = conductorPatchSystemPrompt();
  const prevPlanJson = JSON.stringify(
    {
      name: prior.plan.name,
      ...(prior.plan.description ? { description: prior.plan.description } : {}),
      nodes: prior.plan.nodes,
      ...(prior.plan.outputs?.length ? { outputs: prior.plan.outputs } : {}),
    },
    null,
    1,
  );
  const known = new Set(templates.keys());
  let usage: ModelUsage = { in: 0, out: 0 };
  let lastErr = '';
  for (let attempt = 1; attempt <= maxPlanRetries + 1; attempt++) {
    const correction = attempt === 1 ? '' : `\n\n上次回复不是有效补丁 (${lastErr})。只回 {"patch": {...}} JSON 对象, 别的不要。`;
    const { text, usage: u } = await generate({
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: `${PLAN_BOUNDARY}${prevPlanJson}\n\n[verification failure] ${reason}${correction}` },
      ],
      model: conductorModel,
      thinkingLevel: config.conductorThinkingLevel ?? config.seatThinking?.(conductorModel) ?? 'high',
      maxTokens: config.conductorMaxTokens ?? (Number(process.env.OMD_CONDUCTOR_MAX_TOKENS) || 32_768),
    });
    usage = addUsage(usage, u);
    const parsed = parsePlanPatch(text);
    if (!parsed.ok) {
      lastErr = parsed.error;
      continue;
    }
    const applied = applyPlanPatch(prior.plan, parsed.patch, { knownTemplates: known });
    if (!applied.ok) {
      lastErr = applied.error;
      continue;
    }
    const { plan, changed, removed, added } = applied.applied;
    logger.info(
      { changed, removed, added, total: Object.keys(plan.nodes).length },
      '[omd/executor-dag] escalation 补丁采纳 → 程序化 merge (S3.6; 未补丁节点按构造复用)',
    );
    const exec = await executePlan(applyPlanFilters(plan, config), task, config, generate, usage, templates, prior);
    return { exec, usage };
  }
  logger.warn({ err: lastErr }, '[omd/executor-dag] escalation 补丁模式未产出有效补丁 → 回退整图重规划 (S3.6 fail-open)');
  return { exec: null, usage };
}

/**
 * 执行一张**已定** plan (conductor 路径 ∨ D-7 预构造入口共用): topo 分层 → ready-set 现场 fan-out
 * (map/primitive/command/agent/inproc + checkpoint) → results。**纯下游执行机器**, 与 plan 从哪来无关
 * (ConductorPlan = 接缝, 下游零感知)。conductorUsage 由 caller 传入 (conductor 路径=累加规划用量;
 * 预构造路径={in:0,out:0}) → 账本一致。
 */
async function executePlan(
  plan: ConductorPlan,
  task: string,
  config: ExecutorDagConfig,
  generate: GenerateFn,
  conductorUsage: ModelUsage,
  templates: ReadonlyMap<string, AgentTemplate>,
  prior?: PriorExec,
): Promise<ExecOnce> {
  const levels = topoLevels(plan);
  logger.info(
    { plan: plan.name, leafModel: config.leafModel, nodes: Object.keys(plan.nodes).length, levels: levels.length },
    '[omd/executor-dag] planned',
  );

  // 节点进度事件发射器 (fail-open: 观察者抛错不许扰动执行)。kind 词表 = executor ?? primitive ?? leaf。
  const nodeKind = (n: ConductorPlan['nodes'][string]): string =>
    n.kind === 'primitive' ? 'primitive' : (n.executor ?? 'leaf');
  const emitNodeEvent = (e: Parameters<NonNullable<ExecutorDagConfig['onNodeEvent']>>[0]): void => {
    try {
      config.onNodeEvent?.(e);
    } catch {
      /* fail-open */
    }
  };
  emitNodeEvent({
    type: 'planned',
    nodes: Object.entries(plan.nodes).map(([id, n]) => ({ id, kind: nodeKind(n) })),
  });

  // ── D-21 escalation 跨轮复用: 语义 Merkle 指纹 + 前驱闭包匹配上轮 done 节点 → 零 LLM 注入。
  // 重规划最烧 token 的形态 = 80% 节点语义没变却整图重跑; 指纹按语义不按 id, 重命名不破匹配。
  // D-4 (P1.5): prior.poisoned = 上轮被 judge 点名拒绝的节点指纹, 一律不复用 (前向闭包免费, 见 computeReuse)。
  const reuse = prior ? computeReuse(plan, prior, prior.poisoned) : new Map<string, LeafResult>();
  if (reuse.size > 0) {
    logger.info({ reused: [...reuse.keys()], total: Object.keys(plan.nodes).length }, '[omd/executor-dag] 跨轮语义复用集 (D-21)');
  }
  if (prior?.poisoned?.size) {
    logger.info({ poisoned: prior.poisoned.size, reused: reuse.size }, '[omd/executor-dag] D-4 毒集生效 → 被拒指纹及其下游强制重跑');
  }

  // ── 2. executor: ready-set 现场 fan-out (依赖就绪即跑, 见下方调度器), leaf 调显式 leafModel ──
  const results: Record<string, LeafResult> = {};
  const depOutputs: Record<string, string> = {};
  // fan-in 定向摘要视图: nodeId → 摘要+全文指针 (扇出≥2 且够长的 producer 才有条目)。
  // 下游 fan-in 注入 `faninView[d] ?? depOutputs[d]` (有摘要用摘要, 否则全文兜底)。
  const faninView: Record<string, string> = {};
  const faninCfg = normalizeFaninConfig(config.faninSummary);
  let leavesIn = 0;
  let leavesOut = 0;
  let leavesCacheHit = 0;

  // W2 continuity (SDD C4): 落 _dag.json 元数据 + resume 时预载已绿节点。全程 fail-open (manager 内部已兜)。
  const continuity = config.continuity;
  const resumeGreens = new Map<string, NodeCheckpoint>();
  // W4 SHADOW-3: 本 run 的 DAG 代数签名 (落 metadata + checkpoint; resume 时校验防过期切点乱截)。
  let dagGeneration: string | undefined;
  if (continuity) {
    const goal = task.slice(0, 400);
    const nodeIds = Object.keys(plan.nodes);
    const deps = Object.fromEntries(Object.entries(plan.nodes).map(([k, n]) => [k, n.depends_on ?? []]));
    dagGeneration = computeDagGeneration({ goal, nodeIds, deps });
    continuity.manager.writeDagMetadata(continuity.runId, {
      runId: continuity.runId,
      specSlug: task.slice(0, 60),
      goal,
      nodeIds,
      deps,
      createdAt: new Date().toISOString(),
      generation: dagGeneration,
      // plan-memory 缺口①: 全量 plan + 任务原文落盘 (此前只存骨架, 图的"肉"随进程丢弃)。
      plan: { name: plan.name, ...(plan.description ? { description: plan.description } : {}), nodes: plan.nodes },
      taskText: task,
    });
    if (continuity.resume) {
      for (const cp of continuity.manager.loadAllGreen(continuity.runId)) resumeGreens.set(cp.nodeId, cp);
      dropPoisonedGreens(resumeGreens, plan, prior?.poisoned);
    }
  }

  /**
   * 一个节点这次吃到的**输入面** (D-O): dep id → 该 dep 的**输出全文**。
   *
   * 锚在依赖的全文而非"实际注入的 prompt": fan-in 定向摘要是 LLM 现生成的, 拿它当锚会让每次
   * resume 都判 stale。全文没变 = 输入语义没变。还没产出的 dep 不入表 (调度保证不会发生)。
   */
  const inputsOf = (deps: readonly string[]): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const d of deps) {
      const o = depOutputs[d];
      if (o !== undefined) out[d] = o;
    }
    return out;
  };

  /**
   * **成功节点 checkpoint 落盘** (D-O 统一出口, fail-open)。此前只有 inproc/agent 分支写,
   * command / research 节点根本没有绿 checkpoint。
   *
   * 三件事一起做: ① 输出全文落制品 (`out-<id>.txt`) —— summary 自此只给人看 ② 记输入面指纹
   * (上游内容变了 resume 就不许跳过) ③ 产物 hash (原有的产出面校验)。
   *
   * noun-gate 注释 only, material = 节点 prompt (含 deps 上下文) —— "输出了输入和 repo 都没有的
   * 名词"才是审计信号 (material 含 output 会恒真, SDD C5 消费者② 修正)。无 prompt 的节点
   * (command/research) 不跑它。tokenUsage: agent leaf 真值不可得 → null (V2-ECON)。
   */
  const saveDoneCheckpoint = (opts: {
    id: string;
    kind: NodeCheckpoint['leafKind'];
    model?: string;
    text: string;
    usage: ModelUsage | null;
    filesTouched: readonly string[];
    deps: readonly string[];
    t0: number;
    /** noun-gate material (agent/inproc leaf 的完整 prompt); 无则跳过注释。 */
    prompt?: string;
    /** 产物根 (agent leaf 自报 cwd 最准); 缺省 continuity.repoRoot。 */
    artifactRoot?: string;
  }): void => {
    if (!continuity) return;
    try {
      const root = opts.artifactRoot ?? continuity.repoRoot ?? process.cwd();
      // 产物路径相对化到 repoRoot (worktree 可移植; shouldSkip 用 repoRoot 锚回)。
      const rel = (p: string): string => (p.startsWith(`${root}/`) ? p.slice(root.length + 1) : p);
      const artifactHashes: Record<string, string> = {};
      const outputPaths: string[] = [];
      for (const p of opts.filesTouched) {
        const rp = rel(p);
        outputPaths.push(rp);
        const h = hashArtifact(p.startsWith('/') ? p : `${root}/${rp}`);
        if (h) artifactHashes[rp] = h;
      }
      const summary = opts.text.slice(0, 800);
      // 通道⑤-b: 落盘时把语义指纹一并存下 —— resume 预载判毒时**不用重算**, 于是运行时展开的
      // 子节点 (预载那刻还不在图里) 也判得了。指纹只依赖祖先, 而祖先此刻已定死 → 与轮末 judge
      // 算的值一致。fail-open: 算不出来就不存, 退回原语义。
      let fingerprint: string | undefined;
      try {
        fingerprint = merkleFingerprints(plan!).get(opts.id);
      } catch {
        /* 指纹算不出 (环等) 不该阻断 checkpoint */
      }
      // D-O: 全文落制品。写失败 → null → 字段缺席, resume 退回 summary (fail-open, 有留痕)。
      const outputText = continuity.manager.saveNodeOutput(continuity.runId, opts.id, opts.text);
      const inputHashes: Record<string, string> = {};
      for (const [d, o] of Object.entries(inputsOf(opts.deps))) inputHashes[d] = hashText(o);
      let nounAnnotations: string[] | undefined;
      if (opts.prompt !== undefined) {
        try {
          if (!_nounGate) throw new Error('noun-gate not injected');
          const ng = _nounGate({ text: summary, material: opts.prompt, repoRoot: root, annotate: false });
          if (ng.novelNouns.length > 0) nounAnnotations = ng.novelNouns.slice(0, 10);
        } catch {
          /* noun-gate 注释 only, 挂了不影响 checkpoint */
        }
      }
      continuity.manager.saveCheckpoint(continuity.runId, {
        nodeId: opts.id,
        leafKind: opts.kind,
        status: 'done',
        ...(opts.model ? { model: opts.model } : {}),
        outputPaths,
        artifactHashes,
        tokenUsage: opts.usage,
        summary,
        ...(outputText ? { outputText } : {}),
        ...(fingerprint ? { fingerprint } : {}),
        ...(Object.keys(inputHashes).length ? { inputHashes } : {}),
        ...(nounAnnotations ? { nounAnnotations } : {}),
        durationMs: Date.now() - opts.t0,
        createdAt: new Date().toISOString(),
        ...(dagGeneration ? { generation: dagGeneration } : {}),
        schemaVersion: 1,
      });
    } catch (err) {
      logger.warn({ node: opts.id, err }, '[omd/executor-dag] checkpoint write failed (fail-open)');
    }
  };

  // ── P3 批次 3 第一次加厚: `executor:'conductor'` 运行时**异构**展开 (D-B/D-C/D-D) ───────
  //
  // 与 map 的分工: map 扇的是「同一件事的 N 份」(模板 + 运行时清单); conductor 展的是
  // 「一件事的若干不同步骤」(各有各的 goal/executor/依赖) —— 模板表达不了的形状。
  //
  // **本次不带环** (刻意): 第一次加厚只做「展开 + 局部调度」, 跑通为先。环 (D-A: 把外层 fixpoint
  // 搬进节点内) 留给第二次加厚 —— P1 的 double-loop 教训是两层 verify 必须二选一, 在环搬进来
  // **之前**先把外层撤掉是错的顺序, 会有一段时间两层都不在。
  /**
   * 内环 judge (D-E): 判的是**这个节点的 goal 达成没有**, 不另加一层全局验收
   * (加了就要回边, 破坏无环)。形状承 D-4: 除了收敛与否, 还要它**点名**哪些子节点的产出不作数
   * —— 点名才铸得出票, 铸不出票就只能整轮重来。
   *
   * fail-closed: 解析不出结论 → 判未收敛并说明, 不当作收敛 (谎报收敛比多跑一轮贵得多)。
   */
  const judgeConductorRound = async (
    id: string,
    goal: string,
    leaf: LeafResult,
    round: number,
    children: readonly JudgeChildView[],
  ): Promise<{ converged: boolean; reason: string; rejected: string[]; usage: ModelUsage }> => {
    const childIds = children.map((c) => c.id);
    // 整轮就没跑成 → 直接未收敛, 省一次 judge 调用 (同 llm-judge 的 status==='failed' 短路)。
    if (leaf.status === 'failed') {
      return { converged: false, reason: `整轮失败: ${leaf.output.slice(0, 300)}`, rejected: [], usage: { in: 0, out: 0 } };
    }
    const judgeCoord = config.judgeModel ?? config.conductorModel;
    try {
      // **复用外层那份判词** (D-E, 2026-07-29 实测后改): 我原先另写的一份在 `fabricated` 段
      // 30 次里 9 次谎报完成, 而外层那份 100% —— 差的是它判词里那条「捏造 → converged=false」
      // 与「先抽出所有明确要求再逐条对照」。详见 plan/conductor-judge.ts 的模块注。
      // 顺带白拿 responseSchema 强制结构化 (裸 JSON 手抠时 flash 档实测出过解析失败与空裁决)。
      let usage: ModelUsage = { in: 0, out: 0 };
      const judge = makeLlmConvergenceJudge<null>({
        judgeModel: judgeCoord,
        task: goal,
        // judge 看的是**专门渲染的视图**, 不是节点对下游的 output —— 后者带"N/M 成功"的开场白
        // (对 judge 是"都好着呢"的暗示) 且只有可读名没有可点名的 id。
        extract: () => ({ status: 'done', summary: renderRoundForJudge(children) }),
        callModelFn: async (req) => {
          const r = await (config.judgeSend ?? send)(req);
          usage = addUsage(usage, r.usage ?? { in: 0, out: 0 });
          return r;
        },
      });
      const v = await judge(null, round);
      const { rejected, ghosts } = splitNamedIds(v.rejectedNodes, childIds);
      if (ghosts.length) {
        logger.warn({ node: id, round, ghosts }, '[omd/executor-dag] 内环 judge 点名了子图中不存在的 id → 丢弃');
      }
      return { converged: v.converged, reason: v.failureReason ?? '', rejected, usage };
    } catch (err) {
      // fail-closed: 判不出来就当没达成。judge 挂掉不该变成"那就算过了吧"。
      logger.warn({ node: id, round, err: String(err) }, '[omd/executor-dag] 内环 judge 无结论 → 判未收敛 (fail-closed)');
      return { converged: false, reason: 'judge 无可解析结论 (fail-closed)', rejected: [], usage: { in: 0, out: 0 } };
    }
  };

  /** 一轮内环: 展开 → 闸 → 局部调度 → 汇总。环由 {@link runConductorNode} 在外面绕。 */
  const runConductorRound = async (
    id: string,
    round: number,
    prevReason: string,
    poisoned: ReadonlySet<string>,
    /** 上一轮的子节点结果 (D-21 内环版: 跨轮复用的匹配源, 键 = 内容寻址 id)。 */
    prevResults: ReadonlyMap<string, LeafResult>,
  ): Promise<{ leaf: LeafResult; children: JudgeChildView[]; usage: ModelUsage; results: Map<string, LeafResult> }> => {
    const node = plan!.nodes[id]!;
    const deps = node.depends_on ?? [];
    let usageAcc: ModelUsage = { in: 0, out: 0 };

    // ── 1. 让 conductor 现场画子图 ──
    // 上游输出进 prompt (有 fan-in 摘要用摘要), 与 map lister 同形。
    const depCtx = deps.length
      ? `\n\n<upstream>\n${deps.map((d) => `[${d}]\n${faninView[d] ?? depOutputs[d] ?? ''}`).join('\n\n')}\n</upstream>`
      : '';
    // **环的信息通道**: 上一轮的失败原因回灌给 conductor, 让它**重新画**而不是重跑同一张图。
    // 这是 D-A 环的全部价值 —— 重跑只能把同样的活再干一遍, 重画才补得出上一轮压根没有的步骤
    // (D-G′ 说的「补调研」正是这个形状: 不需要回边, 每一轮都是一张全新的无环子图)。
    const retryCtx = prevReason
      ? `\n\n<上一轮未通过>\n${prevReason.slice(0, 1500)}\n</上一轮未通过>\n` +
        '这一轮请**重新分解**: 该补的步骤补上 (包括上一轮压根没有的那种, 比如先去把某个事实查清楚), ' +
        '该改的改掉。原样再画一遍上一轮的图只会再失败一次。'
      : '';
    let sub: ConductorPlan;
    try {
      const sys = conductorSystemPrompt({
        ...(config.agents ? { agents: config.agents } : {}),
        templates: templateRoster(templates),
        profile: config.conductorPromptProfile ?? (process.env.OMD_CONDUCTOR_PROMPT === 'lean' ? 'lean' : 'full'),
      });
      const { text, usage } = await generate({
        messages: [
          { role: 'system', content: sys },
          {
            role: 'user',
            content:
              `${PLAN_BOUNDARY}${node.goal ?? id}${depCtx}${retryCtx}\n\n` +
              // D-D 写进 prompt 而不只靠事后拒: 让它知道边界, 比让它撞上去便宜。
              '注意: 本次分解出的节点**不得**再用 executor:"conductor" 或 executor:"map" —— ' +
              '你现在就是运行时展开, 已经知道清单了, 直接把步骤列出来即可。',
          },
        ],
        // TPL-3 显式最高优先: 手写 plan 钉了 node.model 就用它; 否则走 conductor 座位。
        // (stamp pass 刻意跳过 conductor 节点 —— 它盖的是 leaf 档坐标, 这里根本不读。)
        model: node.model ?? config.conductorModel,
        thinkingLevel: config.conductorThinkingLevel ?? config.seatThinking?.(node.model ?? config.conductorModel) ?? 'high',
        maxTokens: config.conductorMaxTokens ?? (Number(process.env.OMD_CONDUCTOR_MAX_TOKENS) || 32_768),
      });
      usageAcc = addUsage(usageAcc, usage);
      const parsed = parsePlan(text, { knownTemplates: new Set(templates.keys()) });
      if (!parsed.ok) throw new Error(`子图不是有效 plan: ${parsed.error}`);
      // ── D-N 展开闸 (前半): 子图过**与外层同一条** pass 管线 (oracle 过滤 → prune → dedup →
      // evidence → stamp)。此前子图一条 pass 都不过, 后果不是"少了点优化"而是两个实打实的洞:
      //   ① `tier` 在子节点上是**哑弹** —— stamp 才是把档位翻译成坐标的那一步, 不过它就全部
      //      掉到静态 leafModel, conductor 写 tier:'strong' 白写。
      //   ② evidence pass 的硬闸 (UI 交付物必须挂确定性截图闸) 对子图不生效。
      // 管线抛错 = fail-closed 拒整份子图, 与外层 plan 撞上坏 pass 时同一语义。
      sub = applyPlanFilters(parsed.plan, config);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ node: id, round, err: msg }, '[omd/executor-dag] conductor 节点展开失败 → failed');
      return {
        leaf: { id, status: 'failed', kind: 'conductor', output: `[conductor 展开失败: ${msg}]`, deps, usage: usageAcc },
        children: [], usage: usageAcc, results: new Map(),
      };
    }

    // ── 2. 纯展开: D-B 内容寻址 id + D-D 禁嵌套 + 环检测 + 硬顶 ──
    const expand = expandConductorNode(id, sub, node.max_nodes ? { maxNodes: node.max_nodes } : {});
    if (expand.status !== 'ok') {
      // 'empty' 也走这条: 与 map 的「空清单 = 成功 0 子」**刻意不同**。map 的空是 lister 如实报告
      // "没有东西要处理", 是一条真实且常见的信息; conductor 的空是**它没能把这件事分解出来** ——
      // 这里根本到不了 (PlanSchema 要求 ≥1 节点, 空的在 parsePlan 就被拒了), 但万一到了,
      // 判成 done 就是给"没做任何事"发一张成功票, 那是 empty-done 的同一种坏。
      logger.warn({ node: id, round, status: expand.status, error: expand.error }, '[omd/executor-dag] conductor 子图被拒');
      return {
        leaf: {
          id, status: 'failed', kind: 'conductor',
          output: `[子图被拒 (${expand.status}): ${expand.error ?? '空子图 — conductor 没能分解出任何步骤'}]`,
          deps, usage: usageAcc,
        },
        children: [], usage: usageAcc, results: new Map(),
      };
    }
    if (expand.truncated > 0) {
      logger.warn({ node: id, truncated: expand.truncated }, '[omd/executor-dag] conductor 子图截断 (no-silent-caps)');
    }
    // ── D-N 展开闸 (后半): 结构体检。**刻意只 warn 不拒** —— 这两条都有正当反例
    // (真的只有一步 / 交付物是文档而非可跑的东西), 没有证据支持一个硬阈值, 就别假装有。
    // 硬拒的三条 (禁嵌套 / 环 / 非法 plan) 在上面, 那些没有正当反例。
    for (const w of subgraphWarnings(expand.children)) {
      logger.warn({ node: id, check: w.check }, `[omd/executor-dag] conductor 子图体检: ${w.message}`);
    }

    // ── 3. 子节点挂进 plan.nodes → 复用 runNode 全套 (路由/产物闸/checkpoint/resume) ──
    // 依赖 = 子图内依赖 (已重写成内容寻址 id) **并上父节点的外层上游** —— 后者保证子节点看得见
    // conductor 节点本该看见的东西 (同 map 子节点接 `depends_on: deps`)。
    for (const child of expand.children) {
      const inner = (child.node.depends_on ?? []) as string[];
      plan!.nodes[child.id] = { ...child.node, depends_on: [...new Set([...inner, ...deps])] };
    }
    // **本节点自己的毒集**落到 resume 面 (D-A: 毒集的新家是节点级 journal, 见 NodeLoopJournal)。
    // 上一轮被内环 judge 点名的子节点, 崩溃重来时不许靠 checkpoint 当绿跳过 —— 与外层
    // `dropPoisonedGreens` 同一条纪律, 只是键是**内容寻址的子节点 id** (见 NodeLoopJournal 的注:
    // 子图指纹与整图指纹不相等, 而 id 一把钥匙同时开两把锁)。
    for (const child of expand.children) {
      if (poisoned.has(child.id) && resumeGreens.delete(child.id)) {
        logger.info({ node: id, child: child.id }, '[omd/executor-dag] 内环毒集命中 → 该子节点强制重跑 (D-A)');
      }
    }

    // ── D-21 的内环版: **跨轮复用** ────────────────────────────────────────────
    // 环搬进节点之后一度把这条丢了 —— 外层 fixpoint 有 `computeReuse`, 语义没变的节点零 LLM 注入
    // 上轮输出; 内环第 2 轮却把**每个**子节点重跑一遍 (实测 3 个子节点 → 6 次调用)。修复轮的图与
    // 上一轮大半同构, 全重跑就是把环的成本翻倍。
    //
    // 匹配免费: 子节点 id 是内容寻址的, "同 id" ≡ "同规格 + 同祖先规格"。只需再要一条 ——
    // **前驱也得可复用**: 上游若要重跑, 本节点吃到的输入就变了 (与 computeReuse 的 `deps.every` 同理)。
    const reuseLocal = new Map<string, LeafResult>();
    if (prevResults.size > 0) {
      const memo = new Map<string, boolean>();
      const canReuse = (cid: string): boolean => {
        const m = memo.get(cid);
        if (m !== undefined) return m;
        memo.set(cid, false); // 环/自引用下界 (展开期已查过环, 这里是纯函数自保)
        const prev = prevResults.get(cid);
        const inner = ((plan!.nodes[cid]?.depends_on ?? []) as string[]).filter((d) => d.startsWith(`${id}::`));
        const ok = !!prev && prev.status === 'done' && !poisoned.has(cid) && inner.every(canReuse);
        memo.set(cid, ok);
        if (ok && prev) reuseLocal.set(cid, prev);
        return ok;
      };
      for (const c of expand.children) canReuse(c.id);
      if (reuseLocal.size > 0) {
        logger.info(
          { node: id, round, reused: reuseLocal.size, total: expand.children.length },
          '[omd/executor-dag] 内环跨轮复用 → 语义没变的子节点零 LLM 注入上轮输出',
        );
      }
    }
    logger.info(
      { node: id, children: expand.children.length, ids: expand.children.map((c) => `${c.originalId}→${c.fingerprint}`) },
      '[omd/executor-dag] conductor 子图展开 (D-B 内容寻址)',
    );

    // ── 4. D-C 局部拓扑调度 ──
    // **不复用外层 ready-set**: 外层的 idSet/indeg/dependents 在 run 开始就算死了, 运行期新增的
    // 子节点进不去。也**不能用 map 那种扁平队列**: map 的子节点互相无边, conductor 的子节点有边。
    // 故在子图内自己算一次 ready-set (只认子图内的边; 指向外层的 dep 由外层调度保证已完成)。
    const childIds = expand.children.map((c) => c.id);
    const childSet = new Set(childIds);
    const indegLocal = new Map<string, number>();
    const dependentsLocal = new Map<string, string[]>();
    for (const cid of childIds) {
      const inner = ((plan!.nodes[cid]!.depends_on ?? []) as string[]).filter((d) => childSet.has(d));
      indegLocal.set(cid, inner.length);
      for (const d of inner) dependentsLocal.set(d, [...(dependentsLocal.get(d) ?? []), cid]);
    }
    const readyLocal = childIds.filter((c) => (indegLocal.get(c) ?? 0) === 0);
    const capLocal = Math.max(1, config.maxFanout && config.maxFanout > 0 ? config.maxFanout : childIds.length);
    let runningLocal = 0;
    let settledLocal = 0;
    let failedLocal = 0;
    const childOut: { id: string; originalId: string; status: string; output: string }[] = [];
    // 子树碰过的文件要**冒泡到父节点**: 对外层来说 conductor 节点是一个会产出东西的节点, 而产物
    // 全落在它内部的子节点上 —— 不冒泡, 父节点的 filesTouched 恒空, 调用方 (如 goal 引擎要找
    // 子树写的 spec 文件) 与外层的产物观察面就都看不见这棵子树干了什么。同 map 的收集语义。
    const touchedAll = new Set<string>();
    const roundResults = new Map<string, LeafResult>();
    const byId = new Map(expand.children.map((c) => [c.id, c]));

    await new Promise<void>((resolve) => {
      const pump = (): void => {
        if (settledLocal === childIds.length) {
          resolve();
          return;
        }
        while (runningLocal < capLocal && readyLocal.length > 0) {
          const cid = readyLocal.shift()!;
          runningLocal++;
          const hit = reuseLocal.get(cid);
          void (hit
            ? // 复用命中: 注入上轮输出, 零 LLM 零工具 (id/deps 归本轮, skipped 同 resume 语义)。
              Promise.resolve({ ...hit, id: cid, deps: (plan!.nodes[cid]!.depends_on ?? []) as string[], usage: { in: 0, out: 0 }, skipped: true } as LeafResult)
            : runNode(cid)
          )
            .catch((e): LeafResult => ({
              id: cid, status: 'failed', kind: 'inproc',
              output: `[failed] ${e instanceof Error ? e.message : String(e)}`,
              deps: (plan!.nodes[cid]!.depends_on ?? []) as string[], usage: { in: 0, out: 0 },
            }))
            .then((r) => {
              results[cid] = r;
              roundResults.set(cid, r);
              depOutputs[cid] = r.output;
              usageAcc = addUsage(usageAcc, r.usage);
              if (r.status === 'failed') failedLocal++;
              childOut.push({ id: cid, originalId: byId.get(cid)?.originalId ?? cid, status: r.status, output: r.status === 'failed' ? '[failed]' : r.output });
              for (const f of r.filesTouched ?? []) touchedAll.add(f);
              // 子节点绕过外层 settle() → 补发事件 (同 map 子节点)。
              emitNodeEvent({ type: 'settle', id: cid, status: r.status, kind: r.kind, ...(r.model ? { model: r.model } : {}) });
              // 释放子图内下游。失败也释放 —— 是否执行由下游自己的 requires quorum 判 (D-7v2),
              // 不在这里替它决定 (与外层 settle 同语义)。
              for (const dep of dependentsLocal.get(cid) ?? []) {
                const n = (indegLocal.get(dep) ?? 1) - 1;
                indegLocal.set(dep, n);
                if (n === 0) readyLocal.push(dep);
              }
              runningLocal--;
              settledLocal++;
              pump();
            });
        }
        // 无就绪且无在飞而仍未结清 = 子图内有环 (展开期已查过, 这里是防御性兜底, 不许静默挂起)。
        if (runningLocal === 0 && readyLocal.length === 0 && settledLocal < childIds.length) {
          logger.warn({ node: id, settled: settledLocal, total: childIds.length }, '[omd/executor-dag] conductor 局部调度死锁 → 提前结清 (防挂起)');
          resolve();
        }
      };
      pump();
    });

    // ── 5. 汇总 (INV-U7 同款: 子节点部分失败 = 部分成功; 全失败才算 conductor 节点失败) ──
    const ok = childOut.filter((c) => c.status !== 'failed').length;
    const summary = childOut
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map((c) => `[${c.originalId}] ${c.status}\n${c.output}`)
      .join('\n\n');
    return {
      leaf: {
        id,
        status: ok > 0 ? 'done' : 'failed',
        kind: 'conductor',
        output: `[conductor 子图: ${ok}/${childIds.length} 成功${expand.truncated ? `, 截断 ${expand.truncated}` : ''}${failedLocal ? `, 失败 ${failedLocal}` : ''}]\n\n${summary}`,
        deps,
        usage: usageAcc,
        ...(touchedAll.size ? { filesTouched: [...touchedAll] } : {}),
      },
      children: childOut.map((c) => ({ id: c.id, originalId: c.originalId, status: c.status, output: c.output })),
      usage: usageAcc,
      results: roundResults,
    };
  };

  /**
   * **D-A: 环封在 conductor 节点内** (P3 批次 3 第二次加厚, 2026-07-29)。
   *
   * `max_rounds` 缺省 1 = 展开一次就结束, **零回归** —— 于是在外层 fixpoint 还没撤 (D-F) 之前,
   * 不存在"两层 verify 同时在"的过渡态: 双环只在有人显式写 `max_rounds > 1` 时才出现。
   * (P1 的 double-loop 教训是两层必须二选一; 撤外层要等环在这里跑通, 反过来会有一段时间两层都不在。)
   *
   * 环的语义是**逐轮重展开**, 不是重跑同一张子图 —— 见 `retryCtx` 那段注。
   *
   * 状态 (轮次 / 毒集 / 上轮原因) 落**节点级 journal**, 每轮 judge 判完就写。为什么不是
   * NodeCheckpoint: 那个只在节点 done 时写, 而环没收敛就没有 done, 崩在环中间等于毒集蒸发
   * —— 正好是要防的那件事。详见 {@link NodeLoopJournal} 的类型注。
   */
  const runConductorNode = async (id: string): Promise<LeafResult> => {
    const node = plan!.nodes[id]!;
    const deps = node.depends_on ?? [];
    const maxRounds = node.max_rounds ?? 1;
    const cm = continuity?.manager;

    // resume: 接回上次的轮次/毒集/上轮原因 (INV-P2-6 同款, 只是键降到了节点级)。
    const journal = cm && continuity?.resume ? cm.loadNodeLoopJournal(continuity.runId, id) : null;
    if (journal?.converged) {
      logger.info({ node: id, rounds: journal.completedRounds }, '[omd/executor-dag] 内环已收敛 (journal) → 直接返上次结论');
      return { id, status: 'done', kind: 'conductor', output: journal.lastOutput ?? '[内环已收敛]', deps, usage: { in: 0, out: 0 }, skipped: true };
    }
    const poisoned = new Set(journal?.poisoned ?? []);
    let prevReason = journal?.prevReason ?? '';
    const startRound = (journal?.completedRounds ?? 0) + 1;
    if (journal) {
      logger.info({ node: id, startRound, poisoned: poisoned.size }, '[omd/executor-dag] 内环恢复: 接回轮次/毒集 (D-A)');
    }

    let usageAcc: ModelUsage = { in: 0, out: 0 };
    let last: LeafResult | null = null;
    // 上一轮的子节点结果 —— 跨轮复用的匹配源 (进程内; 崩溃后由各子节点自己的 checkpoint 兜)。
    let prevResults = new Map<string, LeafResult>();

    for (let round = startRound; round <= maxRounds; round++) {
      const r = await runConductorRound(id, round, prevReason, poisoned, prevResults);
      prevResults = r.results;
      usageAcc = addUsage(usageAcc, r.usage);
      last = { ...r.leaf, usage: usageAcc };

      // 单轮档 (max_rounds=1, 缺省): 不请 judge —— 没有下一轮可去, 判了也没有用它的地方,
      // 白花一次贵座调用。这也是零回归的那一半。
      if (maxRounds === 1) return last;

      const verdict = await judgeConductorRound(id, node.goal ?? id, r.leaf, round, r.children);
      usageAcc = addUsage(usageAcc, verdict.usage);
      last = { ...r.leaf, usage: usageAcc };

      // D-4 同款铸票: judge 点名的子节点 → **id** 入毒集 (键取 id 的理由见 NodeLoopJournal 的注)。
      for (const cid of verdict.rejected) poisoned.add(cid);
      prevReason = verdict.reason;

      // **每轮判完就写** journal —— 不是节点结束时写。崩在这之后, 下次 resume 接得回来。
      if (cm && continuity) {
        cm.writeNodeLoopJournal(continuity.runId, {
          runId: continuity.runId,
          nodeId: id,
          completedRounds: round,
          poisoned: [...poisoned],
          ...(prevReason ? { prevReason } : {}),
          ...(verdict.converged ? { converged: true, lastOutput: last.output } : {}),
          updatedAt: new Date().toISOString(),
          schemaVersion: 1,
        });
      }
      if (verdict.converged) {
        logger.info({ node: id, round }, '[omd/executor-dag] 内环收敛 (D-A)');
        return last;
      }
      logger.info({ node: id, round, rejected: verdict.rejected.length }, '[omd/executor-dag] 内环未收敛 → 重新展开');
    }

    // 轮数用尽仍未收敛: 返最后一轮的结果, 但**不谎报收敛** —— 上层 (外层 fixpoint / 调用方) 据此判。
    logger.warn({ node: id, maxRounds }, '[omd/executor-dag] 内环轮数用尽仍未收敛 (INV-GOAL-4 有界)');
    return last ?? { id, status: 'failed', kind: 'conductor', output: '[内环一轮都没跑成]', deps, usage: usageAcc };
  };

  // ── U1 P1: map 节点运行时展开 (SDD 0009 §2.3 StateMachine) ──────────────────
  // lister → expandMapNode(纯) → 子节点入 plan.nodes 复用 runNode 全套(路由/产物闸/checkpoint)
  // → 稳定 key 序 collect。INV-U7: 子节点部分失败 = map partial 成功;只 lister 失败才 fail map。
  const runMapNode = async (id: string): Promise<LeafResult> => {
    const node = plan!.nodes[id]!;
    const deps = node.depends_on ?? [];
    const spec = node.map!;
    const specHash = mapSpecHash(spec as unknown as Parameters<typeof mapSpecHash>[0]);

    // ── U1 P2 (INV-U3): spec 变 → 作废整棵子树的 resume 预载 (子节点重跑)。
    // map 节点自身**永不**整体 skip (lister 便宜, 重展开保正确); 子节点各自按 checkpoint 续。
    const prevMapCp = resumeGreens.get(id);
    if (prevMapCp && prevMapCp.expansionHash !== specHash) {
      for (const key of [...resumeGreens.keys()]) {
        if (key.startsWith(`${id}::`)) resumeGreens.delete(key);
      }
      logger.info({ node: id, prev: prevMapCp.expansionHash, now: specHash }, '[omd/executor-dag] map spec 变 → 子树 resume 作废 (INV-U3)');
    }

    // ── 1. lister (INV-U7: 失败 → map failed, 子节点不 spawn) ──
    let listerOutput: Record<string, unknown>;
    let usageAcc: ModelUsage = { in: 0, out: 0 };
    try {
      const listerGoal = spec.lister.goal ?? `枚举 ${spec.over}`;
      const schemaNote = spec.lister.output_schema
        ? `\n输出 JSON 必须符合 schema: ${JSON.stringify(spec.lister.output_schema)}`
        : '';
      const depCtx = deps.length
        ? `\n\n<upstream>\n${deps.map((d) => `[${d}]\n${faninView[d] ?? depOutputs[d] ?? ''}`).join('\n\n')}\n</upstream>`
        : '';
      let text: string;
      if (spec.lister.executor === 'command' && spec.lister.command && config.commandRunner) {
        const r = await config.commandRunner({ command: spec.lister.command });
        if (r.exitCode !== 0) throw new Error(`lister command exit ${r.exitCode}: ${r.text.slice(0, 300)}`);
        text = r.text;
        usageAcc = addUsage(usageAcc, r.usage);
      } else if (spec.lister.executor === 'agent' && config.agentRunner) {
        const r = await config.agentRunner({
          prompt: `${listerGoal}${schemaNote}${depCtx}\n\n只回一个 JSON 对象, 必含数组键 "${spec.over}"。`,
          model: config.agentLeafModel ?? config.leafModel,
        });
        text = r.text;
        usageAcc = addUsage(usageAcc, r.usage);
      } else {
        const r = await generate({
          messages: [
            { role: 'system', content: config.leafSystemPrefix ?? LEAF_SYSTEM_PREFIX },
            { role: 'user', content: `${listerGoal}${schemaNote}${depCtx}\n\n只回一个 JSON 对象, 必含数组键 "${spec.over}"。别的不要。` },
          ],
          model: config.leafModel,
          thinkingLevel: config.inprocThinkingLevel ?? config.seatThinking?.(config.leafModel) ?? 'high',
        });
        text = r.text;
        usageAcc = addUsage(usageAcc, r.usage);
      }
      // JSON 提取: 剥 code fence → 首 '{' 到末 '}'。
      const stripped = text.replace(/```(?:json)?/g, '').trim();
      const s = stripped.indexOf('{');
      const e = stripped.lastIndexOf('}');
      if (s < 0 || e <= s) throw new Error(`lister 输出无 JSON 对象: ${stripped.slice(0, 200)}`);
      listerOutput = JSON.parse(stripped.slice(s, e + 1)) as Record<string, unknown>;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ node: id, err: msg }, '[omd/executor-dag] map lister 失败 → map failed (INV-U7)');
      return { id, status: 'failed', kind: 'map', output: `[map lister 失败: ${msg}]`, deps, usage: usageAcc };
    }

    // ── 2. 纯展开 (INV-U2/U4/U5/U8 在 expandMapNode 内) ──
    const expand = expandMapNode(id, spec as unknown as Parameters<typeof expandMapNode>[1], listerOutput);
    if (expand.status === 'not_array' || expand.status === 'nested_map') {
      logger.warn({ node: id, error: expand.error }, '[omd/executor-dag] map 展开失败');
      return { id, status: 'failed', kind: 'map', output: `[map 展开失败: ${expand.error}]`, deps, usage: usageAcc };
    }
    if (expand.truncated > 0) {
      logger.warn({ node: id, truncated: expand.truncated }, '[omd/executor-dag] map 扇出截断 (INV-U4, no-silent-caps)');
    }

    // ── 3. 子节点跑 (G9: 空清单 = 成功 0 子) ──
    const childResults: { key: string; item: unknown; status: string; output: string }[] = [];
    let failedCount = 0;
    if (expand.children.length > 0) {
      // 子节点挂进 plan.nodes → runNode 全套复用 (per-node 路由/产物闸/checkpoint/resume)。
      for (const child of expand.children) {
        plan!.nodes[child.id] = { ...(child.node as (typeof plan.nodes)[string]), depends_on: deps };
      }
      // 局部 pump: 并发 = map.concurrency ?? config.maxFanout ?? 全宽。INV-U6: 子集独立, 不进外层 ready-set。
      const childCap = spec.concurrency ?? config.maxFanout ?? expand.children.length;
      const queue = [...expand.children];
      const runners: Promise<void>[] = [];
      for (let w = 0; w < Math.max(1, Math.min(childCap, queue.length)); w++) {
        runners.push(
          (async () => {
            for (;;) {
              const child = queue.shift();
              if (!child) return;
              // INV-6/INV-U7: 子失败隔离, 不连坐。
              const r = await runNode(child.id).catch((e): LeafResult => ({
                id: child.id, status: 'failed', kind: 'inproc',
                output: `[failed] ${e instanceof Error ? e.message : String(e)}`,
                deps, usage: { in: 0, out: 0 },
              }));
              results[child.id] = r;
              depOutputs[child.id] = r.output;
              // map 子节点绕过外层 settle() → 此处补发 settle 事件 (INV-U6 子集独立调度)。
              emitNodeEvent({ type: 'settle', id: child.id, status: r.status, kind: r.kind, ...(r.model ? { model: r.model } : {}) });
              usageAcc = addUsage(usageAcc, r.usage);
              if (r.status === 'failed') failedCount++;
              childResults.push({ key: child.key, item: child.item, status: r.status, output: r.status === 'failed' ? '[failed]' : r.output });
            }
          })(),
        );
      }
      await Promise.all(runners);
      childResults.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)); // 稳定 key 序 (INV-U2)
    } else {
      logger.info({ node: id }, '[omd/executor-dag] map 空清单 → 成功 0 子 (G9)');
    }
    if (failedCount > 0) {
      logger.warn({ node: id, failedCount, total: expand.children.length }, '[omd/executor-dag] map 部分失败 (INV-U7 partial)');
    }

    const output = JSON.stringify(childResults);
    // ── 4. map 自身 checkpoint (expansionHash = spec hash; 产物归子节点各自的 checkpoint) ──
    if (continuity) {
      try {
        continuity.manager.saveCheckpoint(continuity.runId, {
          nodeId: id, leafKind: 'map', status: 'done', outputPaths: [], artifactHashes: {},
          tokenUsage: usageAcc, summary: output.slice(0, 800), expansionHash: specHash,
          durationMs: 0, createdAt: new Date().toISOString(),
          ...(dagGeneration ? { generation: dagGeneration } : {}), schemaVersion: 1,
        });
      } catch (err) {
        logger.warn({ node: id, err }, '[omd/executor-dag] map checkpoint write failed (fail-open)');
      }
    }
    return { id, status: 'done', kind: 'map', output, deps, usage: usageAcc };
  };

  // ── SDD 0013 S1: primitive 节点 (约束选择) 执行 ─────────────────────────────
  // {kind:'primitive', primitive, params} → registry.compilePrimitive (SEL-1 校验 + SEL-2 静态定界) →
  // invocation.run。控制流封装在原语 compile + primitives.ts (SEL-3), 此处只搭 leaf 工厂 ctx。
  const runPrimitiveNode = async (id: string): Promise<LeafResult> => {
    const node = plan!.nodes[id]!;
    const deps = node.depends_on ?? [];
    let usageAcc: ModelUsage = { in: 0, out: 0 };
    const depCtx = deps.length
      ? `\n\n<upstream>\n${deps.map((d) => `[${d}]\n${depOutputs[d] ?? ''}`).join('\n\n')}\n</upstream>`
      : '';
    const ctx: PrimitiveCtx = {
      maxFanout: config.maxFanout,
      usage: () => usageAcc,
      // D-8v2: judge/parallel/tournament 的 attempts 按候选池轮转 (原语层 pickCandidate)。
      candidates: config.primitiveCandidates,
      leaf: async ({ goal, persona, model }) => {
        const cav = cavemanRule(leafCavemanLevel(false, config.cavemanLevel ?? 'full'));
        const personaLine = persona ? `<persona>${persona}</persona>\n` : '';
        const r = await generate({
          messages: [
            { role: 'system', content: config.leafSystemPrefix ?? LEAF_SYSTEM_PREFIX },
            { role: 'user', content: `${personaLine}${goal}${depCtx}${cav ? `\n\n${cav}` : ''}` },
          ],
          model: model ?? config.leafModel,
          thinkingLevel:
            config.inprocThinkingLevel ?? config.seatThinking?.(model ?? config.leafModel) ?? 'high',
        });
        usageAcc = addUsage(usageAcc, r.usage);
        return r.text;
      },
    };
    const compiled = compilePrimitive(node.primitive as string, node.params ?? {}, ctx);
    if (!compiled.ok) {
      // SEL-1 fail-closed: 坏 primitive/params/超 cap → 失败有明确错, 不静默降范围。
      logger.warn({ node: id, err: compiled.error }, '[omd/executor-dag] primitive 编译失败 → failed (SEL-1 fail-closed)');
      return { id, status: 'failed', kind: 'primitive', output: `[primitive 编译失败: ${compiled.error}]`, deps, usage: usageAcc };
    }
    logger.info(
      { node: id, primitive: node.primitive, maxUnits: compiled.invocation.maxUnits },
      '[omd/executor-dag] primitive compiled (SEL-2 静态定界)',
    );
    try {
      const { output, usage } = await compiled.invocation.run();
      return { id, status: 'done', kind: 'primitive', output, deps, usage };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ node: id, err: msg }, '[omd/executor-dag] primitive run 抛错 → failed');
      return { id, status: 'failed', kind: 'primitive', output: `[primitive 失败: ${msg}]`, deps, usage: usageAcc };
    }
  };

  // 节点起跑时刻 (issue #4: 失败 checkpoint 的 durationMs 用; settle 在 runNode 各早退分支之外, 需独立捕获)。
  const nodeStartedAt = new Map<string, number>();

  // runNodeOnce: **单次尝试** (resume-skip / primitive / map / command / agent / inproc + checkpoint)。
  // 重试策略在下方 runNode 包一层 —— 这里只管跑一次, 不认识 max_retry。
  // attempt.causeNote: L0 重试把上一次的失败原因追加进 goal (经 buildLeafPrompt 进 prompt), 不原样重放。
  const runNodeOnce = async (id: string, attempt?: { causeNote?: string }): Promise<LeafResult> => {
      const rawNode = plan!.nodes[id]!;
      const node = attempt?.causeNote ? { ...rawNode, goal: `${rawNode.goal ?? ''}${attempt.causeNote}` } : rawNode;
      const deps = node.depends_on ?? [];
      // D-21: 跨轮复用命中 → 上轮输出直接注入 (零 LLM 零工具; id/deps 归本轮, skipped 同 resume 语义)。
      const prev = reuse.get(id);
      if (prev) {
        logger.info({ node: id }, '[omd/executor-dag] 跨轮语义复用命中 → 注入上轮输出 (D-21)');
        return { ...prev, id, deps, usage: { in: 0, out: 0 }, skipped: true };
      }
      // SDD 0013 S1: primitive 节点 (约束选择) → compile+run 分支 (先于 map/executor, 与自由 node 并存)。
      if (node.kind === 'primitive' && node.primitive) return runPrimitiveNode(id);
      // U1: map 节点走运行时展开分支 (永不整体 resume-skip — lister 便宜, 子节点各自续)。
      if (node.executor === 'map' && node.map) return runMapNode(id);
      // P3 批次 3: conductor 节点走运行时**异构**展开。与 map 同理**永不整体 resume-skip** ——
      // 重新展开是便宜的一次 conductor 调用, 而子节点因 D-B 内容寻址各自命中自己的 checkpoint:
      // 内容没变 → id 没变 → 子节点全跳过, 只白花一次展开; 内容变了 → id 变了 → 本就该重跑。
      if (node.executor === 'conductor') return runConductorNode(id);
      // W2 resume: checkpoint done ∧ 代数匹配 ∧ **输入面未变 (D-O)** ∧ 产物存在且 hash 匹配 → 跳过执行。
      if (
        continuity?.resume &&
        resumeGreens.has(id) &&
        continuity.manager.shouldSkip(continuity.runId, id, dagGeneration, inputsOf(deps))
      ) {
        const cp = resumeGreens.get(id)!;
        // D-O: 还原**全文**产物, 不是 800 字 summary —— 下游吃的就是这份输出, 拿摘要顶替等于
        // 每 resume 一次上游信息就被静默截断一次, 且它的 hash 与下游 inputHashes 对不上,
        // 会让整条下游误判 stale 全体重跑 (省下的钱又赔回去)。
        const full = cp.outputText ? continuity.manager.loadNodeOutput(cp.outputText) : null;
        if (cp.outputText && full === null) {
          logger.warn({ node: id, path: cp.outputText }, '[omd/executor-dag] resume: 输出制品读不到 → 退回 800 字 summary (下游可能因此重跑)');
        }
        logger.info({ node: id, restored: full !== null ? 'full' : 'summary' }, '[omd/executor-dag] continuity resume: 节点已绿, 跳过');
        return { id, status: 'done', kind: cp.leafKind, output: full ?? cp.summary, deps, usage: { in: 0, out: 0 }, skipped: true, filesTouched: cp.outputPaths };
      }
      // command leaf (方案 A): 确定性 CLI, 零 LLM, 无 caveman/prompt。exitCode 0 = done。
      if (node.executor === 'command') {
        if (!config.commandRunner || !node.command) {
          logger.warn({ node: id, hasRunner: !!config.commandRunner, hasCmd: !!node.command }, '[omd/executor-dag] executor:command 缺 commandRunner/command → failed');
          return { id, status: 'failed', kind: 'command', output: '', deps, usage: { in: 0, out: 0 } };
        }
        const r = await config.commandRunner({ command: node.command });
        // D-K: expect_exit = 判 done 的期望退出码 (缺省 0)。verify-red 靠它表达 —— "证明新测试现在是红的"
        // 的成功判据就是非 0 退出, 而 shell 取反整族被注入闸拒 (command-leaf.ts:145)。
        //
        // ⚠ 负退出码**恒 failed**, 不受 expect_exit 影响: -1 是 command-leaf 的**闸拒**返回值
        // (危险命令 / 不在白名单 / 含元字符 / git 写子命令), 不是被执行命令的退出码。让 expect_exit
        // 把一次安全拒绝翻译成 done, 等于给闸开了一条从 plan 里绕过去的路。schema 已 min(0) 挡住
        // conductor 写 -1; 这条是给**预构造 plan** (不经 zod) 的运行期硬闸, 两层都要有。
        const want = node.expect_exit ?? 0;
        const blocked = r.exitCode < 0;
        const ok = !blocked && r.exitCode === want;
        if (!ok && want !== 0) {
          logger.warn({ node: id, want, got: r.exitCode, blocked }, '[omd/executor-dag] command 节点未命中 expect_exit → failed (D-K)');
        }
        return {
          id,
          status: ok ? 'done' : 'failed',
          kind: 'command',
          // 期望非 0 却拿到别的码时, 把"想要什么/拿到什么"写进 output —— 否则 verify-red 失败时
          // 下游只看到一串正常的测试输出, 看不出它失败在"本该红却绿了"。
          output: !ok && want !== 0
            ? `[expect_exit ${want}, 实得 ${r.exitCode}${blocked ? ' (命令被闸拒, 未执行)' : ''}]\n${r.text}`
            : r.text,
          deps,
          usage: r.usage,
        };
      }
      // 明示即承诺的反面守卫: expect_exit 只有 command 分支消费, 设在别处等于一个静默无效的旋钮
      // (正是 2026-07-28 空旋钮全仓扫要杀的形态) → 响亮 WARN, 不改变执行 (fail-open)。
      if (node.expect_exit !== undefined) {
        logger.warn({ node: id, executor: node.executor, expect_exit: node.expect_exit }, '[omd/executor-dag] expect_exit 只对 executor:command 生效 → 本节点忽略 (D-K)');
      }
      // research leaf (D-6): 真 web 检索 + 有界内环。**零来源 = failed** —— INV-GOAL-2 要的是
      // 真抓取痕迹, 一个没抓到还吐终稿的节点吐的是模型记忆里的引用 (假 grounded), 比失败更坏:
      // 它会带着编造的事实往下游走。与 producesFiles 的 filesTouched 闸同一条纪律。
      if (node.executor === 'research') {
        if (!config.researchRunner) {
          logger.warn({ node: id }, "[omd/executor-dag] executor:research 缺 researchRunner → failed (拒绝降级 inproc 编引用)");
          return { id, status: 'failed', kind: 'research', output: '[research 节点无 researchRunner, 无 web 能力]', deps, usage: { in: 0, out: 0 } };
        }
        const groundTruth = deps
          .filter((d) => results[d]?.status === 'done')
          .map((d) => depOutputs[d] ?? '')
          .filter(Boolean)
          .join('\n\n');
        const r = await config.researchRunner({
          question: node.goal ?? id,
          ...(groundTruth ? { groundTruth } : {}),
          ...(node.research?.k ? { k: node.research.k } : {}),
          // 内环有界 (INV-GOAL-4): 缺省 1 轮, 上限由 schema 钳到 4。
          rounds: node.research?.rounds ?? 1,
        });
        if (r.sources.length === 0) {
          logger.warn({ node: id }, '[omd/executor-dag] research 节点零来源 → failed (无真抓取痕迹 = 假 grounded)');
          return { id, status: 'failed', kind: 'research', output: '[research 零来源: 无真 URL 抓取痕迹]', deps, usage: r.usage };
        }
        logger.info({ node: id, sources: r.sources.length, reportPath: r.reportPath }, '[omd/executor-dag] research 节点完成');
        // D-O: research 节点此前**没有绿 checkpoint** —— 于是每次 resume 都重跑一遍真联网检索
        // (实测 104s + token)。它正是最该被 resume 兜住的一类。
        // 对照: command 节点**刻意不落绿 checkpoint** —— 它便宜 (这是它存在的理由) 且往往就是验收
        // oracle, resume 时重跑一遍比"跳过一个闸"安全 (同 map 节点"lister 便宜, 重展开保正确")。
        saveDoneCheckpoint({
          id,
          kind: 'research',
          text: r.text,
          usage: r.usage,
          filesTouched: r.reportPath ? [r.reportPath] : [],
          deps,
          t0: nodeStartedAt.get(id) ?? Date.now(),
        });
        return {
          id,
          status: 'done',
          kind: 'research',
          output: r.text,
          deps,
          usage: r.usage,
          sources: r.sources,
          ...(r.reportPath ? { filesTouched: [r.reportPath] } : {}),
        };
      }
      // agent 模板卡解析: 命中注册表 → body 注入 prompt 前缀 (buildLeafPrompt 前置放)。
      // 未知名 = 预构造 plan 绕过了规划层校验 → TPL-2 执行层兜底: warn + 忽略, 不崩节点。
      const tpl = node.template ? templates.get(node.template) : undefined;
      if (node.template && !tpl) {
        logger.warn({ node: id, template: node.template }, '[omd/executor-dag] 未知 agent 模板 → 忽略 (TPL-2 fail-open)');
      }
      // caveman 路由: 创意节点 (node.creative) → off 护交付物; 否则 → 干活级 (默认 full; ultra opt-in) 压叙述省 token。
      const cav = cavemanRule(leafCavemanLevel(node.creative, config.cavemanLevel ?? 'full'));
      // ponytail (构建相位): leaf-only 降代码量, 维二红线不在砍范围。创意节点护交付物 → 不挂 (同 caveman)。
      const pony = config.leafPonytail && !node.creative ? `\n\n${PONYTAIL_LEAF_DISPOSITION}` : '';
      // fan-in: 有定向摘要的 dep 注入摘要 (faninView 覆盖 depOutputs), 否则全文。
      const basePrompt = buildLeafPrompt(id, node, { ...depOutputs, ...faninView }, tpl ? { name: tpl.name, body: tpl.body } : undefined);
      const prompt = (cav ? `${basePrompt}\n\n${cav}` : basePrompt) + pony;
      // 双模分流: executor:'agent' + 有 agentRunner → 带工具子 agent (能改文件); 否则 inproc 单发。
      // M3 bug 修 (2026-06-20): conductor (M3 非确定性) 把"写文件"节点标成 leaf → inproc 不能写文件 →
      //   exit 0 但无产物 (静默假成功)。判别"写文件意图" = output_type:file/git ∨ 有 output_path ∨
      //   goal 含强写文件信号 (创建/实现/写入 + 文件路径)。命中 = 必须 agent。
      const producesFiles =
        node.output_type === 'file' ||
        node.output_type === 'git' ||
        !!node.output_path ||
        /(?:实现|创建|新建|写入|生成|修改|实装|落地)[^。\n]{0,40}\.(?:ts|tsx|js|jsx|mjs|cjs|sql|json|md|css|html|py|go|rs)\b/.test(node.goal ?? '');
      // 写文件节点但无 agentRunner → 根本无法产物 → 标失败 (拒绝 inproc 静默假成功; oracle/heal 才看得到)。
      if (producesFiles && !config.agentRunner) {
        logger.warn({ node: id, output_type: node.output_type }, '[omd/executor-dag] 写文件节点但无 agentRunner → 失败 (拒绝 inproc 静默假成功)');
        return { id, status: 'failed', kind: 'inproc', output: '[写文件节点无 agentRunner, 无法产物]', deps: node.depends_on ?? [], usage: { in: 0, out: 0 } };
      }
      const wantAgent = node.executor === 'agent' || producesFiles;
      if (producesFiles && node.executor !== 'agent') {
        logger.warn({ node: id, executor: node.executor, output_type: node.output_type }, '[omd/executor-dag] 写文件节点 conductor 标成非 agent → 提升 agent (治 M3 inproc 静默假成功)');
      } else if (node.executor === 'agent' && !config.agentRunner) {
        logger.warn({ node: id }, '[omd/executor-dag] executor:agent 但无 agentRunner → 降级 inproc (无工具, 不会改文件)');
      }
      const useAgent = wantAgent && !!config.agentRunner;
      // ── D-14v2 (SDD v2 S4) attach_media 媒体管道: 直接前驱的**原始输出** (depOutputs, 非 fanin
      // 摘要 — 摘要可能丢路径) 里解析图片引用 → 存在性校验 → data-URI ContentPart, 注入 inproc leaf
      // 的 user 消息 (模型由 stamp pass 分到 multimodal 池)。usage 走 provider 真值 — 图片 token
      // 计入返回的 usage.in, 账本无需特判。
      let mediaParts: ContentPart[] = [];
      if (node.attach_media === true) {
        const mediaRoot = continuity?.repoRoot ?? process.cwd();
        const depTexts = deps.filter((d) => results[d]?.status === 'done').map((d) => depOutputs[d] ?? '');
        const media = collectDepMedia(depTexts, { root: mediaRoot });
        if (media.skipped.length > 0 || media.missing.length > 0) {
          // MEDIA-2 no silent caps: 没附上的引用全部留痕 (超限/读失败/不存在), 不静默装作看过。
          logger.warn(
            { node: id, missing: media.missing, skipped: media.skipped, attached: media.attached.length },
            '[omd/executor-dag] attach_media 部分媒体未附上 (D-14v2)',
          );
        }
        if (media.parts.length === 0) {
          // 拒绝"无图多模态审查"静默文本化 (同 empty-done/产物校验哲学): 看图节点没图 = 假成功
          // 温床 → 显式 failed, heal/escalate 回路可见。前驱失败缺图的形态由 requires quorum 先拦。
          logger.warn({ node: id, missing: media.missing }, '[omd/executor-dag] attach_media 无可用媒体 → failed (D-14v2 fail-closed)');
          return {
            id, status: 'failed', kind: useAgent ? 'agent' : 'inproc',
            output: `[attach_media 无可用媒体: 直接前驱输出未解析出存在的图片${media.missing.length ? `; 路径不存在: ${media.missing.join(', ')}` : ''}]`,
            deps, usage: { in: 0, out: 0 },
          };
        }
        if (useAgent) {
          // agent leaf 走工具子进程 (prompt 是纯文本接缝): 不注入 parts — 路径已在 prompt 文本里,
          // 多模态注入仅 inproc leaf (D-14v2 收窄; agent 自有 Read 工具可看文件)。
          logger.warn({ node: id }, '[omd/executor-dag] attach_media 于 agent 节点 → 忽略注入 (仅 inproc 支持, 路径在 prompt 文本)');
          mediaParts = [];
        } else {
          logger.info({ node: id, attached: media.attached }, '[omd/executor-dag] attach_media 注入媒体 parts (D-14v2)');
          mediaParts = media.parts;
        }
      }
      // per-node model 路由 (TPL-3): node.model 显式最高优先 → 模板卡 model → router (bandit) 选 →
      // 静态 (agent→agentLeafModel, inproc→leafModel)。bucket = executor kind (router 学习单元)。
      const bucket = useAgent ? 'agent' : 'inproc';
      const staticModel = useAgent ? config.agentLeafModel ?? config.leafModel : config.leafModel;
      const model = node.model ?? tpl?.model ?? (config.router ? config.router.select(bucket, staticModel) : staticModel);
      const t0 = Date.now();
      let text: string;
      let usage: ModelUsage;
      let filesTouched: string[] = [];
      let toolCalls: number | undefined;
      let artifactRoot: string | undefined;
      if (useAgent) {
        const r = await config.agentRunner!({ prompt, model });
        text = r.text;
        usage = r.usage;
        filesTouched = r.filesTouched ?? [];
        // 产物根: leaf 自报的 cwd 最准 (它就是写文件的那个进程) > continuity 根 > 本进程 cwd。
        artifactRoot = r.cwd;
        toolCalls = r.toolCalls;
        // 早期心跳闸 (issue #5): provider 挂起判停摆 → 标 failed (不把近零输出当 done), 附 stall 标记
        // 供 settle 记 failureKind='stall' (issue #4 败因留痕)。heal 回路可据此重试/换池。
        if (r.stalled) {
          logger.warn({ node: id, model, outLen: text.length }, '[omd/executor-dag] agent leaf 停摆 (心跳闸) → 节点 failed');
          return {
            id, status: 'failed', kind: 'agent', model,
            output: `[停摆: 心跳闸提前中止, 疑 provider 挂起/排队] 原输出(${text.length}B): ${text.slice(0, 400)}`,
            deps: node.depends_on ?? [], usage, filesTouched, stalled: true,
          };
        }
        // 产物校验闸 (2026-07-03 实测教训: ultraspeed leaf 4 节点 3 个 empty-done — 自报完成
        // 却零改动, oracle 因"新文件没接线"照样绿 → 谎报完工静默漏过)。写文件节点 done 的
        // **必要条件** = 真碰了文件: filesTouched 空 / 声称的路径不存在 → failed (heal 回路可见)。
        if (producesFiles) {
          const root = artifactRoot ?? continuity?.repoRoot ?? process.cwd();
          const missing = filesTouched.filter((p) => !existsSync(p.startsWith('/') ? p : `${root}/${p}`));
          if (filesTouched.length === 0 || missing.length > 0) {
            const why = filesTouched.length === 0
              ? 'filesTouched 空 — leaf 自报完成但未做任何文件写操作'
              : `声称产物不存在: ${missing.join(', ')}`;
            logger.warn({ node: id, filesTouched, missing }, '[omd/executor-dag] 产物校验失败 → 节点 failed (拒绝 empty-done)');
            return {
              id, status: 'failed', kind: 'agent', model,
              output: `[产物校验失败: ${why}] 原输出: ${text.slice(0, 400)}`,
              deps: node.depends_on ?? [], usage, filesTouched,
            };
          }
        }
      } else {
        // inproc leaf 带共享冻结前缀 (system) → 暖发后跨 leaf 命中 prompt-cache。
        // attach_media: user 消息升格 ContentPart[] (text part 在前, 图 parts 随后 — openai-compat 惯例)。
        const userContent: string | ContentPart[] =
          mediaParts.length > 0 ? [{ type: 'text', text: prompt }, ...mediaParts] : prompt;
        const r = await generate({
          messages: [
            { role: 'system', content: config.leafSystemPrefix ?? LEAF_SYSTEM_PREFIX },
            { role: 'user', content: userContent },
          ],
          model,
          // S-T 优先序 (显式永远赢): node.thinking > config 显式档 > 座位档 > 硬默认 high。
          // 座位档来自 auto-assign (量产 worker 座 low / judge·verify 座 xhigh), 老 config 无该段 → 回落 high。
          thinkingLevel: node.thinking ?? config.inprocThinkingLevel ?? config.seatThinking?.(model) ?? 'high',
        });
        text = r.text;
        usage = r.usage;
      }
      const leaf: LeafResult = { id, status: 'done', kind: useAgent ? 'agent' : 'inproc', model, output: text, deps: node.depends_on ?? [], usage, filesTouched, ...(toolCalls !== undefined ? { toolCalls } : {}) };
      saveDoneCheckpoint({
        id,
        kind: useAgent ? 'agent' : 'inproc',
        model,
        text,
        usage: useAgent ? null : usage,
        filesTouched,
        deps: node.depends_on ?? [],
        t0,
        prompt,
        // agent leaf 自报的 cwd 最准 (它就是写文件的那个进程); inproc 无产物, 参数无所谓。
        ...(artifactRoot ? { artifactRoot } : {}),
      });
      return leaf;
  };

  /**
   * runNode: 单节点执行 + **L0 节点级重试** (D-11 / INV-P2-2)。
   *
   * `max_retry` 此前是纯装饰 (有 schema、进语义指纹、零消费者) —— 手写 plan 显式写了会被静默忽略。
   * 语义: 失败则最多再试 `max_retry` 次, 每次把**上一次的失败输出**注入 prompt (不是原样重放 ——
   * 原样重放对确定性失败是纯烧钱)。用尽仍 failed → 交上层 (verifier 升级 / 外层 fixpoint)。
   *
   * **每次尝试的 usage 全部计入**最终结果: 丢弃的尝试也真花了钱, 不记账就是账本对不上
   * (同 escalation 补丁那条"尝试的 token 不丢账")。
   *
   * start 事件与起跑时刻在**这一层**打, 不在 runNodeOnce —— 一个节点对外仍是一次 start,
   * 内部试了几次是实现细节; durationMs 也该覆盖全部尝试。
   */
  const runNode = async (id: string): Promise<LeafResult> => {
    const node = plan!.nodes[id]!;
    nodeStartedAt.set(id, Date.now());
    emitNodeEvent({ type: 'start', id, kind: nodeKind(node) });
    const budget = node.max_retry ?? 0;
    // 上一次的败因 → 下一次的 prompt。**抛错也算一次失败**: 最典型的可重试失败 (429 / 网络抖动)
    // 是 generate 抛出来的, 不是 status='failed' —— 只看 status 的重试恰好漏掉最该重试的那类。
    const causeOf = (prevLeaf: LeafResult | undefined, prevErr: unknown): string => {
      const body = prevLeaf
        ? prevLeaf.output || '(无输出)'
        : `[抛错] ${prevErr instanceof Error ? prevErr.message : String(prevErr)}`;
      return (
        `\n\n[上一次尝试失败]\n${body.slice(0, 600)}\n` +
        '请针对这个失败原因改变做法; 原样重复上一次的做法只会再失败一次。'
      );
    };
    const spent: ModelUsage[] = []; // 被丢弃的尝试的 usage — 也真花了钱, 不记账就是账本对不上
    let leaf: LeafResult | undefined;
    let thrown: unknown;
    for (let attempt = 0; ; attempt++) {
      if (attempt > 0) logger.info({ node: id, attempt, budget }, '[omd/executor-dag] L0 节点级重试 (带上次失败原因)');
      const causeNote = attempt === 0 ? undefined : causeOf(leaf, thrown);
      try {
        leaf = await runNodeOnce(id, causeNote ? { causeNote } : undefined);
        thrown = undefined;
      } catch (err) {
        thrown = err;
        leaf = undefined;
      }
      if (leaf && leaf.status !== 'failed') break; // done / skipped — 重试无意义
      if (attempt >= budget) break; // 预算用尽
      if (leaf) spent.push(leaf.usage);
    }
    // 最后一次是抛错 → 原样抛回, 维持既有 failedFromThrow 隔离路径 (败因不丢, INV-6 不连坐)。
    if (!leaf) throw thrown;
    if (leaf.status === 'failed' && budget > 0) {
      logger.warn({ node: id, budget }, '[omd/executor-dag] L0 重试预算用尽仍 failed → 交上层 (verifier 升级 / 外层 fixpoint)');
    }
    return spent.length ? { ...leaf, usage: spent.reduce((a, b) => addUsage(a, b), leaf.usage) } : leaf;
  };

  // ── 依赖驱动 ready-set 调度 (取代逐层 barrier) ──
  // 节点的所有真实 dep settle (depOutputs 已写) 即入 ready → 立刻可跑, 不等同层最慢节点。
  // 治 M3 深 DAG (实测 7 层) 的逐层 barrier 尾延迟: 旧法每层等最慢叶, 深链时空转损耗叠加。
  // 正确性: indeg 归零 ⟺ 全 dep 已 settle ⟹ buildLeafPrompt 必见全部 dep 输出 (与旧法等价)。
  // levels 仍由 topoLevels 算 (报告 + 环检测), 仅不再驱动执行。INV-6: 单 leaf 抛错隔离成 failed, 不连坐。
  const idSet = new Set(Object.keys(plan.nodes));
  const indeg = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const id of idSet) {
    const deps = (plan.nodes[id]!.depends_on ?? []).filter((d) => idSet.has(d)); // 幻象 dep (不存在 id) 视为已满足, 同 topoLevels
    indeg.set(id, deps.length);
    for (const d of deps) {
      const arr = dependents.get(d) ?? [];
      arr.push(id);
      dependents.set(d, arr);
    }
  }
  const ready: string[] = [...idSet].filter((id) => (indeg.get(id) ?? 0) === 0);
  const cap = config.maxFanout && config.maxFanout > 0 ? config.maxFanout : idSet.size || 1;
  // per-kind 并发闸 (fanout 最大化, 2026-07-21): inproc 纯 API 等待默认不限;
  // agent/command 有本地足迹 (工具调用/CLI 抢本机 CPU·磁盘) → 独立小闸。按声明 executor 记账。
  const kindCap: Record<'agent' | 'command' | 'inproc', number> = {
    agent: config.kindFanout?.agent ?? Number.POSITIVE_INFINITY,
    command: config.kindFanout?.command ?? Number.POSITIVE_INFINITY,
    inproc: config.kindFanout?.inproc ?? Number.POSITIVE_INFINITY,
  };
  const runningByKind: Record<'agent' | 'command' | 'inproc', number> = { agent: 0, command: 0, inproc: 0 };
  const schedKind = (id: string): 'agent' | 'command' | 'inproc' => {
    const n = plan!.nodes[id]!;
    if (n.executor === 'command') return 'command';
    if (n.executor === 'agent') return 'agent';
    return 'inproc'; // leaf/map/primitive (map/primitive 内层并发各自管理)
  };

  // ── D-23 per-channel 并发闸 (SDD v2): key = provider 前缀, 调度期由 node.model ?? kind 静态
  // 模型确定性推出 (运行期 router 选择不改记账 — 与 kind 闸「按声明记账」同哲学)。command 无
  // 模型 → 不入渠道闸。未配 channelFanout → 全部不限 (零回归)。
  const channelCap = config.channelFanout ?? {};
  const hasChannelCaps = Object.keys(channelCap).length > 0;
  const runningByChannel = new Map<string, number>();
  const schedChannel = (id: string): string | null => {
    const n = plan!.nodes[id]!;
    if (n.executor === 'command') return null;
    const model = n.model ?? (schedKind(id) === 'agent' ? config.agentLeafModel ?? config.leafModel : config.leafModel);
    const sep = model.indexOf(':');
    return sep >= 0 ? model.slice(0, sep) : model;
  };
  const channelBlocked = (id: string): boolean => {
    if (!hasChannelCaps) return false;
    const ch = schedChannel(id);
    if (ch == null) return false;
    const cap = channelCap[ch];
    return cap !== undefined && (runningByChannel.get(ch) ?? 0) >= cap;
  };

  // ── fan-in 定向摘要 (扇出≥2 触发) ─────────────────────────────────────────────
  // producer settle 前 (dependents 释放前) 判定并生成: 输出被 ≥2 consumer 消费 ∧ 够长 → 跑 1 发
  // 定向摘要 (按下游目标提炼) + 全文落盘留指针, 存 faninView[id]; 下游 fan-in 注入摘要而非全文。
  // 调用点在调度器 .then 内 (running 保持占位跨此 await → 收敛判据不会在摘要在飞时误触发, 见 pump)。
  // 全程 fail-open: 任何失败 → view=null → 下游回退全文注入。usage 折进 producer 的 r.usage (账本一致)。
  const maybeFaninView = async (id: string, r: LeafResult): Promise<{ r: LeafResult; view: string | null }> => {
    try {
      if (!faninCfg.enabled) return { r, view: null };
      if (r.status !== 'done') return { r, view: null }; // 失败节点不摘要 (败因全文留给 heal)
      if (r.kind === 'map') return { r, view: null }; // map 输出是结构化 JSON 数组, 摘要会毁其可解析性
      const node = plan!.nodes[id]!;
      if (node.creative) return { r, view: null }; // 护创意交付物 (best-of-n/judge 候选需全文, 同 caveman off)
      const consumers = dependents.get(id) ?? [];
      if (consumers.length < faninCfg.minFanout) return { r, view: null }; // 扇出闸 (默认 ≥2)
      const output = r.output ?? '';
      if (output.length < faninCfg.minChars) return { r, view: null }; // 短输出摘要纯亏 (摘要器 input 即全文)
      const depGoals = consumers
        .map((c) => plan!.nodes[c]?.goal)
        .filter((g): g is string => typeof g === 'string' && g.length > 0);
      // output_schema 默认化: producer 声明了则遵之, 否则用默认 fan-in schema。
      const schema = (node.output_schema as Record<string, unknown> | undefined) ?? DEFAULT_FANIN_SCHEMA;
      const { summaryJson, usage } = await runFaninSummary({
        generate,
        model: faninCfg.model ?? config.leafModel,
        producerGoal: node.goal,
        output,
        depGoals,
        schema,
      });
      if (!summaryJson) return { r, view: null }; // 解析失败 → 全文兜底
      // 全文指针: continuity 在则落盘留 path (agent consumer 可自 Read); 否则仅摘要 (artifacts 字段保产物锚)。
      const fullPath = continuity ? continuity.manager.saveFaninFull(continuity.runId, id, output) : null;
      const view = composeFaninView(summaryJson, fullPath, output.length);
      logger.info(
        { node: id, consumers: consumers.length, fullLen: output.length, viewLen: view.length, persisted: !!fullPath },
        '[omd/executor-dag] fan-in 定向摘要 (扇出≥2 → 摘要替全文注入)',
      );
      return { r: { ...r, usage: addUsage(r.usage, usage) }, view };
    } catch (err) {
      logger.warn(
        { node: id, err: err instanceof Error ? err.message : String(err) },
        '[omd/executor-dag] fan-in 摘要失败 → 全文兜底 (fail-open)',
      );
      return { r, view: null };
    }
  };

  // 节点抛错 → 隔离成 failed LeafResult, **保留错误消息** (issue #4: 此前 .catch(()=>null) 直接
  // 丢弃败因 → 失败节点无诊断信息)。INV-6: 单 leaf 抛错不连坐其它节点。
  const failedFromThrow = (id: string, err: unknown): LeafResult => {
    const node = plan!.nodes[id]!;
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ node: id, err: msg }, '[omd/executor-dag] 节点抛错 → 隔离 failed (保留败因)');
    return {
      id,
      status: 'failed',
      kind: node.executor === 'agent' && config.agentRunner ? 'agent' : 'inproc',
      output: `[节点抛错] ${msg}`,
      deps: node.depends_on ?? [],
      usage: { in: 0, out: 0 },
    };
  };

  // settle: 写 results/depOutputs + 累加遥测 + 释放 dependents (indeg 归零 → 入 ready)。
  const settle = (id: string, r: LeafResult | null): void => {
    if (r == null) {
      const node = plan!.nodes[id]!;
      results[id] = { id, status: 'failed', kind: node.executor === 'agent' && config.agentRunner ? 'agent' : 'inproc', output: '', deps: node.depends_on ?? [], usage: { in: 0, out: 0 } };
      depOutputs[id] = '[failed]';
    } else {
      results[id] = r;
      depOutputs[id] = r.output;
      leavesIn += r.usage.in;
      leavesOut += r.usage.out;
      leavesCacheHit += r.usage.cacheHit ?? 0;
    }
    const settled = results[id]!;
    emitNodeEvent({ type: 'settle', id, status: settled.status, kind: settled.kind, ...(settled.model ? { model: settled.model } : {}) });
    // issue #4: 失败节点留痕。成功节点由 runNode 内成功分支落 checkpoint; failed/抛错节点此前**零记录**
    // (stdout 被 caveman 压掉、dag-runs.db 未启用、continuity 只存绿节点 → judge 截停后无法诊断)。
    // 这里补一条结构化败因 checkpoint (节点 id/executor/model/败因分类/错误消息截断)。全程 fail-open,
    // status≠'done' 故 resume 永不当绿跳过 (loadAllGreen/shouldSkip 只认 done)。skipped (D-7v2
    // quorum 级联) 同样留痕: failureKind='dep-skip', summary 含未达 quorum 的依赖清单。
    if (settled.status !== 'done' && continuity) {
      try {
        const startedAt = nodeStartedAt.get(id);
        continuity.manager.saveCheckpoint(continuity.runId, {
          nodeId: id,
          leafKind: settled.kind,
          status: settled.status,
          failureKind: settled.status === 'skipped' ? 'dep-skip' : settled.stalled ? 'stall' : 'failed',
          ...(settled.model ? { model: settled.model } : {}),
          outputPaths: [],
          artifactHashes: {},
          tokenUsage: settled.usage ?? null,
          summary: (settled.output ?? '').slice(0, 800),
          durationMs: startedAt ? Date.now() - startedAt : 0,
          createdAt: new Date().toISOString(),
          ...(dagGeneration ? { generation: dagGeneration } : {}),
          schemaVersion: 1,
        });
      } catch (err) {
        logger.warn({ node: id, err }, '[omd/executor-dag] 失败 checkpoint 落盘失败 (fail-open)');
      }
    }
    for (const dep of dependents.get(id) ?? []) {
      const n = (indeg.get(dep) ?? 1) - 1;
      indeg.set(dep, n);
      if (n === 0) ready.push(dep);
    }
  };

  // warmThenFanout: 全局暖 1 发写共享 leafSystemPrefix 缓存, 再放 pool。
  // (旧法每层暖 1 发 = 深 DAG 暖 N 次且每次阻塞该层; 共享前缀全局相同 → 单次全局暖即覆盖, 命中面更大、阻塞更少。)
  if (config.warmThenFanout && idSet.size > 1 && ready.length > 0) {
    const id = ready.shift()!;
    const r0 = await runNode(id).catch((e) => failedFromThrow(id, e));
    const { r: r1, view } = await maybeFaninView(id, r0); // 扇出≥2 → 摘要 (dependents 释放前)
    if (view) faninView[id] = view;
    settle(id, r1);
  }

  // ── D-7v2 quorum (SDD v2): 全部依赖 settle (indeg 归零) 后判定本节点是否还值得跑 ─────
  // requires 缺省启发: 单依赖 'all' (依赖失败还跑 = 拿 [failed] 文本当正文, 纯浪费 + 静默假成功),
  // 多依赖 fan-in 'any' (宽扇出单叶 429 不陪葬 synth; 反 happy-path: 一律 'all' 比现状更脆)。
  // 不达 quorum → status:'skipped' 级联 (settle 释放下游 → 下游同判), 零 LLM 零 worker 槽。
  const quorumSkip = (id: string): LeafResult | null => {
    const node = plan!.nodes[id]!;
    const deps = (node.depends_on ?? []).filter((d) => idSet.has(d));
    if (deps.length === 0) return null;
    const doneCount = deps.filter((d) => results[d]?.status === 'done').length;
    const req = node.requires ?? (deps.length <= 1 ? 'all' : 'any');
    const ok = req === 'all' ? doneCount === deps.length : req === 'any' ? doneCount >= 1 : doneCount >= req;
    if (ok) return null;
    const bad = deps.filter((d) => results[d]?.status !== 'done').map((d) => `${d}(${results[d]?.status ?? '?'})`);
    logger.warn(
      { node: id, requires: req, done: doneCount, deps: deps.length, bad },
      '[omd/executor-dag] 依赖未达 quorum → skipped 级联 (D-7v2)',
    );
    return {
      id,
      status: 'skipped',
      kind: node.executor === 'command' ? 'command' : node.executor === 'agent' && config.agentRunner ? 'agent' : 'inproc',
      output: `[skipped: 依赖未达 quorum (requires=${req}, done ${doneCount}/${deps.length}) — ${bad.join(', ')}]`,
      deps,
      usage: { in: 0, out: 0 },
    };
  };

  // worker pool: 维持 ≤cap 并发, 节点完成即补位 + 释放下游, ready 空且无在跑 → 收敛。
  let running = 0;
  await new Promise<void>((resolve, reject) => {
    const pump = (): void => {
      for (;;) {
        // ① quorum skip 先于 kind 闸消化 (skip 不运行不占槽, 不该被闸挡; 同步 settle 可能释放
        //    新 ready 甚至清空图 → continue 回到循环头重判收敛, 防全 skip 链上的收敛死锁)。
        let skippedOne = false;
        for (let i = 0; i < ready.length; i++) {
          const sk = quorumSkip(ready[i]!);
          if (sk) {
            ready.splice(i, 1);
            try {
              settle(sk.id, sk);
            } catch (e) {
              reject(e instanceof Error ? e : new Error(String(e)));
              return;
            }
            skippedOne = true;
            break;
          }
        }
        if (skippedOne) continue;
        if (ready.length === 0 && running === 0) {
          resolve();
          return;
        }
        if (running >= cap || ready.length === 0) return;
        // kind × channel 双闸内选第一个可起跑节点 (非严格 FIFO: 被闸挡住的节点让位, 保持吞吐)。
        const idx = ready.findIndex((id) => runningByKind[schedKind(id)] < kindCap[schedKind(id)] && !channelBlocked(id));
        if (idx < 0) return; // 所有就绪节点都被 kind/channel 闸挡住 → 等 settle 释放
        const id = ready.splice(idx, 1)[0]!;
        const kind = schedKind(id);
        const channel = hasChannelCaps ? schedChannel(id) : null;
        running++;
        runningByKind[kind]++;
        if (channel != null) runningByChannel.set(channel, (runningByChannel.get(channel) ?? 0) + 1);
        runNode(id)
          .catch((e) => failedFromThrow(id, e)) // INV-6: leaf 抛错隔离成 failed (保留败因), 不连坐其它节点
          .then(async (r) => {
            // fan-in 定向摘要在 running-- 之前 await: 保持槽位占用跨摘要在飞 → 收敛判据 (running===0)
            // 不会误触发, dependents 也不会在摘要就绪前被释放 (settle 在此后)。fail-open, 永不抛。
            const { r: settledR, view } = await maybeFaninView(id, r);
            running--;
            runningByKind[kind]--;
            if (channel != null) runningByChannel.set(channel, (runningByChannel.get(channel) ?? 1) - 1);
            if (view) faninView[id] = view;
            try {
              settle(id, settledR);
            } catch (e) {
              reject(e instanceof Error ? e : new Error(String(e)));
              return;
            }
            pump();
          });
      }
    };
    pump();
  });

  return { plan, levels, results, reusedNodes: [...reuse.keys()], conductorUsage, leavesIn, leavesOut, leavesCacheHit };
}

/**
 * 跑 omd 本体内部 executor-DAG。task → conductor 规划 → 现场 fan-out leaves → results。
 * 纯 in-process, 不落 PG。conductor/leaf 模型必须显式 (无硬默认)。
 *
 * 校验回流 (config.verifier 给则启用): DAG 跑完 → verifier 审结果 → fail 且配了**可用**升级模型
 * (provider 已注册) → 用更强 conductor 模型 + 注入失败原因重规划重跑, 有界 (maxEscalations, 默认 1)。
 * **升级模型 provider 未注册 (没配 API key) → 不升级, 维持弱模型** (Nick 指令; escalationProviderReady 判)。
 */
export async function runExecutorDag(
  task: string,
  config: ExecutorDagConfig,
  prior?: PriorExec,
): Promise<ExecutorDagResult> {
  if (!config.conductorModel) throw new Error('executor-dag: conductorModel 必填 (无硬默认, 形如 provider:modelId)');
  if (!config.leafModel) throw new Error('executor-dag: leafModel 必填 (无硬默认, 形如 provider:modelId)');
  return runDagInternal(task, config, null, prior);
}

/**
 * D-7 预构造入口: 接受一张**预构造 ConductorPlan** (pathfinder slice-compiler 的产物), **跳过 conductor
 * LLM 步**, 直接把 plan 交下游执行机器 (ready-set 调度 / 叶子 / verify / escalate) —— 下游行为与 conductor
 * 路径**完全一致** (ConductorPlan = 接缝, 下游零感知 plan 来源; D-7「执行机器不变」)。
 * conductorModel 对纯预构造执行**非必填** —— 仅当 verifier fail 且升级模型就绪时, escalate 才用 conductor
 * 重规划 (那时需 conductorEscalationModel)。leafModel 仍必填 (叶子执行要它)。
 */
export async function runExecutorDagWithPlan(
  plan: ConductorPlan,
  config: ExecutorDagConfig,
  prior?: PriorExec,
): Promise<ExecutorDagResult> {
  if (!config.leafModel) throw new Error('executor-dag: leafModel 必填 (无硬默认, 形如 provider:modelId)');
  return runDagInternal(deriveTaskFromPlan(plan), config, plan, prior);
}

/**
 * plan → 文本大纲 (节点 id/executor/deps/goal 逐行)。escalation 重规划与预构造种子共用:
 * 重规划 conductor 必须**看得见上一轮分解**才可能「只修不发明」— 只给 task 散文会让它从零
 * 重新发明 plan (id/措辞全漂), 既丢已裁决结构又把 D-21 语义指纹复用全部打空 (2026-07-25 实证:
 * conductor 路径 escTask 原本不带上轮 plan → 重规划 0 复用)。
 */
function planOutline(plan: ConductorPlan): string {
  return Object.entries(plan.nodes ?? {})
    .map(([id, n]) => {
      const node = n as { goal?: string; depends_on?: string[]; executor?: string };
      const deps = node.depends_on?.length ? ` (depends_on: ${node.depends_on.join(', ')})` : '';
      return `- [${id}]${node.executor ? ` (${node.executor})` : ''}${deps}: ${node.goal ?? ''}`;
    })
    .join('\n');
}

/**
 * 预构造 plan → escalation 重规划的种子 task (仅 verify fail 升级时喂 conductor; 正常执行不触及)。
 * ★ 必须携带**整张已编译 plan** (节点 goal = pathfinder 裁决, depends_on = blockedBy 边):
 * 只给 description (= 目的地一句话) 会让升级 conductor 从散文重新发明 plan, 把地图上
 * 已裁定的每一条决策全部丢掉 (违反 D-11 只组装不发明)。
 */
function deriveTaskFromPlan(plan: ConductorPlan): string {
  const header = plan.description?.trim() || plan.name;
  return [
    header,
    '',
    '===== 已裁决的执行分解 (预构造 plan; 重规划时**只修不发明** — 保留各节点既定目标与依赖边) =====',
    planOutline(plan),
  ].join('\n');
}

/**
 * D-4 × W2 接缝 (2026-07-29 故障注入实测揪出): **resume 的已绿预载此前不问毒集**。
 *
 * 崩溃若落在「judge 拒了 X」与「X 真的重跑」之间, 盘上 X 的 per-node checkpoint 仍是那份**被拒的
 * 产出**, resume 会把它当绿跳过 —— 被拒产出借一次崩溃复活了。`computeReuse` 的毒集闸只管 D-21
 * 那条通道 (上轮 results 注入), 管不到 continuity 这条; 两条通道都能让上轮产出进入本轮, 只堵一条
 * 等于没堵。这正是 INV-P2-6 说的"毒集丢了比不复用更坏", 只是走的是另一条路。
 *
 * 前向闭包一起清: 下游那份 checkpoint 是**吃着被拒输出**跑出来的, 同样不作数
 * (computeReuse 靠 `deps.every(check)` 免费拿到这个闭包, 这里没有那条链, 故显式求不动点)。
 *
 * 代价是崩溃后被毒节点及其下游必然重跑一次 —— 与 D-4 同一个取舍: 多花的是钱, 省下的是信任。
 */
function dropPoisonedGreens(
  greens: Map<string, NodeCheckpoint>,
  plan: ConductorPlan,
  poisoned?: ReadonlySet<string>,
): void {
  if (!poisoned?.size || greens.size === 0) return;
  const blocked = new Set<string>();
  for (const [id, fp] of merkleFingerprints(plan)) if (poisoned.has(fp)) blocked.add(id);
  // 通道⑤-b: 上面那行只认**图里现在有的**节点, 而 map/conductor 的子节点是运行期才挂进去的 ——
  // 预载这一刻它们不在图里, 重算够不着。judge 恰恰最可能点名的就是它们 (它在轮结果里看得见
  // 具体哪个子节点坏了)。改判 checkpoint 自己存下来的指纹, 不依赖当前图的形状。
  for (const [id, cp] of greens) if (cp.fingerprint && poisoned.has(cp.fingerprint)) blocked.add(id);
  if (blocked.size === 0) return;
  for (let changed = true; changed; ) {
    changed = false;
    for (const [id, n] of Object.entries(plan.nodes)) {
      if (blocked.has(id)) continue;
      if ((n.depends_on ?? []).some((d) => blocked.has(d))) {
        blocked.add(id);
        changed = true;
      }
    }
  }
  // **运行时展开出来的子节点一起清** (2026-07-29 补, 通道⑤): 被毒的若是 map / conductor 节点,
  // 它的子节点 id 是 `${parentId}::${key}` —— 运行期才挂进 plan.nodes, 而本函数跑在 resume 预载
  // 阶段, 那时 `plan` 里**根本没有它们**, 上面的指纹遍历与前向闭包都够不着。
  //
  // 于是原样会漏成这样: judge 拒了 conductor 节点 C → C 的绿被清、C 重新展开 → 内容没变则子节点
  // 拿到**同样的内容寻址 id** → 各自命中自己那份**被拒的** checkpoint → 整棵子树跳过。
  // 父节点重跑了, 干活的子节点一个没重跑, 被拒的产出照样交付。
  //
  // 判据用 id 前缀而不是重建子图: 子图要重建就得先跑一次展开 (一次模型调用), 而前缀是
  // `${parentId}::` 这个由 INV-U2/D-B **构造保证**的形状, 不需要跑任何东西就能判。
  // 与 map 的 `expansionHash` 变更清子树 (`key.startsWith(`${id}::`)`) 是同一手法。
  for (const parentId of [...blocked]) {
    const prefix = `${parentId}::`;
    for (const key of [...greens.keys()]) if (key.startsWith(prefix)) blocked.add(key);
  }
  const dropped = [...blocked].filter((id) => greens.delete(id));
  if (dropped.length) {
    logger.warn({ dropped }, '[omd/executor-dag] resume: 毒集命中 → 丢弃这些节点的已绿 checkpoint, 强制重跑 (D-4 × W2)');
  }
}

async function runDagInternal(
  task: string,
  config: ExecutorDagConfig,
  prebuiltPlan: ConductorPlan | null,
  /** 上一**外层轮**的 {plan, results} (D-21 跨轮复用)。轮内 escalation 的 prior 另在下方组装。 */
  prior?: PriorExec,
): Promise<ExecutorDagResult> {
  // sessionId: 本次 run 的 conductor+leaf 全部经 send → 同一 Langfuse session (B2)。
  // 可注入 (config.sessionId): 调用方传则跨平面关联 (派活飞轮 dispatchId ↔ Langfuse session); 省略 → 自生成。
  const sessionId = config.sessionId ?? randomUUID();
  const generate = config.generate ?? makeDefaultGenerate(sessionId);
  const maxPlanRetries = config.maxPlanRetries ?? 2;
  const maxEscalations = config.maxEscalations ?? 1;
  // agent 模板注册表: 注入 (测试/宿主) 或加载 (内置+.omd/agents)。每 run 载一次, 规划+执行+升级共用。
  const templates = config.agentTemplates ?? loadAgentTemplates({ root: config.continuity?.repoRoot });

  let conductorModel = config.conductorModel ?? '';
  // D-7: 预构造 plan → executePlan 直执 (跳过 conductor); 否则 conductor 规划 → 执行。二者下游同一机器。
  let exec: ExecOnce;
  if (prebuiltPlan) {
    exec = await executePlan(applyPlanFilters(prebuiltPlan, config), task, config, generate, { in: 0, out: 0 }, templates, prior);
  } else {
    exec = await planAndExecute(task, config, conductorModel, generate, maxPlanRetries, templates, prior);
  }
  let conductorUsage = exec.conductorUsage;
  let leavesIn = exec.leavesIn;
  let leavesOut = exec.leavesOut;
  let leavesCacheHit = exec.leavesCacheHit;

  // ── 3. verify + conductor 静默升级 (config.verifier 给则启用) ──────────────────
  let verification: ExecutorDagResult['verification'];
  let verifierUsage: ModelUsage = { in: 0, out: 0 };
  if (config.verifier) {
    let attempts = 1;
    let escalated = false;
    let verdict = await config.verifier({ task, plan: exec.plan, results: exec.results });
    verifierUsage = addUsage(verifierUsage, verdict.usage);

    let escCount = 0;
    while (!verdict.pass && escCount < maxEscalations && escalationProviderReady(config.conductorEscalationModel)) {
      escCount++;
      attempts++;
      escalated = true;
      logger.info(
        { from: conductorModel, to: config.conductorEscalationModel, reason: verdict.reason },
        '[omd/executor-dag] verifier 未过 → conductor 静默升级重规划',
      );
      conductorModel = config.conductorEscalationModel;
      // D-21: escTask 必带上轮 plan 大纲 (planOutline) — 重规划「只修不发明」的前提是看得见上轮
      // 分解; 未点名节点逐字保留 → 语义指纹跨轮复用零 LLM (措辞漂移 = 白白重算)。
      const escTask = [
        task,
        '',
        '===== 上一轮的执行分解 (重规划基线) =====',
        planOutline(exec.plan),
        '',
        `[上一轮校验未通过] ${verdict.reason}`,
        '请基于上述分解重新规划: 只修被点名有问题的节点; 未点名节点**逐字保留**其 id/goal/字段/依赖边',
        '(引擎按语义指纹复用未变节点的上轮结果 — 任何措辞变化都会浪费一次重算)。',
      ].join('\n');
      // D-21: 上轮 plan+results 作复用匹配源 — 语义未变的节点零 LLM 注入上轮输出, 只重跑变化子图。
      // 毒集从外层轮继承下来 (D-4): 外层 judge 拒过的指纹在轮内 escalation 里同样不该复活。
      // 轮内不新铸票 —— verifier 的 verdict 只有整轮 {pass, reason}, 没有节点级点名 (要它得先扩 verifier 契约)。
      const priorExec: PriorExec = {
        plan: exec.plan,
        results: exec.results,
        ...(prior?.poisoned?.size ? { poisoned: prior.poisoned } : {}),
      };
      // S3.6 补丁模式优先 (未补丁节点字节不动 → 复用按构造成立); 补丁失败回退整图重规划 (fail-open)。
      const patched = await tryPatchReplan(escTask, verdict.reason, priorExec, config, conductorModel, generate, maxPlanRetries, templates);
      if (patched.exec) {
        exec = patched.exec;
      } else {
        conductorUsage = addUsage(conductorUsage, patched.usage); // 补丁尝试的 token 不丢账
        exec = await planAndExecute(escTask, config, conductorModel, generate, maxPlanRetries, templates, priorExec);
      }
      conductorUsage = addUsage(conductorUsage, exec.conductorUsage);
      leavesIn += exec.leavesIn;
      leavesOut += exec.leavesOut;
      leavesCacheHit += exec.leavesCacheHit;
      verdict = await config.verifier({ task, plan: exec.plan, results: exec.results });
      verifierUsage = addUsage(verifierUsage, verdict.usage);
    }

    // 配了升级模型但 provider 未注册 (没配 API key) → 显式记: 维持弱模型 (Nick: 没配 SOTA 就不升级)。
    if (!verdict.pass && !escalated && config.conductorEscalationModel && !escalationProviderReady(config.conductorEscalationModel)) {
      logger.warn(
        { escalationModel: config.conductorEscalationModel },
        '[omd/executor-dag] verifier 未过, 但升级模型 provider 未注册 → 维持弱模型 (不升级)',
      );
    }
    verification = { pass: verdict.pass, reason: verdict.reason, attempts, escalated, conductorModel };
  }

  // ── 4. bandit reward 回更 (config.router 给则): 最终轮每 leaf 的 (bucket, model) 按
  //       leafCostReward 更新 (ROUTER-5 成本主信号): 成功闸 × dag 软惩罚 (×0.3, 非清零 — DAG 级
  //       连坐是归因噪声) × exp(-costUsd/scale) 连续成本效率。质量由 verifier 闸住, bandit 学"过闸最省"。
  if (config.router) {
    const dagPass = verification ? verification.pass : undefined;
    for (const leaf of Object.values(exec.results)) {
      if (leaf.kind === 'command' || !leaf.model) continue;
      config.router.recordReward(leaf.kind, leaf.model, leafCostReward(leaf, dagPass));
    }
  }

  const result: ExecutorDagResult = {
    plan: exec.plan,
    sessionId,
    levels: exec.levels,
    results: exec.results,
    reusedNodes: exec.reusedNodes,
    usage: {
      conductor: conductorUsage,
      leavesIn,
      leavesOut,
      leavesCacheHit,
      verifier: config.verifier ? verifierUsage : undefined,
    },
    verification,
  };
  if (config.onComplete) {
    try {
      await config.onComplete(result);
    } catch (e) {
      logger.warn({ err: (e as Error).message }, '[omd/executor-dag] onComplete 钩子抛错 (不阻断返回)');
    }
  }
  return result;
}
