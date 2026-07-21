/**
 * oracle-plan-filter reuse-own fixture (worktree 版, 取代早期裸 /tmp 版)。
 *
 * 目标 = src/harness/oracle-plan-filter.ts (73 行纯函数, 有 231 行 colocated 测试)。经 worktree 隔离:
 * 清空该模块 → fleet 照 SPEC + 测试重建。sibling 依赖 (conductor-plan) 在 worktree 里在位可解析。
 * 现阶段作 GWT-0b 冒烟 + O1 的 worktree 机制落点; medium/large 真任务集扩展见 SDD O1/O2。
 */
import { createWorktreeFixture, type WorktreeFixture } from './worktree';

/** filterOracleCommandNodes 的行为契约 (替代被清空的实现, INV-3 钉 public API)。 */
const SPEC = `# Oracle plan filter

实现 \`export function filterOracleCommandNodes(plan: ConductorPlan, oracleCmd: string): ConductorPlan\`
(从 './conductor-plan' import type ConductorPlan)。

Expected behavior:
- 规范化空白: trim 并把连续空白折叠成单个空格, 再比较。
- 当 command executor 节点的 node.command == 规范化 oracleCmd → 移除该节点。
- 当规范化 node.command 是规范化 oracleCmd 的子串 → 移除。
- 当 node.command 是 oracleCmd 的严格超集 → **不**移除。
- 移除一个节点时, 把下游 depends_on 里指向它的边改接到"该被移除节点的未被移除父节点"。
- 被移除节点无父 → 下游节点成为根 (不留悬空 depends_on)。
- 保留所有无关节点与图拓扑。无节点命中 → 原样返回 plan。
- 绝不放松 command-leaf 元字符封锁: 含 &&/|/; 的非 oracle 命令仍须被 command-leaf 测试拒绝。

oracle = 本目录 src/harness/oracle-plan-filter.test.ts 全绿 + whole-project tsc 无错。
`;

/** 建 oracle-plan-filter 的 worktree fixture (清空目标 + 留测试 + 写 SPEC)。用后调 .cleanup()。 */
export function createOraclePlanFilterFixture(opts: { repoRoot?: string } = {}): Promise<WorktreeFixture> {
  return createWorktreeFixture({
    id: 'oracle-plan-filter',
    repoRoot: opts.repoRoot,
    targetPaths: ['src/harness/oracle-plan-filter.ts'],
    testPaths: ['src/harness/oracle-plan-filter.test.ts'],
    spec: SPEC,
  });
}
