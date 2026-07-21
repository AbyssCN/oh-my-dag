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
  parsePlan,
  PLAN_BOUNDARY,
  type ConductorPlan,
} from './conductor-plan';
import { hashArtifact, computeDagGeneration } from './continuity/checkpoint-manager';
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
): Promise<ExecOnce> {
  // ── 1. conductor: 单结构化调用规划 (我们用 MiMo, 显式可换) ──────────────────
  // 模板注册表进规划 prompt (每卡一行 description); parsePlan 校验 template 引用 (TPL-2 规划层拒)。
  const sys = conductorSystemPrompt({ agents: config.agents, templates: templateRoster(templates) });
  let plan: ConductorPlan | null = null;
  let conductorUsage: ModelUsage = { in: 0, out: 0 };
  let lastErr = '';
  for (let attempt = 1; attempt <= maxPlanRetries + 1; attempt++) {
    const correction = attempt === 1 ? '' : `\n\n上次回复不是有效 plan (${lastErr})。只回 JSON 对象, 别的不要。`;
    const { text, usage } = await generate({
      messages: [{ role: 'system', content: sys }, { role: 'user', content: `${PLAN_BOUNDARY}${task}${correction}` }],
      model: conductorModel,
      thinkingLevel: config.conductorThinkingLevel ?? 'high', // 分解器: high 默认
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

  // 确定性过滤: plan 中 command 与 oracleCmd 等价的节点移除 (oracle 已跑过, 重跑 = 浪费)。
  const filteredPlan = config.oracleCmd ? filterOracleCommandNodes(plan, config.oracleCmd) : plan;
  // conductor 之后, 下游执行机器与 plan 来源无关 → 交 executePlan (D-7 预构造入口共用同一机器)。
  return executePlan(filteredPlan, task, config, generate, conductorUsage, templates);
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

  // ── 2. executor: 逐层现场 fan-out (层内并行, 经 primitives), leaf 调显式 leafModel ──
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
    });
    if (continuity.resume) {
      for (const cp of continuity.manager.loadAllGreen(continuity.runId)) resumeGreens.set(cp.nodeId, cp);
    }
  }

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
          thinkingLevel: config.inprocThinkingLevel ?? 'high',
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
      leaf: async ({ goal, persona }) => {
        const cav = cavemanRule(leafCavemanLevel(false, config.cavemanLevel ?? 'full'));
        const personaLine = persona ? `<persona>${persona}</persona>\n` : '';
        const r = await generate({
          messages: [
            { role: 'system', content: config.leafSystemPrefix ?? LEAF_SYSTEM_PREFIX },
            { role: 'user', content: `${personaLine}${goal}${depCtx}${cav ? `\n\n${cav}` : ''}` },
          ],
          model: config.leafModel,
          thinkingLevel: config.inprocThinkingLevel ?? 'high',
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

  // runNode: 单节点执行 (resume-skip / primitive / map / command / agent / inproc + checkpoint)。由下方 ready-set 调度器按依赖就绪驱动。
  const runNode = async (id: string): Promise<LeafResult> => {
      const node = plan!.nodes[id]!;
      const deps = node.depends_on ?? [];
      nodeStartedAt.set(id, Date.now());
      emitNodeEvent({ type: 'start', id, kind: nodeKind(node) });
      // SDD 0013 S1: primitive 节点 (约束选择) → compile+run 分支 (先于 map/executor, 与自由 node 并存)。
      if (node.kind === 'primitive' && node.primitive) return runPrimitiveNode(id);
      // U1: map 节点走运行时展开分支 (永不整体 resume-skip — lister 便宜, 子节点各自续)。
      if (node.executor === 'map' && node.map) return runMapNode(id);
      // W2 resume: checkpoint done ∧ 产物存在 ∧ hash 匹配 → 跳过执行 (shouldSkip 内含校验)。
      if (continuity?.resume && resumeGreens.has(id) && continuity.manager.shouldSkip(continuity.runId, id, dagGeneration)) {
        const cp = resumeGreens.get(id)!;
        logger.info({ node: id }, '[omd/executor-dag] continuity resume: 节点已绿, 跳过');
        return { id, status: 'done', kind: cp.leafKind, output: cp.summary, deps, usage: { in: 0, out: 0 }, skipped: true, filesTouched: cp.outputPaths };
      }
      // command leaf (方案 A): 确定性 CLI, 零 LLM, 无 caveman/prompt。exitCode 0 = done。
      if (node.executor === 'command') {
        if (!config.commandRunner || !node.command) {
          logger.warn({ node: id, hasRunner: !!config.commandRunner, hasCmd: !!node.command }, '[omd/executor-dag] executor:command 缺 commandRunner/command → failed');
          return { id, status: 'failed', kind: 'command', output: '', deps, usage: { in: 0, out: 0 } };
        }
        const r = await config.commandRunner({ command: node.command });
        return { id, status: r.exitCode === 0 ? 'done' : 'failed', kind: 'command', output: r.text, deps, usage: r.usage };
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
      // per-node model 路由 (TPL-3): node.model 显式最高优先 → 模板卡 model → router (bandit) 选 →
      // 静态 (agent→agentLeafModel, inproc→leafModel)。bucket = executor kind (router 学习单元)。
      const bucket = useAgent ? 'agent' : 'inproc';
      const staticModel = useAgent ? config.agentLeafModel ?? config.leafModel : config.leafModel;
      const model = node.model ?? tpl?.model ?? (config.router ? config.router.select(bucket, staticModel) : staticModel);
      const t0 = Date.now();
      let text: string;
      let usage: ModelUsage;
      let filesTouched: string[] = [];
      if (useAgent) {
        const r = await config.agentRunner!({ prompt, model });
        text = r.text;
        usage = r.usage;
        filesTouched = r.filesTouched ?? [];
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
          const root = continuity?.repoRoot ?? process.cwd();
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
        const r = await generate({
          messages: [
            { role: 'system', content: config.leafSystemPrefix ?? LEAF_SYSTEM_PREFIX },
            { role: 'user', content: prompt },
          ],
          model,
          thinkingLevel: config.inprocThinkingLevel ?? 'high', // inproc leaf: high (mass fan-out 省成本, 非 max)
        });
        text = r.text;
        usage = r.usage;
      }
      const leaf: LeafResult = { id, status: 'done', kind: useAgent ? 'agent' : 'inproc', model, output: text, deps: node.depends_on ?? [], usage, filesTouched };
      // W2 checkpoint 落盘 (done 节点, fail-open)。summary=output 截断; noun-gate 注释 only,
      // material=节点 prompt (含 deps 上下文) —— "输出了输入和 repo 都没有的名词" 才是审计信号
      // (material 含 output 会恒真, SDD C5 消费者② 修正)。tokenUsage: agent leaf 真值不可得 → null (V2-ECON)。
      if (continuity) {
        try {
          const root = continuity.repoRoot ?? process.cwd();
          // 产物路径相对化到 repoRoot (worktree 可移植; shouldSkip 用 repoRoot 锚回)。
          const rel = (p: string): string => (p.startsWith(`${root}/`) ? p.slice(root.length + 1) : p);
          const artifactHashes: Record<string, string> = {};
          const outputPaths: string[] = [];
          for (const p of filesTouched) {
            const rp = rel(p);
            outputPaths.push(rp);
            const h = hashArtifact(p.startsWith('/') ? p : `${root}/${rp}`);
            if (h) artifactHashes[rp] = h;
          }
          const summary = text.slice(0, 800);
          let nounAnnotations: string[] | undefined;
          try {
            if (!_nounGate) throw new Error('noun-gate not injected');
            const ng = _nounGate({ text: summary, material: prompt, repoRoot: root, annotate: false });
            if (ng.novelNouns.length > 0) nounAnnotations = ng.novelNouns.slice(0, 10);
          } catch {
            /* noun-gate 注释 only, 挂了不影响 checkpoint */
          }
          continuity.manager.saveCheckpoint(continuity.runId, {
            nodeId: id,
            leafKind: useAgent ? 'agent' : 'inproc',
            status: 'done',
            outputPaths,
            artifactHashes,
            tokenUsage: useAgent ? null : usage,
            summary,
            ...(nounAnnotations ? { nounAnnotations } : {}),
            durationMs: Date.now() - t0,
            createdAt: new Date().toISOString(),
            ...(dagGeneration ? { generation: dagGeneration } : {}),
            schemaVersion: 1,
          });
        } catch (err) {
          logger.warn({ node: id, err }, '[omd/executor-dag] checkpoint write failed (fail-open)');
        }
      }
      return leaf;
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
    // status='failed' 故 resume 永不当绿跳过 (loadAllGreen/shouldSkip 只认 done)。
    if (settled.status === 'failed' && continuity) {
      try {
        const startedAt = nodeStartedAt.get(id);
        continuity.manager.saveCheckpoint(continuity.runId, {
          nodeId: id,
          leafKind: settled.kind,
          status: 'failed',
          failureKind: settled.stalled ? 'stall' : 'failed',
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

  // worker pool: 维持 ≤cap 并发, 节点完成即补位 + 释放下游, ready 空且无在跑 → 收敛。
  let running = 0;
  await new Promise<void>((resolve, reject) => {
    const pump = (): void => {
      if (ready.length === 0 && running === 0) {
        resolve();
        return;
      }
      for (;;) {
        if (running >= cap || ready.length === 0) break;
        // kind 闸内选第一个可起跑节点 (非严格 FIFO: 被 kind 闸挡住的节点让位给其它 kind, 保持吞吐)。
        const idx = ready.findIndex((id) => runningByKind[schedKind(id)] < kindCap[schedKind(id)]);
        if (idx < 0) break; // 所有就绪节点都被各自 kind 闸挡住 → 等 settle 释放
        const id = ready.splice(idx, 1)[0]!;
        const kind = schedKind(id);
        running++;
        runningByKind[kind]++;
        runNode(id)
          .catch((e) => failedFromThrow(id, e)) // INV-6: leaf 抛错隔离成 failed (保留败因), 不连坐其它节点
          .then(async (r) => {
            // fan-in 定向摘要在 running-- 之前 await: 保持槽位占用跨摘要在飞 → 收敛判据 (running===0)
            // 不会误触发, dependents 也不会在摘要就绪前被释放 (settle 在此后)。fail-open, 永不抛。
            const { r: settledR, view } = await maybeFaninView(id, r);
            running--;
            runningByKind[kind]--;
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

  return { plan, levels, results, conductorUsage, leavesIn, leavesOut, leavesCacheHit };
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
): Promise<ExecutorDagResult> {
  if (!config.conductorModel) throw new Error('executor-dag: conductorModel 必填 (无硬默认, 形如 provider:modelId)');
  if (!config.leafModel) throw new Error('executor-dag: leafModel 必填 (无硬默认, 形如 provider:modelId)');
  return runDagInternal(task, config, null);
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
): Promise<ExecutorDagResult> {
  if (!config.leafModel) throw new Error('executor-dag: leafModel 必填 (无硬默认, 形如 provider:modelId)');
  return runDagInternal(deriveTaskFromPlan(plan), config, plan);
}

/**
 * 预构造 plan → escalation 重规划的种子 task (仅 verify fail 升级时喂 conductor; 正常执行不触及)。
 * ★ 必须携带**整张已编译 plan** (节点 goal = pathfinder 裁决, depends_on = blockedBy 边):
 * 只给 description (= 目的地一句话) 会让升级 conductor 从散文重新发明 plan, 把地图上
 * 已裁定的每一条决策全部丢掉 (违反 D-11 只组装不发明)。
 */
function deriveTaskFromPlan(plan: ConductorPlan): string {
  const header = plan.description?.trim() || plan.name;
  const nodeLines = Object.entries(plan.nodes ?? {}).map(([id, n]) => {
    const node = n as { goal?: string; depends_on?: string[]; executor?: string };
    const deps = node.depends_on?.length ? ` (depends_on: ${node.depends_on.join(', ')})` : '';
    return `- [${id}]${node.executor ? ` (${node.executor})` : ''}${deps}: ${node.goal ?? ''}`;
  });
  return [
    header,
    '',
    '===== 已裁决的执行分解 (预构造 plan; 重规划时**只修不发明** — 保留各节点既定目标与依赖边) =====',
    ...nodeLines,
  ].join('\n');
}

async function runDagInternal(
  task: string,
  config: ExecutorDagConfig,
  prebuiltPlan: ConductorPlan | null,
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
    const filteredPlan = config.oracleCmd ? filterOracleCommandNodes(prebuiltPlan, config.oracleCmd) : prebuiltPlan;
    exec = await executePlan(filteredPlan, task, config, generate, { in: 0, out: 0 }, templates);
  } else {
    exec = await planAndExecute(task, config, conductorModel, generate, maxPlanRetries, templates);
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
      const escTask = `${task}\n\n[上一轮校验未通过] ${verdict.reason}\n请基于此重新规划, 修复上述问题。`;
      exec = await planAndExecute(escTask, config, conductorModel, generate, maxPlanRetries, templates);
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
