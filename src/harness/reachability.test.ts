/**
 * 可达性闸 —— `src/` + `scripts/` 里的每个非测试 `.ts` 都必须从**生产入口**走 import 图到得了。
 *
 * ## 为什么要这条闸
 *
 * 它不是"理论上有用"。2026-08-01/02 这三轮里,同一个形态**撞见了四次,没有一次是靠计划找到的**,
 * 每次都是人手工重算 import 闭包才发现:
 *
 *   ① 砍 TUI 之后剩下的 63 个文件里有一批再没有入口(13 号)
 *   ② `skills/` 的函数级死码(14 号,那次是按符号查的)
 *   ③ `dream_consolidate` 工具一摘, `src/dream/` 四个文件当场成孤儿(15 号 → ADR-0003)
 *   ④ 删 `TaskSignals` 的连带: `plan/complexity.ts` 断了最后一个消费者 —— **上一个提交刚造的**
 *
 * ④ 尤其说明问题: 上一轮刚写完"要一个可达性工具", 一个提交之后自己又撞了同一个坑。
 * **靠人记不住的事情, 这个仓的纪律是让测试记。**
 *
 * ## 判据
 *
 * 根 = `src/harness/cli.ts`(`package.json` 的 `bin`)+ `scripts/*.ts`(`package.json` 的 scripts)。
 *
 * **刻意不把测试当根。** 一个只有自己的 `.test.ts` 还在用的文件, 在生产里就是死的 ——
 * 它应该红一次, 逼出一次显式决定(删掉 / 接上生产调用点 / 登记豁免并写明它凭什么活着),
 * 而不是靠"它有测试啊"糊过去。②③④ 里有两件正是这个形态。
 *
 * 豁免件**同时也当根**: 它们的下游闭包算可达。这样名单里只需要登记**真正的入口**,
 * 不用把入口能拉起来的一整串都抄进去(`fullstack-dag` 一条就带进了 `tasks/fullstack`)。
 *
 * ## ⚠ 这条闸的诚实边界
 *
 * - **只看静态 import 图。** 按路径字符串拉起来的东西它看不见 —— 这正是豁免名单存在的理由,
 *   不是名单的漏洞。新增动态加载会误报, 修法是登记进名单并写清是谁按什么路径拉的。
 * - **不查函数级死码。** 一个文件只要还有人 import 就算可达, 哪怕里头一半的导出没人用
 *   (14 号那次要按**符号**查, 是另一层)。同一天顺手清掉的两个 unused import
 *   (`role-models.ts` / `auto-assign.ts` 的 `SEAT_TIER`)就是这条闸抓不到的形态。
 * - **不进 `experimental/`。** 那里按 ADR-0001/0002/0003 就是停用件, 本来就没有生产入口。
 *
 * 别把这条闸的绿读成"这个文件在生产里真的跑过" —— 它只说"从入口 import 得到"。
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { reachableFrom, tsFiles } from './plan/import-reach';

const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');

/**
 * 豁免 = **有生产入口, 但那条入口不走静态 import**。
 * 值 = 谁在什么地方按什么路径拉它(写不出这句话 = 它没有入口 = 该删, 不该豁免)。
 */
const DYNAMIC_ENTRIES: Record<string, string> = {
  'src/harness/leaf-worker.ts':
    'bwrap 子进程按**路径字符串**拉起: hooks/sandboxed-leaf.ts 的 WORKER_REL = 这个路径, ' +
    '每次 agent leaf 调用 spawn 一个 `bwrap [binds] bun run <它>`。',
  'src/eval/oracles/agent-leaf-prompt.ts':
    '**外部** tournament 脚本按路径参数跑: `bun run $FUSANG_HOME/scripts/xihe-tournament.ts <它>` ' +
    '(见该文件头注的「消费」段)。本仓没有、也不该有它的 import 方。',
  'src/eval/oracles/fullstack-dag.ts':
    '同上, `xihe-tournament.ts <它>`。顺带把 `eval/tasks/fullstack.ts` 拉进可达闭包 —— ' +
    '所以那个 fixture 不必单独豁免。',
  'src/eval/tasks/oracle-plan-filter.ts':
    'eval fixture: 消费方是 colocated 的 `.test.ts`(worktree 隔离 → 清空目标模块 → fleet 照 SPEC 重建)。' +
    '**生产零消费者是它的设计**, 不是缺陷 —— 它量的就是"照 spec 重建"这件事本身。',
  'src/eval/tasks/no-graph-baseline/f2-checklist.ts':
    'r2 对照实验 F2 核实清单: 实验协议按路径引用 (评分时 import scoreF2); 规范表+存在性自检 = ' +
    'colocated f2-registry.test.ts。生产零 import 是设计, 同 f1-check。',
  'src/eval/tasks/no-graph-baseline/f1-check.ts':
    'r2 对照实验的点位校验器: 实验协议按**路径字符串**跑 `bun run <它> --dir <快照目录>` ' +
    '(设计 docs/plan/2026-08-04-r2-no-graph-baseline-design.md 片1); 语料规范表 = colocated ' +
    'f1-registry.test.ts。生产零 import 是设计 —— 它只在实验会话被点名。',
  'src/harness/dag-mermaid.ts':
    '**benchmark 靶子**: `eval/tasks/medium.ts` 与 `large.ts` 都把这个路径列进目标集 —— ' +
    'eval 会清空它让 fleet 照 SPEC 重建。⚠ `planToMermaid` 生产零消费者, ' +
    '存在的唯一理由就是当靶子; 删它会同时打断两个 fixture。',
};

// ⚠ 走图的四件 (`IMPORT_SPEC` / `tsFiles` / `resolveSpec` / `reachableFrom`) 2026-08-03
// **提取到 `plan/import-reach.ts`** —— 它们原本只有本闸一个消费者 (S-1 的味道), 而
// `invocation-facts` 需要同一张图回答"哪些调度入口到得了这个文件"。
// **本闸现在反过来 import 那份**: 于是"抽出来的与原来行为一致"由本闸自己保住,
// 而不是靠两份平行实现互相祈祷不漂。
const rel = (abs: string) => abs.slice(ROOT.length + 1);

/** 生产入口: bin 的 cli.ts + package.json scripts 指向的 `scripts/*.ts`。 */
const PROD_ROOTS = [join(ROOT, 'src/harness/cli.ts'), ...tsFiles(join(ROOT, 'scripts'))];
const ALL_FILES = [...tsFiles(join(ROOT, 'src')), ...tsFiles(join(ROOT, 'scripts'))];

describe('可达性 — 每个非测试 .ts 都从生产入口 import 得到', () => {
  test('扫描面自检: 根存在 + 可达面成规模 (正则漂了/路径错了要红, 而不是"全仓都死了")', () => {
    expect(existsSync(join(ROOT, 'src/harness/cli.ts'))).toBe(true);
    expect(PROD_ROOTS.length).toBeGreaterThan(10);
    expect(ALL_FILES.length).toBeGreaterThan(100);
    // 副作用 import (`import '../src/harness/script-bootstrap';`) 必须被认出来 ——
    // 早期版本的正则只认 `from '...'`, 于是 script-bootstrap 被误报成孤儿。
    expect(reachableFrom(PROD_ROOTS)).toContain(join(ROOT, 'src/harness/script-bootstrap.ts'));
  });

  test('★ 没有孤儿 (豁免件同时当根, 其下游闭包算可达)', () => {
    const exemptRoots = Object.keys(DYNAMIC_ENTRIES).map((p) => join(ROOT, p));
    const reachable = reachableFrom([...PROD_ROOTS, ...exemptRoots]);
    const orphans = ALL_FILES.filter((f) => !reachable.has(f)).map(rel).sort();

    expect(
      orphans.length === 0
        ? ''
        : `以下文件从生产入口不可达 (import 图上的孤儿):\n  ${orphans.join('\n  ')}\n` +
          '修法三选一: ① 删掉 (它真的死了); ② 接上生产调用点; ' +
          '③ 若它由**路径字符串**动态拉起, 登记进 DYNAMIC_ENTRIES 并写明"谁在哪按什么路径拉它"。\n' +
          '⚠ "它有测试啊" 不是理由 —— 测试刻意不算根, 见本文件头注。',
    ).toBe('');
  });

  test('豁免名单不许收留真的可达件 (防名单变垃圾桶)', () => {
    // 反向: 一个被豁免的文件如果**从生产根就已经可达**, 说明豁免多余 —— 摘掉。
    const reachable = reachableFrom(PROD_ROOTS);
    const needless = Object.keys(DYNAMIC_ENTRIES).filter((p) => reachable.has(join(ROOT, p)));
    expect(
      needless,
      `这些文件从生产入口本来就可达, 不该待在 DYNAMIC_ENTRIES 里: ${needless.join(', ')}`,
    ).toEqual([]);
  });

  test('豁免名单不含已不存在的文件 (删了文件要同步删登记)', () => {
    const stale = Object.keys(DYNAMIC_ENTRIES).filter((p) => !existsSync(join(ROOT, p)));
    expect(stale, `DYNAMIC_ENTRIES 登记了不存在的路径: ${stale.join(', ')}`).toEqual([]);
  });

  test('每条豁免都写了理由 (写不出"谁按什么路径拉它" = 它没有入口)', () => {
    const empty = Object.entries(DYNAMIC_ENTRIES)
      .filter(([, why]) => why.trim().length < 20)
      .map(([p]) => p);
    expect(empty, `这些豁免没写清理由: ${empty.join(', ')}`).toEqual([]);
  });
});
