/**
 * src/serve/chat-tools —— chat conductor 的工具面 = 装配层 MCP 工具的**薄包装**。
 *
 * 一个控制面原则:daemon 的 HTTP 桥、MCP 客户端、chat agent 三方调用**同一批 assembled handler**;
 * 这里只做形状转换(MCP 的 zod 注册面 → pi AgentTool 的 typebox 面),零业务逻辑。
 * 白名单收窄:chat 位是指挥位不是执行位 —— 给 run/solve/status/output/地图/图库/取消/记忆召回,
 * **不给** leaf 的文件工具(改文件走图,不走对话;这是 THE-LOOP 的角色红线,Fleet 才动文件)。
 * 记忆只给 recall 不给 remember:召回是读,写记忆是有后果的动作,不放在对话位自主调。
 *
 * 工具名承接改名表后的新名 (run/solve/map_*); 找不到点名的工具 → 装配时响亮抛
 * (静默少一个工具 = chat 位悄悄残废, 那是最贵的静默失效)。
 */
import { type Static, Type } from 'typebox';
import type { AnyOmdTool } from '../harness/agent-tools';
import type { OmdMcpTool } from '../mcp/server';
import { zodShapeToFields } from './zod-typebox';

/** MCP handler 的返回形状 (content 数组取 text 拼接; isError → 前缀标注, 让模型看得见失败)。 */
async function invoke(tool: OmdMcpTool, args: Record<string, unknown>): Promise<string> {
  // MCP SDK 的 ToolCallback 第二参是 RequestHandlerExtra — 桥内直调用不到, 传空壳。
  const res = (await (tool.handler as (a: unknown, extra: unknown) => unknown)(args, {})) as {
    content?: { type: string; text?: string }[];
    isError?: boolean;
  };
  const text = (res.content ?? [])
    .map((c) => c.text ?? '')
    .filter(Boolean)
    .join('\n');
  return res.isError ? `[TOOL ERROR]\n${text}` : text;
}

function must(tools: readonly OmdMcpTool[], name: string): OmdMcpTool {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`[serve/chat-tools] 装配面里找不到工具 '${name}' — 白名单与装配层漂了`);
  return t;
}

function textTool<S extends ReturnType<typeof Type.Object>>(
  name: string,
  description: string,
  promptSnippet: string,
  parameters: S,
  run: (params: Static<S>) => Promise<string>,
): AnyOmdTool {
  return {
    name,
    label: name,
    description,
    promptSnippet,
    parameters,
    executionMode: 'sequential',
    async execute(_id: string, params: unknown) {
      const text = await run(params as Static<S>);
      return { content: [{ type: 'text', text }], details: undefined };
    },
  } as AnyOmdTool;
}

/**
 * 本体 conductor 工具面 ⊇ MCP 装配面 (conductor 类工具) 的闸 + 工具清单。
 *
 * owner 2026-08-19 裁决: 本体 chat 位应持**超集** —— MCP 是给外部 agent (Claude Code/Codex)
 * 的窄桥, 不是本体够引擎能力的唯一通道。COVERED_MCP_NAMES 是「MCP 面 → 本体工具」的映射真源;
 * assertSurfaceComplete 保证: MCP 面里任何非别名、非显式排除的工具, 本体都有对应, 否则装配期响亮抛
 * (静默少一个工具 = chat 位悄悄残废, 那是最贵的静默失效 —— 与 must() 同一条纪律)。
 */
const CHAT_EXCLUSIONS: ReadonlySet<string> = new Set(['conductor_chat']);

const COVERED_MCP_NAMES: ReadonlySet<string> = new Set([
  // 既有 12 (createConductorChatTools 手写 textTool)。
  'run', 'solve', 'dag_run_plan', 'dag_status', 'dag_runs', 'dag_node_output',
  'dag_cancel', 'map_tickets', 'omd_plans', 'memory_recall', 'history_read', 'history_search',
  // 扩展 30 (下方 EXTRA_CONDUCTOR_TOOLS 经 wrapMcpTool 装配)。
  'dag_research', 'dag_review', 'dag_slim', 'dag_deepen', 'dag_debug',
  'dag_triage', 'dag_rule', 'dag_intervene', 'dag_resume', 'dag_result',
  'map_init', 'map_open', 'map_add', 'map_rule', 'map_deliver', 'map_prefetch', 'map_confirm',
  'memory_remember', 'memory_fact', 'omd_web', 'omd_distill',
  'omd_set_key', 'omd_apply_preset', 'omd_set_role', 'omd_models_auto', 'omd_register_provider',
  'omd_set_model', 'omd_config_status', 'omd_toggle_hud', 'omd_primitive', 'omd_shapes',
]);

function assertSurfaceComplete(tools: readonly OmdMcpTool[]): void {
  const missing: string[] = [];
  for (const t of tools) {
    if (t.description.startsWith('[deprecated →')) continue; // 改名 alias —— 同一扇门, 不重复计数。
    if (CHAT_EXCLUSIONS.has(t.name)) continue;
    if (!COVERED_MCP_NAMES.has(t.name)) missing.push(t.name);
  }
  if (missing.length > 0) {
    throw new Error(
      `[serve/chat-tools] 本体 chat 白名单缺 conductor 工具: ${missing.join(', ')} — ` +
        'MCP 面有而本体没有 (本体应 ⊇ MCP)。把缺的加进 COVERED_MCP_NAMES, 或显式加进 CHAT_EXCLUSIONS。',
    );
  }
}

/**
 * 把 MCP 工具薄包装成本体 chat 工具: 复用 MCP description + 转换 zod schema → typebox,
 * handler 直调同一 assembled handler (零业务逻辑, 与 textTool 同款)。
 * confirmRequired = 凭证写工具 —— 每次调用必须带 confirm:true (owner 经 ask_user 确认后才 set)。
 */
function wrapMcpTool(
  chatName: string,
  mcpName: string,
  tools: readonly OmdMcpTool[],
  opts: { confirmRequired?: boolean; promptSnippet?: string } = {},
): AnyOmdTool {
  const tool = must(tools, mcpName);
  const fields = zodShapeToFields(tool.inputSchema);
  const parameters = Type.Object({
    ...fields,
    ...(opts.confirmRequired
      ? {
          confirm: Type.Optional(
            Type.Boolean({ description: 'Owner 已确认 (先 ask_user 征得明确同意, 再 set true)' }),
          ),
        }
      : {}),
  });
  return {
    name: chatName,
    label: chatName,
    description: tool.description,
    promptSnippet: opts.promptSnippet ?? tool.description,
    parameters,
    executionMode: 'sequential',
    async execute(_id, params) {
      const p = params as Record<string, unknown>;
      if (opts.confirmRequired && p.confirm !== true) {
        return {
          content: [
            {
              type: 'text',
              text:
                `[BLOCKED] ${chatName} 是凭证写工具 —— 必须先 ask_user 征得 owner 明确同意, ` +
                '再带 confirm:true 重调。本次未执行。',
            },
          ],
          details: undefined,
        };
      }
      const text = await invoke(tool, p);
      return { content: [{ type: 'text', text }], details: undefined };
    },
  } as AnyOmdTool;
}

/** 扩展工具: mcpName (装配面) → chatName (本体原生名)。描述/提示复用 MCP 的一行说明。 */
const EXTRA_CONDUCTOR_TOOLS: ReadonlyArray<{
  chatName: string;
  mcpName: string;
  confirmRequired?: boolean;
  promptSnippet?: string;
}> = [
  { chatName: 'omd_research', mcpName: 'dag_research', promptSnippet: 'omd_research(question, council?, super?, k?, rounds?) — 真 web 深度调研/议会 (无 provider 响亮拒)' },
  { chatName: 'omd_review', mcpName: 'dag_review', promptSnippet: 'omd_review(gate?, scope?, deep?) — 对抗式 diff 审 (异步, 返 runId)' },
  { chatName: 'omd_slim', mcpName: 'dag_slim', promptSnippet: 'omd_slim(scope?) — 过度工程只删不增审计 (异步)' },
  { chatName: 'omd_deepen', mcpName: 'dag_deepen', promptSnippet: 'omd_deepen(commits?, hotspots?) — 架构加深热点扫描 (异步, 返 HTML 报告路径)' },
  { chatName: 'omd_debug', mcpName: 'dag_debug', promptSnippet: 'omd_debug(failure, repro?, oracleCmd?, rounds?, hypotheses?) — 并发多假设根因调试 (异步)' },
  { chatName: 'omd_triage', mcpName: 'dag_triage', promptSnippet: 'omd_triage(runId?) — owner 收件箱: 待决岔口 + 需人看的 run (只读)' },
  { chatName: 'omd_rule', mcpName: 'dag_rule', promptSnippet: 'omd_rule(forkId, ruling) — 裁决决策岔口 (ruling 逐字进下一轮 conductor)' },
  { chatName: 'omd_intervene', mcpName: 'dag_intervene', promptSnippet: 'omd_intervene(runId, cause, note?) — 记录一次人工介入' },
  { chatName: 'omd_resume', mcpName: 'dag_resume', promptSnippet: 'omd_resume(runId, leafModel?, maxFanout?) — 从 checkpoint 续跑失败/中断的 run (跳过已绿节点)' },
  { chatName: 'omd_result', mcpName: 'dag_result', promptSnippet: 'omd_result(runId) — 取完整 run 结果 (非 done 状态报错)' },
  { chatName: 'omd_map_init', mcpName: 'map_init', promptSnippet: 'omd_map_init(destination?, backend?, cloudAfk?) — 初始化 pathfinder 后端 (无参 = 探针报告)' },
  { chatName: 'omd_map_open', mcpName: 'map_open', promptSnippet: 'omd_map_open(destination?) — 列开放地图 / 开或续一张图' },
  { chatName: 'omd_map_add', mcpName: 'map_add', promptSnippet: 'omd_map_add(title, type?, slug?, id?, blockedBy?, blockedByDelivery?, executorKind?) — 加票' },
  { chatName: 'omd_map_rule', mcpName: 'map_rule', promptSnippet: 'omd_map_rule(ticketId, ruling, slug?, disposition?) — 裁决前沿票' },
  { chatName: 'omd_map_deliver', mcpName: 'map_deliver', promptSnippet: 'omd_map_deliver(slug?) — 执行可交付区域 (编译 ruled 票成 slice 跑 DAG)' },
  { chatName: 'omd_map_prefetch', mcpName: 'map_prefetch', promptSnippet: 'omd_map_prefetch(slug?) — 预取地图上下文' },
  { chatName: 'omd_map_confirm', mcpName: 'map_confirm', promptSnippet: 'omd_map_confirm(...) — 确认/拒绝 suggested 票' },
  { chatName: 'omd_remember', mcpName: 'memory_remember', promptSnippet: 'omd_remember(fact) — 写一条记忆 (只写已验证事实/裁决; append 不覆盖)' },
  // recall 的 L2 出口 (2026-08-28): recall 只给 1500 字符的头部, 全文走这里。
  // 没有它, 截断就是内容永久不可达 —— 而库里 omd.pattern 最长 4518 字符。
  { chatName: 'omd_fact', mcpName: 'memory_fact', promptSnippet: 'omd_fact(id) — 按 id 取一条记忆全文 + 代码锚是否已变 (recall 截断后的出口)' },
  { chatName: 'omd_web', mcpName: 'omd_web', promptSnippet: 'omd_web(query, k?, crawl?, mode?) — 搜+抓网页, 零 LLM, 全文存盘 (无 provider 不挂)' },
  { chatName: 'omd_distill', mcpName: 'omd_distill', promptSnippet: 'omd_distill(text, question?, lens?, url?, title?) — 吃已有原文蒸馏洞察' },
  { chatName: 'omd_set_key', mcpName: 'omd_set_key', confirmRequired: true, promptSnippet: 'omd_set_key(provider, key, target?) — 写 API key (凭证写, 每次 ask_user 确认)' },
  { chatName: 'omd_apply_preset', mcpName: 'omd_apply_preset', promptSnippet: 'omd_apply_preset(presetId) — 套角色模型预设 (.env + config.json)' },
  { chatName: 'omd_set_role', mcpName: 'omd_set_role', promptSnippet: 'omd_set_role(role, coord) — 覆盖单座位模型坐标 (改敏感座报备, 绝不偷降档)' },
  { chatName: 'omd_models_auto', mcpName: 'omd_models_auto', promptSnippet: 'omd_models_auto() — 按渠道经济学自动分配各节点模型并存盘' },
  { chatName: 'omd_register_provider', mcpName: 'omd_register_provider', confirmRequired: true, promptSnippet: 'omd_register_provider(id, baseUrl, keyEnv, api?, models?) — 登记 provider (凭证写, 每次确认)' },
  { chatName: 'omd_set_model', mcpName: 'omd_set_model', promptSnippet: 'omd_set_model(coord, maxTokens?, contextWindow?) — 更新模型参数' },
  { chatName: 'omd_config_status', mcpName: 'omd_config_status', promptSnippet: 'omd_config_status() — 查引擎角色→模型绑定 + 凭证状态 + 全座位自检 (只读)' },
  { chatName: 'omd_toggle_hud', mcpName: 'omd_toggle_hud', promptSnippet: 'omd_toggle_hud(on) — 装/卸 HUD 状态行' },
  { chatName: 'omd_primitive', mcpName: 'omd_primitive', promptSnippet: 'omd_primitive(primitive, params, model?) — 直接跑一个控制流原语' },
  { chatName: 'omd_shapes', mcpName: 'omd_shapes', promptSnippet: 'omd_shapes(id?) — 取图式 (触发条件/什么时候别用/步骤)' },
];

/**
 * @param tools assembleOmdMcpTools() 的产物(改名表已应用)。
 */
/**
 * L3/solve 的写死预算 (S-C, 契约 C-3): 旋钮不暴露给模型 —— 模型改不了的旋钮才是闸。
 * 值的依据: budgetMinutes=30 承心跳单次调用先例 (`--budget-minutes 30`);
 * budgetTokens=3M ≈ e0bd80a1 事故 contract 相位均值 2.1M/run 的 1.4×
 * (单次 solve 超过它基本是失控不是大活)。超预算 outcome='budget-exhausted' (词表已有)。
 */
export const SOLVE_BUDGET_TOKENS = 3_000_000;
export const SOLVE_BUDGET_MINUTES = 30;

export function createConductorChatTools(tools: readonly OmdMcpTool[]): AnyOmdTool[] {
  assertSurfaceComplete(tools);
  const runTool = must(tools, 'run');
  const solveTool = must(tools, 'solve');
  const runPlanTool = must(tools, 'dag_run_plan');
  const statusTool = must(tools, 'dag_status');
  const runsTool = must(tools, 'dag_runs');
  const outputTool = must(tools, 'dag_node_output');
  const cancelTool = must(tools, 'dag_cancel');
  const ticketsTool = must(tools, 'map_tickets');
  const plansTool = must(tools, 'omd_plans');
  const recallTool = must(tools, 'memory_recall');
  const historyReadTool = must(tools, 'history_read');
  const historySearchTool = must(tools, 'history_search');

  return [
    textTool(
      'omd_run',
      'Launch a DAG run: conductor plans the task into a graph and fans out executors. Returns runId immediately (fire-and-forget); poll omd_status.',
      'omd_run(task) — 把任务交给引擎规划成图并发执行, 立返 runId',
      Type.Object({ task: Type.String({ description: 'Task for the engine conductor to plan and execute' }) }),
      (p) => invoke(runTool, { task: p.task }),
    ),
    textTool(
      'omd_solve',
      'Autonomous goal loop: research → spec → execute → verify → 1 repair round. Returns runId.',
      'omd_solve(goal) — 自主环 (research→spec→execute→verify), 立返 runId',
      Type.Object({ goal: Type.String({ description: 'The goal to pursue autonomously' }) }),
      // C-3: 预算写死透传 (schema 刻意不暴露 —— per-lane 预算是闸不是旋钮)。
      (p) => invoke(solveTool, { goal: p.goal, budgetTokens: SOLVE_BUDGET_TOKENS, budgetMinutes: SOLVE_BUDGET_MINUTES }),
    ),
    textTool(
      'omd_run_plan',
      'Execute a pre-built ConductorPlan JSON directly — skips the conductor planning segment. For small decided tasks (N<=2, fix already stated). Invalid plan JSON is rejected loudly by parsePlan. Returns runId (fire-and-forget).',
      'omd_run_plan(plan, task?) — 预构造 plan 直接执行, 跳过规划段 (owner 2026-08-09 裁 C: 审计链零损失, 调度税砍大头)',
      Type.Object({
        plan: Type.String({ description: 'ConductorPlan JSON string (validated by parsePlan)' }),
        task: Type.Optional(Type.String({ description: 'Task description (escalation re-planning seed)' })),
      }),
      (p) => invoke(runPlanTool, { plan: p.plan, ...(p.task ? { task: p.task } : {}) }),
    ),
    textTool(
      'omd_status',
      'Status of a DAG run by runId (live progress ASCII while running).',
      'omd_status(runId) — 查 run 进度',
      Type.Object({ runId: Type.String() }),
      (p) => invoke(statusTool, { runId: p.runId }),
    ),
    textTool(
      'omd_runs',
      'List recent DAG runs (memory + disk checkpoints merged).',
      'omd_runs() — 列最近的 run',
      Type.Object({}),
      () => invoke(runsTool, {}),
    ),
    textTool(
      'omd_node_output',
      'Full output text of one node in a run (paged via offset).',
      'omd_node_output(runId, nodeId) — 读某节点输出全文',
      Type.Object({
        runId: Type.String(),
        nodeId: Type.String(),
        offset: Type.Optional(Type.Number({ description: 'Char offset (default 0)' })),
      }),
      (p) => invoke(outputTool, { runId: p.runId, nodeId: p.nodeId, ...(p.offset !== undefined ? { offset: p.offset } : {}) }),
    ),
    textTool(
      'omd_cancel',
      'Cooperatively stop a running DAG run (in-flight nodes finish; resumable).',
      'omd_cancel(runId, reason?) — 叫停一个 run',
      Type.Object({ runId: Type.String(), reason: Type.Optional(Type.String()) }),
      (p) => invoke(cancelTool, { runId: p.runId, ...(p.reason ? { reason: p.reason } : {}) }),
    ),
    textTool(
      'omd_map_tickets',
      'Pathfinder decision-map frontier: tickets ready to work, blocked set, suggestions.',
      'omd_map_tickets(slug?) — 看决策地图前沿票',
      Type.Object({ slug: Type.Optional(Type.String({ description: 'Map slug (omit = the single open map)' })) }),
      (p) => invoke(ticketsTool, p.slug ? { slug: p.slug } : {}),
    ),
    textTool(
      'omd_plans',
      'Plan library: task families with version chains and win/loss records (best-known plans).',
      'omd_plans() — 看 plan 图库 (family/版本/战绩)',
      Type.Object({}),
      () => invoke(plansTool, {}),
    ),
    textTool(
      'omd_recall',
      'Recall facts from omd self-memory (semantic + lexical hybrid). Returns ranked hits with confidence and source. A hit is a lead, not ground truth — verify low-confidence hits against the real source before relying on them.',
      'omd_recall(query, k?) — 查既有记忆 (召回是线索不是真理, 低 confidence 落到依据前先核真源)',
      Type.Object({
        query: Type.String({ description: 'Natural-language search query' }),
        k: Type.Optional(Type.Number({ description: 'Max results (default 10)' })),
      }),
      (p) => invoke(recallTool, { query: p.query, k: p.k ?? 10 }),
    ),
    textTool(
      'history_read',
      'Read paged original messages hidden by one compaction entry.',
      'history_read(compactionEntryId, offset?) — 读取压缩遮蔽的原文',
      Type.Object({
        compactionEntryId: Type.String(),
        offset: Type.Optional(Type.Number({ description: 'Transcript character offset (default 0)' })),
      }),
      (p) => invoke(historyReadTool, { compactionEntryId: p.compactionEntryId, ...(p.offset !== undefined ? { offset: p.offset } : {}) }),
    ),
    textTool(
      'history_search',
      'Search original messages hidden by compaction entries in this session.',
      'history_search(query, compactionEntryId?, limit?) — 搜索压缩遮蔽的原文',
      Type.Object({
        query: Type.String(),
        compactionEntryId: Type.Optional(Type.String()),
        limit: Type.Optional(Type.Number({ description: 'Maximum snippets to return' })),
      }),
      (p) =>
        invoke(historySearchTool, {
          query: p.query,
          ...(p.compactionEntryId !== undefined ? { compactionEntryId: p.compactionEntryId } : {}),
          ...(p.limit !== undefined ? { limit: p.limit } : {}),
        }),
    ),
    // ── 扩展 30 (本体 ⊇ MCP, owner 2026-08-19) ──────────────────────────────
    ...EXTRA_CONDUCTOR_TOOLS.flatMap((s) => {
      // 部分装配面 (最小 boot / 测试) 或条件挂载缺件 (omd_web 无 search provider) → 跳过,
      // 不抛 —— 只有核心 12 用 must() 硬性要求; 扩展工具是「有就给, 没有就少」。
      if (!tools.some((x) => x.name === s.mcpName)) return [];
      return [
        wrapMcpTool(s.chatName, s.mcpName, tools, {
          ...(s.confirmRequired ? { confirmRequired: true } : {}),
          ...(s.promptSnippet ? { promptSnippet: s.promptSnippet } : {}),
        }),
      ];
    }),
  ];
}
