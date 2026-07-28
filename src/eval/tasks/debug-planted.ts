/**
 * debug-planted fixture (owner 2026-07-28) —— 测 **debug 能力**, 与 medium/large 的"照 spec 重建"正交。
 *
 * 为什么要单独一类: 重建题量的是"能不能照契约写出来", debug 题量的是"能不能在**已有正确代码**里
 * 定位一个不显眼的错"。后者才是 executor 日常真在干的事, 而且它的 ground truth 最硬 ——
 * bug 是我们亲手种的, 测试原本全绿, 种完必红, 修对必再绿。零判官。
 *
 * 种的是**语义 bug 不是语法 bug**: tsc 照样过, 只有测试会红 —— 逼模型真读逻辑, 不能靠编译器指路。
 * 且 SPEC **只给症状不给位置** (给了位置就退化成"照着改"), 定位过程本身是被测能力。
 *
 * 反作弊闸 (确定性):
 *   - 测试文件必须逐字节未改 (改测试让红变绿 = 作弊, 不是修复)
 *   - 未被种 bug 的文件不该被动 (改动面 = 精准度读数)
 */
import { $ } from 'bun';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createWorktreeFixture, type WorktreeFixture } from './worktree';

/** 一处种下的 bug: 在 file 里把 find 换成 replace。 */
export interface PlantedBug {
  id: string;
  file: string;
  find: string;
  replace: string;
  /** 这个 bug 为什么不显眼 (只作记录, 不进 SPEC)。 */
  why: string;
}

/**
 * 种 bug 清单。全部满足: ① 改完 tsc 仍过 ② 对应测试必红 ③ 肉眼扫一遍不易看出。
 * 选的都是**边界/方向/序**这类错 —— 与真实线上 bug 同型, 而不是"写错变量名"那种。
 */
export const PLANTED_BUGS: readonly PlantedBug[] = [
  {
    id: 'off-by-one-popcount',
    file: 'src/model/family-rotate.ts',
    find: 'for (let i = 0; i < n; i++) {',
    replace: 'for (let i = 0; i <= n; i++) {',
    why: '循环边界 off-by-one: 多轮一次, 结果数组长度多 1, 只有断言长度的测试会红',
  },
  {
    id: 'swrr-weight-sign',
    file: 'src/model/family-rotate.ts',
    find: 'current.set(pick, current.get(pick)! - totalW);',
    replace: 'current.set(pick, current.get(pick)! + totalW);',
    why: 'SWRR 扣权重写成加: 单次调用看不出, 只有多轮分布断言会红 (公平性被破坏)',
  },
];

const SPEC = `# Debug 任务: 定位并修复回归

仓库里有**已经存在且原本正确**的代码发生了回归: 下列测试现在是红的。

症状:
- \`bun test src/model/family-rotate.test.ts\` 有失败用例。
- 编译是干净的 (\`tsc\` 无错) —— 所以这**不是**类型/语法问题, 是逻辑错。

要求:
1. 定位根因并修复, 让该测试全绿, 且 whole-project tsc 保持无错。
2. **不要修改任何测试文件** —— 测试是契约, 让红变绿的办法只有改实现。
3. 改动尽量小: 只动出错的地方, 不要顺手重构、不要加依赖、不要改公共签名。
4. 修完简述根因 (一两句), 不要长篇报告。

提示: 症状集中在"轮转分配的结果长度与分布"上。`;

export interface DebugFixture extends WorktreeFixture {
  bugs: readonly PlantedBug[];
  /** 被种过 bug 的文件 (repo-relative) —— 改动精准度的分母。 */
  buggyFiles: string[];
}

/**
 * 建 debug fixture: checkout HEAD → **不清空任何文件** (与重建题的关键差别) → 逐处种 bug → 写 SPEC。
 * targetPaths 传空: worktree fixture 的"清空"语义在这里必须关掉, 我们要的是完整可运行的仓库。
 */
export async function createDebugFixture(opts: { repoRoot?: string } = {}): Promise<DebugFixture> {
  const fx = await createWorktreeFixture({
    id: 'debug-planted',
    ...(opts.repoRoot ? { repoRoot: opts.repoRoot } : {}),
    targetPaths: [], // 不清空 —— debug 题要的是"有正确代码, 其中一处被弄坏了"
    testPaths: ['src/model/family-rotate.test.ts'],
    spec: SPEC,
  });

  const planted: PlantedBug[] = [];
  for (const bug of PLANTED_BUGS) {
    const p = join(fx.root, bug.file);
    const src = await readFile(p, 'utf8');
    if (!src.includes(bug.find)) {
      // 源码漂移 → 种不进去。**必须响**, 否则 fixture 静默退化成"没有 bug 的题", 全员满分。
      throw new Error(`debug-planted: 种 bug 失败 ${bug.id} —— ${bug.file} 里找不到锚点, 源码已漂移, 请更新 PLANTED_BUGS`);
    }
    await writeFile(p, src.replace(bug.find, bug.replace), 'utf8');
    planted.push(bug);
  }

  // **把种完的状态提交进 worktree** —— 否则 git diff 的基线是"没 bug 的原版", 而正确的修复恰好把代码
  // 改回原版 → 完美修复显示成 +0/-0, 与"一动没动"无法区分 (2026-07-28 首跑实测踩到)。
  // 提交后基线 = 带 bug 的状态, diff 量的就是**模型改了什么**。
  await $`git add -A`.cwd(fx.root).quiet().nothrow();
  await $`git -c user.email=eval@local -c user.name=eval commit -m planted-baseline`.cwd(fx.root).quiet().nothrow();

  // 自检: 种完测试必须真的红 —— 不红说明这题测不出东西 (测试覆盖不到种的 bug)。
  const red = await $`bun test src/model/family-rotate.test.ts`.cwd(fx.root).quiet().nothrow();
  if (red.exitCode === 0) {
    await fx.cleanup();
    throw new Error('debug-planted: 种完 bug 测试仍全绿 —— 该 bug 测不出, fixture 无效');
  }

  return {
    ...fx,
    bugs: planted,
    buggyFiles: [...new Set(planted.map((b) => b.file))],
  };
}

/** 反作弊 + 精准度读数: 测试是否被改 / 改动面有多大。全部走 git, 零 LLM。 */
export async function inspectDiff(
  fx: DebugFixture,
): Promise<{ testsModified: string[]; filesChanged: string[]; strayFiles: string[]; insertions: number; deletions: number }> {
  const nameOnly = await $`git diff --name-only`.cwd(fx.root).quiet().nothrow();
  const filesChanged = nameOnly.stdout.toString().trim().split('\n').filter(Boolean);
  const stat = await $`git diff --numstat`.cwd(fx.root).quiet().nothrow();
  let insertions = 0;
  let deletions = 0;
  for (const line of stat.stdout.toString().trim().split('\n').filter(Boolean)) {
    const [a, d] = line.split('\t');
    insertions += Number(a) || 0;
    deletions += Number(d) || 0;
  }
  return {
    testsModified: filesChanged.filter((f) => f.endsWith('.test.ts')),
    filesChanged,
    // 既不是被种 bug 的文件、也不是 EVAL_SPEC → 无关改动 (精准度扣分项)
    strayFiles: filesChanged.filter((f) => !fx.buggyFiles.includes(f) && !f.includes('EVAL_SPEC')),
    insertions,
    deletions,
  };
}
