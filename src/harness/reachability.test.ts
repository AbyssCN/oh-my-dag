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
  // leaf-worker.ts 2026-08-11 出名单: sandboxed-leaf.ts 现在静态 import 其 LeafWorkerPayload 类型
  // (profile 跨沙箱载荷同型, run d39b559e), 静态可达已覆盖; bwrap 仍按路径字符串拉起它, 但豁免名单
  // 只收"静态不可达"的件。
  'src/eval/oracles/agent-leaf-prompt.ts':
    '**外部** tournament 脚本按路径参数跑: `bun run $FUSANG_HOME/scripts/xihe-tournament.ts <它>` ' +
    '(见该文件头注的「消费」段)。本仓没有、也不该有它的 import 方。',
  'src/eval/oracles/fullstack-dag.ts':
    '同上, `xihe-tournament.ts <它>`。顺带把 `eval/tasks/fullstack.ts` 拉进可达闭包 —— ' +
    '所以那个 fixture 不必单独豁免。',
  'src/eval/tasks/oracle-plan-filter.ts':
    'eval fixture: 消费方是 colocated 的 `.test.ts`(worktree 隔离 → 清空目标模块 → fleet 照 SPEC 重建)。' +
    '**生产零消费者是它的设计**, 不是缺陷 —— 它量的就是"照 spec 重建"这件事本身。',
  // 'src/harness/session/ledger.ts' 的豁免 2026-08-19 (#206) 删除 —— 照它自己写的退出条件:
  // 「消费点若哪天进了 src/ 或 scripts/, 请删掉本条豁免」。消费点进来了:
  // `scripts/session-continuity-hook.ts` 静态 import `appendLedger`。本闸当场抓到,没靠人记得。
  'src/tui/ext/runner.ts':
    '扩展子进程的入口, 按**路径字符串**拉起: `tui/ext/host.ts` 的 ' +
    '`join(import.meta.dir, \'runner.ts\')` → `bwrap [binds] bun run <它> <扩展入口>`。\n' +
    '⚠ 它是**唯一 import 第三方扩展代码的地方**, 而宿主 (host.ts) 永远不 import 扩展 —— ' +
    '这条边界正是沙箱成立的前提, 所以它必须在子进程里, 也就必然不在静态 import 图上。',
  'src/harness/dag/dag-mermaid.ts':
    '**benchmark 靶子**: `eval/tasks/medium.ts` 与 `large.ts` 都把这个路径列进目标集 —— ' +
    'eval 会清空它让 fleet 照 SPEC 重建。⚠ `planToMermaid` 生产零消费者, ' +
    '存在的唯一理由就是当靶子; 删它会同时打断两个 fixture。',
  'src/mcp/client/fixtures/stdio-ping-server.ts':
    'MCP client 真传输测试的 fixture server, 按**路径字符串**拉起: `mcp/client/pool.test.ts` 的 ' +
    'FIXTURE = 这个路径 → `StdioClientTransport({ command: "bun", args: [<它>] })` 起真子进程。' +
    '生产零消费者是设计 (开放生态 SDD S1): 它验的是真 stdio 传输腿, InMemory 假体验不出。',
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

  /**
   * 已提交的那一面 (2026-08-29)。**未跟踪文件不参与判红** ——
   *
   * 未跟踪 = 还没进仓 = 对任何人都不存在, 让它把闸拉红是**假警报**: 那天本闸因为别人
   * 一个未提交的 `src/cli/runs-gc.ts` 一直红, 而红的原因和谁提交过的东西都无关。
   * 一条经常因无关原因发红的闸, 教会人的是忽略它。
   *
   * 但**早反馈的价值要留住**: 未跟踪的孤儿照样打印出来 (下一条 test 里), 只是不判红。
   * `git ls-files` 挂了 → 返 null → 退回"全都算" (fail-closed: 宁可多判也不漏判)。
   */
  /**
   * **第二格豁免: 消费方是在录的票, 还没落地** (2026-08-29)。
   *
   * 为什么不塞进 `DYNAMIC_ENTRIES`: 那一格的语义是「有生产入口, 但入口不走静态 import」,
   * 值要写清"谁在哪按什么路径拉它"。把一个**还没有消费方**的件写进去就是**说假话** ——
   * 而这条闸的全部价值就是逼出一次诚实的决定。
   *
   * 所以分成两格。进这一格的条件比 DYNAMIC_ENTRIES **更严**:
   *   · `ticket` 必须指向 `docs/plan/` 下**真实存在**的文件 (下面那条 test 机械校验);
   *   · 票没了 / 文档改名 → 本条当场红 → 逼你重新决定 (删掉, 还是接上)。
   *
   * ⚠ 它不是"缓刑名单"。一个件在这里待着, 意思是「有人承诺了消费方, 且承诺写在盘上」。
   */
  const PENDING_CONSUMERS: Record<string, { ticket: string; why: string }> = {
    'src/harness/inventory/scale-fixture.ts': {
      ticket: 'docs/plan/2026-08-24-247-248-活环闭合-执行契约.md',
      why:
        'S2 债 (inventory 装配进活环) 的输入面: 规模实验 20/50/100/200 条要求"只改条目数、其余冻结", ' +
        '而"冻结"只有确定性发生器做得到。消费方 = S2 的实验脚本, 尚未落地。' +
        'S2 若被裁掉, 本条与该文件一起删。',
    },
  };

  const tracked = (): Set<string> | null => {
    const r = Bun.spawnSync(['git', 'ls-files', '--', 'src'], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
    if (r.exitCode !== 0) return null;
    return new Set(r.stdout.toString().split('\n').filter(Boolean));
  };

  test('★ 没有孤儿 (豁免件同时当根, 其下游闭包算可达)', () => {
    const exemptRoots = Object.keys(DYNAMIC_ENTRIES).map((p) => join(ROOT, p));
    const reachable = reachableFrom([...PROD_ROOTS, ...exemptRoots]);
    const t = tracked();
    const orphans = ALL_FILES.filter((f) => !reachable.has(f))
      .map(rel)
      .filter((f) => t === null || t.has(f))
      .filter((f) => !(f in PENDING_CONSUMERS))
      .sort();

    expect(
      orphans.length === 0
        ? ''
        : `以下文件从生产入口不可达 (import 图上的孤儿):\n  ${orphans.join('\n  ')}\n` +
          '修法三选一: ① 删掉 (它真的死了); ② 接上生产调用点; ' +
          '③ 若它由**路径字符串**动态拉起, 登记进 DYNAMIC_ENTRIES 并写明"谁在哪按什么路径拉它"。\n' +
          '⚠ "它有测试啊" 不是理由 —— 测试刻意不算根, 见本文件头注。',
    ).toBe('');
  });

  test('未跟踪的孤儿: 打印出来但不判红 (早反馈留住, 假警报去掉)', () => {
    const exemptRoots = Object.keys(DYNAMIC_ENTRIES).map((p) => join(ROOT, p));
    const reachable = reachableFrom([...PROD_ROOTS, ...exemptRoots]);
    const t = tracked();
    const untrackedOrphans = t === null ? [] : ALL_FILES.filter((f) => !reachable.has(f)).map(rel).filter((f) => !t.has(f)).sort();
    if (untrackedOrphans.length > 0) {
      // 不 expect —— 这一条**故意不判红**: 它是提醒, 不是闸。
      console.warn(`[reachability] 未跟踪的孤儿 ${untrackedOrphans.length} 个 (未提交, 不判红): ${untrackedOrphans.join(', ')}`);
    }
    expect(true).toBe(true);
  });

  test('★ PENDING_CONSUMERS 的票必须真的在盘上 (票没了 = 承诺没了 = 该重新决定)', () => {
    const missing = Object.entries(PENDING_CONSUMERS)
      .filter(([, v]) => !existsSync(join(ROOT, v.ticket)))
      .map(([f, v]) => `${f} → ${v.ticket}`);
    expect(
      missing,
      `这些条目引用的票文件不存在, 承诺已经没有依据了: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  test('PENDING_CONSUMERS 与 DYNAMIC_ENTRIES 不许重叠 (一个件只能有一种理由)', () => {
    const dup = Object.keys(PENDING_CONSUMERS).filter((k) => k in DYNAMIC_ENTRIES);
    expect(dup).toEqual([]);
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
