/**
 * 产物闸「绝对路径锚回 worktree」s1-red 测试集 (SDD 2026-08-22 · C-1 · C-2)。
 *
 * 承重那一跳 (GWT1) **今天必红** —— 当前 helper 是「纯提取, 一字不变」(SDD 切片 1 Step A),
 * `root`/`repoRoot` 在签名里留位但 body 还没接锚回。所以 main-root 前缀的绝对路径
 * 必落 `missing`, 节点必被闸判 empty-artifact。这正是 s1-green 要解的 bug。
 *
 * 反向自检 (S-49 · 第二轮拒绝原因): 上一轮的测试文件没被发现 (路径/命名错)。
 * 这一轮落 `src/harness/dag/artifact-gate-anchor.test.ts`, 与同类闸测试同路径同格式
 * (见 `blame-attribution.test.ts` / `oracle-red.test.ts`), bun test 默认 `*.test.ts` 扫得到。
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveMissingArtifacts } from './engine';

/** 在临时根下建一棵 worktree 形状的树, 把指定相对路径全部写成非空文件。 */
function makeWorktreeWith(relPaths: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'omd-anchor-'));
  for (const rel of relPaths) {
    const abs = join(root, rel);
    mkdirSync(abs.slice(0, abs.lastIndexOf('/')), { recursive: true });
    writeFileSync(abs, '/* anchor-gate test fixture */\n');
  }
  return root;
}

/** 清理临时树。rmSync 在 14+ 上有 recursive, 这里强制声明。 */
function rmWorktree(root: string): void {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch { /* best-effort */ }
}

describe('resolveMissingArtifacts —— 产物闸「绝对路径判定」纯提取', () => {
  // ─────────── GWT1 · 承重 ───────────
  test('GWT1 · 锚回 worktree: 文件只在 worktree, 主干绝对路径不在 missing', () => {
    // 证伪 (R-1): 若 INV-2 不在 ⇒ 第一条 GWT 必红 —— 还绿就说明用例没判别力, 重写。
    //   方式: 改 helper 的 anchor 短路 (不剥前缀再 stat) ⇒ 本用例必变红。
    //   当前实现 (Step A, 不引入锚回) ⇒ 本用例**今天必红**, 因为 `${root}/${abs}` 是原样 stat 的主干路径,
    //   而那条路径在 worktree 里并不存在。
    const wt = makeWorktreeWith(['src/x/foo.test.ts']);
    try {
      const mainRoot = '/repo/never/exists/main-root-A';
      const result = resolveMissingArtifacts({
        root: wt,
        repoRoot: mainRoot,
        filesTouched: [`${mainRoot}/src/x/foo.test.ts`],
      });
      // 实际 stat 过的路径 ── s1-green 后 INV-2 触发, 两条 stat 都记:
      //   [原样绝对, 剥主干根前缀拼 root 的锚回绝对]。
      expect(result.probed[`${mainRoot}/src/x/foo.test.ts`]).toEqual([
        `${mainRoot}/src/x/foo.test.ts`,
        `${wt}/src/x/foo.test.ts`,
      ]);
      // ★ 承重断言: helper 锚回以后这条路径**不在** missing。
      //   Step A 没引入锚回 ⇒ 落入 missing ⇒ 失败 (RED)。
      expect(result.missing).not.toContain(`${mainRoot}/src/x/foo.test.ts`);
    } finally {
      rmWorktree(wt);
    }
  });

  // ─────────── GWT2 · 钉闸 ───────────
  test('GWT2 · 两个基准下都不存在 ⇒ 在 missing (今天绿, 修后仍必须绿)', () => {
    // 反向自检 (S-49 钉闸): 修后变绿 ⇒ 锚回把不存在的文件也放行了,
    //   helper 被锚回逻辑搞坏了。把它修回当前行为再放行。
    const wt = makeWorktreeWith([]);
    try {
      const mainRoot = '/repo/never/exists/main-root-B';
      const result = resolveMissingArtifacts({
        root: wt,
        repoRoot: mainRoot,
        filesTouched: [`${mainRoot}/src/y/ghost.test.ts`],
      });
      expect(result.missing).toContain(`${mainRoot}/src/y/ghost.test.ts`);
      // s1-green 后 INV-2 触发 (路径以主干根开头) ⇒ 两条 stat 都记, 都 miss。
      expect(result.probed[`${mainRoot}/src/y/ghost.test.ts`]).toEqual([
        `${mainRoot}/src/y/ghost.test.ts`,
        `${wt}/src/y/ghost.test.ts`,
      ]);
    } finally {
      rmWorktree(wt);
    }
  });

  // ─────────── GWT3 · INV-4 ───────────
  test('GWT3 · root === repoRoot (非 branch) ⇒ 行为与今天逐字相同 (INV-4 钉闸)', () => {
    // 钉闸: 即使将来加 INV-2, `root === repoRoot` 时必须短路 (D-3), 否则每个绝对路径白 stat 一次。
    // 这里用真实盘上的一个 tmpdir 当 root/repoRoot, 写一个真文件, 跑出基线。
    const wt = makeWorktreeWith(['src/z/exists.ts']);
    try {
      const result = resolveMissingArtifacts({
        root: wt,
        repoRoot: wt, // 相等 ⇒ INV-4 短路
        filesTouched: [`${wt}/src/z/exists.ts`, `${wt}/src/z/missing.ts`],
      });
      expect(result.missing).toEqual([`${wt}/src/z/missing.ts`]);
      expect(result.probed[`${wt}/src/z/exists.ts`]).toEqual([`${wt}/src/z/exists.ts`]);
      expect(result.probed[`${wt}/src/z/missing.ts`]).toEqual([`${wt}/src/z/missing.ts`]);
    } finally {
      rmWorktree(wt);
    }
  });

  // ─────────── GWT4 · INV-5 ───────────
  test('GWT4 · 相对路径走 `${root}/${p}` (INV-5 钉闸)', () => {
    // 钉闸: 修后错的代价 (走反: `${p}` 不拼 root, 把 worktree 自己拼成怪路径)
    // 这里直接断言 stat 路径 = `${root}/${p}`, helper body 怎么实现无所谓,
    // 但 stat 路径表不许变。
    const wt = makeWorktreeWith(['src/rel/exists.ts']);
    try {
      const result = resolveMissingArtifacts({
        root: wt,
        repoRoot: '/never/exists/main-root-D',
        filesTouched: ['src/rel/exists.ts', 'src/rel/missing.ts'],
      });
      expect(result.missing).toEqual(['src/rel/missing.ts']);
      expect(result.probed['src/rel/exists.ts']).toEqual([`${wt}/src/rel/exists.ts`]);
      expect(result.probed['src/rel/missing.ts']).toEqual([`${wt}/src/rel/missing.ts`]);
    } finally {
      rmWorktree(wt);
    }
  });

  // ─────────── GWT5 · 现场回放 ───────────
  test('GWT5 · 现场回放: SDD 9 条 filesTouched 全在同一棵 worktree 上 ⇒ missing 空 (今天必红)', () => {
    // 证伪 (R-2): 把 INV-2 剥前缀拼 root 那条挪走 ⇒ 这条必变红。
    //   当前 Step A 没有 INV-2 ⇒ 3 条主干绝对路径落 missing ⇒ RED。
    //
    // 9 条入参 (与 SDD 2026-08-22 §「现场」逐字相同, worktree 前缀替换为本次临时根):
    //   - 3 主干绝对: 仅在 worktree 新建 (本次 sed 走临时根, 不是字面 `/home/nick/...`).
    //   - 1 worktree 绝对: 临时根下方, 走 `${root}${rel}` 命中。
    //   - 5 相对: `${root}/${p}` 命中 (我们在 worktree 全建过)。
    const wt = makeWorktreeWith([
      'src/harness/session/sessions-cli.ts',
      'src/mcp/tools/session.ts',
      'src/harness/session/sessions-cli.test.ts',
      'src/mcp/assemble.ts',
      'src/harness/cli.ts',
      'test/core/mcp-e2e.test.ts',
      'src/tui/tools/chat-seat.test.ts',
      'src/tui/tools/chat-seat.ts',
    ]);
    try {
      const mainRoot = '/home/nick/repos/oh-my-dag'; // 模拟 leaf 报的前缀
      const filesTouched = [
        `${mainRoot}/src/harness/session/sessions-cli.ts`,
        `${mainRoot}/src/mcp/tools/session.ts`,
        'src/mcp/assemble.ts',
        'src/harness/cli.ts',
        'test/core/mcp-e2e.test.ts',
        'src/tui/tools/chat-seat.test.ts',
        `${mainRoot}/src/harness/session/sessions-cli.test.ts`,
        `${wt}/src/harness/session/sessions-cli.test.ts`, // worktree 绝对 (与上一条同文件不同前缀)
        'src/tui/tools/chat-seat.ts',
      ];
      const result = resolveMissingArtifacts({ root: wt, repoRoot: mainRoot, filesTouched });
      // ★ 承重断言: 全部命中 ⇒ missing 为空。
      //   修前: 3 条主干绝对路径必落 missing ⇒ RED。
      //   修后: 锚回命中, 5 条相对命中, 1 条 worktree 绝对命中 ⇒ missing 空 ⇒ GREEN。
      expect(result.missing).toEqual([]);
    } finally {
      rmWorktree(wt);
    }
  });

  // ─────────── GWT6 · 判词探针 INV-6 ───────────
  test('GWT6 · 探针 (INV-6): 锚回试过仍不中时, probed[p] 列出两条实际 stat 过的路径', () => {
    // 证伪 (R-3): 把 `probed[p].push(anchored)` 那行挪走 ⇒ 本用例必变红 (length !== 2)。
    //   当前 Step A 没有 anchored 第二跳 ⇒ length === 1 ⇒ RED。
    //
    // 场景: 文件**两个基准都不在**, 但路径以主干根开头 (满足 INV-2 进入条件) ⇒ anchored 也试过, 仍不中。
    const mainRoot = '/repo/never/exists/main-root-F';
    const wt = mkdtempSync(join(tmpdir(), 'omd-anchor-')); // 空 worktree
    try {
      const ghost = `${mainRoot}/src/no/where/file.ts`;
      const result = resolveMissingArtifacts({
        root: wt,
        repoRoot: mainRoot,
        filesTouched: [ghost],
      });
      // 期望: probed[ghost] = [原样绝对, 锚回绝对]
      expect(result.probed[ghost]?.length).toBe(2);
      // 第一条 = 原样 stat 路径 (与今天逐字相同, INV-1)
      expect(result.probed[ghost]?.[0]).toBe(ghost);
      // 第二条 = 剥主干根前缀拼 root 的锚回路径 (INV-2)
      expect(result.probed[ghost]?.[1]).toBe(`${wt}/src/no/where/file.ts`);
      // 文件**两个基准下都不在** ⇒ 钉死 in missing (修后仍必须 true, 防锚回放行不存在的文件)。
      expect(result.missing).toContain(ghost);
    } finally {
      rmWorktree(wt);
    }
  });
});
