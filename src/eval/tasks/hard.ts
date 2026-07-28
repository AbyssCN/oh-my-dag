/**
 * hard fixture 三档 (owner 2026-07-28) —— 治 large 的天花板。
 *
 * large 为什么测不出差距 (11 模块 48-185 行, 满分不难):
 *   ① **测试就是答案钥匙** —— colocated 测试写死了导出名/签名/行为, 任务退化成"照着抄", 不需要设计判断;
 *   ② **oracle 只跑 scoped 测试** —— 把邻居改坏了看不见, 于是"局部弄绿"和"真的修好"同分;
 *   ③ **因果同址** —— 红的测试就在要改的文件旁边, 不需要定位, 而定位才是 debug 的主要成本。
 *
 * 三档各拆掉一层:
 *   H1 hidden-spec  : 目标的 colocated 测试**移出 worktree**, 打分时才放回。模型只能从散文 SPEC 推出
 *                     精确 API (导出名/签名/边界)。这是最大的一根杠杆 —— 抄不到了。
 *   H2 distant-bug  : bug 种在 A 文件, 红的测试在 B 文件, 且**因处没有任何红测试指路**。
 *                     必须沿"症状→消费者→被消费者"反向推。
 *   H3 whole-suite  : oracle = 全量 1100+ 测试, 不是 scoped。任何为了弄绿而破坏邻居的改法当场现形。
 *
 * 三档正交, 可叠加: H1+H3 = 最难的重建题; H2+H3 = 最难的 debug 题。
 */
import { $ } from 'bun';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { createWorktreeFixture, type WorktreeFixture } from './worktree';

// ── H1: 藏答案钥匙 ───────────────────────────────────────────────────────────
/**
 * 把 colocated 测试挪到 worktree 外的暂存路径, 打分前再放回。
 * 关键: 移走的是**答案**, 不是 oracle —— oracle 一分不减, 只是模型看不到它。
 */
export interface HiddenTests {
  restore: () => Promise<void>;
}
export async function hideTests(root: string, testPaths: string[]): Promise<HiddenTests> {
  const moved: [string, string][] = [];
  for (const t of testPaths) {
    const from = join(root, t);
    const to = join(root, `${t}.hidden`); // 留在 worktree 内但改名 → bun test 不收, 模型也 grep 不到 .test.ts
    await rename(from, to).catch(() => {});
    moved.push([to, from]);
  }
  return {
    restore: async () => {
      for (const [to, from] of moved) await rename(to, from).catch(() => {});
    },
  };
}

// ── H2: 因果异址的 bug ───────────────────────────────────────────────────────
export interface DistantBug {
  id: string;
  /** 种 bug 的文件 (因)。 */
  causeFile: string;
  find: string;
  replace: string;
  /** 会变红的测试 (果) —— 与 causeFile **不同文件**。 */
  symptomTest: string;
  why: string;
}

/**
 * 共享根因陷阱: 因在 channels 的渠道后缀剥离, 果**同时**落在两个文件的测试上 ——
 * family-rotate (轮转分配崩) 与 channels (家族判定崩)。
 *
 * 难在**诱惑**而不是信息缺失: 症状最显眼的是"轮转比例不对", 最省事的修法是在 family-rotate 里
 * 打个特例把分配掰回来 —— 那样 family-rotate 绿了, 根因还在, channels 继续红。
 * 只有 H3 全量 oracle 会当场戳穿这种局部弄绿 (scoped oracle 会给它满分, 这正是 large 的病)。
 *
 * (原设计想做"因处全绿的远距离 bug", 实测做不成: family-rotate 用到的每个坐标 channels.test 都直接
 *  断言过, 任何能咬到症状的改动因处必然也红。这是本仓测试覆盖密的副产品 —— 好事, 但难度得换个来源。)
 */
export const DISTANT_BUGS: readonly DistantBug[] = [
  {
    id: 'brand-alias-token-plan',
    causeFile: 'src/model/channels.ts',
    find: 'const base = provider.replace(/-(coding|platform|go|cn|us)$/i, "");',
    replace: 'const base = provider.replace(/-(platform|go|cn|us)$/i, "");',
    symptomTest: 'src/model/family-rotate.test.ts',
    why: '后缀表少了 coding → kimi-coding 自成一族 → judge 池"三族各一"崩; 局部在 family-rotate 打特例能弄绿它, 但 channels 仍红',
  },
];

const DISTANT_SPEC = `# Debug 任务: 定位并修复回归 (根因在别处)

有一处回归导致下列测试变红:
- \`bun test src/model/family-rotate.test.ts\` —— 轮转分配相关用例失败: 本该分给不同家族的名额分布不对。
- 仓库里还有**别的**测试也红了, 自己找出来 —— 它们大概率指向同一个根因。

已知:
- 编译是干净的 (tsc 无错), 这不是类型问题。
- \`src/model/family-rotate.ts\` 本身**最近没有被改过** —— 别默认错在这里。
- 该测试失败前, 整个仓库的测试是全绿的。

要求:
1. 找到真正的根因并修复, 让**全量测试**恢复全绿 (不只是这一个文件)。
2. 不要修改任何测试文件。
3. 不要在消费侧打特例补丁绕过根因 —— 特例能让这个测试变绿, 但根因还在, 别处会继续错。
4. 修完用一两句说明根因在哪、为什么会表现成这个症状。`;

export interface HardDebugFixture extends WorktreeFixture {
  bugs: readonly DistantBug[];
  causeFiles: string[];
  /** = causeFiles 的别名, 让 debug-planted 的 inspectDiff 能同样吃这份 fixture (改动面判据共用一套)。 */
  buggyFiles: string[];
}

/** H2 fixture: 不清空任何文件, 只在"因"处种 bug, SPEC 明确排除"果"文件以逼真定位。 */
export async function createDistantBugFixture(opts: { repoRoot?: string } = {}): Promise<HardDebugFixture> {
  const fx = await createWorktreeFixture({
    id: 'hard-distant-bug',
    ...(opts.repoRoot ? { repoRoot: opts.repoRoot } : {}),
    targetPaths: [],
    testPaths: DISTANT_BUGS.map((b) => b.symptomTest),
    spec: DISTANT_SPEC,
  });

  for (const bug of DISTANT_BUGS) {
    const p = join(fx.root, bug.causeFile);
    const src = await readFile(p, 'utf8');
    if (!src.includes(bug.find)) {
      await fx.cleanup();
      throw new Error(`hard/distant: 锚点漂移, 种不进 ${bug.id} (${bug.causeFile}) —— 请更新 DISTANT_BUGS`);
    }
    await writeFile(p, src.replace(bug.find, bug.replace), 'utf8');
  }

  // 与 debug-planted 同: 把种完的状态提交进 worktree, 让 diff 基线 = 带 bug 的状态
  // (否则正确修复恰好改回原版 → 显示 +0/-0, 与"没干活"分不开)。
  await $`git add -A`.cwd(fx.root).quiet().nothrow();
  await $`git -c user.email=eval@local -c user.name=eval commit -m planted-baseline`.cwd(fx.root).quiet().nothrow();

  // 自检 ①: 果处必须真的红 (否则这题测不出东西)。
  const red = await $`bun test ${DISTANT_BUGS[0]!.symptomTest}`.cwd(fx.root).quiet().nothrow();
  if (red.exitCode === 0) {
    await fx.cleanup();
    throw new Error('hard/distant: 种完症状测试仍绿 —— bug 测不出, fixture 无效');
  }
  // 自检 ②: 因处也必须红 —— 陷阱靠的就是"两处都红, 只有改根因才能同时清零"。
  // 若因处是绿的, 局部修法就不会被全量 oracle 抓到, 这道题的区分度就没了。
  const causeTest = 'src/model/channels.test.ts';
  const causeRed = await $`bun test ${causeTest}`.cwd(fx.root).quiet().nothrow();
  if (causeRed.exitCode === 0) {
    await fx.cleanup();
    throw new Error(`hard/trap: 因处 ${causeTest} 仍绿 —— 局部弄绿将无法被识破, 陷阱失效`);
  }

  const causeFiles = [...new Set(DISTANT_BUGS.map((b) => b.causeFile))];
  return { ...fx, bugs: DISTANT_BUGS, causeFiles, buggyFiles: causeFiles };
}

// ── H3: 全量 oracle ──────────────────────────────────────────────────────────
export interface SuiteResult {
  tscClean: boolean;
  pass: number;
  fail: number;
  /** 全绿 = tsc 零错 且 fail=0。**这才是"真修好了"的定义**。 */
  green: boolean;
  /** 相对基线新坏掉的测试数 (附带损伤) —— 局部弄绿的代价在这里现形。 */
  regressions: number;
}

/**
 * 全量 oracle: whole-project tsc + 全量 bun test。
 * baselineFail = 种 bug 后、动手前的失败数; 交付后 fail 若高于它, 差额就是**新弄坏的**。
 */
export async function wholeSuite(root: string, baselineFail = 0): Promise<SuiteResult> {
  const tsc = await $`npx tsc --noEmit -p tsconfig.json`.cwd(root).quiet().nothrow();
  const t = await $`bun test`.cwd(root).quiet().nothrow();
  const out = t.stdout.toString() + t.stderr.toString();
  const pass = Number(/(\d+) pass/.exec(out)?.[1] ?? 0);
  const fail = Number(/(\d+) fail/.exec(out)?.[1] ?? 0);
  return {
    tscClean: tsc.exitCode === 0,
    pass,
    fail,
    green: tsc.exitCode === 0 && fail === 0,
    regressions: Math.max(0, fail - baselineFail),
  };
}
