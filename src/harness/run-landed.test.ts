/**
 * `runBranchLanded` —— 「产物到主树了吗」三值判据 (#202, 承 #200 D1)。
 *
 * ## 为什么用真 git 而不是注入假 git
 *
 * 这条判据的**全部价值**就在于它对真仓判得准 —— #200 票面原本写的是「合主树是人做的, 引擎
 * 无从知道」, 而推翻那个前提的正是一次真仓实测。拿注入的假 gitExit 去测, 测的是我对
 * `merge-base --is-ancestor` 语义的记忆, 不是它的行为。故主路走 `git init` 真仓;
 * 注入面只用来钉「退出码就是答案, 不解析 stdout」这一条形状。
 *
 * ## 三值不是布尔 (NULL≠0)
 *
 * `no-branch` 既不是"已合入"也不是"没合" —— 编成任一个都是拿猜当事实。两个调用方各自按
 * 它知道的策略表态 (settleRunTicket 知道 strategy; reflowGoalResults 靠 dispatch 恒 head 档),
 * 判据本身不替它们猜。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBranchLanded, runWorktreeBranch } from './run-worktree';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const git = (root: string, args: string[]): void => {
  const r = Bun.spawnSync(['git', '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (r.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} 失败 (${r.exitCode}): ${new TextDecoder().decode(r.stderr).trim()}`);
  }
};

/** 起一个真仓, main 上一个基线 commit; 返回仓根。 */
function repoWithMain(): string {
  const root = mkdtempSync(join(tmpdir(), 'omd-landed-'));
  dirs.push(root);
  git(root, ['init', '-q', '-b', 'main']);
  writeFileSync(join(root, 'a.txt'), 'baseline\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-m', 'baseline']);
  return root;
}

/** 在 `omd/run/<runId>` 上造一个真 commit (模拟 run 的自动收编)。 */
function commitOnRunBranch(root: string, runId: string, file = 'b.txt'): void {
  git(root, ['checkout', '-q', '-b', runWorktreeBranch(runId)]);
  writeFileSync(join(root, file), 'run artifact\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-m', `omd run ${runId}: 收编`]);
  git(root, ['checkout', '-q', 'main']);
}

describe('#202 runBranchLanded: 真 git 三值', () => {
  test('分支不存在 → no-branch (head 档: 产物本就在主树, 没有待合的东西)', () => {
    const root = repoWithMain();
    expect(runBranchLanded('never-dispatched', { cwd: root })).toBe('no-branch');
  });

  test('分支在但没合 → awaiting-merge (活做完了, 等人合)', () => {
    const root = repoWithMain();
    commitOnRunBranch(root, 'r-unmerged');
    // ★ 反向自检 (已实测会红): 把 runBranchLanded 里 `merge-base --is-ancestor` 的
    //   `=== 0` 改成恒 true → 这条报 'landed', 当场红。
    expect(runBranchLanded('r-unmerged', { cwd: root })).toBe('awaiting-merge');
  });

  test('合进 main 之后 → landed (同一张票, 同一条命令, 只是人合了一次)', () => {
    const root = repoWithMain();
    commitOnRunBranch(root, 'r-merged');
    expect(runBranchLanded('r-merged', { cwd: root })).toBe('awaiting-merge'); // 合之前
    git(root, ['merge', '--no-ff', '-m', 'merge run', runWorktreeBranch('r-merged')]);
    expect(runBranchLanded('r-merged', { cwd: root })).toBe('landed'); // 合之后
  });

  /**
   * 同名前缀那一格: `git branch --merged` 的文本匹配会把 `omd/run/abcd` 误读成 `omd/run/abc` 已合。
   * `merge-base --is-ancestor` 拿的是 ref 不是文本, 天然不吃这一坑 —— 这条把它钉住。
   */
  test('同名前缀不串: omd/run/abc 已合 ≠ omd/run/abcd 已合', () => {
    const root = repoWithMain();
    commitOnRunBranch(root, 'abc', 'from-abc.txt');
    commitOnRunBranch(root, 'abcd', 'from-abcd.txt');
    git(root, ['merge', '--no-ff', '-m', 'merge abc', runWorktreeBranch('abc')]);
    expect(runBranchLanded('abc', { cwd: root })).toBe('landed');
    expect(runBranchLanded('abcd', { cwd: root })).toBe('awaiting-merge');
  });

  test('主干 ref 可换 (mainRef): 判的是"到没到那个 ref", 不是硬编码 main', () => {
    const root = repoWithMain();
    commitOnRunBranch(root, 'r-x');
    git(root, ['branch', 'release']);
    expect(runBranchLanded('r-x', { cwd: root, mainRef: 'release' })).toBe('awaiting-merge');
    git(root, ['checkout', '-q', 'release']);
    git(root, ['merge', '--no-ff', '-m', 'merge into release', runWorktreeBranch('r-x')]);
    expect(runBranchLanded('r-x', { cwd: root, mainRef: 'release' })).toBe('landed');
    // main 那边没动 —— 两个 ref 各答各的。
    expect(runBranchLanded('r-x', { cwd: root, mainRef: 'main' })).toBe('awaiting-merge');
  });

  test('非 git 目录 → no-branch (不抛; 判据缺席不该把一次 run 的收尾带塌)', () => {
    const bare = mkdtempSync(join(tmpdir(), 'omd-landed-nogit-'));
    dirs.push(bare);
    expect(runBranchLanded('whatever', { cwd: bare })).toBe('no-branch');
  });

  test('判据是退出码不是 stdout (注入面钉形状)', () => {
    const calls: string[][] = [];
    // 两条命令都退 0 → 分支在 ∧ 是祖先 → landed; 全程零 stdout 解析。
    const got = runBranchLanded('r1', { cwd: '/nowhere' }, { gitExit: (a) => (calls.push(a), 0) });
    expect(got).toBe('landed');
    expect(calls[0]).toEqual(['rev-parse', '--verify', '--quiet', 'refs/heads/omd/run/r1']);
    expect(calls[1]).toEqual(['merge-base', '--is-ancestor', 'omd/run/r1', 'main']);
  });
});
