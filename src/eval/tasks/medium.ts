/**
 * medium reuse-own fixture (SDD O1) —— 3 个**互相独立**的纯函数模块小簇。
 *
 * 目的: 强制 conductor 拆多节点 (3 并行重建 + 验证), 是能真触发"分解"的最小 code 任务
 * (单模块只会出 1-2 节点, 见 SDD D1)。三模块互不 import; colocated 测试 = 各自 public API + 行为契约。
 * 经 worktree 隔离清空 → fleet 照 SPEC + 测试从零重建。oracle = 3 测试全绿 + whole-project tsc。
 */
import { createWorktreeFixture, type WorktreeFixture } from './worktree';

const TARGETS = [
  'src/harness/dag-mermaid.ts',
  'src/harness/slim/debt-scan.ts',
  'src/harness/arch/hotspots.ts',
];

const TESTS = [
  'src/harness/dag-mermaid.test.ts',
  'src/harness/slim/debt-scan.test.ts',
  'src/harness/arch/hotspots.test.ts',
];

const SPEC = `# Medium reuse-own 任务: 重建 3 个纯模块

重建下列 3 个**互相独立**的纯函数模块, 使各自 colocated 测试全绿、且 whole-project tsc 无错。
每个模块的**测试文件就是精确契约** (导出名 / 签名 / 行为), 照它们重建 —— 不要改测试。

1. src/harness/dag-mermaid.ts — planToMermaid(plan: ConductorPlan, opts?: MermaidOpts): string
   ConductorPlan → Mermaid flowchart 文本 (不含 \`\`\` 围栏)。command 节点画 [[双框]], agent 画 ([圆角]),
   其余 inproc leaf 画 [方框]; 带 results 时 failed 节点加 class failed; 节点 id 须 sanitize 防 mermaid 语法炸裂。

2. src/harness/slim/debt-scan.ts — parseDebtLine / scanDebtLines / formatLedger
   扫 \`// ponytail: <ceiling>, <upgrade>\` 结构化标记 (# 与 /* 前缀同理)。前缀强制: 注释符后仅隔空白紧跟
   ponytail: 才算 (散文/字符串里提到 ponytail: 不入账)。容错解析: 缺 upgrade 字段 → '-' (rot 风险行)。

3. src/harness/arch/hotspots.ts — countTouches / computeHotspots
   注入式 git-log 文本 (不自己跑 git) → 数文件触碰频率 → 按目录聚成 module 级热点 → 按触碰量取 top K。
   支持 scope 前缀过滤; 该前缀近期无触碰时仍返回一个空热点 (files=[]), 不因日志冷而短路。

oracle = 这 3 个测试文件全绿 (过测比例) + whole-project tsc 无错。`;

/** 建 medium worktree fixture (清空 3 目标 + 留测试 + 写 SPEC)。用后调 .cleanup()。 */
export function createMediumFixture(opts: { repoRoot?: string } = {}): Promise<WorktreeFixture> {
  return createWorktreeFixture({
    id: 'medium-3mod',
    repoRoot: opts.repoRoot,
    targetPaths: TARGETS,
    testPaths: TESTS,
    spec: SPEC,
  });
}
