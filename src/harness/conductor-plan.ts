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
import { DEFAULT_COMMAND_ALLOWLIST, GIT_READONLY_SUBCOMMANDS } from './command-leaf';
import { renderShapesForPrompt } from './shapes';
import { TRUST_FENCE_RULE } from './prompt-fence';
import {
  DECISION_EDUCATION_CANONICAL,
  lintDecisionEducation,
} from './prompt-lint';

/** Frozen-prefix boundary (SDD §2 __SYSTEM_PROMPT_DYNAMIC_BOUNDARY__ analogue). */
export const PLAN_BOUNDARY = '\n\n===== TASK (dynamic, below the frozen boundary) =====\n\n';

// ── L2 教化段编译期闸 (INV-8 / D8) ──
//
// 模块顶层二次校验 (prompt-lint.ts 内部已 throw 一次, 这是调用方的红线复用): 装配点 (本文件)
// 把它送进 prompt 前, 还要过一道 lintDecisionEducation —— 任何让它膨胀的改动到这里一定被拒。
// 双重防御: prompt-lint.ts 的模块顶层 throw 抓 canonical 自身超限; 这里抓「本文件用了别的字符串
// 假装 canonical」这种语义漂移。两道闸都要绿才能让 conductor prompt 装上。
const _decisionLint = lintDecisionEducation(DECISION_EDUCATION_CANONICAL);
if (!_decisionLint.ok) {
  throw new Error(
    `[conductor-plan] DECISION_EDUCATION_CANONICAL rejected at assembly: ${_decisionLint.reason}`,
  );
}

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
     * g1 (图 #9): 本节点须摄入的内容总字节预估 (goal 里路径不可 stat 时的体量声明, lister 侧信息可给)。
     * 消费者 = plan/leaf-tier-gate (选「单 cat+leaf」还是「conductor 展开 per-item 对」的路)。
     * 体量提示不改节点语义 → 不入指纹。
     */
    content_bytes: z.number().int().positive().optional(),
    // 'map' (U1) = 运行时动态扇出节点 (STUDY Q3): lister → per-element 展开成 applicative 子节点。
    // 'conductor' (P3 D-G′/批次 3) = 运行时**异构**展开: 现场让 conductor 画一张子图再局部调度。
    //   与 map 的分工: map 扇的是**同一件事的 N 份** (模板 + 运行时清单); conductor 展的是
    //   **一件事的若干不同步骤** (各有各的 goal/executor/依赖) —— 那是模板表达不了的形状。
    executor: z.enum(['agent', 'leaf', 'command', 'map', 'research', 'conductor', 'await']).optional(),
    /**
     * executor='conductor' 的子图节点数硬顶 (D-B/D-D 展开闸)。缺省见 DEFAULT_MAX_CHILDREN=64,
     * 与 map 的 maxItems 同一个数 —— 没有证据支持给它一个不同的值。
     */
    max_nodes: z.number().int().min(1).max(64).optional(),
    /**
     * executor='conductor' 的**内环轮数上限** (P3 D-A)。缺省 1 = 展开一次就结束, **零回归**。
     *
     * >1 时环的语义是**逐轮重展开**, 不是"重跑同一张子图": 每轮把上一轮的失败原因喂回给
     * conductor, 让它**重新画**。这条区分是环的全部价值所在 —— 重跑同一张图只能把同样的活
     * 再干一遍, 重新画才能补一个上一轮压根没有的步骤 (D-G′ 说的「补调研」正是这个形状:
     * 不需要回边, 因为每一轮都是一张全新的无环子图)。
     *
     * INV-GOAL-4 有界: 不允许"跑到满意为止"。
     */
    max_rounds: z.number().int().min(1).max(4).optional(),
    /**
     * executor='conductor' 的**终轮必判** (P3 D-F, 2026-07-30)。缺省 false = 零回归。
     *
     * 环内的 judge 本来只为"要不要再画一轮"服务, 所以最后一轮 (含 `max_rounds:1`) 不请它 ——
     * 判了也没有下一轮可去, 白花一次贵座调用。但**撤掉外层 fixpoint 之后** (D-F), 「整体目标
     * 成了吗」这个问题就没有别的层来问了: 调用方 (如 goal 引擎决定 `dag_goal` 记 succeed 还是
     * fail) 拿不到裁决, 只能拿"跑完了"当"成了", 那正是谎报完成最舒服的入口。
     *
     * 置 true = 最后一轮也判一次, 裁决经 `LeafResult.converged` 带给调用方。代价是一次 judge
     * 调用 (~1100 out tok / ~17s 实测)。**刻意不进 conductor 的图式引导** —— 这是程序构造节点
     * 时用的旋钮 (谁要裁决谁自己开), 不是让规划者随手打开的东西。
     */
    judge_final: z.boolean().optional(),
    /**
     * **图内 fan-in 检测者** (P3 D-Q, 2026-07-30)。缺省 false = 零回归。
     *
     * 置 true = 本节点的输出按**检测者协议**读 (`REJECT: <id>` / `BLOCKED: <原因>`,
     * 见 plan/detector.ts): 点名的兄弟节点直接进内环毒集, `BLOCKED:` 让环提前退出等外部输入。
     * 它补的是 D-Q 说的那个洞 —— 普通节点只看得见自己的 depends_on, 而一个 fan-in 节点天然
     * 看得见一批兄弟的产出, 缺的只是让它的判断**落进环**而不是留成一段没人读的文字。
     *
     * 只在 **conductor 节点展开出来的子图里**生效 (环在那儿); 设在别处引擎会 WARN 而不改变执行
     * (明示即承诺的反面守卫, 同 expect_exit)。首选 `executor:'command'` —— 确定性 oracle 说
     * "谁坏了"比再请一次 LLM 既便宜又可信; 它点名要用**规划期的可读 id** (命令串写死在规划期,
     * 那时内容寻址 id 还不存在, 引擎负责翻译 —— 见 plan/detector.ts 的 aliases)。
     *
     * ⚠ **进 conductor 的明示形状是被迫的** (2026-07-30 当天推翻了自己前一版的"刻意不明示"):
     * 它只在 conductor 自己画的子图里有消费者, 而子图只有 conductor 画得出来 —— 不告诉它,
     * 这个字段就没有任何生产者, 那正是本仓一直在猎杀的空旋钮形态 (要么给生产者, 要么删掉,
     * 中间态最坏)。代价用 prompt 里**比 when 更长的 whenNot** 压: 能用 command oracle 直接判的
     * 别用它、只有一个产出节点的别用它、"这东西好不好"是轮末 judge 的活不是它的。
     */
    detector: z.boolean().optional(),
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
     * ≥K 才执行(best-of-N 至少 K 候选)。缺省启发:deps≤1 → 'all',≥2 → 'any'(判定在执行器)。
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
    // ── 片 2 schema 增量 (S1 契约 · INV-6 全 optional) ──
    /** PP-* 诊断码的抑制声明 (元素 = 诊断码字符串, 如 'PP-T01')。INV-S1-3: PP-S02 不可抑制,
     *  该闸由 plan-critic 跑 (不是 zod), 这层只接形状。可选 · 缺省 = 不抑制。 */
    suppressions: z.array(z.string()).optional(),
    /** plan schema 版本号 (PP-V01 消费)。可选 · 缺省视作 '1.0' (由 isSupportedSchemaVersion 调用方补)。 */
    schema_version: z.string().optional(),
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

// ── system prompt (SDD §3.1 coordinator identity · build, not port) ───────────

/**
 * The conductor's frozen system prompt (PLAN-1). Encodes the coordinator's 4-phase
 * decomposition stance (SDD §3.1: Research-parallel / Synthesis-central / Impl-dispatch /
 * Verify-independent) and pins the output contract to the plan schema.
 *
 * profile (SDD v2 追加, 2026-07-25): prompt 内容 = 环境事实 + 弱模型补偿两类混装。
 *  - 'full' (默认, 零回归) = 全量 — 弱 conductor (mimo/M3 era) 需要 granularity/深度/genre 教练。
 *  - 'lean' = 只留**环境事实**(输出 schema / executor 词表+写文件硬规则 / 并行安全 / map·primitive
 *    菜单 / 模板注册表 / SDD v2 调度分配字段 / 前端 SDD motif — 字段语义与 motif 接线是本引擎独有,
 *    强模型也推导不出) + 一行版纪律 — 顶级 conductor (k3) 上全量教练是保守偏置, 疑压平分解质量
 *    (harness 退役测试: 强模型使教练冗余 → 撤)。两档均为字节稳定冻结前缀 (PLAN-1, 各自成 cache 面)。
 *    档位选择走 A/B eval (conductor-modelmix oracle), 不拍脑袋。
 *    裁决 (2026-07-25, medium R=2 串行): k3 full/lean 同分 1.000 且 firstShot 全过, lean 少 25%
 *    leaf token → k3 采 lean (assemble 接线); large fixture 高分辨率复核为可选 follow-up。
 */
/** 岗位档案名册条目 DTO(INV-7 收窄形状): 只有 name + summary, 拒绝整份 ProfileSpec 穿透。 */
export interface ConductorProfileRosterEntry {
  readonly name: string;
  readonly summary: string;
}

/**
 * conductor prompt 档位 (issue #171 加 `-kb` 两档, 2026-08-18; issue #182 加 `bare`, 2026-08-19)。
 * `full-kb` / `lean-kb` = 对应基档字节 + **单点插入** {@link PLAN_KB_SECTION}, 其余逐字节不动
 * (单一变量; 测试以字节级 replace 钉死)。A/B 裁决前不进任何默认路径 —— 只有 conductor-modelmix
 * oracle 的 `--profiles` 轴能选到; 判据冻结在 issue #171, 塌了整段撤。
 * `bare` = **零附加内容**基线 (见 {@link bareConductorSystemPrompt}) —— 只留身份 + 分解指令 +
 * 输出 schema, 一切教练与环境事实全裁, 供跑分对照 (量 harness 增量到底值多少)。同不默认:
 * 只有显式 `config.conductorPromptProfile:'bare'` / oracle `--profiles bare` 能选到。
 */
export type ConductorPromptProfile = 'full' | 'lean' | 'full-kb' | 'lean-kb' | 'bare';

/** 档位合法值的运行时全集 (engine 的 env 校验用; 与上面类型并排, 加档时两处一起改)。 */
export const CONDUCTOR_PROMPT_PROFILES: readonly ConductorPromptProfile[] = [
  'full',
  'lean',
  'full-kb',
  'lean-kb',
  'bare',
];

/**
 * env `OMD_CONDUCTOR_PROMPT` → 档位 (engine 的 config 显式覆盖优先, 在调用点 `??` 之前)。
 *
 * #182 接上 bare: 此前 engine 里只认 'lean' (其余一律 'full'), 于是 -kb / bare 无法经 env 选到 ——
 * 一个合法档位值被静默吞成 'full' (与「写错值」在读数上不可分)。现在对 `CONDUCTOR_PROMPT_PROFILES`
 * 全集映射; 非法/未设仍落 'full' (零回归, 与旧行为一致)。单一真源: engine 两处解析都调这里。
 */
export function conductorPromptProfileFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ConductorPromptProfile {
  const v = env.OMD_CONDUCTOR_PROMPT;
  return (CONDUCTOR_PROMPT_PROFILES as readonly string[]).includes(v as string)
    ? (v as ConductorPromptProfile)
    : 'full';
}

/**
 * APoSD「按知识边界分解、反时序性分解」段 (#171 处理臂)。与 chat conductor 的
 * `<knowledge-boundary>` (harness-prompts.ts) 同源同义, 措辞换成 PLAN-1 的祈使句 register。
 */
export const PLAN_KB_SECTION: readonly string[] = [
  'Split on KNOWLEDGE boundaries, never on execution order (temporal decomposition is the classic trap):',
  '- Steps that merely run one-after-another but depend on the SAME understanding — a file format, a',
  '  schema, a protocol, one encoding decision — belong in ONE node that OWNS that knowledge. Splitting',
  '  them copies the shared decision into every node, and each copy drifts independently.',
  '- Test the finished plan: if two nodes can only both be correct by silently agreeing on something no',
  '  artifact between them states, merge them — or route the shared decision through an explicit artifact',
  '  one node produces and the others consume (the "ONE decision, THEN the fan-out" rule below).',
  '',
];

/**
 * summary 单行 + ≤80 code points 归一化 (INV-7 第一道防线, 在 conductor-plan.ts 本地做 —— 不依赖
 * 调用方守规矩)。折叠任意空白/换行成单空格再按 Unicode code point 截断 (`.slice` 按 UTF-16 code
 * unit 会切碎代理对; `Array.from` 按 code point 迭代更安全)。
 */
function oneLineSummary(summary: string): string {
  const normalized = summary.replace(/\s+/gu, ' ').trim();
  return Array.from(normalized).slice(0, 80).join('');
}

/**
 * bare 档 (#182): **零附加内容** conductor system prompt —— 只有身份 + 分解指令 + 输出 schema。
 *
 * 与 full/lean 的分界: 一切「教练」(decomposition stance / granularity / redraw / parallel-safety /
 * discipline / command 闸 / shapes / trust fence / 知识边界段) 与一切「环境事实」(白名单、模板注册表、
 * 岗位名册) 全裁掉。只留引擎 `PlanSchema` 能解析的最小契约 —— 字段名 + 枚举值 (枚举值写错整 plan
 * 被 zod 拒, 所以它们属于"接口"而非"教练"; 教练是教你**怎么用**这些字段, 那才是增量)。
 *
 * 供跑分对照 (conductor-modelmix `--profiles bare`): A/B 量 full/lean/lean-kb 的 harness 增量到底
 * 值多少, 快照锁管没人手滑改坏 —— 两者不互替 (issue #182 verify)。零 harness 增量断言在
 * conductor-prompt-snapshot.test.ts: bare 不含任何教练/环境事实标记, 且字节被快照钉死。
 */
export function bareConductorSystemPrompt(): string {
  return [
    'You are the CONDUCTOR — the planner of the omd agent runtime. Decompose the task below into a',
    'directed acyclic graph of executor nodes.',
    '',
    'Output STRICTLY one JSON object, no prose, matching:',
    '{ "name": string, "description"?: string, "outputs"?: string[],',
    '  "nodes": { "<node_id>": {',
    '    "goal"?: string, "depends_on"?: string[],',
    '    "executor"?: "leaf"|"agent"|"command"|"map"|"research"|"conductor"|"await",',
    '    "command"?: string, "expect_exit"?: number, "expect_output"?: string,',
    '    "output_type"?: "structured"|"file"|"git"|"none", "output_path"?: string,',
    '    "content_bytes"?: number, "requires"?: "all"|"any"|number, "cluster"?: string,',
    '    "tier"?: "strong"|"mid"|"cheap", "attach_media"?: boolean, "creative"?: boolean,',
    '    "persona"?: string, "profile"?: string, "template"?: string, "mcp"?: string[],',
    '    "max_nodes"?: number, "max_rounds"?: number, "max_retry"?: number,',
    '    "detector"?: boolean, "judge_final"?: boolean,',
    '    "self_check"?: { "command": string, "expect_exit"?: number, "expect_output"?: string },',
    '    "kind"?: "primitive",',
    '    "primitive"?: "parallel"|"pipeline"|"loop-until"|"verify"|"judge"|"discovery"|"iterate"|"tournament"|"router"|"race"|"escalation"|"saga"|"escape-hatch",',
    '    "params"?: object,',
    '    "map"?: { "lister": object, "over": string, "itemVar": string, "keyBy"?: string, "template": object, "maxItems"?: number, "concurrency"?: number },',
    '    "research"?: { "k"?: number, "lensCount"?: number, "rounds"?: number },',
    '    "await"?: { "artifact": string, "fromRun"?: string, "timeoutMs"?: number } } } }',
  ].join('\n');
}

export function conductorSystemPrompt(
  opts: {
    agents?: string[];
    templates?: { name: string; description: string }[];
    profiles?: readonly ConductorProfileRosterEntry[];
    profile?: ConductorPromptProfile;
  } = {},
): string {
  if (opts.profile === 'bare') return bareConductorSystemPrompt();
  const lean = opts.profile === 'lean' || opts.profile === 'lean-kb';
  const kb = opts.profile === 'full-kb' || opts.profile === 'lean-kb';
  // roster 段 2026-07-26 撤下: node.agent 在 executor-dag 零消费者 (分流看 executor/model), 且
  // conductor 每轮重掷它 → 系统性打空 D-21 跨轮复用。宿主若真注入 agents 名单才提一句, 否则不提。
  const roster = opts.agents?.length
    ? [`Host executor roster (field "agent", optional label): ${opts.agents.join(', ')}.`]
    : [];
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
  // 岗位档案名册 (field "profile", optional): 每条仅 name + 归一化 summary, INV-7 不带 persona 全文。
  // oneLineSummary 是双层防线的第一层 (本地做, 不信调用方); 装配点 (engine.ts) 投影 loadProfiles()
  // 结果为 {name, summary} 是第二层, 二者独立生效, 任一层单独在场也不破 ≤80/单行不变量。
  const profileSection = opts.profiles?.length
    ? [
        '',
        'Leaf profile roster (field "profile", optional; use ONLY these names):',
        ...opts.profiles.map((p) => `- "${p.name}": ${oneLineSummary(p.summary)}`),
        'Set "profile" only when its role matches the node. Do not invent profile names.',
        'Unknown names fall back to an ordinary leaf at run time.',
      ]
    : [];
  return [
    'You are the CONDUCTOR — the L2 orchestrator of the omd agent runtime. You plan, coordinate,',
    'and OWN COMPLETENESS; you never execute (touch files / run tools) yourself. Your job is not just',
    'to split work — it is to guarantee the graph, once run, fully answers the task with nothing missing.',
    'Decompose the task below into a directed acyclic graph of executor nodes.',
    '',
    // ── 纪律段: full = 弱 conductor 教练全量; lean = 一行版 (强模型自判, 只留不可自推导的钩子) ──
    ...(lean
      ? [
          'Split on natural boundaries; route correctness-critical output through a checking node. Prefer',
          '"command" nodes over fresh generation where indexed infra already answers. depends_on only for',
          'real data dependencies. Executors may be weak models: phrase each leaf goal to PRODUCE its',
          'deliverable content (never "execute step X"), and size nodes so a weak executor stays coherent.',
          'On redraw rounds re-emit un-blamed nodes byte-identical — content-addressed ids make unchanged',
          'specs free (D-21); reword only what the failure reason forces.',
          // #153② (2026-08-17): 尾链直线是实测事故形态 (run 50e48b27 gate_fix→types→tests→build)。
          // 纯 command 段有机械合并兜底 (plan-passes/merge-command-chain), 含「修」段只有这条规则管。
          'Acceptance tail: verification-only steps = ONE "command" node chained with && — never stacked',
          'gate nodes. A tail that also FIXES = ONE "agent" node looping run-gates → fix → re-run ALL',
          'gates (bounded, state max rounds ≤3): a later fix can break an earlier gate nothing re-checks.',
          '',
        ]
      : [
    'Decomposition stance (split on NATURAL boundaries, not turn counts):',
    '- Research-parallel: independent investigations become sibling nodes (no deps between them).',
    '- Synthesis-central: a node that consumes several siblings declares them in depends_on.',
    '- Impl-dispatch: distinct skills / agents / artifacts become distinct nodes.',
    '- Verify-independent: where correctness matters, add a checking node ("command" oracle or a judge/verify\n  primitive) downstream — a node that actually RUNS, not a declared condition.',
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
    '  route its output through a checking node that names that part.',
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
    'Redraw economics (applies when a failure reason from a previous round is present):',
    '- Node identity is CONTENT-ADDRESSED: a re-emitted node with a byte-identical spec (goal text, deps,',
    '  executor) is reused for FREE — zero tokens, zero re-run. Rewording an innocent node forfeits that',
    '  reuse and re-burns its whole subtree.',
    '- So change ONLY what the failure reason forces: fix the named nodes, add the missing step. Every',
    '  node NOT named by the failure: re-emit its spec VERBATIM.',
    '',
    'Minimize critical-path DEPTH (scheduling is dependency-driven — a node runs the moment its deps settle,',
    'there are NO level barriers — but every unnecessary dep still adds critical-path latency and re-accumulates',
    'context at its fan-in; a weak no-think planner over-stratifies — keep nodes fine but FLAT):',
    '- depends_on ONLY for a REAL data/file dependency the node consumes — NEVER to impose tidy ordering.',
    '  Two nodes with no data dependency between them MUST be siblings (same level), even if one "feels" logically later.',
    '- Collapse the verify tail into ONE command node: chain "bun run tsc --noEmit && bun test" — do NOT emit',
    '  separate typecheck-level → test-level → review-level. One gate, one node, not three stacked levels.',
    // #153② (2026-08-17): 含「修」的尾链没有机械兜底 (merge-command-chain 只并纯 command 直线),
    // 靠这条把 fix 环收进单 agent 节点 —— 后修可破先闸, 直线上没人回头重查。
    '- If the acceptance tail also FIXES (a repair step between gates), do NOT emit fix→typecheck→tests→build',
    '  as stacked nodes: emit ONE "agent" node whose goal is an explicit bounded loop — run all gates, fix',
    '  what is red, re-run ALL gates (state max rounds, ≤3) — because a later fix can break an earlier gate.',
    '- After planning, scan the longest dependency chain: if a node sits on a deep level but consumes nothing',
    '  from the levels above it, LIFT it up to run in parallel. Keep the graph WIDE (many siblings) and SHALLOW.',
    '',
        ]),
    // ── L2 组合判定教化段 (INV-8 / D8) ──
    // 两档 (full / lean, 含 -kb) 都带, bare 不带 (零附加内容基线, 见 bareConductorSystemPrompt)。
    // canonical 文本由 prompt-lint.ts 编译期守 ≤350 Unicode 字符闸 (模块顶层 throw), 这里用前再过
    // 一道 lintDecisionEducation 防本文件漂移。改 canonical 必须同时改 prompt-lint.ts 的常量与
    // bare/lean/full 三档快照 (byte-level 锁在 conductor-prompt-snapshot.test.ts)。
    [
      DECISION_EDUCATION_CANONICAL,
      '',
    ],
    // #171 处理臂: '-kb' 档在此单点插入知识边界段; 基档 (full/lean) 走空数组, 字节零变化。
    ...(kb ? PLAN_KB_SECTION : []),
    ...(lean
      ? [
          'Parallel-safety: siblings run CONCURRENTLY with NO level barrier — two nodes may be siblings only',
          'if they touch disjoint files, write distinct output_path, and share no migration / fixture / scarce',
          'resource. Anything colliding gets chained via depends_on.',
          '',
        ]
      : [
    'Parallel-safety (siblings run concurrently — this GATES the WIDE-over-DEEP rule above):',
    '- Make two nodes siblings (no dep between them) ONLY if they touch disjoint files, write distinct',
    '  output_path, and share no migration / DB fixture / scarce resource (port, provider rate limit).',
    '  If any collide, serialize them via depends_on — a wrong parallel edge corrupts files or double-writes.',
    '- Serialize hotspots, parallelize slices: schema/migrations, hot shared routes, and contracts are',
    '  collision-prone → chain them (or route through ONE owner node); isolated modules/files fan out wide.',
    '',
        ]),
    // 2026-07-26 owner: contract-node 从「全栈 SDD motif 第 2 步」提为通用规则 —— 它不是前端专属,
    // 任何「一个决策 → 一堆执行」的图都该长这样, 且是 tier:'strong' 最该出现的位置。两档都发。
    'ONE decision, THEN the fan-out (applies to ANY fan-out — not just full-stack work):',
    '- When N nodes must agree on the same interface / schema / naming / design decision, emit ONE node',
    '  that OUTPUTS that decision as text, and have all N depend_on it. NEVER let N siblings each invent',
    '  it: you get N incompatible answers and a merge nobody owns.',
    '- The decision node is an ORDINARY leaf — no special node kind. Give it tier:"strong" when the whole',
    '  fan-out rides on it (this is the single best place to spend a strong model); the workers below it',
    '  can stay cheap, because they are now transcribing a decision instead of making one.',
    '',
    'Executor kind per node (field "executor"):',
    '- "leaf"  = a single-shot model call, NO tools. Use for generation / judgement / drafting from what',
    '            you already have. A leaf has NO web access — it answers from model memory.',
    '- "research" = real WEB research (search → fetch → distill → multi-lens synthesis), bounded by',
    '            field "research".rounds (1..4, default 1). Two knobs shape the depth:',
    '              - "lensCount" (1..6, optional) = how many expert lenses to author/cover; wide = more angles,',
    '                narrow = one tight frame. Default = conductor self-decides.',
    '              - "k" (1..12, optional) = retrieval recall cap (how many candidate URLs the search layer pulls).',
    '                Distinct from lensCount: k widens the candidate pool, lensCount widens the synthesis.',
    '            Use whenever the node needs CURRENT external facts (docs, APIs, prior art, "what do people do',
    '            about X"). A node that fails to fetch a single real page FAILS — so never use it for questions',
    '            answerable from the repo alone.',
    '- "agent" = a tool-using sub-agent (read / edit / write / bash). Use ONLY for nodes that must touch',
    '            files or run commands; scope each agent node to ONE atomic artifact (e.g. a single file).',
    '- "command" = run a deterministic CLI (field "command", e.g. "codegraph trace A B") with NO model.',
    '            CHEAPEST — use for indexed lookups / scanners / tool retrieval / typecheck+test self-verify.',
    '            You MAY chain sequential verification steps with && (e.g. "bun run tsc --noEmit && bun test");',
    '            each link is gated independently. Other shell operators (; | $() ` redirects) are REJECTED.',
    '            Field "expect_exit" (0..255, default 0) sets which exit code counts as SUCCESS. Use it for a',
    '            Field "expect_output" is a SUBSTRING the output must contain, ANDed with expect_exit.',
    '            An exit code cannot tell "ran and passed" apart from "never ran anything" — a test',
    '            command with a wrong path exits 0 having tested nothing. Name a string only a real run',
    '            produces (a count, the test file name) and that whole class of false green is closed.',
    '            RED step — "prove the new test fails before the implementation exists" is expect_exit:1 on the',
    '            test command. Do NOT try to negate a command in the shell (! / ; / $?): those are rejected.',
    '- "map"  = runtime dynamic fan-out (field "map"): a lister enumerates an array AT RUNTIME, then a',
    '            per-element template spawns one child per item. Use when the work-list is unknown until run',
    '            time (see the "Runtime work-list" section below).',
    '- "conductor" = runtime HETEROGENEOUS decomposition: when it runs, it plans its own sub-graph and',
    '            schedules it. Use ONLY when HOW to break this step up depends on what upstream produces',
    '            ("decide the split after reading the research"). Costs one extra planning call plus a',
    '            layer of indirection — if you can name the steps NOW, name them now instead. Not for',
    '            "the same thing N times" (that is "map"). Its children may NOT be map/conductor.',
    '            See the runtime-decomposition shape below for when NOT to use it.',
    'Default to "leaf" unless the node needs tools/CLI/web. Only "map"/"conductor" spawn DAG sub-nodes.',
    'HARD RULE — file producers MUST be "agent": if a node CREATES or MODIFIES any file (its job is to',
    '  implement/write/生成 a path like src/x.ts), it MUST set executor:"agent" AND output_type:"file"',
    '  (set output_path too). A "leaf" CANNOT touch the filesystem — a leaf told to write a file silently',
    '  produces NOTHING (returns text, node reports done, no artifact). NEVER use "leaf" for an',
    '  implementation/build node. "Default to leaf" applies only to text-deliverable nodes (analysis/design/research).',
    // 2026-08-09 补 (S2 图 reachability-entry 实测: 验证节点被标成产文件 → 产物闸 filesTouched
    // 空误杀, 级联砍下游)。执法端 = 引擎 empty-artifact 判词已带同款自纠指引, 这里管画图端。
    'MIRROR RULE — verification/check nodes MUST NOT declare artifacts: if a node only VERIFIES/inspects',
    '  (runs tests, greps, compares, audits) and is not expected to write any file, set output_type:"none"',
    '  (no output_path). Declaring output_type:"file" on a no-write node makes the artifact gate fail it',
    '  for the crime of doing exactly its job.',
    // g1 leaf 档位判据 (图「引擎墙钟与 leaf 档位」#9, 2026-08-04)。这段是**教学**, 执法在
    // plan/leaf-tier-gate.ts (prompt 规则不可证伪, 闸红/绿可证伪 —— 违规 plan 会被拒回重画)。
    'HARD RULE — big content enters via PROMPT (billed once), never via an agent tool loop (the loop',
    '  re-sends the whole conversation EVERY turn — measured 6x token replay on a 1.2MB corpus): if a',
    '  node only READS paths already determinate (named in the goal, or produced by a lister) and its',
    '  deliverable is structured output with NO file writes, do NOT use executor:"agent". Emit a',
    '  "command" node feeding a "leaf" via depends_on — content reaches the leaf prompt at',
    '  one-time cost. Keep "agent" for nodes that must DECIDE what to read next from content, modify',
    '  files, or run verification. Explore-then-hand-off: an agent/lister may LOCATE, but re-reading goes',
    '  to command+leaf pairs (via executor:"conductor" when the list exists only at run time). Optional',
    '  field "content_bytes" (estimated bytes the node must ingest) helps the engine pick the route.',
    '  KEEP PER-SOURCE IDENTITY when reading many files: ONE file per node ("cat <path>", e.g. a map',
    '  template over the list), or if you must bundle, use "tail -v -n +1 <paths>" which prints an',
    '  "==> path <==" header per file. A bare "cat a b c" concatenates with NO separators — the leaf',
    '  then cannot tell which file said what and will invent citations (measured: keywords 5/8 right,',
    '  source attribution 0/8). Never bundle when the deliverable must attribute facts to sources.',
    '',
    'Scheduling / allocation fields (all optional; the engine enforces them — set only where the default is wrong):',
    '- "requires": how many done dependencies a node needs to run: "all" (default for ≤1 dep — any failed dep',
    '  SKIPS this node), "any" (default for ≥2 deps — survives sibling failures), or an integer K (run only',
    '  when ≥K deps succeeded, e.g. a judge needing 3 candidates). Set "all" explicitly on a synthesis that',
    '  MUST see every input; leave the defaults elsewhere.',
    '- "cluster": short workstream label ("research"/"backend"/"frontend"/...) on nodes forming one strand.',
    '  It groups progress display and keeps one model along a same-cluster chain (prompt-cache affinity).',
    '  Label honestly — do not force unrelated nodes into one cluster.',
    '- "tier": "strong"|"mid"|"cheap" — override the model-strength floor for THIS node. Reserve "strong"',
    '  for judging/synthesis that gates the run; "cheap" for mechanical enumeration. Omit for the default.',
    '- "attach_media": true on a leaf whose job is to LOOK AT images (UI screenshots, diagrams, renders).',
    '  The engine parses image paths from the node\'s DIRECT predecessor outputs and feeds the actual images',
    '  to a multimodal model — so its predecessor must OUTPUT the image path(s) (e.g. a "command" render',
    '  node that prints screenshot paths). A media node whose predecessors yield no existing image FAILS.',
    '- Plan-level "outputs": [node ids] — declare the final deliverable nodes; the engine then prunes any',
    '  node that neither feeds an output nor is a file/git/command node. Declare it when the deliverable',
    '  set is clear (dead branches cost real tokens).',
    '',
    ...(lean
      ? []
      : [
    'Node goal phrasing (genre): when the task asks to DESIGN / BREAK DOWN / DESCRIBE / PLAN / ANALYZE',
    '(the deliverable is TEXT, not a side effect), each node\'s "goal" must PRODUCE that piece of content',
    '— e.g. "describe step 2 / design the review for X / list the checks" — NEVER "execute / perform / run',
    'step X". Action-verb goals belong only to executor:agent/command nodes that genuinely touch files or',
    'run tools; phrasing a leaf goal as "execute …" makes the model fake-perform it and fabricate data.',
    '',
        ]),
    ...commandGateRules(),
    '',
    'Runtime work-list → executor:"map" (do NOT hallucinate a command that enumerates AND processes):',
    'When the SET of items to process is UNKNOWN at plan time — audit EACH module, research EACH lens,',
    'fix EACH failing test, process EACH discovered file — you cannot name them now. Do NOT collapse the',
    'fan-out into one fabricated command (e.g. a made-up "tools/audit-all.ts"): that invents a tool that',
    'does not exist. Emit ONE node with executor:"map": a "lister" sub-step produces the array AT RUNTIME,',
    'and a per-element "template" fans out one child node per item. Shape (field "map"):',
    '  { "lister": { "goal"?, "executor"?: "leaf"|"agent"|"command", "command"?, "output_schema"? },',
    '    "over": "<array key the lister returns>", "itemVar": "<var the template interpolates, e.g. item>",',
    '    Template strings interpolate ${item.field} / {{item.field}} (both accepted; also ${key}) in',
    '    goal / command / persona / output_path — the engine substitutes REAL item values at expansion.',
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
    ...(lean
      ? [
          'Field "persona" (optional): ONE line ROLE + first-principles lens to condition a weak executor',
          'into its expert region (research/judgement/design leaves only; omit for mechanical/command).',
        ]
      : [
    'Expert framing (field "persona", optional): condition a weak executor into the EXPERT REGION of its',
    'distribution. A persona is ONE line = ROLE + VIEWPOINT/first-principles lens, MATCHED to the leaf',
    'genre — never a bland title ("expert"/"engineer" alone barely conditions; the sharper the role+lens,',
    'the more probability mass moves). Match the register to the work:',
    '- research / judgement / hard design → expert-theorist depth: name the role AND its governing lens,',
    '  e.g. "分布式系统 PhD (CALM/单调性视角)" · "前沿战略分析师 (二阶效应/反身性视角)".',
    '- impl / drafting → senior practitioner + a stance, e.g. "资深 Bun/TS 工程师 (删减优先, 最小接口)".',
    '- mechanical / file / command → OMIT persona (framing adds nothing, just wastes tokens).',
        ]),
    // D-Q 检测者。**只在 conductor 节点自己画的子图里**有消费者 (环在那儿) —— 顶层图上设了引擎
    // 会 WARN 并忽略。2026-07-30 撞出来的教训: 一个只有 conductor 能放、却又不告诉 conductor 的
    // 字段, 就是没有生产者的空旋钮。所以要么明示它, 要么删掉它 —— 中间态最坏。
    // whenNot 写得比 when 更长是刻意的 (同 runtime-decomposition 图式): 检测者是**额外一个节点**,
    // 默认不该有; 只在"几段产出必须相互对得上"这个 command oracle 表达不了的形状上才划算。
    // 2026-07-30 实测 (n=12, scripts/eval-detector-usage.ts): 上一版把这段写成"能力介绍",
    // 结果是**形状率 92% / 使用率 8%** —— conductor 几乎每次都画了那个交叉检查节点, 却几乎从不
    // 标那个字段 (缺口 83%)。所以这一版改成**挂在它已经会画的形状上的祈使句**: 先说"你只要画了
    // 这种节点就必须标", 再说它是干什么的。滥用率上一版是 0%, whenNot 因此收成一行。
    // 第三版 (2026-07-30 下午): 第二版留下的 20% 缺口**不是"忘了写字段"**, 读原始 plan 看到的是
    // 三条各不相同的因, 这一版逐条堵:
    //   ① prompt **自相矛盾**: 「PREFER command 检测者」对上「有 command oracle 就别加 detector」——
    //      模型自己手写了个 `node -e` 比对命令, 于是判定"我已经有 oracle 了", 不标。那句 whenNot
    //      本意是"现成的项目检查 (tsc/test)", 却被读成"任何命令"。→ 收窄成 OFF-THE-SHELF, 并正面
    //      说清: **手写的比对命令本身就是检测者**, 自己写了比较逻辑不替代这个字段, 恰恰需要它。
    //   ② 「让节点失败 / exit 1」被当成反馈通道 (两个样本都这么写)。→ 明说裁决是**印出来的那一行**,
    //      不是退出码。(引擎侧同日补了网: 失败检测者印出的裁决不再被吞 —— 但那是兜底, 不是正路。)
    //   ③ 滥用的唯一形态: **单产出**的"完备性/质量 review"被标 detector (n=15 里 2 次, 两次都只
    //      依赖 1 个产出节点)。→ ≥2 从"触发条件"提成**硬前提** (NEVER), 与轮末 judge 划清界。
    'RULE — if you draw a node that depends on ≥2 sibling nodes in order to CHECK WHETHER THEY AGREE',
    '(consistency / no-conflict / same-assumptions / cross-check), you MUST put "detector": true on it.',
    'This holds however you implement it: a hand-written `node -e` / grep / diff command that compares the',
    'siblings IS the detector — writing the comparison yourself does not replace the field, it is what needs it.',
    'Without that field its findings are just text nobody acts on; with it the engine reads its output as',
    'a VERDICT and feeds it back into the loop:',
    '  `REJECT: <sibling node id>`  → that sibling\'s output is not accepted; the loop redoes it next round',
    '  `BLOCKED: <one-line reason>` → no amount of retrying helps without outside input; the loop stops',
    'Name siblings by the ids YOU write in this plan (the engine translates them to runtime ids).',
    'The verdict is what you PRINT, not the exit code — print those lines and exit 0. Failing the node',
    'on a conflict is not the channel; it just adds a red node the loop then has to explain away.',
    'PREFER executor:"command" (`echo "REJECT: <that id>"` is deterministic and cheaper than a model call);',
    'a "leaf" detector works too. It only has an effect inside a conductor node\'s OWN sub-graph.',
    'NEVER put "detector" on a node with fewer than 2 producing dependencies: a single-producer',
    '"is it complete / is it good?" review is the ROUND JUDGE\'s job, and marking it just wastes a node.',
    'Also skip it when an OFF-THE-SHELF project check already decides (tsc / lint / `bun test`).',
    'Keep the graph acyclic.',
    ...roster,
    ...templateSection,
    ...profileSection,
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
    '',
    ...renderShapesForPrompt(lean ? 'lean' : 'full'),
    '',
    'Output STRICTLY one JSON object, no prose, matching:',
    '{ "name": string, "description"?: string, "outputs"?: string[],',
    // "skill" 从明示 schema 撤下 (2026-07-25 ponytail): 执行层无 skill 加载器, 该字段只会渲染成一行
    // 无载荷文字 — 别邀请 conductor 相信一个不存在的通道。zod 层保留容忍 (daemon 遗产/旧 plan 兼容)。
    // "agent" 2026-07-26 从明示 schema 撤下 (同 skill 的理由): executor-dag 零消费者 —— 分流只看
    // executor/model; 而 conductor 每轮重掷这个字段, 反而系统性打空 D-21 跨轮语义复用
    // (semantic-key 为此把它排除在指纹外)。zod 层仍容忍旧 plan。
 '  "nodes": { "<node_id>": { "goal"?: string, "persona"?: string, "profile"?: string, "template"?: string, "mcp"?: string[] (server name or "server:tool" — an unregistered server makes the whole plan INVALID, like "template"),',
    '    "args"?: object, "depends_on"?: string[], "executor"?: "leaf"|"agent"|"command"|"map"|"conductor", "command"?: string, "expect_exit"?: number, "expect_output"?: string, "creative"?: boolean,',
    // detector 进形状 (2026-07-30): 散文里提一嘴不算明示 —— 「明示即承诺」的闸判的就是这份
    // **conductor 照抄的形状**, 而不在形状里的字段它基本不会写。放在 max_nodes 旁边是因为两者
    // 同属"子图那一层"的东西 (顶层图上设 detector 引擎会 WARN 并忽略)。
    // v4 (2026-07-30 第三臂): v3 的三条散文修完, 缺口里 4/6 仍是**手写 node -e 比对 + 冲突退出 1**,
    // 2/6 是没有裁决通道的文字比对 —— 也就是散文一条都没转化掉。所以把约束挂到它**逐字照抄的
    // 那一行**上: 模型写每个节点时对着的是这份形状, 不是 40 行以上的字段说明墙。
    // 刻意不用 `//` 注释: 这份形状里一条注释都没有, 引进注释语法等于邀请它在输出的 JSON 里也写
    // 注释 (那会直接解析失败)。用括号补语, 与 "requires"?: "all"|"any"|number 同一个 register。
    '    "max_nodes"?: number, "detector"?: boolean (MUST be true on any node that cross-checks ≥2 siblings),',
    // #248 (2026-08-24): S1 四字段进 shape (former declaredFields 正则只认 [a-z_]+, 物理不可见
    // camelCase —— D-5 改正则)。oracleKind 枚举措辞与 PlanSchema zod 一致;budgetBasis 字段名
    // 全用 zod 的字面 (不带引号的外键也算 shape 的形状契约)。每字段一行 when/whenNot 短注,
    // 照 detector / self_check 字段先例的 (parens) register。
    '    "oracleKind"?: "cheap"|"render"|"judge"|"none"|"self_built" (REQUIRED; UI output MUST NOT be "none" — see PP-O01),',
    '    "toolRefs"?: ["<source>:<name>@<ver>"] (REQUIRED; entries not in working-set rejected at critique — PP-T01),',
    '    "whyNoFanout"?: string|null (REQUIRED non-null when executor is single-leaf; null = "no reason given"),',
    '    "budgetBasis"?: { "calls": number, "tokensIn": number, "tokensOut": number, "costUsdCeiling": number, "estimatedBy": string } (per-node cost estimate; critique only checks presence — values not gated),',
    // P1 D-3 (2026-08-21): self_check = 节点级确定性判据, 让 leaf 在内环将停时跑一条命令验自己;
    // 退出码不合则同节点再转一轮 (有界)。**只对** output_path 存在的产物节点写: 这一类节点才会
    // 「交付物长什么样」可被外部命令判; 抽象节点 (analysis / research / drafting) 写它 = 逼模型
    // 给自己的观点想一条退出码, 那是本仓 P2 空旋钮的全貌。命令承接 `command` 节点的同一道闸
    // (白名单/元字符); expect_exit 缺省 0, 0..255。
    '    "self_check"?: { "command": string, "expect_exit"?: number, "expect_output"?: string } (only on output_path nodes),',
    '    "map"?: { "lister": object, "over": string, "itemVar": string, "keyBy"?: string, "template": object, "maxItems"?: number },',
    // "postcondition" 2026-07-28 从明示 schema 撤下 (同 skill/agent 的理由, 空旋钮全仓扫): 全仓零消费者,
    // 引擎从不检查它。明示它比明示 skill 更坏 —— 那是在请 conductor 给"正确性敏感的节点"写验证条件,
    // 写完没人看: 是验证的样子而不是验证, 还会把它从**真的会跑**的 command / judge 节点那条路上引开。
    // zod 层仍容忍旧 plan; 指纹已排除 (semantic-key)。
    '    "output_type"?: "structured"|"file"|"git"|"none", "output_path"?: string,',
    '    "content_bytes"?: number (estimated bytes of content this node must ingest — see the big-content HARD RULE),',
    '    "requires"?: "all"|"any"|number, "cluster"?: string, "tier"?: "strong"|"mid"|"cheap", "attach_media"?: boolean,',
    '    "kind"?: "primitive", "primitive"?: "parallel"|"pipeline"|"loop-until"|"verify"|"judge"|"discovery"|"iterate"|"tournament"|"router"|"race"|"escalation"|"saga"|"escape-hatch", "params"?: object } } }',
    // A8 (2026-07-31): 可信边界规则进**冻结前缀** —— 规则是静态文本 (进得了 prompt cache),
    // 每轮现生成的 token 值走动态段。两者分开放正是为了不让一次注入防御把缓存打掉。
    TRUST_FENCE_RULE,
  ].join('\n');
}

/**
 * escalation patch 模式的冻结 system prompt (SDD v2 S3.6, D-21/G-21 强化)。
 * 信任反转: 不再要求重规划 conductor「逐字保留」整图 (S3.5 实证跨 LLM 重措辞漂移, 4 采样 1 中),
 * 改为只输出节点补丁 JSON — 引擎程序化 merge, 未补丁节点字节不动 → 复用按构造成立。
 * 字节稳定冻结前缀 (PLAN-1 同哲学); 上轮 plan JSON + 失败原因走 user 消息动态尾部。
 */
/**
 * `executor:"command"` 的**环境事实**(白名单 / 元字符 / git 只读 / expect_exit)——
 * 规划 prompt 与**补丁重规划 prompt** 共用的单一真源。白名单是真源导出的常量, 表变了两份 prompt
 * 自动跟着变。
 *
 * 立这个函数的理由不是"复用好看", 是 **2026-08-01 live 实测 (3/3 跑) 抓到的洞**: 这段事实此前
 * 只在规划 prompt 里, 而 `conductorPatchSystemPrompt` 是自足的十几行、一个字都没有 —— 于是
 * **escalation 重规划轮的 conductor 对闸是瞎的**。实测它把一个合法的 `expect_exit:1` 节点改写成
 * `grep …; rc=$?; test "$rc" -eq 1` (正是规划 prompt 明文禁止的 shell 取反), 把另一个改写成
 * `$(cat …)` 命令替换, 两条都撞注入闸 → 退出码 -1 → gate-rejected。
 *
 * 后果是**假红**: 合法验证步被闸拦下, 而读数上看起来是"这一步失败了"。这恰是当初把白名单塞进
 * 规划 prompt 时写下的那条判据 (「conductor 只能猜, 猜错就是假红」) —— 当时只补了一条路,
 * 修复轮那条一直空着, 而修复轮偏偏是最需要它的时候 (它专门在改被判失败的节点)。
 */
export function commandGateRules(): string[] {
  return [
    `executor:"command" — allowed binaries (first token MUST be one of these, else the node is REJECTED`,
    `unrun): ${DEFAULT_COMMAND_ALLOWLIST.join(' ')}.`,
    `Also blocked: shell metacharacters ; | & \` $ ( ) < > \\ and newlines (chain steps with && instead —`,
    `each link is gated separately); git is READ-ONLY (${GIT_READONLY_SUBCOMMANDS.join('/')} only — never`,
    'checkout/commit/add/push); no writes (rm/mv/cp/mkdir), no network (curl/wget), no env dumping.',
    'A step that must SUCCEED on a non-zero exit (prove a test is red) sets field "expect_exit" (0..255) —',
    'do NOT express it in the shell (! / ; / $? / $() are all rejected, so such a node can never run).',
    'Need anything outside this set? Use executor:"agent" (it has real tools) — do NOT invent a command.',
  ];
}

export function conductorPatchSystemPrompt(): string {
  return [
    'You are the CONDUCTOR in REPLAN-PATCH mode. A previous run of the plan (given below the boundary)',
    'FAILED verification. Your job is to fix the plan with the SMALLEST possible patch — the engine',
    'merges your patch into the previous plan programmatically, and every node you do NOT mention is',
    'reused verbatim WITHOUT re-running (that is the point: unchanged nodes cost zero tokens).',
    '',
    'Output STRICTLY one JSON object, no prose, matching:',
    '{ "patch": { "<node_id>": { <only the fields you change> } | null, ... }, "outputs"?: string[] }',
    'Patch semantics (per node id):',
    '- an OBJECT is shallow-merged into the existing node: include ONLY fields you change;',
    '  set a field to null to REMOVE that field from the node.',
    '- null DELETES the node — you must then also patch the depends_on of every node that referenced it.',
    '- an id NOT in the previous plan ADDS a new node (give its full fields, same schema as planning).',
    '- an empty patch {} means: the topology is fine, just re-run whatever failed.',
    '"outputs" (optional) REPLACES the plan-level outputs array.',
    '',
    'Rules: keep the graph acyclic; only fix what the verification failure names — do NOT rewrite,',
    'rephrase, or "improve" nodes that were not blamed (any touched node re-runs and burns tokens).',
    '',
    // 修复轮最常改的就是验证节点, 而它此前看不见闸 → 改出来的命令被拒 = 假红 (见 commandGateRules)。
    ...commandGateRules(),
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
