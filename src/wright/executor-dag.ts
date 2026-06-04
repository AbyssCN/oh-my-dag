/**
 * src/wright/executor-dag —— wright 本体的**内部 executor-DAG**(现场 fan-out, ⊥ xihe 宏观 PG DAG)。
 *
 * 这是 wright agent **本体 runtime 底层**自包含的编排循环 (the owner 2026-06-01 锁定「两者都要, 先 in-process」):
 *
 *   task ──conductor(显式模型, 我们用 MiMo 2.5 pro 单结构化调用)──▶ plan(leaves + deps)
 *        ──executor(显式模型, 我们用 DeepSeek 高并发)──▶ src/orchestration/primitives 现场 fan-out ──▶ results
 *
 * 设计锁 (the owner):
 *   - **无硬默认**: conductorModel / leafModel 必须显式给 (config), 缺则 callModel 抛错。不 bake 任何模型。
 *   - **model-agnostic**: 经 src/model callModel + provider 注册表 → pi-ai 那些 provider 开源用户随意换。
 *   - **不碰 PG / conduct() / claude -p**: claude -p 是 xihe 接入后 IM 唤醒的另一项目, 不在 wright 本体。
 *   - **现场 in-process**: leaves 经 primitives.parallel 跑, 不落 xihe_workflow_nodes。宏观 PG DAG = 后续外层。
 *
 * 复用 conductor/plan 的**纯规划件** (conductorSystemPrompt / parsePlan / PLAN_BOUNDARY / ConductorPlan)。
 * NOTE(依赖方向): 这些 pure planner 件理应属 wright 本体; 现暂从 src/conductor import (它们不拉 conduct/claude-p)。
 * 后续应迁进 wright, 让 conductor/plan(xihe conduct 路径) 反向依赖 wright 本体 —— 留作 clean-up, 不阻塞。
 */
import { callModel } from '../model';
import type { ModelUsage } from '../model/types';
import { parallel } from '../orchestration/primitives';
import { escalationProviderReady, type VerifierFn } from './verifier';
import type { LeafModelRouter } from './model-router';
import {
  conductorSystemPrompt,
  parsePlan,
  PLAN_BOUNDARY,
  type ConductorPlan,
} from './conductor-plan';
import type { AgentLeafRunner } from './agent-leaf';
import type { CommandLeafRunner } from './command-leaf';
import { cavemanRule, leafCavemanLevel, type CavemanLevel } from './caveman';
import { logger } from '../logger';

/** wright 本体编排的注入式模型调用 (单一注入点; 默认 callModel, 测试传 fake)。 */
export type GenerateFn = (req: {
  messages: { role: 'system' | 'user'; content: string }[];
  model: string;
  /** 推理档 (conductor=分解器 high / inproc leaf=high; → deepseek reasoning_effort)。省略=模型默认。 */
  thinkingLevel?: 'off' | 'low' | 'medium' | 'high' | 'xhigh';
}) => Promise<{ text: string; usage: ModelUsage }>;

export interface ExecutorDagConfig {
  /** conductor 模型 'provider:modelId' (规划用, 我们=mimo:mimo-v2.5-pro)。**必填, 无硬默认。** */
  conductorModel: string;
  /** inproc leaf 模型 'provider:modelId' (生成/判断单发)。**必填, 无硬默认。** 我们: 烧 MiMo 沉没额度时=mimo:mimo-v2.5, 耗尽=deepseek:deepseek-v4-flash。 */
  leafModel: string;
  /**
   * agent leaf 模型 (带工具改文件)。省略 = 同 leafModel。我们=deepseek:deepseek-v4-flash
   * (MiMo agentic flaky + 无 cache, 不适合工具循环 → agent leaf 走 DeepSeek; inproc 才用 MiMo 烧额度)。
   */
  agentLeafModel?: string;
  /** 内层 fan-out 并发上限 (传给 primitives.parallel)。省略 → primitives 的 XIHE_MAX_FANOUT/CPU 兜底。 */
  maxFanout?: number;
  /**
   * 暖发调度 (契约 §10.2): 每层先串行暖 1 发(写 cache)→ 再并行轰其余(命中共享冻结前缀)。
   * 关 = 同时轰(thundering herd, 共享前缀全 miss)。默认 false(小 DAG 不值那一发串行延迟);
   * WIDE 层多时开 = input cache 命中大涨。仅对 inproc leaf 有意义(agent leaf 各自上下文)。
   */
  warmThenFanout?: boolean;
  /**
   * 干活 leaf 的 caveman 压缩级 (省 output token)。默认 'ultra' (output=叙述扔掉, 实测零正确性成本)。
   * 创意节点 (node.creative) 恒 'off' 不受此影响 (护交付物)。设 'off' 全关。
   */
  cavemanLevel?: CavemanLevel;
  /**
   * inproc leaf 的共享冻结 system 前缀 (字节稳定 → 暖发后跨 leaf 命中 prompt-cache)。
   * 省略 = 内置精简指令 (~80 token, 对 DeepSeek cache 粒度偏短, 命中≈0)。要真省 input, 设成
   * 大前缀 (如 WRIGHT_IDENTITY + 指令, ~800+ token) —— 既给 leaf wright 灵魂 (VAL-DAG-6) 又过 cache 阈值。
   */
  leafSystemPrefix?: string;
  /** conductor 规划无效输出的有界重试 (默认 2 → ≤3 次)。 */
  maxPlanRetries?: number;
  /** 限定 conductor 可派的 agent roster (进规划 system prompt)。 */
  agents?: string[];
  /** 注入式模型调用 (inproc leaf, 默认 callModel)。 */
  generate?: GenerateFn;
  /** conductor 分解推理档 (high 默认/复杂 plan 升 max; conductor 是分解器不需深推理, 见 fleet 注释)。 */
  conductorThinkingLevel?: 'off' | 'low' | 'medium' | 'high' | 'xhigh';
  /** inproc leaf 推理档 (默认 high; mass fan-out 省成本, 不走 max — 那是 wright 设计 / best-of-N 的档)。 */
  inprocThinkingLevel?: 'off' | 'low' | 'medium' | 'high' | 'xhigh';
  /**
   * agent-kind leaf 的执行器 (带工具子 agent, 能改文件)。给则 `executor:'agent'` 节点经此跑;
   * 省略 → agent 节点降级为 inproc 单发 (无工具, 只生成文本) + warn。默认 createAgentLeafRunner。
   */
  agentRunner?: AgentLeafRunner;
  /**
   * command-kind leaf 的执行器 (确定性 CLI, 零 LLM, 方案 A)。给则 `executor:'command'` 节点经此跑
   * node.command (经 fail-closed 闸 + 白名单)。省略 → command 节点失败 (无 runner)。
   * codegraph / piolium 等"方法论+CLI工具"型能力的并行检索底座。
   */
  commandRunner?: CommandLeafRunner;
  /**
   * 跨模型校验器 (model-agnostic skeptic, 见 verifier.ts)。省略 = 不校验 (back-compat 老行为)。
   * 给则 DAG 跑完用它审结果 → fail 且配了可用升级模型时触发 conductor 静默升级重规划。
   */
  verifier?: VerifierFn;
  /**
   * conductor 升级模型 'provider:modelId' (verifier fail 时用更强模型重规划重跑)。
   * **provider 未注册 (没配对应 API key) → 自动不升级, 维持弱模型** (the owner: 没配 SOTA API 就维持弱)。
   * 省略 = 永不升级。仅在 config.verifier 存在时有意义。
   */
  conductorEscalationModel?: string;
  /** verifier-fail → 升级重规划的最大次数 (默认 1)。每次升级 = 一整轮重规划 + 重跑 leaves。 */
  maxEscalations?: number;
  /**
   * executor leaf 模型选型路由器 (B-2 bandit, 见 model-router.ts)。省略 = 静态 (leafModel/agentLeafModel)。
   * 给则 inproc/agent leaf 经 router.select(bucket, 静态) 选模型, DAG 校验后按 reward 回更新。
   * pool 未配 → router no-op = 静态 (ship 安全)。node.model 显式给时仍最高优先 (绕过 router)。
   */
  router?: LeafModelRouter;
  /**
   * 运行完成钩子 (留痕层接口)。每次 runExecutorDag 结束前调用一次, 传完整 result (含升级后的最终态)。
   * 传 createDagRecorder().record 的闭包 → 自动落 SQLite 运行记录 (node 图谱可回溯)。抛错不阻断返回。
   */
  onComplete?: (result: ExecutorDagResult) => void | Promise<void>;
}

export interface LeafResult {
  id: string;
  status: 'done' | 'failed';
  /** 实际执行模式: inproc 单发 / agent 带工具子 agent / command 确定性 CLI。 */
  kind: 'inproc' | 'agent' | 'command';
  /** 实际所用模型坐标 (inproc/agent leaf; command 无模型 → undefined)。bandit reward 归因 + 审计用。 */
  model?: string;
  output: string;
  deps: string[];
  usage: ModelUsage;
}

export interface ExecutorDagResult {
  plan: ConductorPlan;
  /** 拓扑层级 (level 0 = 无依赖根; 每 level 内并行)。 */
  levels: string[][];
  results: Record<string, LeafResult>;
  usage: {
    /** conductor 规划用量 (升级时跨所有尝试累加)。 */
    conductor: ModelUsage;
    /** 所有 leaf 的 input/output token 合计 (output 永远全价, cache 只省 input — 见 contract §10.2)。升级时累加。 */
    leavesIn: number;
    leavesOut: number;
    /** 所有 inproc leaf 命中 prompt-cache 的 input token 合计 (⊆ leavesIn, 按 ~10% 价)。 */
    leavesCacheHit: number;
    /** 校验器用量 (跨所有 verify 轮累加)。仅 config.verifier 存在时有值。 */
    verifier?: ModelUsage;
  };
  /** 校验结果 (仅 config.verifier 存在时有值)。escalated=是否触发过 conductor 升级。 */
  verification?: {
    pass: boolean;
    reason: string;
    /** plan+exec 尝试次数 (1 = 未升级 / 首轮即过 / 无可用升级模型)。 */
    attempts: number;
    escalated: boolean;
    /** 最终采用的 conductor 模型 (升级后 = 升级模型)。 */
    conductorModel: string;
  };
}

const defaultGenerate: GenerateFn = async (req) => {
  const r = await callModel({ messages: req.messages, model: req.model, thinkingLevel: req.thinkingLevel });
  return { text: r.text, usage: r.usage };
};

/**
 * 共享冻结 leaf 前缀 (契约 §10.2 VAL-INV-8): **字节稳定**(无时间戳/随机) → 所有 inproc leaf 共享
 * 这段, 暖发后被 prompt-cache 命中。改这段 = 全 leaf cache 失效, 故保持稳定。
 */
const LEAF_SYSTEM_PREFIX =
  'You are a wright executor leaf inside a deterministic DAG. You receive ONE atomic step with its ' +
  'goal and any predecessor outputs. Execute exactly that step and return its result directly — no ' +
  'preamble, no meta-commentary, no asking for clarification. Be concise and faithful to the goal.';

/**
 * 拓扑分层 (Kahn): level k = 所有依赖都在 level <k 的节点。环 → 抛错 (conductor 应产 DAG)。
 * 未知 dep 引用按"已满足"处理 (宽容, conductor 偶发引用不存在节点不应卡死整图)。
 */
export function topoLevels(plan: ConductorPlan): string[][] {
  const ids = Object.keys(plan.nodes);
  const idSet = new Set(ids);
  const placed = new Set<string>();
  const levels: string[][] = [];
  while (placed.size < ids.length) {
    const layer = ids.filter(
      (id) =>
        !placed.has(id) &&
        (plan.nodes[id]!.depends_on ?? []).every((d) => !idSet.has(d) || placed.has(d)),
    );
    if (layer.length === 0) {
      throw new Error(`executor-dag: dependency cycle among [${ids.filter((i) => !placed.has(i)).join(', ')}]`);
    }
    layer.forEach((id) => placed.add(id));
    levels.push(layer);
  }
  return levels;
}

/** 单个 leaf 的执行 prompt: 节点目标/skill/args + 已完成前驱的输出 (fan-in context)。 */
function buildLeafPrompt(
  id: string,
  node: ConductorPlan['nodes'][string],
  depResults: Record<string, string>,
): string {
  const parts: string[] = [`[wright leaf: ${id}]`];
  // 专家框定前置 (persona conditioning, 同 fanout 技法): 把弱 executor 拉进专家区。conductor 仅对吃
  // 专家视角的 leaf 设 (research/judgement/design/drafting), 缺省则无 (机械/file/command 节点不需)。
  if (node.persona) parts.push(`<persona>${node.persona}</persona>`);
  if (node.goal) parts.push(`Goal: ${node.goal}`);
  if (node.skill) parts.push(`Skill: ${node.skill}`);
  if (node.args && Object.keys(node.args).length > 0) parts.push(`Args: ${JSON.stringify(node.args)}`);
  const deps = node.depends_on ?? [];
  if (deps.length > 0) {
    const ctx = deps
      .filter((d) => depResults[d] !== undefined)
      .map((d) => `### ${d}\n${depResults[d]}`)
      .join('\n\n');
    if (ctx) parts.push(`Predecessor outputs:\n${ctx}`);
  }
  // 治 meta 碎话 + 省 output (the owner: leaf 不需要太多 output) + 治 genre 塌缩/捏造 (2026-06-03 高并发验证
  // 发现: "设计/拆步" 类任务被 leaf 当成 "执行一遍" 演 + 捏数据填空 → 显式禁止)。
  parts.push(
    "\nProduce this step's deliverable directly. If the goal is to design / describe / analyze / plan / draft, " +
      'OUTPUT that content — do NOT simulate performing the step, and do NOT fabricate data, results, or inputs you ' +
      'were not given. A one-line confirmation is only for when the deliverable actually went to a file/tool. ' +
      'No preamble, no meta-commentary, no restating the inputs. Be concise.',
  );
  return parts.join('\n');
}

/** ModelUsage 累加 (跨 plan/verify 尝试合计成本)。 */
function addUsage(a: ModelUsage, b: ModelUsage): ModelUsage {
  return { in: a.in + b.in, out: a.out + b.out, cacheHit: (a.cacheHit ?? 0) + (b.cacheHit ?? 0) };
}

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
): Promise<ExecOnce> {
  // ── 1. conductor: 单结构化调用规划 (我们用 MiMo, 显式可换) ──────────────────
  const sys = conductorSystemPrompt({ agents: config.agents });
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
    const parsed = parsePlan(text);
    if (parsed.ok) {
      plan = parsed.plan;
      break;
    }
    lastErr = parsed.error;
  }
  if (!plan) throw new Error(`executor-dag: conductor (${conductorModel}) 未产出有效 plan: ${lastErr}`);

  const levels = topoLevels(plan);
  logger.info(
    { conductorModel, leafModel: config.leafModel, nodes: Object.keys(plan.nodes).length, levels: levels.length },
    '[wright/executor-dag] planned',
  );

  // ── 2. executor: 逐层现场 fan-out (层内并行, 经 primitives), leaf 调显式 leafModel ──
  const results: Record<string, LeafResult> = {};
  const depOutputs: Record<string, string> = {};
  let leavesIn = 0;
  let leavesOut = 0;
  let leavesCacheHit = 0;

  for (const layer of levels) {
    const thunks = layer.map((id) => async (): Promise<LeafResult> => {
      const node = plan!.nodes[id]!;
      const deps = node.depends_on ?? [];
      // command leaf (方案 A): 确定性 CLI, 零 LLM, 无 caveman/prompt。exitCode 0 = done。
      if (node.executor === 'command') {
        if (!config.commandRunner || !node.command) {
          logger.warn({ node: id, hasRunner: !!config.commandRunner, hasCmd: !!node.command }, '[wright/executor-dag] executor:command 缺 commandRunner/command → failed');
          return { id, status: 'failed', kind: 'command', output: '', deps, usage: { in: 0, out: 0 } };
        }
        const r = await config.commandRunner({ command: node.command });
        return { id, status: r.exitCode === 0 ? 'done' : 'failed', kind: 'command', output: r.text, deps, usage: r.usage };
      }
      // caveman 路由: 创意节点 (node.creative) → off 护交付物; 否则 → 干活级 (默认 ultra) 压叙述省 token。
      const cav = cavemanRule(leafCavemanLevel(node.creative, config.cavemanLevel ?? 'ultra'));
      const prompt = cav ? `${buildLeafPrompt(id, node, depOutputs)}\n\n${cav}` : buildLeafPrompt(id, node, depOutputs);
      // 双模分流: executor:'agent' + 有 agentRunner → 带工具子 agent (能改文件);
      // 否则 inproc 单发。agent 节点但缺 runner → 降级 inproc + warn (别静默当成功干了活)。
      const wantAgent = node.executor === 'agent';
      if (wantAgent && !config.agentRunner) {
        logger.warn({ node: id }, '[wright/executor-dag] executor:agent 但无 agentRunner → 降级 inproc (无工具, 不会改文件)');
      }
      const useAgent = wantAgent && !!config.agentRunner;
      // per-node model 路由: node.model 显式最高优先 → 否则 router (bandit) 选 → 否则静态
      // (agent→agentLeafModel, inproc→leafModel)。bucket = executor kind (router 学习单元)。
      const bucket = useAgent ? 'agent' : 'inproc';
      const staticModel = useAgent ? config.agentLeafModel ?? config.leafModel : config.leafModel;
      const model = node.model ?? (config.router ? config.router.select(bucket, staticModel) : staticModel);
      const { text, usage } = useAgent
        ? await config.agentRunner!({ prompt, model })
        : // inproc leaf 带共享冻结前缀 (system) → 暖发后跨 leaf 命中 prompt-cache。
          await generate({
            messages: [
              { role: 'system', content: config.leafSystemPrefix ?? LEAF_SYSTEM_PREFIX },
              { role: 'user', content: prompt },
            ],
            model,
            thinkingLevel: config.inprocThinkingLevel ?? 'high', // inproc leaf: high (mass fan-out 省成本, 非 max)
          });
      return { id, status: 'done', kind: useAgent ? 'agent' : 'inproc', model, output: text, deps: node.depends_on ?? [], usage };
    });

    // 暖发调度 (契约 §10.2): warmThenFanout 时先串行暖 1 发 (写 cache), 再并行轰其余 (命中共享前缀);
    // 否则同时轰 (thundering herd)。parallel 把抛错隔离成 null (INV-6); 暖发那一发也对齐成 null。
    const concurrency = config.maxFanout !== undefined ? { concurrency: config.maxFanout } : undefined;
    let layerResults: (LeafResult | null)[];
    if (config.warmThenFanout && thunks.length > 1) {
      const warm = await thunks[0]!().catch(() => null);
      const rest = await parallel(thunks.slice(1), concurrency);
      layerResults = [warm, ...rest];
    } else {
      layerResults = await parallel(thunks, concurrency);
    }

    layer.forEach((id, i) => {
      const r = layerResults[i];
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
    });
  }

  return { plan, levels, results, conductorUsage, leavesIn, leavesOut, leavesCacheHit };
}

/**
 * 跑 wright 本体内部 executor-DAG。task → conductor 规划 → 现场 fan-out leaves → results。
 * 纯 in-process, 不落 PG。conductor/leaf 模型必须显式 (无硬默认)。
 *
 * 校验回流 (config.verifier 给则启用): DAG 跑完 → verifier 审结果 → fail 且配了**可用**升级模型
 * (provider 已注册) → 用更强 conductor 模型 + 注入失败原因重规划重跑, 有界 (maxEscalations, 默认 1)。
 * **升级模型 provider 未注册 (没配 API key) → 不升级, 维持弱模型** (the owner 指令; escalationProviderReady 判)。
 */
export async function runExecutorDag(
  task: string,
  config: ExecutorDagConfig,
): Promise<ExecutorDagResult> {
  if (!config.conductorModel) throw new Error('executor-dag: conductorModel 必填 (无硬默认, 形如 provider:modelId)');
  if (!config.leafModel) throw new Error('executor-dag: leafModel 必填 (无硬默认, 形如 provider:modelId)');
  const generate = config.generate ?? defaultGenerate;
  const maxPlanRetries = config.maxPlanRetries ?? 2;
  const maxEscalations = config.maxEscalations ?? 1;

  let conductorModel = config.conductorModel;
  let exec = await planAndExecute(task, config, conductorModel, generate, maxPlanRetries);
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
        '[wright/executor-dag] verifier 未过 → conductor 静默升级重规划',
      );
      conductorModel = config.conductorEscalationModel;
      const escTask = `${task}\n\n[上一轮校验未通过] ${verdict.reason}\n请基于此重新规划, 修复上述问题。`;
      exec = await planAndExecute(escTask, config, conductorModel, generate, maxPlanRetries);
      conductorUsage = addUsage(conductorUsage, exec.conductorUsage);
      leavesIn += exec.leavesIn;
      leavesOut += exec.leavesOut;
      leavesCacheHit += exec.leavesCacheHit;
      verdict = await config.verifier({ task, plan: exec.plan, results: exec.results });
      verifierUsage = addUsage(verifierUsage, verdict.usage);
    }

    // 配了升级模型但 provider 未注册 (没配 API key) → 显式记: 维持弱模型 (the owner: 没配 SOTA 就不升级)。
    if (!verdict.pass && !escalated && config.conductorEscalationModel && !escalationProviderReady(config.conductorEscalationModel)) {
      logger.warn(
        { escalationModel: config.conductorEscalationModel },
        '[wright/executor-dag] verifier 未过, 但升级模型 provider 未注册 → 维持弱模型 (不升级)',
      );
    }
    verification = { pass: verdict.pass, reason: verdict.reason, attempts, escalated, conductorModel };
  }

  // ── 4. bandit reward 回更 (config.router 给则): 最终轮每 leaf 的 (bucket, model) 按
  //       reward = leafOk × dagOk 更新 (dagOk = 有 verifier 时 verdict.pass 否则 1)。command 无模型跳过。
  //       DAG 级 verdict 摊到该轮所有 leaf — credit assignment 噪声跨多轮 run 均掉。
  if (config.router) {
    const dagOk = verification ? (verification.pass ? 1 : 0) : 1;
    for (const leaf of Object.values(exec.results)) {
      if (leaf.kind === 'command' || !leaf.model) continue;
      const leafOk = leaf.status === 'done' ? 1 : 0;
      config.router.recordReward(leaf.kind, leaf.model, leafOk * dagOk);
    }
  }

  const result: ExecutorDagResult = {
    plan: exec.plan,
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
      logger.warn({ err: (e as Error).message }, '[wright/executor-dag] onComplete 钩子抛错 (不阻断返回)');
    }
  }
  return result;
}
