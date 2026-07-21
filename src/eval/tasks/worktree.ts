/**
 * src/eval/tasks/worktree —— reuse-own benchmark fixture 的**隔离机制** (SDD O1/O2)。
 *
 * 为什么 worktree 而非裸 /tmp 拷 N 文件: 目标模块的测试会 import sibling (conductor-plan/executor-dag/…),
 * 裸拷解析不了跨模块 import (见早期 fleet 版的已知限制)。git worktree = HEAD 的全量 checkout, 所有依赖
 * 天然在位; 放在 repo 根下的 .omd/eval-worktrees/ (已 gitignore), bun 从嵌套目录**向上解析**到根
 * node_modules (pre-flight 已验)。
 *
 * stub 策略: **清空目标文件** (换成指向 EVAL_SPEC.md 的桩头), 不做 brace-level 挖空 (脆弱, 遇字符串/
 * 注释里的括号即错)。清空 = 最鲁棒 + 最贴 Cursor 原实验 (只给 spec+测试, 无源码), 让 fleet 照 SPEC 与
 * colocated 测试从零重建 —— firstShot tsc/test 必红 (fraction 0), 正是预期起点。
 *
 * INV-3 (钉 public API): 测试 import 面 = 事实契约; INV-2 (隐藏 oracle): 判分靠 worktree 里的测试套件,
 * 被测 fleet 在同一 worktree 里干活但看不到"标准答案实现"(已清空)。
 */
import { $ } from 'bun';
import { randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const STUB_HEADER =
  '// EVAL FIXTURE —— 实现已移除。照本目录 EVAL_SPEC.md 重建本模块, 使其 colocated 测试转绿;\n' +
  '// 保持测试所 import 的 public API 面 (导出名/签名) 不变。\n';

export interface WorktreeFixtureOpts {
  /** base id → worktree 目录名 (.omd/eval-worktrees/<id>-<uuid8>, F4 内部加唯一后缀防并发撞)。 */
  id: string;
  /** repo 根 (默认 cwd)。 */
  repoRoot?: string;
  /** checkout 的 ref (默认 HEAD)。 */
  ref?: string;
  /** 被清空的目标模块 (repo-relative) —— fleet 照 SPEC 重建它们。 */
  targetPaths: string[];
  /** 构成 oracle 的测试 (repo-relative)。 */
  testPaths: string[];
  /** 描述所需行为的 prose spec (替代被移除的实现, 写进 worktree 的 EVAL_SPEC.md)。 */
  spec: string;
}

export interface WorktreeFixture {
  /** worktree 绝对根 (作 dag-build --cwd; 依赖可解析, node_modules 走向上解析)。 */
  root: string;
  /** oracle 命令 (whole-project tsc + scoped test)。 */
  oracleCmd: string;
  targetPaths: string[];
  testPaths: string[];
  spec: string;
  /** 摘 worktree + 删目录 (幂等)。用后必调 (afterAll / finally)。 */
  cleanup(): Promise<void>;
}

/** 建一个隔离 worktree: checkout HEAD → 清空目标 → 写 SPEC。返回句柄 + cleanup。 */
export async function createWorktreeFixture(opts: WorktreeFixtureOpts): Promise<WorktreeFixture> {
  const repoRoot = resolve(opts.repoRoot ?? process.cwd());
  // F4: id 加唯一后缀 → 两个 ④ run 并发时 base id 相同也各占各的 worktree, 不撞 (原固定 id 会争同一目录)。
  const rel = join('.omd', 'eval-worktrees', `${opts.id}-${randomUUID().slice(0, 8)}`);
  const root = join(repoRoot, rel);

  // 幂等: 摘掉同名残留 worktree + 删目录, 再新建。
  await $`git worktree remove --force ${rel}`.cwd(repoRoot).quiet().nothrow();
  await rm(root, { recursive: true, force: true }).catch(() => {});
  await $`git worktree add --detach --force ${rel} ${opts.ref ?? 'HEAD'}`.cwd(repoRoot).quiet();

  for (const t of opts.targetPaths) {
    await writeFile(join(root, t), STUB_HEADER, 'utf8');
  }
  await writeFile(join(root, 'EVAL_SPEC.md'), opts.spec, 'utf8');

  return {
    root,
    oracleCmd: `bun run tsc --noEmit && bun test ${opts.testPaths.join(' ')}`,
    targetPaths: opts.targetPaths,
    testPaths: opts.testPaths,
    spec: opts.spec,
    cleanup: async () => {
      await $`git worktree remove --force ${rel}`.cwd(repoRoot).quiet().nothrow();
      await rm(root, { recursive: true, force: true }).catch(() => {});
    },
  };
}
