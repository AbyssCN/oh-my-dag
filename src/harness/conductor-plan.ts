/**
 * src/harness/conductor-plan —— conductor 规划的**纯件** (omd 本体所有, 无 conduct/PG/dag 依赖)。
 *
 * 从 src/conductor/plan.ts 抽出 (依赖方向矫正): plan schema + system prompt + JSON 解析校验 这些
 * **纯规划件理应属 omd 本体** —— executor-dag (omd 现场 fan-out) 与 conductor/plan (宿主宏观引擎 conduct
 * 路径) 都消费它们。抽进 omd 后: valinor 自包含 (executor-dag 不再跨 import daemon 层 conductor),
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

/**
 * MapSpec (U1 动态扇出) —— executor:'map' 节点的运行时展开规格。
 * lister 跑出运行时数组 → per-element 模板展开成 N 个 applicative 子节点 (STUDY Q3)。
 * SDD: docs/plan/SDD-2026-07-11-omd-dynamic-fanout-map-node.md。
 * template 用宽松 record (同 PlanNode passthrough 的弱模型容忍哲学): 深校验在插入期 (P1);
 * 此处只钉 INV-U5 (禁嵌套 map, superRefine 于 PlanNode) + 结构必填字段。
 */
const MapSpec = z
  .object({
    /** lister: 跑出运行时数组的子步 (agent/leaf/command)。其结构化输出须含数组。 */
    lister: z
      .object({
        goal: z.string().optional(),
        executor: z.enum(['agent', 'leaf', 'command']).optional(),
        command: z.string().optional(),
        agent: z.string().optional(),
        output_schema: z.record(z.string(), z.unknown()).optional(),
      })
      .passthrough(),
    /** lister 输出里"作为待扇出数组"的键 (如 'modules')。取到的必须是数组 (运行时校验)。 */
    over: z.string().min(1),
    /** 每个元素在模板里绑定的变量名 (模板 goal 用 ${itemVar} 插值)。 */
    itemVar: z.string().min(1),
    /** 元素稳定身份的取键路径 (如 'path')。缺省 → 元素内容 hash。★ 决定 resume 稳定性 (INV-U2)。 */
    keyBy: z.string().optional(),
    /** per-element 子节点模板 (node-shaped; executor:'map' 被 INV-U5 拒)。 */
    template: z.record(z.string(), z.unknown()),
    /** 硬顶,防量级膨胀 (INV-U4)。缺省见 map-expand DEFAULT_MAX_ITEMS=64。 */
    maxItems: z.number().int().positive().optional(),
    /** 本 map 扇出并发上限 (缺省继承 config.maxFanout)。 */
    concurrency: z.number().int().positive().optional(),
  })
  .passthrough();

const PlanNode = z
  .object({
    // 'agent' = 宿主宏观引擎 roster 概念 (dispatch 用); omd 本体 executor-dag 按 executor/model 分流, 不用它。
    // 弱 conductor 常在 synth/command 节点漏填 → 设 optional (弱模型不可信原则: schema 宽容它不需要的字段)。
    // 宿主宏观引擎 路径 (toWorkflowYaml) 缺省补 'unassigned'。
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
    // 'map' (U1) = 运行时动态扇出节点 (STUDY Q3): lister → per-element 展开成 applicative 子节点。
    executor: z.enum(['agent', 'leaf', 'command', 'map']).optional(),
    /** executor='command' 时要跑的确定性 CLI (如 'codegraph trace X Y')。经 fail-closed 闸 + 白名单。 */
    command: z.string().optional(),
    /** executor='map' 时的动态扇出规格 (与 executor:'map' 互为 required, superRefine 校验)。 */
    map: MapSpec.optional(),
    // ── SDD 0013 S1 约束选择节点 (与自由 node 并存, SEL-5 BC) ──
    // kind:'primitive' = 从 vetted 菜单选原语 + 填 params, 非自由画 node-graph。
    // 此处只钉"选择 shape"(primitive ∈ 5 枚举 + params 存在); 各原语 params 深校验在 compile 期
    // 经 primitive-registry.paramsSchema (SEL-1)。enum 与 primitive-registry.PrimitiveId 同步 (改一处核两处)。
    /** kind:'primitive' 标记此节点走约束选择分支 (executor-dag runPrimitiveNode)。 */
    kind: z.literal('primitive').optional(),
    /** 选中的原语 id (S1/S2/S4/S6 全集,与 primitive-registry.PrimitiveId 同步)。 */
    primitive: z
      .enum([
        'parallel', 'pipeline', 'loop-until', 'verify', 'judge', 'discovery', 'iterate',
        'tournament', 'router', 'race', 'escalation', 'saga', 'escape-hatch',
      ])
      .optional(),
    /** 该原语的参数 (深校验在 compile 期, 承弱模型不可信)。 */
    params: z.record(z.string(), z.unknown()).optional(),
    /** true = 此节点 OUTPUT 即创意交付物 (文案/best-of-n 候选/用户可见 prose) → 关 caveman 压缩护质量。 */
    creative: z.boolean().optional(),
    /**
     * 专家框定 (persona conditioning): 一行专家身份, 把弱 executor 从通用区拉进专家区
     * (搬概率质量, 同 fanout/best-of-n/distill 的注入技法)。仅对吃专家视角的 leaf 设
     * (research/judgement/design/drafting); 机械/file/command 节点省略。abstraction 框架由强模型手写,
     * 弱 conductor 不自动生成 (防 slop)。
     */
    persona: z.string().optional(),
    /**
     * Agent 模板引用 (agent-templates 注册表按名选卡): 执行期把卡片 body (方法论+检查单+输出纪律)
     * 注入 leaf prompt 前缀 — 模板管深度, persona 管任务角度 (一行调味), 二者叠加。卡片可携 model
     * (TPL-3: node.model 显式仍最高优先)。未知名规划期被 parsePlan(knownTemplates) 拒 (TPL-2)。
     */
    template: z.string().optional(),
    model: z.string().optional(),
    leaf: z.record(z.string(), z.unknown()).optional(),
    on_failure: z.enum(['retry', 'complete-then-retry', 'escalate', 'pause']).optional(),
    max_retry: z.number().int().optional(),
    fallback: z.enum(['human', 'reactive']).optional(),
  })
  .passthrough()
  // U1 map 节点交叉校验: map spec ⇔ executor:'map' 互为 required + INV-U5 禁嵌套 map。
  .superRefine((node, ctx) => {
    const isMap = node.executor === 'map';
    if (isMap && !node.map)
      ctx.addIssue({ code: 'custom', message: "executor:'map' 需 map spec", path: ['map'] });
    if (node.map && !isMap)
      ctx.addIssue({ code: 'custom', message: "map spec 需 executor:'map'", path: ['executor'] });
    // INV-U5: 模板节点禁再为 map (禁运行时无界递归展开)。
    if (node.map && (node.map.template as { executor?: string })?.executor === 'map')
      ctx.addIssue({
        code: 'custom',
        message: 'INV-U5: map 模板禁再为 map (v1 禁嵌套动态扇出)',
        path: ['map', 'template', 'executor'],
      });
    // SDD 0013 SEL-1: primitive 节点 kind ⇔ primitive ⇔ params 互为 required (params 深校验在 compile 期)。
    if (node.kind === 'primitive') {
      if (!node.primitive)
        ctx.addIssue({ code: 'custom', message: "kind:'primitive' 需 primitive 字段", path: ['primitive'] });
      if (node.params === undefined)
        ctx.addIssue({ code: 'custom', message: "kind:'primitive' 需 params 字段", path: ['params'] });
    }
    if (node.primitive && node.kind !== 'primitive')
      ctx.addIssue({ code: 'custom', message: "primitive 字段需 kind:'primitive'", path: ['kind'] });
  });

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
export function conductorSystemPrompt(
  opts: { agents?: string[]; templates?: { name: string; description: string }[] } = {},
): string {
  const roster = opts.agents?.length
    ? `Available executor agents (use ONLY these as node "agent"): ${opts.agents.join(', ')}.`
    : 'Use the SAMPO roster as node "agent" ids (sibelius / lönnrot / vaaka / kaiku / aalto).';
  // agent 模板注册表段 (只付每卡一行 description; body 执行期才注入 leaf — 规划上下文零 body 成本)。
  const templateSection = opts.templates?.length
    ? [
        '',
        'Agent template cards (field "template", optional — a registry of frozen specialist role cards):',
        'A template injects a vetted role card (expert method + domain checklist + output discipline) into',
        "the executor's prompt at run time — depth you do NOT have to author. Registry (use ONLY these names):",
        ...opts.templates.map((t) => `- "${t.name}": ${t.description}`),
        'When a node\'s job matches a card, SET "template" instead of hand-writing that depth; you may still',
        'add a one-line "persona" ON TOP for the task-specific angle (template = depth, persona = angle).',
        'Do NOT invent template names — an unknown name makes the whole plan INVALID. A card may pin the',
        'node\'s model; omit "model" unless you must override it. Mechanical/command nodes need no template.',
      ]
    : [];
  return [
    'You are the CONDUCTOR — the L2 orchestrator of the omd agent runtime. You plan, coordinate,',
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
    'Minimize critical-path DEPTH (levels = serial barriers; a weak no-think planner over-stratifies — keep nodes fine but FLAT):',
    '- depends_on ONLY for a REAL data/file dependency the node consumes — NEVER to impose tidy ordering.',
    '  Two nodes with no data dependency between them MUST be siblings (same level), even if one "feels" logically later.',
    '- Collapse the verify tail into ONE command node: chain "bun run tsc --noEmit && bun test" — do NOT emit',
    '  separate typecheck-level → test-level → review-level. One gate, one node, not three stacked levels.',
    '- After planning, scan the longest dependency chain: if a node sits on a deep level but consumes nothing',
    '  from the levels above it, LIFT it up to run in parallel. Keep the graph WIDE (many siblings) and SHALLOW.',
    '',
    'Parallel-safety (siblings run concurrently — this GATES the WIDE-over-DEEP rule above):',
    '- Make two nodes siblings (no dep between them) ONLY if they touch disjoint files, write distinct',
    '  output_path, and share no migration / DB fixture / scarce resource (port, provider rate limit).',
    '  If any collide, serialize them via depends_on — a wrong parallel edge corrupts files or double-writes.',
    '- Serialize hotspots, parallelize slices: schema/migrations, hot shared routes, and contracts are',
    '  collision-prone → chain them (or route through ONE owner node); isolated modules/files fan out wide.',
    '',
    'Executor kind per node (field "executor"):',
    '- "leaf"  = a single-shot model call, NO tools. Use for generation / research / judgement / drafting.',
    '- "agent" = a tool-using sub-agent (read / edit / write / bash). Use ONLY for nodes that must touch',
    '            files or run commands; scope each agent node to ONE atomic artifact (e.g. a single file).',
    '- "command" = run a deterministic CLI (field "command", e.g. "codegraph trace A B") with NO model.',
    '            CHEAPEST — use for indexed lookups / scanners / tool retrieval / typecheck+test self-verify.',
    '            You MAY chain sequential verification steps with && (e.g. "bun run tsc --noEmit && bun test");',
    '            each link is gated independently. Other shell operators (; | $() ` redirects) are REJECTED.',
    '- "map"  = runtime dynamic fan-out (field "map"): a lister enumerates an array AT RUNTIME, then a',
    '            per-element template spawns one child per item. Use when the work-list is unknown until run',
    '            time (see the "Runtime work-list" section below). This is the ONLY node kind that expands itself.',
    'Default to "leaf" unless the node needs tools/CLI. A non-map node never spawns DAG sub-nodes itself.',
    'HARD RULE — file producers MUST be "agent": if a node CREATES or MODIFIES any file (its job is to',
    '  implement/write/生成 a path like src/x.ts), it MUST set executor:"agent" AND output_type:"file"',
    '  (set output_path too). A "leaf" CANNOT touch the filesystem — a leaf told to write a file silently',
    '  produces NOTHING (returns text, node reports done, no artifact). NEVER use "leaf" for an',
    '  implementation/build node. "Default to leaf" applies only to text-deliverable nodes (analysis/design/research).',
    '',
    'Node goal phrasing (genre): when the task asks to DESIGN / BREAK DOWN / DESCRIBE / PLAN / ANALYZE',
    '(the deliverable is TEXT, not a side effect), each node\'s "goal" must PRODUCE that piece of content',
    '— e.g. "describe step 2 / design the review for X / list the checks" — NEVER "execute / perform / run',
    'step X". Action-verb goals belong only to executor:agent/command nodes that genuinely touch files or',
    'run tools; phrasing a leaf goal as "execute …" makes the model fake-perform it and fabricate data.',
    '',
    'Runtime work-list → executor:"map" (do NOT hallucinate a command that enumerates AND processes):',
    'When the SET of items to process is UNKNOWN at plan time — audit EACH module, research EACH lens,',
    'fix EACH failing test, process EACH discovered file — you cannot name them now. Do NOT collapse the',
    'fan-out into one fabricated command (e.g. a made-up "tools/audit-all.ts"): that invents a tool that',
    'does not exist. Emit ONE node with executor:"map": a "lister" sub-step produces the array AT RUNTIME,',
    'and a per-element "template" fans out one child node per item. Shape (field "map"):',
    '  { "lister": { "goal"?, "executor"?: "leaf"|"agent"|"command", "command"?, "output_schema"? },',
    '    "over": "<array key the lister returns>", "itemVar": "<var the template interpolates, e.g. item>",',
    '    "keyBy"?: "<stable-identity path for resume, e.g. path>", "template": { <a normal node, NOT a map> },',
    '    "maxItems"?: number }.',
    '  Prefer a lister that REUSES indexed infra (executor:"command" over codegraph / scanners) over a model',
    '  guess. Child count = the REAL runtime item count; resume re-runs only changed items (via keyBy). The',
    '  template must NOT itself be executor:"map" (no nested runtime fan-out).',
    '- Research / 审议 fan-out (map over expert LENSES): the per-element template must carry the FROZEN',
    '  RESEARCH_LENS_TEMPLATE 5-stage structure (persona + distinct sub-angles → per-lens reduce → framing',
    '  synthesis → judge panel → graft) — REFERENCE that structure, do NOT re-derive it ad hoc (re-deriving',
    '  drops the quality stages and risks hallucinating model names). One decomposer: you, referencing it.',
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
    ...templateSection,
    '',
    'Constrained control-flow primitives (field "kind":"primitive" — OPTIONAL, prefer over hand-wiring):',
    'When a node\'s job matches a known control-flow SHAPE, emit ONE primitive node instead of hand-drawing',
    'the sub-graph. You pick the primitive + its params ONLY — the loop/branch/stop/scoring logic is OWNED',
    'by the runtime, never by you. Menu (pick by shape, fill params; do NOT put a "model" field in params):',
    '- "parallel"   {goals:string[], persona?}         — N independent sibling investigations, run at once.',
    '- "pipeline"   {items:string[], stages:[{goal}]}  — each item flows through the SAME ordered stages.',
    '- "loop-until" {stepGoal, target, maxIterations?}  — repeat a step until `target` items accumulate.',
    '- "verify"     {claim, n?}                         — spawn n skeptics to adversarially refute a claim.',
    '- "judge"      {attempts, attemptGoal, scoreCriterion} — N independent attempts, keep the best-scored.',
    '- "discovery"  {roundGoal, over?, keyBy?, maxRounds}   — repeat a finder until K dry rounds (find-all, unknown count).',
    '- "iterate"    {stepGoal, convergeCriterion, maxRounds?} — refine one output until a judge says it converged.',
    '- "tournament" {attempts, attemptGoal, scoreCriterion, bracketSize?} — large candidate pool → bracket elimination.',
    '- "router"     {classifyGoal, branches:[{label,goal}]}  — classify first, then run ONLY the matching branch.',
    '- "race"       {goals:string[]}                         — run redundant alternatives, take the first to succeed.',
    '- "escalation" {levels:[{goal}], acceptCriterion}       — try levels cheap→strong until one is accepted.',
    '- "saga"       {steps:[{goal, compensateGoal}]}         — multi-step; on mid-failure, run compensations in reverse.',
    'A primitive node uses "depends_on" like any node; omit executor/goal for it. If no primitive fits the',
    'shape, just use ordinary leaf/agent/command nodes (the free graph is always valid).',
    '("escape-hatch" is a gated last-resort imperative sequence — OFF by default; do NOT reach for it.)',
    roster,
    '',
    'Output STRICTLY one JSON object, no prose, matching:',
    '{ "name": string, "description"?: string,',
    '  "nodes": { "<node_id>": { "agent": string, "skill"?: string, "goal"?: string, "persona"?: string, "template"?: string,',
    '    "args"?: object, "depends_on"?: string[], "executor"?: "leaf"|"agent"|"command"|"map", "command"?: string, "creative"?: boolean,',
    '    "map"?: { "lister": object, "over": string, "itemVar": string, "keyBy"?: string, "template": object, "maxItems"?: number },',
    '    "postcondition"?: { "method"?: "structural"|"code"|"llm-judge"|"human", "threshold"?: number },',
    '    "output_type"?: "structured"|"file"|"git"|"none",',
    '    "kind"?: "primitive", "primitive"?: "parallel"|"pipeline"|"loop-until"|"verify"|"judge"|"discovery"|"iterate"|"tournament"|"router"|"race"|"escalation"|"saga"|"escape-hatch", "params"?: object } } }',
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

/**
 * Parse + validate a model reply into a plan. Returns ok|error (never throws).
 * opts.knownTemplates 给则校验每个 node.template (含 map 子模板) ∈ 注册表 — 未知名 = 整 plan 无效
 * (TPL-2: 拒在规划层, 驱动 conductor 重试; enum 级防幻觉, 同 primitive-registry .strict() 手法)。
 */
export function parsePlan(
  text: string,
  opts: { knownTemplates?: ReadonlySet<string> } = {},
): { ok: true; plan: ConductorPlan } | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(extractPlanJson(text));
  } catch (e) {
    return { ok: false, error: `not JSON: ${(e as Error).message}` };
  }
  const res = PlanSchema.safeParse(raw);
  if (!res.success) return { ok: false, error: res.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
  if (opts.knownTemplates) {
    const unknown = new Set<string>();
    for (const node of Object.values(res.data.nodes)) {
      if (node.template && !opts.knownTemplates.has(node.template)) unknown.add(node.template);
      const mapChildTpl = (node.map?.template as { template?: unknown } | undefined)?.template;
      if (typeof mapChildTpl === 'string' && !opts.knownTemplates.has(mapChildTpl)) unknown.add(mapChildTpl);
    }
    if (unknown.size > 0) {
      return {
        ok: false,
        error: `unknown template(s): ${[...unknown].join(', ')} — "template" 只能取: ${[...opts.knownTemplates].join(', ')}`,
      };
    }
  }
  return { ok: true, plan: res.data };
}
