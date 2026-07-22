/**
 * harness/debug/debug-plan —— dag-debug 的**预构造 ConductorPlan** 工厂(零 conductor LLM)。
 *
 * 图形状固定(照 arch/deepen-plan 姿态,预构造入口 runExecutorDagWithPlan,不请模型规划):
 *   scope_lock (agent 只读锁范围, 符号→codegraph|文本→ugrep 双路)
 *     → hypotheses (map: 假设 lister 运行时枚举 → 每假设一 agent verify-leaf, skeptic 证伪)
 *       → judge (leaf: 择 CONFIRMED 根因 + 提议最小修 / 或判"无根因"驱动三振)
 *
 * SDD: docs/plan/2026-07-22-dag-debug.md。issue #9。
 *
 * ⚠️ scope_lock / verify-leaf 是**只读探查**: goal 措辞刻意避开 executor-dag 的 producesFiles
 * 强写信号(实现/创建/新建/写入/生成/修改/实装/落地 + 文件后缀)—— 命中会触发产物校验闸,
 * 把零改动的只读叶误判成 empty-done failed。debug-plan.test.ts 对此有回归守卫(同 deepen)。
 *
 * ★ 无根因不修(investigate 铁律): judge 未 CONFIRMED → 不提修, 回 fanout(SDD §3.2)。
 *   默认只提议不改文件(SDD §3.3): 全节点只读, 无 agent 写盘; judge 输出提修文本。
 */
import { PlanSchema, type ConductorPlan } from '../conductor-plan';

/** judge 节点固定 id(脚本收结果 + 测试都锚它)。 */
export const JUDGE_NODE_ID = 'judge';
/** 假设扇出 map 节点固定 id。 */
export const HYPOTHESES_NODE_ID = 'hypotheses';
/** scope 锁定节点固定 id。 */
export const SCOPE_NODE_ID = 'scope_lock';

/** 假设并发扇出硬顶(护量级 + 三振纪律; 一假设一 agent verify-leaf)。 */
const DEFAULT_MAX_HYPOTHESES = 5;

export interface DebugPlanOptions {
  /** 失败描述(用户 --repro 的症状 / stack trace / "昨天还好的")。 */
  failure: string;
  /** 复现拿到的确定 red 证据(裸 shell 跑 reproCmd 的输出; 无 --repro 则空)。 */
  redEvidence?: string;
  /** codegraph 能力探测结果(plan 期; true→符号导航, false→ugrep 降级)。SDD §3.1。 */
  cgAvailable: boolean;
  /** 前几轮被证伪的假设(三振循环反馈; 下轮 lister 避开重复猜)。 */
  priorRefuted?: string[];
  /** 假设扇出上限(默认 5)。 */
  maxHypotheses?: number;
}

/** scope_lock goal: 只读锁最窄受影响范围, 按 codegraph 可用性分双路(SDD §3.1 降级)。 */
function scopeLockGoal(cgAvailable: boolean): string {
  const nav = cgAvailable
    ? [
        `本仓有 codegraph 索引 → 用**符号导航**锁范围(比 grep 准):`,
        `- codegraph_context 摸症状涉及的符号; codegraph_callers/callees 看调用链;`,
        `- codegraph_impact 看"改这里会崩什么"(爆炸半径)。`,
      ].join('\n')
    : [
        `本仓无 codegraph → **文本搜索降级**(精度降照跑):`,
        `- ugrep -n 搜症状关键词 / 错误串 / 相关标识符; read 读命中文件上下文。`,
      ].join('\n');
  return [
    `你在做**只读范围锁定** —— 绝对不许改任何文件, 只用 read/ls/grep/codegraph 类工具看代码。`,
    ``,
    `任务: 从失败症状追到**最窄的受影响目录/文件集**, 声明范围。这是下游假设扇出的边界,`,
    `范围锁准 = 假设不散、证伪有的放矢。`,
    ``,
    nav,
    ``,
    `输出: 1) 锁定范围(目录/文件清单 + 一句为什么是这里); 2) 范围内与症状最相关的 3-8 个`,
    `关键位置(file:line + 一句它可疑在哪), 供下游生成假设。只读探查, 不提修复方案。`,
  ].join('\n');
}

/** 假设 lister goal(🆕 新逻辑): 读 failure+red+scope → emit 结构化假设数组。 */
function hypothesisListerGoal(opts: DebugPlanOptions): string {
  const red = opts.redEvidence?.trim()
    ? `\n复现拿到的确定失败证据(red):\n\`\`\`\n${opts.redEvidence.slice(0, 2000)}\n\`\`\`\n`
    : `\n(无 --repro 复现证据; 据症状描述 + 上游范围推断。)\n`;
  const avoid = opts.priorRefuted?.length
    ? [
        ``,
        `⚠️ 以下假设**前几轮已被证伪**, 不要重复提(换角度/换层想):`,
        ...opts.priorRefuted.map((h) => `  - ${h}`),
      ].join('\n')
    : '';
  return [
    `你是根因调查员。基于失败症状 + 上游锁定的范围(见 upstream), 枚举**可区分、可验证**的`,
    `根因假设。每个假设是"某处某机制导致此症状"的具体命题, 不是模糊方向。`,
    ``,
    `失败症状:\n${opts.failure}`,
    red,
    `先 step-back: 这类症状(数据不一致/超时/类型错/竞态/权限泄漏/schema 漂移/fail-open)在本栈`,
    `通常由哪层引起? 建宏观诊断框架再落具体假设, 别直接跳最"像"的。${avoid}`,
    ``,
    `输出严格 JSON(下游按 schema 扇出, 一假设一验证叶):`,
    `{ "hypotheses": [ { "id": "<短稳定 kebab id, 如 missing-scope-filter>",`,
    `  "claim": "<一句根因命题: 哪个文件/函数的什么机制导致此症状>",`,
    `  "where": "<最该查证的 file:line 或符号>" } ] }`,
    ``,
    `宁缺毋滥: 2-${opts.maxHypotheses ?? DEFAULT_MAX_HYPOTHESES} 个高质量假设, 覆盖不同层/机制。`,
  ].join('\n');
}

/** 单假设 verify-leaf goal(skeptic 证伪; refute-first, 只读读码引 file:line)。 */
const HYPOTHESIS_VERIFY_GOAL = [
  `你是根因假设的**证伪裁决员**(skeptic)。默认此假设不成立, 只有代码证据硬撑才 CONFIRMED。`,
  `绝对不许改任何文件, 只用 read/grep/codegraph 类工具读码取证。`,
  ``,
  `待验证假设:`,
  `- id: \${hyp.id}`,
  `- 命题: \${hyp.claim}`,
  `- 该查处: \${hyp.where}`,
  ``,
  `三步推导(investigate Phase 5 纪律):`,
  `1. **观察**: 去 \${hyp.where} 附近读真码, 引 file:line 说你看到什么。`,
  `2. **推论**: 若此假设成立, 代码里还应看到什么(必然的伴随事实)?`,
  `3. **验证**: 找那个伴随事实在不在。在 → 支撑; 不在/相反 → 证伪。`,
  ``,
  `裁决规则(refute-first): 证据表明命题不成立 → REJECTED; 证据硬撑 → CONFIRMED;`,
  `证据不足以判 → UNCLEAR(别硬 CONFIRMED)。`,
  ``,
  `输出: 首行 \`VERDICT: CONFIRMED|REJECTED|UNCLEAR\`, 随后三步推导各一段(每段引 file:line 证据)。`,
].join('\n');

/** judge goal: 收敛择根因 + 提议最小修 / 或判"无根因确认"驱动三振。 */
const JUDGE_GOAL = [
  `你收到多个根因假设的证伪裁决(见 upstream)。做两件事:`,
  ``,
  `1. **择根因**: 在 CONFIRMED 的假设里选**证据最硬、最能解释全部症状**的那个作根因。`,
  `   若无一 CONFIRMED(全 REJECTED/UNCLEAR)→ 明确输出 "无根因确认", 列已排除了什么`,
  `   (供三振循环带反馈重扇 / 或升 owner)。**无根因不修**——不许在没确认时硬提修复。`,
  `2. **提议最小修**(仅当有 CONFIRMED 根因): 最少文件、最少行的修复方向 + 为什么能解决,`,
  `   附一个回归验证思路(红→绿如何确认)。**只提议, 不改文件**(实装走显式闸)。`,
  ``,
  `输出结构:`,
  `- 首行 \`ROOT_CAUSE: CONFIRMED <id>\` 或 \`ROOT_CAUSE: NONE\`。`,
  `- 若 CONFIRMED: 根因(为什么)/ 证据(file:line)/ 提议修复(file:line + 思路)/ 回归验证思路。`,
  `- 若 NONE: 已排除的假设清单 + 各自被证伪的理由 + 下一步建议(换角度重扇 / 埋点观察 / 升 owner)。`,
].join('\n');

/**
 * 构造 dag-debug 的预构造 plan: scope_lock(agent) → hypotheses(map) → judge(leaf)。
 * 返回前过 PlanSchema.parse —— 图形状坏在构造期炸, 不流进执行器。
 */
export function compileDebugPlan(opts: DebugPlanOptions): ConductorPlan {
  if (!opts.failure.trim()) throw new Error('compileDebugPlan: failure 描述不能为空');
  const maxHypotheses = opts.maxHypotheses ?? DEFAULT_MAX_HYPOTHESES;

  const nodes: Record<string, unknown> = {
    [SCOPE_NODE_ID]: {
      executor: 'agent', // 要读真文件锁范围 → 带工具; goal 已钉只读纪律
      goal: scopeLockGoal(opts.cgAvailable),
      persona: '根因调查员(证据优先, 先锁最窄范围再展开, 反 happy-path)',
    },
    [HYPOTHESES_NODE_ID]: {
      executor: 'map',
      depends_on: [SCOPE_NODE_ID],
      map: {
        lister: {
          executor: 'leaf',
          goal: hypothesisListerGoal({ ...opts, maxHypotheses }),
          output_schema: {
            hypotheses: [{ id: 'string', claim: 'string', where: 'string' }],
          },
        },
        over: 'hypotheses',
        itemVar: 'hyp',
        keyBy: 'id', // 稳定身份 → resume 只重跑变动假设(INV-U2)
        maxItems: maxHypotheses, // 有界扇出(INV-U4)
        template: {
          executor: 'agent', // verify 要读真码引 file:line → 带工具; goal 已钉只读
          goal: HYPOTHESIS_VERIFY_GOAL,
          persona: '根因假设证伪裁决员(refute-first, 默认不成立除非证据硬撑)',
        },
      },
    },
    [JUDGE_NODE_ID]: {
      executor: 'leaf', // 纯文本收敛, 单发 inproc
      goal: JUDGE_GOAL,
      depends_on: [HYPOTHESES_NODE_ID],
      creative: true, // 提修提议 prose → 关 caveman 压缩护质量
    },
  };

  return PlanSchema.parse({
    name: 'dag-debug',
    description: `根因调查: 并发验 ≤${maxHypotheses} 假设 → 收敛根因(codegraph ${opts.cgAvailable ? '可用' : '降级 ugrep'})`,
    nodes,
  });
}
