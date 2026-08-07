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
 * @param tools assembleOmdMcpTools() 的产物(改名表已应用)。
 */
export function createConductorChatTools(tools: readonly OmdMcpTool[]): AnyOmdTool[] {
  const runTool = must(tools, 'run');
  const solveTool = must(tools, 'solve');
  const statusTool = must(tools, 'dag_status');
  const runsTool = must(tools, 'dag_runs');
  const outputTool = must(tools, 'dag_node_output');
  const cancelTool = must(tools, 'dag_cancel');
  const ticketsTool = must(tools, 'map_tickets');
  const plansTool = must(tools, 'omd_plans');
  const recallTool = must(tools, 'memory_recall');

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
      (p) => invoke(solveTool, { goal: p.goal }),
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
  ];
}
