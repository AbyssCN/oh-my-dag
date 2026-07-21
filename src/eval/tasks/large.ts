export type EvalTaskSize = 'large';

export interface EvalTaskFixture {
  id: string;
  size: EvalTaskSize;
  description: string;
  oracleCommand: string;
}

/** Placeholder large reuse-own fixture (pathfinder subsystem). */
export function createLargeFixture(): EvalTaskFixture {
  // TODO(SDD O2): pathfinder subsystem 复用为大任务。fixture 应改 worktree-based stub —— 在仓库
  // clone/worktree 里只把目标模块 impl 替成桩, sibling 依赖 (conductor-plan/executor-dag/…) 天然可解析
  // (裸 /tmp 拷 N 文件解析不了跨模块 import, 见 tasks/oracle-plan-filter.test.ts 的已知限制注)。
  return {
    id: 'large-placeholder',
    size: 'large',
    description: 'TODO(SDD O2): pathfinder subsystem fixture (worktree-based stub).',
    oracleCommand: 'bun run tsc --noEmit && bun test',
  };
}
