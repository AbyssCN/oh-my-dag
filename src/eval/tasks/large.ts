/**
 * large reuse-own fixture (SDD O2) —— 11 个模块的**难度梯度**大任务簇。
 *
 * medium (3 模块) 的病: 每模块整体过/挂 → 有效分辨率 ≈ 模块数 ≈ 4 档, 量不出相近模型的小差距
 * (v2.5 vs v2.5-pro)。large 铺一条 易×5 → 中×4 → 难×2 的梯度: 弱模型在梯度不同点掉队, 强的多清几个,
 * 过测比例 (parseBunTest 按 test-case 汇总) 分布才连续、才拉得开。
 *
 * 机制同 medium: worktree 清空 11 目标 → fleet 照 SPEC + colocated 测试从零重建 → oracle = 11 测试
 * 过测比例 + whole-project tsc。选材约束: 都有 colocated 测试 (事实契约) + 带测试注入接缝
 * (clean 的 Python / query-expand 的模型 / map-store 的 sqlite 均可隔离重建, 不打真外部依赖)。
 *
 * 唯一 target 间耦合: map-store import pathfinder/types (俩都清空) —— types 是 49 行纯形状, 低风险,
 * fleet 先重建 types、map-store 测试再解析。其余 target 只 import 非 target sibling (留在 worktree)。
 */
import { createWorktreeFixture, type WorktreeFixture } from './worktree';

// ⚠️ 不变量 (2026-07-23, bwrap 隔离): 目标集**必须与 leaf-worker 运行时 import 闭包不相交**。
// eval leaf 在 bwrap jail 里从 **worktree 内**跑 (真隔离, 主 repo 不可见); worktree 清空目标 → 若某目标
// 又是 worker 启动依赖 (model/bootstrap→models-json), worker import 到空桩即崩、无法产物。故 model/models-json.ts
// (模型配置 infra, 本非好的"照 spec 重建"目标) 已移出。改目标集前跑 importtrace 确认不落进 leaf-worker 闭包。
const TARGETS = [
  // 易 ×5 (48–87 行, 纯函数/纯数据)
  'src/harness/pathfinder/types.ts',
  'src/harness/plan/sdd-template.ts',
  'src/harness/dag-mermaid.ts',
  'src/harness/slim/debt-scan.ts',
  'src/harness/arch/hotspots.ts',
  // 中 ×4 (73–185 行, 有依赖注入/分支逻辑)
  'src/harness/oracle-plan-filter.ts',
  'src/harness/web/query-expand.ts',
  'src/harness/debug/debug-plan.ts',
  'src/harness/web/clean.ts',
  // 难 ×2 (270–328 行, 大表/预设/三态互转)
  'src/harness/init/role-presets.ts',
  'src/harness/pathfinder/map-store.ts',
];

const TESTS = TARGETS.map((t) => t.replace(/\.ts$/, '.test.ts'));

const SPEC = `# Large reuse-own 任务: 重建 11 个模块 (难度梯度)

重建下列 11 个模块, 使各自 colocated 测试全绿、且 whole-project tsc 无错。
每个模块的**测试文件就是精确契约** (导出名 / 签名 / 行为), 照它们重建 —— 不要改测试。
各模块**互相独立** (唯一例外: pathfinder/map-store import pathfinder/types, 一并重建即可解析)。

## 易档

1. src/harness/pathfinder/types.ts — pathfinder 决策地图纯数据模型
   导出 type TicketType / TicketStatus / ExecutorKind (字面量联合) + interface Ticket / PathMap。
   Ticket = 一个待决问题 (blockedBy=前置票 id), PathMap = 跨 session 持久的决策 DAG。零逻辑, 只形状;
   测试断言字段结构与联合成员。

2. src/harness/plan/sdd-template.ts — /sdd canonical plan 的 SDD 增强段
   导出 const SDD_EXTRA_SECTIONS (字节稳定的骨架文本: 接缝/先红/oracle 硬闸/文件边界/review gate/D-number 决策表)
   + renderSddDoc(base: string): string (把增强段拼进传入的 base plan)。无时间戳/随机, 常量字节稳定。

3. src/harness/dag-mermaid.ts — planToMermaid(plan, opts?): string
   ConductorPlan → Mermaid flowchart 文本 (不含围栏)。command 节点画 [[双框]], agent 画 ([圆角]),
   其余 inproc leaf 画 [方框]; 带 results 时 failed 节点加 class failed; 节点 id 须 sanitize 防语法炸裂。

4. src/harness/slim/debt-scan.ts — parseDebtLine / scanDebtLines / formatLedger
   扫 \`// ponytail: <ceiling>, <upgrade>\` 结构化标记 (# 与 /* 前缀同理)。前缀强制: 注释符后仅隔空白紧跟
   ponytail: 才算 (散文/字符串里提到不入账)。容错: 缺 upgrade → '-' (rot 风险行)。

5. src/harness/arch/hotspots.ts — countTouches / computeHotspots
   注入式 git-log 文本 (不自己跑 git) → 数文件触碰频率 → 按目录聚成 module 级热点 → 按触碰量取 top K。
   支持 scope 前缀过滤; 该前缀近期无触碰时仍返回一个空热点 (files=[]), 不因日志冷而短路。

## 中档

6. src/harness/oracle-plan-filter.ts — filterOracleCommandNodes(plan, oracleCmd): ConductorPlan
   移除 plan 里与 oracle 命令等价或被其包含的 command 节点 (空白规范化后 command==oracle 或 command 是 oracle 子串;
   command 是超集则保留)。连通性: 删节点的下游 depends_on 重接到删节点的父依赖; 无父依赖则下游去掉该依赖变根。

7. src/harness/web/query-expand.ts — QueryExpander 类型 + parseRewrites / createModelQueryExpander / expandQueries + const EXPAND_SYSTEM
   检索 query 扩展。parseRewrites(raw, original): 从模型原始输出解析改写列表, 去重、含原 query、至少 1 条。
   expandQueries: 原 query + 全部改写并搜、按 URL 去重。红线: expander 是增益非链路, 调用失败退回单 query 不断链;
   注入接缝 → 测试永不真调模型。

8. src/harness/debug/debug-plan.ts — compileDebugPlan(opts): ConductorPlan + const SCOPE_NODE_ID/HYPOTHESES_NODE_ID/JUDGE_NODE_ID + interface DebugPlanOptions
   预构造固定形状 DAG (零 conductor LLM): scope_lock (只读锁范围) → hypotheses (map: 每假设一 verify-leaf) → judge。
   ⚠ scope_lock/verify-leaf 是只读探查, goal 措辞须避开强写信号词 (实现/创建/写入/生成/修改/... + 文件后缀),
   否则触发产物校验闸误判 empty-done (测试对此有回归守卫)。

9. src/harness/web/clean.ts — looksLikeRawHtml / stripHtmlToText / resolveCleaner + class TrafilaturaCleaner / PassthroughCleaner / CleaningFetchProvider + interface CleanResult/Cleaner + type CleanRunner
   HTML → 干净 markdown 正文。stripHtmlToText=纯 HTML 去标签; looksLikeRawHtml=启发判定;
   resolveCleaner=bin 缺失降级 PassthroughCleaner。runner 注入 → 单测不打 Python。

## 难档

10. src/harness/init/role-presets.ts — const ROLE_PRESETS (三档预设数组) + coordProvider(coord) + 各 BASE_URL 常量 + ROLE_ENV_ALLOWLIST + interface RolePreset 等
    角色模型矩阵预设 (wizard 数据源)。三档: base-opencode-go / cn-standard / cn-ultimate, 每档定 config 角色 + 自定 api +
    多模态池 + key prompt。coordProvider('provider:model')→'provider'。模型 id 字符串只住这里。字节稳定。

11. src/harness/pathfinder/map-store.ts — renderMapMarkdown / parseMapMarkdown (纯, roundtrip: parse(render(m))≡m) + saveMapDb / loadMapDb / rebuildDbFromMarkdown (bun:sqlite) + loadMap / saveMap / mutateMap + 路径 helper
    markdown ↔ PathMap ↔ SQLite 三态互转。markdown=真相源 (byte-stable 行式 kv, render∘parse 幂等), db=可重建索引。
    纯 render/parse 与落盘分离便于无盘单测。import pathfinder/types。

oracle = 这 11 个测试文件全绿 (过测比例) + whole-project tsc 无错。`;

/** 建 large worktree fixture (清空 12 目标 + 留测试 + 写 SPEC)。用后调 .cleanup()。 */
export function createLargeFixture(opts: { repoRoot?: string } = {}): Promise<WorktreeFixture> {
  return createWorktreeFixture({
    id: 'large-12mod',
    repoRoot: opts.repoRoot,
    targetPaths: TARGETS,
    testPaths: TESTS,
    spec: SPEC,
  });
}
