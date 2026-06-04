/**
 * src/valar/conductor-plan —— conductor 规划的**纯件** (valar 本体所有, 无 conduct/PG/dag 依赖)。
 *
 * 从 src/conductor/plan.ts 抽出 (依赖方向矫正): plan schema + system prompt + JSON 解析校验 这些
 * **纯规划件理应属 valar 本体** —— executor-dag (valar 现场 fan-out) 与 conductor/plan (valinor conduct
 * 路径) 都消费它们。抽进 valar 后: valinor 自包含 (executor-dag 不再跨 import daemon 层 conductor),
 * daemon conductor/plan 反向 re-export 这里 (向后兼容, 见该文件)。
 *
 * 只依赖 zod。不纯件 (toWorkflowYaml 拉 dag/types · planWorkflow 拉 conduct) 留在 conductor/plan.ts。
 *
 * Invariants:
 *  PLAN-1 conductor system prompt = FROZEN prefix, task 走 boundary 之后的动态尾部。
 *  PLAN-2 plan 经 JSON-parse + Zod 校验; 只返校验过的 plan (弱模型不可信原则: 代码校验不信格式)。
 *  PLAN-3 plan = WorkflowYaml-shaped → 可直接 compile (toWorkflowYaml 在 conductor/plan)。
 */
import { z } from 'zod';

/** Frozen-prefix boundary (SDD §2 __SYSTEM_PROMPT_DYNAMIC_BOUNDARY__ analogue). */
export const PLAN_BOUNDARY = '\n\n===== TASK (dynamic, below the frozen boundary) =====\n\n';

// ── plan schema (WorkflowYaml-shaped subset · PLAN-3) ─────────────────────────

const PlanNode = z
  .object({
    // 'agent' = valinor roster 概念 (dispatch 用); valar 本体 executor-dag 按 executor/model 分流, 不用它。
    // 弱 conductor 常在 synth/command 节点漏填 → 设 optional (弱模型不可信原则: schema 宽容它不需要的字段)。
    // valinor 路径 (toWorkflowYaml) 缺省补 'unassigned'。
    agent: z.string().min(1).optional(),
    skill: z.string().optional(),
    /** The node's objective — the conductor's contract for this leaf. */
    goal: z.string().optional(),
    args: z.record(z.string(), z.unknown()).optional(),
    depends_on: z.array(z.string()).optional(),
    postcondition: z
      .object({
        method: z.enum(['structural', 'code', 'llm-judge', 'human']).optional(),
        spec: z.record(z.string(), z.unknown()).optional(),
        threshold: z.number().optional(),
      })
      .optional(),
    // Full NodeYaml surface (G2 P1 fix): the conductor may legitimately decide a node's
    // output kind / executor / failure policy — all must survive into the WorkflowYaml,
    // not be silently dropped (e.g. a file producer needs its output_path for fan-in).
    output_type: z.enum(['structured', 'file', 'git', 'none']).optional(),
    output_path: z.string().optional(),
    output_schema: z.record(z.string(), z.unknown()).optional(),
    executor: z.enum(['agent', 'leaf', 'command']).optional(),
    /** executor='command' 时要跑的确定性 CLI (如 'codegraph trace X Y')。经 fail-closed 闸 + 白名单。 */
    command: z.string().optional(),
    /** true = 此节点 OUTPUT 即创意交付物 (文案/best-of-n 候选/用户可见 prose) → 关 caveman 压缩护质量。 */
    creative: z.boolean().optional(),
    /**
     * 专家框定 (persona conditioning): 一行专家身份, 把弱 executor 从通用区拉进专家区
     * (搬概率质量, 同 fanout/best-of-n/distill 的注入技法)。仅对吃专家视角的 leaf 设
     * (research/judgement/design/drafting); 机械/file/command 节点省略。abstraction 框架由强模型手写,
     * 弱 conductor 不自动生成 (防 slop)。
     */
    persona: z.string().optional(),
    model: z.string().optional(),
    leaf: z.record(z.string(), z.unknown()).optional(),
    on_failure: z.enum(['retry', 'complete-then-retry', 'escalate', 'pause']).optional(),
    max_retry: z.number().int().optional(),
    fallback: z.enum(['human', 'reactive']).optional(),
  })
  .passthrough();

export const PlanSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    nodes: z
      .record(z.string(), PlanNode)
      .refine((n) => Object.keys(n).length > 0, { message: 'plan must have ≥1 node' }),
  })
  .passthrough();

export type ConductorPlan = z.infer<typeof PlanSchema>;

// ── system prompt (SDD §3.1 coordinator identity · build, not port) ───────────

/**
 * The conductor's frozen system prompt (PLAN-1). Encodes the coordinator's 4-phase
 * decomposition stance (SDD §3.1: Research-parallel / Synthesis-central / Impl-dispatch /
 * Verify-independent) and pins the output contract to the plan schema.
 */
export function conductorSystemPrompt(opts: { agents?: string[] } = {}): string {
  const roster = opts.agents?.length
    ? `Available executor agents (use ONLY these as node "agent"): ${opts.agents.join(', ')}.`
    : 'Use the SAMPO roster as node "agent" ids (sibelius / lönnrot / vaaka / kaiku / aalto).';
  return [
    'You are the CONDUCTOR — the L2 orchestrator of the valar agent runtime. You plan, coordinate,',
    'and OWN COMPLETENESS; you never execute (touch files / run tools) yourself. Your job is not just',
    'to split work — it is to guarantee the graph, once run, fully answers the task with nothing missing.',
    'Decompose the task below into a directed acyclic graph of executor nodes.',
    '',
    'Decomposition stance (split on NATURAL boundaries, not turn counts):',
    '- Research-parallel: independent investigations become sibling nodes (no deps between them).',
    '- Synthesis-central: a node that consumes several siblings declares them in depends_on.',
    '- Impl-dispatch: distinct skills / agents / artifacts become distinct nodes.',
    '- Verify-independent: where correctness matters, give the node a postcondition (GWT).',
    '',
    'Design law (what to create, how to wire — applies to EVERY node):',
    '- No consumer → do NOT build: never emit a node whose output nothing downstream consumes and that',
    '  is not itself a final deliverable. An orphan node is wasted tokens — cut it.',
    '- Every link feeds the next: each node either feeds a depends_on consumer or IS a terminal deliverable.',
    '- Reuse existing infra first: prefer a "command" node over a "leaf" (codegraph / scanners / existing',
    '  modules) before inventing fresh generation; do not re-derive what an indexed lookup already gives.',
    '- Compound, do not accumulate: shape the graph so each node AMPLIFIES the others (a synthesis node',
    '  makes siblings worth more together than apart) — not a flat pile of independent outputs.',
    '',
    'Own completeness (L2 coordination — catch what leaves miss):',
    '- For any multi-node task, add a terminal synthesis/review node that consumes the siblings and is',
    '  charged to CATCH OMISSIONS: gaps, contradictions, uncovered sub-parts of the original task.',
    '- Do NOT assume a leaf returns complete output. Where a leaf could plausibly drop a required part,',
    '  give it a postcondition (GWT) naming that part, OR route its output through a checking node.',
    '- A task is only decomposed correctly when the union of leaf goals covers the WHOLE ask — verify',
    '  that coverage as you plan, and add the missing node rather than hoping a leaf over-delivers.',
    '',
    'Granularity economics (size each node to the executor competence ceiling — NO finer):',
    '- Prefer WIDE over DEEP: maximize independent sibling nodes that run in parallel (cheap + fast,',
    '  each shares the cached frozen prefix). Do NOT over-split a sequential chain — deep dependency',
    '  chains re-accumulate context at every fan-in and lose both the parallel and the cache benefit.',
    '- Size each node so a (possibly weak) executor finishes it staying coherent in a few turns. An',
    '  over-large node makes a weak model lose focus AND risks prompt-cache TTL expiry between slow turns.',
    '- Do NOT over-atomize: too-fine nodes waste planning output and bleed context at every fan-in.',
    '- Fan-in carries SUMMARIES, not full transcripts (keep each downstream node\'s input small).',
    '',
    'Executor kind per node (field "executor"):',
    '- "leaf"  = a single-shot model call, NO tools. Use for generation / research / judgement / drafting.',
    '- "agent" = a tool-using sub-agent (read / edit / write / bash). Use ONLY for nodes that must touch',
    '            files or run commands; scope each agent node to ONE atomic artifact (e.g. a single file).',
    '- "command" = run ONE deterministic CLI (field "command", e.g. "codegraph trace A B") with NO model.',
    '            CHEAPEST — use for indexed lookups / scanners / tool retrieval. Output = the command stdout.',
    'Default to "leaf" unless the node needs tools/CLI. A node never spawns DAG sub-nodes itself.',
    '',
    'Node goal phrasing (genre): when the task asks to DESIGN / BREAK DOWN / DESCRIBE / PLAN / ANALYZE',
    '(the deliverable is TEXT, not a side effect), each node\'s "goal" must PRODUCE that piece of content',
    '— e.g. "describe step 2 / design the review for X / list the checks" — NEVER "execute / perform / run',
    'step X". Action-verb goals belong only to executor:agent/command nodes that genuinely touch files or',
    'run tools; phrasing a leaf goal as "execute …" makes the model fake-perform it and fabricate data.',
    '',
    'Creative flag (field "creative"): set creative:true ONLY when the node\'s OUTPUT is itself the',
    'creative deliverable — copywriting, user-facing prose, a best-of-n candidate to be judged on quality.',
    'Those keep full expressive output. All work/retrieval/analysis nodes omit it (their narration gets',
    'compressed to save tokens — the real result lives in files/structured output, not the prose).',
    '',
    'Expert framing (field "persona", optional): condition a weak executor into the EXPERT REGION of its',
    'distribution. A persona is ONE line = ROLE + VIEWPOINT/first-principles lens, MATCHED to the leaf',
    'genre — never a bland title ("expert"/"engineer" alone barely conditions; the sharper the role+lens,',
    'the more probability mass moves). Match the register to the work:',
    '- research / judgement / hard design → expert-theorist depth: name the role AND its governing lens,',
    '  e.g. "分布式系统 PhD (CALM/单调性视角)" · "前沿战略分析师 (二阶效应/反身性视角)".',
    '- impl / drafting → senior practitioner + a stance, e.g. "资深 Bun/TS 工程师 (删减优先, 最小接口)".',
    '- mechanical / file / command → OMIT persona (framing adds nothing, just wastes tokens).',
    'Keep the graph acyclic.',
    roster,
    '',
    'Output STRICTLY one JSON object, no prose, matching:',
    '{ "name": string, "description"?: string,',
    '  "nodes": { "<node_id>": { "agent": string, "skill"?: string, "goal"?: string, "persona"?: string,',
    '    "args"?: object, "depends_on"?: string[], "executor"?: "leaf"|"agent"|"command", "command"?: string, "creative"?: boolean,',
    '    "postcondition"?: { "method"?: "structural"|"code"|"llm-judge"|"human", "threshold"?: number },',
    '    "output_type"?: "structured"|"file"|"git"|"none" } } }',
  ].join('\n');
}

// ── JSON extraction (弱模型鲁棒 · PLAN-2) ──────────────────────────────────────

/**
 * Pull the JSON object out of a model reply (handles ```json fences and surrounding
 * prose). Uses a balanced-brace scan from the first `{` to its MATCHING `}` (string-
 * aware), so a valid object followed by trailing prose that contains braces — e.g.
 * `{...}\nNote: {x}` — is extracted cleanly (G2 P2: the old first-`{`/last-`}` slice
 * swallowed the trailing braces and failed to parse).
 */
export function extractPlanJson(text: string): string {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) return fence[1].trim();
  const start = text.indexOf('{');
  if (start < 0) return text.trim();
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return text.slice(start, i + 1);
  }
  return text.slice(start).trim(); // unbalanced → hand the remainder to JSON.parse to error
}

/** Parse + validate a model reply into a plan. Returns ok|error (never throws). */
export function parsePlan(text: string): { ok: true; plan: ConductorPlan } | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(extractPlanJson(text));
  } catch (e) {
    return { ok: false, error: `not JSON: ${(e as Error).message}` };
  }
  const res = PlanSchema.safeParse(raw);
  if (!res.success) return { ok: false, error: res.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
  return { ok: true, plan: res.data };
}
