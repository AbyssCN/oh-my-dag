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
import { findGraphCycle } from './plan/graph-cycle';
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

/**
 * 节点级确定性判据的**单一类型源**。此前 `{ command, expect_exit }` 在四处手写
 * (agent-leaf / leaf-runners / dag/planner / goal/sdd-compile), 其中一处的 `expect_exit`
 * 还是可选而另外两处必填 —— 加一个字段要改四遍, 漏掉一处不会有任何提示。
 *
 * 两个视角刻意都导出:
 *   - `SelfCheckInput` = zod **输入**侧 (default 未应用): 手写 plan 与编译产物用它。
 *   - `SelfCheckSpec`  = zod **输出**侧 (default 已应用, expect_exit 必有值): 执行期用它。
 */
export const SelfCheckSchema = z.object({
  /** 跑在 leaf 工作根内的命令。须过 `command-leaf` 的白名单/危险命令闸 (INV-2-2)。 */
  command: z.string().min(1),
  /** 期望退出码。缺省 0。0..255, 与 `expect_exit` 字段同源 (POSIX 域)。 */
  expect_exit: z.number().int().min(0).max(255).default(0),
  /** 期望输出子串。与 `expect_exit` 取交 —— 语义同节点级 `expect_output`。 */
  expect_output: z.string().min(1).optional(),
});
export type SelfCheckInput = z.input<typeof SelfCheckSchema>;
export type SelfCheckSpec = z.output<typeof SelfCheckSchema>;

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
    /**
     * D-2 (SDD cairness-distill 2026-08-10): **ex-ante 写集声明** —— 本节点预期写入的相对路径
     * 清单 (可选字段, 声明了才对账, 声明成本读数见该 SDD O-1)。消费者 = harness/writeset/write-set 的
     * 归属阶梯: 跑后 git diff 逐文件走 ①治理产物 → ②全局豁免 → ③在跑节点声明命中 (>1 → ambiguous)
     * → ④intentional 例外 → ⑤orphan 红。只在真写文件的 executor 节点上设; verify/check 节点声明了
     * 反而惹 orphan (与 MIRROR RULE「检查节点不声明制品」同源)。**刻意不进 conductor prompt** ——
     * O-1 未裁默认开之前, 只收手写 plan 的声明。
     */
    write_set: z.array(z.string()).optional(),
    /**
     * T-1b (2026-08-28): **契约里那些不进节点的话**的内容锚(`goal/spec-anchor.ts`)。
     *
     * 直通档编译器(`goal/sdd-compile`)给每片的实施节点盖上它。治的是 S-51:契约改了片外的
     * 规格(决策段 / 契约不变量),而编译出来的节点逐字节不变 ⇒ 语义指纹不动 ⇒ resume 把
     * 整片当绿跳过,修订一行代码都没进。
     *
     * **入指纹**(`nodeFieldsKey`):锚变了 = 管着这个节点的规格变了 = 上一跑那份绿证明的是
     * 另一件事。同一份契约里所有片拿到同一个锚值 —— 每片之间的差别由 goal / write_set /
     * self_check 那些字段分开,共享段本来就是全片共享的规格。
     *
     * 只在 sddPath 直通路径上有值;conductor 铺的图与手写 plan 没有契约可锚,缺席即闸缺席。
     * **刻意不进 conductor prompt**:它是编译器盖的机器值,不是规划者该写的东西。
     */
    spec_anchor: z.string().optional(),
    /**
     * g1 (图 #9): 本节点须摄入的内容总字节预估 (goal 里路径不可 stat 时的体量声明, lister 侧信息可给)。
     * 消费者 = plan/leaf-tier-gate (选「单 cat+leaf」还是「conductor 展开 per-item 对」的路)。
     * 体量提示不改节点语义 → 不入指纹。
     */
    content_bytes: z.number().int().positive().optional(),
    // 'map' (U1) = 运行时动态扇出节点 (STUDY Q3): lister → per-element 展开成 applicative 子节点。
    // 'conductor' (P3 D-G′/批次 3) = 运行时**异构**展开: 现场让 conductor 画一张子图再局部调度。
    //   与 map 的分工: map 扇的是**同一件事的 N 份** (模板 + 运行时清单); conductor 展的是
    //   **一件事的若干不同步骤** (各有各的 goal/executor/依赖) —— 那是模板表达不了的形状。
    executor: z.enum(['agent', 'leaf', 'command', 'map', 'research', 'await']).optional(),
    /** executor='command' 时要跑的确定性 CLI (如 'codegraph trace X Y')。经 fail-closed 闸 + 白名单。 */
    command: z.string().optional(),
    /**
     * D-K (2026-07-29): command 节点判 done 的**期望退出码**, 缺省 0 (零回归)。
     *
     * 存在理由 = **verify-red**: TDD 的第二步要证明"新写的测试现在是红的", 那一步的成功判据恰是
     * `bun test` 退出非 0。此前表达不出来 —— shell 取反 (`! bun test` / `bun test; [ $? -ne 0 ]`)
     * 整族元字符被 command-leaf 的注入闸全拒 (`command-leaf.ts:145`), 而"让模型自己说测试红了"
     * 等于把确定性 oracle 换成 LLM 自证 (正是 command 节点存在的意义的反面)。
     *
     * 只在 executor='command' 生效; 设在别的节点上引擎会 WARN (明示即承诺: 不消费就别静默吞)。
     * 上界 255 = POSIX 退出码域, 顺带把 -1 挡在 schema 外 —— 那是 command-leaf 的**闸拒**返回值
     * (blocked/危险命令), 绝不能被一个 expect_exit 翻译成 done (执行器另有硬闸, 见 executor-dag)。
     */
    expect_exit: z.number().int().min(0).max(255).optional(),
    /**
     * 期望输出**子串**。与 `expect_exit` 取**交**:退出码对且输出含它,才判 done。
     *
     * 补的是 `expect_exit` 单独判不了的那一格:「命令根本没跑到该跑的东西」与「跑了且过了」
     * 退出码一模一样。实测形态是 `bun test <路径写错>` 空匹配 exit 0 —— 一条什么都没测的
     * 命令拿到绿灯。挡它此前靠契约把 verify 写成 `ugrep -q '<锚>' … && bun test …` 两段式,
     * 而那是一条没有闸的散文纪律。
     *
     * 取子串不取正则:子串写不错;写错的正则恰好是恒真那种 (`.*`), 会把判据变成永绿。
     * 要模式匹配就在命令里用 grep, 让退出码去说话。
     *
     * 缺省 = 不检查输出 (存量 plan 行为逐字节不变)。
     */
    expect_output: z.string().min(1).optional(),
    /**
     * executor='research' 的旋钮 (D-6 + A1 修法)。**rounds 是节点内环的界** (INV-GOAL-4: 环封节点内且必须有界) ——
     * schema 层就钳到 1..4, 不给"跑到满意为止"留口子。
     *
     * A1 (2026-08-25): `k` 与 `lensCount` 是两件事 —— `k` = 检索召回条数上限, `lensCount` = 镜头数/广度旋钮
     * (council 分解时透传给 authorFanoutSpec)。前者影响搜索候选池, 后者影响研究的多视角合成面 —— 改 `k`
     * 接线会静默改变存量 plan 行为, 所以只改描述 + 新增旋钮, 不动 `k` 接线。
     */
    research: z.object({
      k: z.number().int().min(1).max(12).optional().describe('检索命中条数上限 (召回)'),
      lensCount: z.number().int().min(1).max(6).optional().describe('镜头数 (广度, council 分解时建议拆几个视角)'),
      rounds: z.number().int().min(1).max(4).optional().describe('second-pass 轮数上限 (内环的界)'),
    }).optional(),
    /** executor='map' 时的动态扇出规格 (与 executor:'map' 互为 required, superRefine 校验)。 */
    map: MapSpec.optional(),
    /** executor='await' 时的跨 run 等待规格: 等待 run-board 上出现匹配的 published 条目, 然后 git 合入其 commit。 */
    await: z.object({
      artifact: z.string().min(1),
      fromRun: z.string().optional(),
      /** D-8: 超时毫秒, 默认 3h (10_800_000)。 */
      timeoutMs: z.number().int().positive().optional(),
    }).optional(),
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
    /** 岗位档案名; conductor 只能从注入名册选择, 未知名由执行期 INV-1 闸 fail-open。 */
    profile: z.string().min(1).optional(),
    /**
     * Agent 模板引用 (agent-templates 注册表按名选卡): 执行期把卡片 body (方法论+检查单+输出纪律)
     * 注入 leaf prompt 前缀 — 模板管深度, persona 管任务角度 (一行调味), 二者叠加。卡片可携 model
     * (TPL-3: node.model 显式仍最高优先)。未知名规划期被 parsePlan(knownTemplates) 拒 (TPL-2)。
     */
    template: z.string().optional(),
    /**
     * MCP 工具声明 (开放生态 D-3): 元素 = server 名或 'server:tool' — 执行期据此挂载外部工具。
     * 未注册 server 规划期被 parsePlan(knownServers) 拒 (同 TPL-2 的 template 通道: 注册表由调用方
     * loadMcpClientConfig 取, 不在此 import)。
     */
    mcp: z.array(z.string()).optional(),
    model: z.string().optional(),
    leaf: z.record(z.string(), z.unknown()).optional(),
    /**
     * L0 节点级重试上限 (INV-P2-2)。省略/0 = 不重试 (默认, 零回归)。每次重试把**上一次的失败原因**
     * 注入 prompt (不是原样重放); 用尽仍 failed → 该节点 failed, 由上层 (verifier 升级 / 外层 fixpoint) 接手。
     *
     * 这是本 schema 里**唯一**的节点级恢复旋钮 (D-11, 2026-07-28): 原先并列的 `on_failure`
     * (retry/complete-then-retry/escalate/pause) 与 `fallback` (human/reactive) 全部**零引擎消费者**却
     * 进语义指纹 —— 手写 plan 显式写了会被静默忽略。二选一时删掉它们而非实装:
     * escalate 的语义 (便宜→强逐级试) `escalation` **原语**已经做了 (primitive-registry), 不重复造;
     * pause/human 属 HITL, 已定推迟 (D-8)。判据承 `agent` 字段被排出指纹时立的那条: 不消费就不该在键里。
     *
     * INV-GOAL-4 有界: 不允许"无限"这个取值。
     */
    max_retry: z.number().int().min(0).max(3).optional(),
    // ── SDD v2 (dag-engine-fusion-refactor) 调度/分配元数据 ──
    /**
     * D-7v2 quorum: 依赖失败时本节点的执行判据。'all' = 任一依赖 failed/skipped → 本节点级联
     * skipped(不执行零 token);'any' = ≥1 依赖 done 即执行(fan-in 韧性);K(整数)= done 依赖
     * ≥K 才执行(best-of-N 至少 K 候选)。缺省 = 'all' (S3 片 3 / D-6: 合成节点必须看见全部输入,
     * 宽扇出单叶 429 不陪葬 synth 的诉求改由显式 'any' / K 表达)。
     */
    requires: z.union([z.enum(['all', 'any']), z.number().int().min(1)]).optional(),
    /** D-12v2 cluster 标签:HUD/报告分组 + stamp pass 链亲和(D-22)的边界信号。纯元数据,不进调度。 */
    cluster: z.string().optional(),
    /** D-17 强度档覆盖:stamp pass 选池档位(缺省 executor-kind 启发地板)。 */
    tier: z.enum(['strong', 'mid', 'cheap']).optional(),
    /**
     * S-T 推理档显式覆盖:显式给了永远赢过座位档与全局默认(同 TPL-3 的 model 优先序哲学)。
     * 刻意**不进 conductor prompt** —— 这是手写 plan / patch 的逃生口,不是让弱 conductor
     * 到处撒的旋钮(档位该由座位分配表统一给,散在节点上就没人管得住)。
     */
    thinking: z.enum(['off', 'low', 'medium', 'high', 'xhigh']).optional(),
    /**
     * D-14v2 多模态:true = 执行期从直接前驱输出解析图片路径(存在性校验),经 content parts
     * 注入本 leaf 调用,模型走 multimodal 池。
     */
    attach_media: z.boolean().optional(),
    /**
     * **节点级确定性判据** (P1 D-3, 2026-08-21) ——「这个节点自己判自己做完没有」。
     *
     * 在 leaf 内环将停时由引擎跑一遍 (执行器内 pi 通道专属: 见 C-2 INV-2-1) —— 退出码
     * `=== expect_exit` → 节点转绿;否则构造一条 follow-up 让同节点**再多转一轮** (有界,
     * 见 P1 C-3) 而**不**新建节点、不重画图。命令承接与 `command` 节点同源的安全闸
     * (白名单/元字符/git 写子命令, 危险命令直接拒 —— 见 INV-2-2)。
     *
     * **规划期判据自证** (P1 INV-1-3): conductor 写出的 `self_check` 必须过
     * `acceptance-gate.ts` 的判别力/空世界自证 —— 一份**明显错**的产物上仍通过的判据会被
     * **悄悄丢弃**(节点退回无 `self_check` 的旁路, 不判节点红 —— 那会逼真红为虚红)。
     * 缺席 = 旁路 (INV-1-2): 执行路径与无 `self_check` 逐字节相同。
     */
    self_check: SelfCheckSchema.optional(),
    // ── 片 2 schema 增量 (INV-6 全 optional · 存量 plan parse 行为逐字节不变) ──
    // 必填性由 plan-critic 判 (诊断码), 绝不由 zod 判。zod 只管类型与枚举, 不替 critic 做诊断。
    /** PP-O01 / PP-I02 消费: oracle 选型 (cheap|render|judge|none|self_built)。 */
    oracleKind: z.enum(['cheap', 'render', 'judge', 'none', 'self_built']).optional(),
    /** PP-T01/T02/T03 消费: 节点引用的工具列表 (与 capability 一起解析)。 */
    toolRefs: z.array(z.string()).optional(),
    /** PP-I01 消费: 不扇出本节点的说明。null = 「无理由」(与字段缺省 = 「未表态」语义不同)。 */
    whyNoFanout: z.string().nullable().optional(),
    /** 节点级预算声明: calls · tokens · 美元上限 · 估算法。 */
    budgetBasis: z
      .object({
        calls: z.number().int().nonnegative(),
        tokensIn: z.number().int().nonnegative(),
        tokensOut: z.number().int().nonnegative(),
        costUsdCeiling: z.number().nonnegative(),
        estimatedBy: z.string(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()
  // U1 map 节点交叉校验: map spec ⇔ executor:'map' 互为 required + INV-U5 禁嵌套 map。
  .superRefine((node, ctx) => {
    const isMap = node.executor === 'map';
    if (isMap && !node.map)
      ctx.addIssue({ code: 'custom', message: "executor:'map' 需 map spec", path: ['map'] });
    if (node.map && !isMap)
      ctx.addIssue({ code: 'custom', message: "map spec 需 executor:'map'", path: ['executor'] });
    // D-8: await 节点交叉校验: await spec ⇔ executor:'await' 互为 required (同 map/primitive 的形态)。
    const isAwait = node.executor === 'await';
    if (isAwait && !node.await)
      ctx.addIssue({ code: 'custom', message: "executor:'await' 需 await spec", path: ['await'] });
    if (node.await && !isAwait)
      ctx.addIssue({ code: 'custom', message: "await spec 需 executor:'await'", path: ['executor'] });
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
    /**
     * D-2/4v2 交付物声明:prune pass 的 keep-set 种子。未声明 → prune 恒等(INV-9 零回归)。
     * 引用的 id 必须存在于 nodes(superRefine 闸,防剪错图)。
     */
    outputs: z.array(z.string().min(1)).optional(),
    /**
     * **这张图跟的是哪张图式卡**(SH-1, 2026-08-30, owner 裁)。取 `GRAPH_SHAPES` 的 `id`
     * (`src/harness/shapes/index.ts` 的 8 张卡), 没跟任何一张就**缺席**。
     *
     * ## 为什么必须是 conductor 自己声明, 派生不出来
     *
     * 仓里已有一个**结构指纹** `shapeOf()`(`plan-passes/evidence-pass.ts:203`,
     * 形如 `n3/e3/agent=2,leaf=1`), 但它答的是**这张图长什么样**, 不是**跟的哪张卡**:
     * 同一张卡能画出不同结构, 不同卡也能撞出同一个结构指纹。两者不能互相替代。
     * 没有这一列, 「哪个图式好」这个问题**永远答不了** —— conductor 优化就无从谈起
     * (owner 2026-08-30 的原话: 没有它就无法回溯之后哪些是好的)。
     *
     * ## 为什么**不**校验成枚举
     *
     * 值域故意是 `string` 而不是 `z.enum([...8 个 id])`: 卡表会长, 而一个拼错的 id
     * **不该让整张 plan 判 INVALID**(同 `executor:'await'` 那条教训 —— 词表明示了却让
     * 用了就炸)。原始观测**原样写入磁盘**, 「是不是已知卡」留给消费面判
     * ({@link isKnownShapeId}) —— 与 `seat-usage.ts` 的 `traceName`/`seatOfTrace` 同一条纪律:
     * 映射表将来发现错了, 历史行还能重算。
     */
    shape: z.string().min(1).optional(),
    // ── 片 2 schema 增量 (S1 契约 · INV-6 全 optional) ──
    /** PP-* 诊断码的抑制声明 (元素 = 诊断码字符串, 如 'PP-T01')。INV-S1-3: PP-S02 不可抑制,
     *  该闸由 plan-critic 跑 (不是 zod), 这层只接形状。可选 · 缺省 = 不抑制。 */
    suppressions: z.array(z.string()).optional(),
    /** plan schema 版本号 (PP-V01 消费)。可选 · 缺省视作 '1.0' (由 isSupportedSchemaVersion 调用方补)。 */
    schema_version: z.string().optional(),
    // ── L1 平铺契约 (2026-08-31, 片 2 · INV-2) ──
    /**
     * **plan 拓扑来源** — L1 平铺编译器写 `flat`, 既有重仪式 conductor 写 `full` (省略
     * 等价于 full, 零回归)。枚举故意只两个: D-2「路由权在 config, 不在模型」—— 让
     * conductor 在 prompt 里**看不见**这个字段, 重仪式路径不会主动声明, 也就没有
     * 「写错第三个值」的面。
     *
     * 缺席语义 = full: GWT-3 (INV-2) 要求「不含 complexity 字段的既有 plan JSON
     * 解析通过且行为与今天逐字节相同」。PlanSchema 顶层仍 `.passthrough()`, 故省略
     * 即可, 与显式 `'full'` 行为一致。值域错 (如 `'deep'`) → zod 拒绝, 与 `executor`
     * 枚举的失败语义同源。
     */
    complexity: z.enum(['flat', 'full']).optional(),
  })
  .passthrough()
  .superRefine((plan, ctx) => {
    for (const id of plan.outputs ?? []) {
      if (!(id in plan.nodes))
        ctx.addIssue({ code: 'custom', message: `outputs 引用不存在的节点 id: ${id}`, path: ['outputs'] });
    }
    /**
     * 环 → 整份 plan 无效 (2026-08-14, issue #25)。
     *
     * 此前唯一拦环的地方是 `executePlan` 入口的 `topoLevels` 抛错 —— 那时 plan 早已被采纳,
     * 异常直接穿出 `runExecutorDag`, 于是**一个 conductor 的手误炸掉整跑**, 而它本该走
     * 「plan 无效 → 带精确错误重问一次」那条有界重试路 (parsePlan 的 ok:false 出口)。放在 schema
     * 层是因为造 plan 的入口不止 parsePlan 一个: plan-patch 的 merge、slice-compiler、deepen-plan、
     * slim/local-plan 全都过这道 `PlanSchema`, 而它们全都没有自己的环检。
     *
     * 与 `outputs` 那条同为 fail-closed: 环没有任何 intentional 消费方 —— 运行时子图对环
     * 早就是拒整份 (`conductor-expand` 的 status:'cycle'), 顶层反而最宽, 那是双标不是宽容。
     */
    const cycle = findGraphCycle(plan.nodes);
    if (cycle)
      ctx.addIssue({
        code: 'custom',
        message: `依赖环: ${cycle.join(' → ')} —— 图必须无环。改法: 断掉环上任意一条 depends_on (通常是那条"为了顺序好看"而不是真数据依赖的边)。`,
        path: ['nodes'],
      });
  });

export type ConductorPlan = z.infer<typeof PlanSchema>;

// ── 片 2 schema 增量 (INV-7): schema_version 支持集 + fail-fast 判定函数 ────────

/** 支持的 schema_version 字符串全集 (单一真源, 改这里一处所有消费者跟上)。
 *  顺序: 含 '1.0' (用户任务的「默认视作」字面值) 与 '1.0.0' (S1 契约原值), PP-V01 与
 *  conductor 提示词的版本声明都从这里查。 */
export const SUPPORTED_SCHEMA_VERSIONS: readonly string[] = ['1.0', '1.0.0'];

/** 当前 plan 写出的 schema_version 字面值 (S1 契约 §1.3 的 `SCHEMA_VERSION='1.0.0'` 占位;
 *  用户任务「默认视作 '1.0'」取短名版)。 */
export const SCHEMA_VERSION = '1.0';

/** PP-V01 消费: 给定 schema_version 是否在支持集中。**fail-fast** — 不在即拒整 plan (PP-V01
 *  诊断码的源头)。调用方负责把 plan.schema_version 缺省补成 '1.0', 这层不做。
 *  (签名照 S1 契约: `isSupportedSchemaVersion(v:string):boolean`。) */
export function isSupportedSchemaVersion(v: string): boolean {
  return (SUPPORTED_SCHEMA_VERSIONS as readonly string[]).includes(v);
}
/** start 起的括号平衡切片 (字符串感知); 不平衡 → 余文 (交 JSON.parse 报错)。 */
function balancedSlice(text: string, start: number): string {
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
  return text.slice(start).trim();
}

export function extractPlanJson(text: string): string {
  // 候选制提取 (2026-07-25 两轮 k3 实证):
  //  ① 惰性 ```…``` 正则被字符串值里的 ``` 提前截断 (goal 引用 spec 的 "不含 ``` 围栏" →
  //     Unterminated string) → 终点一律括号平衡扫描, 不信闭合 fence。
  //  ② fence 开点也不可信 —— 裸 JSON 的字符串值里同样可能有 ```, 拿它当起点会跳进正文
  //     深处抓到嵌套小对象 (首版修的回归, k3-fail-rep6 样本)。
  // → 多锚点 (文首 + 每个 fence 开点) 各取平衡切片当候选, 优先返回「可解析且带 name+nodes」
  //   的 plan 形状候选; 其次首个可解析; 全不可解析 → 文首余文交上层报错 (原行为)。
  const anchors: number[] = [0];
  const fenceRe = /```(?:json)?\s*/gi;
  for (let m = fenceRe.exec(text); m; m = fenceRe.exec(text)) anchors.push(m.index + m[0].length);
  let firstParseable: string | null = null;
  for (const a of anchors) {
    const start = text.indexOf('{', a);
    if (start < 0) continue;
    const cand = balancedSlice(text, start);
    try {
      const obj = JSON.parse(cand) as Record<string, unknown>;
      if (obj && typeof obj === 'object' && 'name' in obj && 'nodes' in obj) return cand;
      firstParseable ??= cand;
    } catch {
      /* 该锚点候选不可解析 → 试下一锚点 */
    }
  }
  if (firstParseable) return firstParseable;
  const start = text.indexOf('{');
  return start < 0 ? text.trim() : balancedSlice(text, start);
}

/**
 * Parse + validate a model reply into a plan. Returns ok|error (never throws).
 * opts.knownTemplates 给则校验每个 node.template (含 map 子模板) ∈ 注册表 — 未知名 = 整 plan 无效
 * (TPL-2: 拒在规划层, 驱动 conductor 重试; enum 级防幻觉, 同 primitive-registry .strict() 手法)。
 * opts.knownServers **必传** (开放生态 D-3 惰性闸修复): 校验每个 node.mcp (含 map 子模板) 的 server 段 ∈
 * 已注册 server — 未注册 = 整 plan 无效 (同 TPL-2 通道)。必传是为了不存在「省略 = 静默跳过校验」的
 * 路径: 注册表由调用方经 knownMcpServerNames(该 run 的 cwd) 取 (mcp/client/config), 不在此 import。
 */
export function parsePlan(
  text: string,
  opts: { knownTemplates?: ReadonlySet<string>; knownServers: ReadonlySet<string> },
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
  if (opts.knownServers) {
    const unknown = new Set<string>();
    for (const node of Object.values(res.data.nodes)) {
      for (const entry of node.mcp ?? []) {
        const server = entry.split(':')[0] ?? entry;
        if (!opts.knownServers.has(server)) unknown.add(server);
      }
      const mapChildMcp = (node.map?.template as { mcp?: unknown } | undefined)?.mcp;
      if (Array.isArray(mapChildMcp)) {
        for (const entry of mapChildMcp) {
          if (typeof entry !== 'string') continue;
          const server = entry.split(':')[0] ?? entry;
          if (!opts.knownServers.has(server)) unknown.add(server);
        }
      }
    }
    if (unknown.size > 0) {
      return {
        ok: false,
        error: `${[...unknown].map((s) => `未注册的 MCP server "${s}"`).join('; ')}。已注册: ${[...opts.knownServers].join(', ')}`,
      };
    }
  }
  return { ok: true, plan: res.data };
}

/**
 * D-7 授权清单 (开放生态): `node.mcp ∪ 模板卡 mcp` 的去重并集 —— 元素 = server 名或 'server:tool'
 * (C-5 闸判据)。executor-dag 的 agent-run 调用点与接线测试共用这一个真源, 禁止测试侧复刻合并逻辑。
 */
export function mergeMcpAllow(node: { mcp?: string[] }, tpl: { mcp?: string[] } | undefined): string[] {
  return [...new Set([...(node.mcp ?? []), ...(tpl?.mcp ?? [])])];
}
