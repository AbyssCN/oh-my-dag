/**
 * src/mcp/tools/compose —— **组合模式的入口** (2026-07-26 owner 定位)。
 *
 * omd 正在从"图是唯一入口"走向"任何 SOTA agent 经 MCP 自由组合"。这一步把两样图内能力
 * 递到图外:
 *
 *   omd_primitive —— 单独跑一个控制流原语 (parallel / judge / verify / tournament / …),
 *                    **不需要先有一张图**。终止/打分/分支逻辑仍归运行时, 调用方只挑形状填参数。
 *   omd_shapes    —— 取图式 (什么时候用某个形状、**什么时候别用**、为什么)。
 *                    组合模式下 conductor 不在场, 这些知识必须够得着, 否则每次从零发明形状。
 *
 * **为什么不新建执行路径**: 原语在图内已经跑得好好的 —— 这里只是把它包成一张**单节点 plan**
 * 交给 runExecutorDagWithPlan。stamp / 闸 / checkpoint / usage 账全部照旧, 零分叉。
 *
 * 这也顺带吸收了一批 xihe script 的形状: xihe-fanout ≈ parallel · xihe-tournament ≈ tournament ·
 * xihe-council 的判优段 ≈ judge。它们当年是 script, 现在是任何 agent 都能调的工具。
 */
import { z } from 'zod';
import type { OmdMcpTool } from '../server';
import type { ConductorPlan } from '../../harness/conductor-plan';
import { GRAPH_SHAPES, shapeById } from '../../harness/shapes';
import { recordDagRun, type DagRecorder } from '../../harness/dag/dag-record';
import { randomUUID } from 'node:crypto';

/** 可从图外直接调的原语 (escape-hatch 刻意不列: 它是 gated 的最后手段, 不该被顺手调到)。 */
const COMPOSABLE = [
  'parallel',
  'pipeline',
  'loop-until',
  'verify',
  'judge',
  'discovery',
  'iterate',
  'tournament',
  'router',
  'race',
  'escalation',
  'saga',
] as const;

/** 每个原语一行说明 —— 进工具 schema, 让调用方在 schema 里就能选对形状。 */
const PRIMITIVE_DOC: Record<(typeof COMPOSABLE)[number], string> = {
  parallel: 'N 路独立调研并发跑 {goals[]}',
  pipeline: '每个 item 走同一串有序阶段 {items[], stages[]}',
  'loop-until': '重复一步直到攒够 target 个 {stepGoal, target, maxIterations?}',
  verify: '派 n 个怀疑者对抗式证伪一个论断 {claim, n?}',
  judge: 'N 次独立尝试取最优 {attempts, attemptGoal, scoreCriterion}',
  discovery: '重复找直到 K 轮无新增 —— 数量未知的找全 {roundGoal, maxRounds}',
  iterate: '打磨一个产出直到裁判说收敛 {stepGoal, convergeCriterion, maxRounds?}',
  tournament: '大候选池走淘汰赛 {attempts, attemptGoal, scoreCriterion, bracketSize?}',
  router: '先分类再只跑命中的那一支 {classifyGoal, branches[]}',
  race: '冗余跑几条, 取第一个成功的 {goals[]}',
  escalation: '便宜→强逐级试, 直到某级被接受 {levels[], acceptCriterion}',
  saga: '多步; 中途失败按逆序跑补偿 {steps[{goal, compensateGoal}]}',
};

export interface ComposeToolDeps {
  /** 注入式执行 (默认真 runExecutorDagWithPlan)。 */
  runPlan: (plan: ConductorPlan, config: Record<string, unknown>) => Promise<{
    results: Record<string, { status: string; output?: string }>;
    usage: unknown;
  }>;
  /** 引擎基础 config (模型坐标 / runner / planFilters …)。 */
  /** 每次调用重解 (INV-MODEL-3 无 boot 冻结) — 见 assemble.buildDefaultConfig。 */
  baseConfig: () => Record<string, unknown>;
  /**
   * 运行留痕 (T6, 2026-08-03)。缺省 = 不记, 也不炸 (同其余入口: 留痕是可选项不是执行前提)。
   *
   * **S0 当时刻意没接这条**, 理由记在交付节里:「它没有 runId, 记进去是无主的账」。
   * 那条理由今天不成立了 —— `dag_run` 早就是**自己生成 runId** 的成例 (`randomUUID`),
   * 而 `entry` 轴要回答的正是"哪个入口在被用"; 一个从不落账的入口在分布里与
   * "没人用这个入口"**长得一模一样**(D-AM 立 `entry` 必填时点名的就是这个形态)。
   */
  recorder?: DagRecorder;
}

/** 把一个原语包成单节点 plan —— 复用图内全部机器, 不新建执行路径。 */
export function primitivePlan(primitive: string, params: Record<string, unknown>, model?: string): ConductorPlan {
  return {
    name: `primitive:${primitive}`,
    nodes: {
      p: {
        kind: 'primitive',
        primitive,
        params,
        ...(model ? { model } : {}),
      },
    },
    outputs: ['p'],
  } as unknown as ConductorPlan;
}

export function createComposeTools(deps: ComposeToolDeps): OmdMcpTool[] {
  return [
    {
      name: 'omd_primitive',
      // D-11: description ≤120 字符 (每次 tools/list 都付这个 context)。原语菜单挪进字段 describe。
      description: '直接跑一个控制流原语, 不必先有图。终止/打分/分支归运行时。2–5 步组合用它; 大扇出走 dag_run。',
      inputSchema: {
        primitive: z.enum(COMPOSABLE).describe(
          `原语 id —— ${Object.entries(PRIMITIVE_DOC).map(([k, v]) => `${k}: ${v}`).join(' · ')}`,
        ),
        params: z
          .record(z.string(), z.unknown())
          .describe('该原语的参数 (schema 由 primitive-registry 强校验, 未知键会被拒)'),
        model: z.string().optional().describe('模型坐标 provider:modelId (省略 = 引擎按档位分配)'),
      },
      handler: (async (args: Record<string, unknown>) => {
        const primitive = String(args.primitive ?? '');
        if (!(COMPOSABLE as readonly string[]).includes(primitive)) {
          return { isError: true, content: [{ type: 'text', text: `未知原语 '${primitive}'; 可选: ${COMPOSABLE.join(', ')}` }] };
        }
        const params = (args.params ?? {}) as Record<string, unknown>;
        const model = typeof args.model === 'string' ? args.model : undefined;
        try {
          // T6 留痕: runId 本地生成 (同 dag_run 成例) —— 这个入口没有三段式 runId, 但账本要的是
          // "哪个入口跑了一次", 不是"调用方能不能拿这个 id 回来查"。链上 baseConfig 自带的
          // onComplete: 留痕是搭车的, 不许吃掉调用方自己的钩子 (S0 那条纪律)。
          const cfg = deps.baseConfig();
          if (deps.recorder) {
            cfg.onComplete = recordDagRun(
              deps.recorder,
              { runId: randomUUID(), entry: 'omd_primitive', question: `${primitive} ${JSON.stringify(params).slice(0, 160)}` },
              cfg.onComplete as Parameters<typeof recordDagRun>[2],
            );
          }
          const res = await deps.runPlan(primitivePlan(primitive, params, model), cfg);
          const leaf = res.results.p;
          if (!leaf || leaf.status !== 'done') {
            return {
              isError: true,
              content: [{ type: 'text', text: `原语 ${primitive} 未完成 (status=${leaf?.status ?? 'missing'}): ${leaf?.output ?? ''}` }],
            };
          }
          return { content: [{ type: 'text', text: leaf.output ?? '' }] };
        } catch (e) {
          // 参数不合 schema 在编译期就 fail-closed —— 原样把理由带出去, 别静默降范围。
          return { isError: true, content: [{ type: 'text', text: `原语 ${primitive} 失败: ${(e as Error).message}` }] };
        }
      }) as OmdMcpTool['handler'],
    },
    {
      name: 'omd_shapes',
      description: '取图式: 每条带触发条件、什么时候别用、步骤、为什么。分解任务前调一次。不传 id = 全部。',
      inputSchema: {
        id: z.string().optional().describe(`shape id (可选, 不传=全部): ${GRAPH_SHAPES.map((s) => s.id).join(' / ')}`),
      },
      handler: (async (args: Record<string, unknown>) => {
        const id = typeof args.id === 'string' ? args.id.trim() : '';
        if (id) {
          const s = shapeById(id);
          if (!s) {
            return { isError: true, content: [{ type: 'text', text: `未知 shape '${id}'; 可选: ${GRAPH_SHAPES.map((x) => x.id).join(', ')}` }] };
          }
          return { content: [{ type: 'text', text: JSON.stringify(s, null, 2) }] };
        }
        return { content: [{ type: 'text', text: JSON.stringify(GRAPH_SHAPES, null, 2) }] };
      }) as OmdMcpTool['handler'],
    },
  ];
}
