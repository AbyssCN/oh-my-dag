/**
 * **PlanNode schema 字段 → 消费点 全量登记表** (2026-07-30, 欠了三份交接的那份)。
 *
 * 这是**数据**, 它的闸在 `schema-field-registry.test.ts` (每一列都有确定性 oracle 在核:
 * 指纹归属比键, 明示列扫 conductor prompt, 覆盖面走 zod 内省), 人读版由
 * `scripts/gen-schema-registry-doc.ts` 从这里生成 —— 三处同一个真源, 不手抄。
 *
 * 为什么值得单独存在 (`empty-knobs.test.ts` 已经守住一半): 那一半只管**被 prompt 明示的**字段。
 * 而一个字段可以不进 prompt 却活在 schema 里 (手写 plan 的逃生口: `thinking` / `judge_final` /
 * `detector` / `max_rounds`), 也可以零消费者却被 zod 容忍着 (`agent` / `postcondition` / `leaf`)。
 * 这两类都不受那个闸约束, 而 P2 空旋钮全仓扫撞见的五次缺陷里有三次正是它们。
 */
import type { ConductorPlan } from './conductor-plan';

export type PlanNodeField = keyof ConductorPlan['nodes'][string] | string;

/**
 * 指纹归属**是三态不是两态** —— 这条是写这张表时被 oracle 当场纠正的:
 *  - `'fields'`: 进 `nodeFieldsKey` (节点自身的语义字段序列化)。
 *  - `'merkle'`: **不在** `nodeFieldsKey` 里, 但经 Merkle 递归进指纹 —— 只有 `depends_on` 是这样,
 *    而且这是刻意的: 指纹存的是**前驱的指纹**而不是它们的 id, 于是 conductor 跨轮重命名节点
 *    不破匹配 (id 刻意不入指纹)。写成两态会逼人在"漏了"和"撒谎"之间选一个。
 *  - `false`: 不进指纹 (改它不影响判重与跨轮复用)。
 */
export type FingerprintKind = 'fields' | 'merkle' | false;

export interface FieldEntry {
  /** 引擎消费点 (`file.符号` 级)。`—` = 无消费者 (仅 zod 容忍旧 plan, 见 note)。 */
  consumer: string;
  /** 指纹归属 (三态, 见 FingerprintKind)。 */
  fingerprint: FingerprintKind;
  /** 是否进 conductor prompt 的明示形状 (= 是否邀请规划者写它)。 */
  declared: boolean;
  /** 为什么是这个归属 —— 尤其是"有消费者却不明示"与"零消费者却留着"两类。 */
  note: string;
}

/**
 * 全量登记表。字段顺序照 schema 声明序 (改 schema 时对照着改这里最省事)。
 * 导出是给 `scripts/gen-schema-registry-doc.ts` 用的 —— 人读版那张表由它生成, 不手抄。
 */
export const REGISTRY: Record<string, FieldEntry> = {
  agent: {
    consumer: '—',
    fingerprint: false,
    declared: false,
    note: 'SAMPO roster 指派, omd 引擎不消费; conductor 每轮随机指派 → 入键会系统性打空 D-21 跨轮复用 (2026-07-25 实证)。zod 留容忍, 明示已撤。',
  },
  skill: {
    consumer: 'executor-dag-planner.buildLeafPrompt (写进 prompt 的一行 `Skill:`)',
    fingerprint: 'fields',
    declared: false,
    note: '有消费者但只是 prompt 的一行文本, 不改变执行形态; 明示已撤 (2026-07-28) 免得 conductor 拿它当能力开关用。',
  },
  goal: { consumer: 'executor-dag-planner.buildLeafPrompt', fingerprint: 'fields', declared: true, note: '节点要干的事本身。' },
  args: { consumer: 'executor-dag-planner.buildLeafPrompt', fingerprint: 'fields', declared: true, note: '进 prompt 的结构化参数。' },
  depends_on: {
    consumer: 'executor-dag.executePlan (topo/ready-set 调度 + fan-in 注入)',
    fingerprint: 'merkle',
    declared: true,
    note: '⚠ 指纹里**不存 dep 的 id 而存 dep 的指纹** (Merkle), 故重命名不破匹配 —— 见 merkleFingerprints。',
  },
  postcondition: {
    consumer: '—',
    fingerprint: false,
    declared: false,
    note: '零消费者。2026-07-28 撤明示: 两个 conductor prompt 曾主动教「对正确性敏感的节点补 postcondition」而没有任何地方检查它 —— 是验证的样子, 不是验证。',
  },
  output_type: { consumer: 'executor-dag.runNodeOnce (producesFiles 判定 → agent 提升 + 产物闸)', fingerprint: 'fields', declared: true, note: '' },
  output_path: {
    consumer: 'executor-dag.runNodeOnce (producesFiles + 产物闸 + **跑前 hash 快照**救回 bash 写入)',
    fingerprint: 'fields',
    declared: true,
    note: '2026-07-30 起还是"经非受控工具写入"的唯一可核对锚 (没声明就不救)。',
  },
  output_schema: {
    consumer: 'fanin-summary (producer 声明则摘要按它出) + map lister 的 schemaNote',
    fingerprint: 'fields',
    declared: false,
    note: '⚠ 只在 **map.lister** 那一层被明示; node 顶层的同名字段不邀请 conductor 写 (它是 fan-in 摘要的形状约束, 由接线层/手写 plan 给)。',
  },
  write_set: {
    consumer: 'harness/write-set.attributeWriteSet (D-2 归属阶梯的声明面) + goal/run-goal 挂点',
    fingerprint: 'fields',
    declared: false,
    note: 'D-2 (SDD cairness-distill): ex-ante 写集声明, 可选字段声明了才对账 (O-1 收声明覆盖率读数)。声明集不同 = 越界判定面不同 → 语义, 入键。不明示: O-1 未裁默认开之前只收手写 plan 的声明 (不进 conductor prompt)。',
  },
  content_bytes: {
    consumer: 'plan/leaf-tier-gate.leafTierGateFindings (g1 图#9: 体量声明帮闸在「单 cat+leaf」与「conductor 展开 per-item 对」间选路)',
    fingerprint: false,
    declared: true,
    note: '体量**提示**不改节点语义 —— 入键会让预估值抖动打空 D-21 跨轮复用 (同 agent 字段的教训)。',
  },
  executor: { consumer: 'executor-dag.runNodeOnce (agent/command/research/map/conductor 分流)', fingerprint: 'fields', declared: true, note: '缺省归一为 leaf (省略与显式 leaf 同指纹)。' },
  max_nodes: { consumer: 'executor-dag.runConductorRound → plan/conductor-expand (子图硬顶)', fingerprint: 'fields', declared: true, note: 'D-B/D-D: 顶不同 = 允许展开的范围不同 = 不同的执行。' },
  max_rounds: {
    consumer: 'executor-dag.runConductorNode (内环轮数上限)',
    fingerprint: 'fields',
    declared: false,
    note: 'D-A: 跑 1 轮 vs 3 轮 = 不同深度的执行 (schema 钳 1..4, INV-GOAL-4 有界)。**不明示** —— 环的深度是调用方的成本决策 (goal 引擎按档设), 不该由规划者随手加轮。',
  },
  judge_final: {
    consumer: 'executor-dag.runConductorNode (终轮必判 → LeafResult.converged)',
    fingerprint: 'fields',
    declared: false,
    note: 'D-F: 程序构造节点时用的旋钮 (谁要裁决谁自己开), 不邀请规划者随手打开 —— 它每次都多花一次 judge 调用。',
  },
  detector: {
    consumer: 'executor-dag.runConductorRound (parseDetectorVerdict → 毒集 / BLOCKED 出口)',
    fingerprint: 'fields',
    declared: true,
    note: 'D-Q。⚠ 明示是**被迫的**: 它只在 conductor 自己画的子图里有消费者, 而子图只有 conductor 画得出来 —— 不告诉它就等于这个字段没有任何生产者 (空旋钮)。prompt 里的 whenNot 比 when 长, 压它别每张图都塞一个。',
  },
  command: { consumer: 'executor-dag.runNodeOnce (commandRunner)', fingerprint: 'fields', declared: true, note: '' },
  expect_exit: { consumer: 'executor-dag.runNodeOnce (command 分支判 done 的期望退出码)', fingerprint: 'fields', declared: true, note: 'D-K: 期望绿 (0) 与期望红 (1) 是**相反**的验收, 不入键会让 verify-red / verify-green 判重串味。' },
  research: { consumer: 'executor-dag.runNodeOnce (researchRunner 的 k / rounds)', fingerprint: 'fields', declared: false, note: 'D-6: 同问题跑 1 轮 vs 4 轮 = 不同深度。明示面是 `executor:"research"`, 旋钮本身不明示。' },
  map: {
    consumer: 'executor-dag.runMapNode → plan/map-expand',
    fingerprint: 'fields',
    declared: true,
    note: '⚠ 指纹**含** map spec (D-21 对 map 节点保守但正确), 但 **dedup 层整节点不判重** (D-20 v1 保守) —— 两个 pass 对它的待遇不同, 别合并理解。',
  },
  kind: { consumer: 'executor-dag.runNodeOnce (kind==="primitive" → runPrimitiveNode)', fingerprint: 'fields', declared: true, note: '' },
  primitive: { consumer: 'primitive-registry.compilePrimitive', fingerprint: 'fields', declared: true, note: 'enum 与 primitive-registry.PrimitiveId 同步 (改一处核两处)。' },
  params: { consumer: 'primitive-registry (paramsSchema 深校验 + run)', fingerprint: 'fields', declared: true, note: '' },
  creative: { consumer: 'executor-dag.runNodeOnce (caveman 档位路由 + fan-in 摘要豁免)', fingerprint: 'fields', declared: true, note: '' },
  persona: { consumer: 'executor-dag-planner.buildLeafPrompt', fingerprint: 'fields', declared: true, note: '' },
  template: { consumer: 'executor-dag.runNodeOnce (agent-templates 查卡 → prompt 前缀 + 卡片 model)', fingerprint: 'fields', declared: true, note: '未知名规划期被 parsePlan 拒 (TPL-2)。' },
  mcp: {
    consumer: 'executor-dag.runNodeOnce (agentRunner 调用点: node.mcp ∪ 模板卡 mcp → mcpAllow → C-5 授权闸)',
    fingerprint: 'fields',
    declared: true,
    note: 'D-7 开放生态: 授权清单不同 = 外部 MCP 工具面不同 = 不同的执行。',
  },
  model: { consumer: 'executor-dag.runNodeOnce (TPL-3 显式坐标最高优先) + 调度期 channel 记账', fingerprint: 'fields', declared: false, note: '坐标该由座位分配表统一给; 明示会让 conductor 到处写死模型名。' },
  leaf: { consumer: '—', fingerprint: false, declared: false, note: '零消费者 (2026-07-28 空旋钮全仓扫)。zod 留容忍旧 plan。' },
  max_retry: { consumer: 'executor-dag.runNode (L0 节点级重试, 带上次败因)', fingerprint: 'fields', declared: false, note: 'D-11: 唯一的节点级恢复旋钮 (on_failure/fallback 已从 schema 删除)。重试次数不同 = 不同的执行与成本 → 入键。' },
  requires: { consumer: 'executor-dag.quorumSkip (D-7v2 级联)', fingerprint: 'fields', declared: true, note: '' },
  cluster: { consumer: 'stamp pass (D-22 链亲和) + HUD 分组', fingerprint: 'fields', declared: true, note: '纯元数据不进调度, 但它改变 stamp 的分配 → 是语义。' },
  tier: { consumer: 'stamp pass (D-17 选池档位)', fingerprint: 'fields', declared: true, note: '⚠ 子图**必须过同一条 pass 管线**, 否则 tier 在子节点上是哑弹 (D-N 修的那条)。' },
  thinking: { consumer: 'executor-dag.runNodeOnce (S-T 推理档, 显式最高优先)', fingerprint: 'fields', declared: false, note: '手写 plan / patch 的逃生口。⚠ 入键的理由是"档位在认档的家族上是语义", 不是"deepseek 上有效" —— 后者 200 次实测读不出差 (2026-07-29)。' },
  attach_media: { consumer: 'executor-dag.runNodeOnce (D-14v2 媒体 content parts)', fingerprint: 'fields', declared: true, note: '' },
};

