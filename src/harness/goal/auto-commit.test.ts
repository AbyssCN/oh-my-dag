/**
 * #165② 收编闸 — 真 git 端到端契约 (run-worktree.test.ts 那组是注入假 git,
 * 这组用真 `git init`/`commit`/`rev-list` 验真实行为 —— 写集真身是否真进 commit、
 * 判据红时脏树是否真留在外面, 都得用真 git 才验得出)。
 *
 * ⚠ 2026-08-19 修:本文件原先两条反向自检都写着「删 src/mcp/tools/goal.ts:719/727 的某行 → 红」,
 *   而它 import 面里根本没有 goal.ts —— **实测把 `:719` 的门卫换成 `if (true)`, 两条仍 2 pass 0 fail**。
 *   那是一条永远绿的闸,正是本仓「一条永远绿的闸不是闸」要拦的东西。反向自检只能指向
 *   **本文件真的会执行到的代码**,也就是 run-worktree.ts 那两个纯函数。
 *
 * 两条用例, 各一格反向自检 (均已实测会红, 破坏方式写在各自用例末尾)。grep "反向自检" 冻结判据。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitRunArtifacts, shouldAutoCommit } from '../run-worktree';

const dirs: string[] = [];
const freshRoot = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'omd-goal-auto-commit-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 跑本地 git (纯本地, 零网络); 非零退出即抛。 */
const git = (root: string, args: string[]): string => {
  const r = Bun.spawnSync(['git', ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  if (r.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} 失败 (exit ${r.exitCode}): ${new TextDecoder().decode(r.stderr).trim()}`);
  }
  return new TextDecoder().decode(r.stdout).trim();
};

/** 起真仓 + 基线 commit —— 模拟"worktree 内已经跑过前一轮, 这次 run 是新写脏"。 */
const initRepoWithDirtyB = (root: string): void => {
  git(root, ['init', '-q']);
  git(root, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'config', 'user.email', 't@t']);
  git(root, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'config', 'user.name', 't']);
  writeFileSync(join(root, 'a.txt'), 'baseline A\n');
  git(root, ['add', '-A']);
  git(root, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'baseline']);
  // 基线之后再写脏文件 B —— 这就是本 run 的写集真身。
  writeFileSync(join(root, 'b.txt'), 'run-r1 artifact B\n');
};

describe('auto-commit #165②: 冻结判据绿 → 真 git 端到端收编', () => {
  test('判据绿 (executable + success + branch) → 收编进 commit, 工作树变净', () => {
    const root = freshRoot();
    initRepoWithDirtyB(root);

    const baselineCount = Number(git(root, ['rev-list', '--count', 'HEAD']));
    // 脏文件落地后工作树必须非空 —— 否则下面的"收编后变净"是伪命题。
    expect(git(root, ['status', '--porcelain'])).not.toBe('');

    expect(shouldAutoCommit({ acceptanceKind: 'executable', outcome: 'success' }, 'branch')).toBe(true);

    const r = commitRunArtifacts({
      cwd: root,
      runId: 'r1',
      message: 'omd run r1: 冻结判据绿自动收编 (success)\n\n判据: bun test',
    });
    expect(r.committed).toBe(true);
    expect(r.sha).toMatch(/^[0-9a-f]{7,}$/);

    // 写集真身进了 commit —— 比基线 +1。
    expect(Number(git(root, ['rev-list', '--count', 'HEAD']))).toBe(baselineCount + 1);
    // 收编后工作树变净。
    expect(git(root, ['status', '--porcelain'])).toBe('');
    // run 锚留在 commit message 里 —— 冻结判据: grep "omd run r1" 能溯到这次产物。
    const msg = git(root, ['log', '-1', '--pretty=%B']);
    expect(msg).toContain('omd run r1');
    expect(msg).toContain('冻结判据绿自动收编');
    expect(msg).toContain('判据: bun test');
    // ★ 反向自检 (已实测会红): 把 run-worktree.ts 的 commitRunArtifacts 里 `git add -A` 那步去掉
    //   → 没有可提交的改动, commit 失败进 catch → r.committed=false 与 HEAD +1 两条断言同时红。
  });

  // 三个真红终态逐个过一遍 —— `RunOutcomeKind` 里**没有 'failed' 这一格**, 拿它当"判据红"
  // 的样本等于在测一个永不出现的值 (shouldAutoCommit 收的是宽松 string, tsc 拦不住)。
  for (const outcome of ['not-converged', 'oracle-failed', 'blocked'] as const) {
    test(`判据红 (executable + ${outcome} + branch) → 门卫挡住, 脏文件仍在工作树`, () => {
      const root = freshRoot();
      initRepoWithDirtyB(root);

      const baselineCount = Number(git(root, ['rev-list', '--count', 'HEAD']));
      expect(git(root, ['status', '--porcelain'])).not.toBe('');

      // **照 src/mcp/tools/goal.ts:719 的形状原样走一遍门卫** —— 只断言 shouldAutoCommit 返回 false
      // 而不真的走这个 if, 那条断言就是重言式: 什么都没调, 树当然还脏。
      if (shouldAutoCommit({ acceptanceKind: 'executable', outcome }, 'branch')) {
        commitRunArtifacts({ cwd: root, runId: 'r1', message: `omd run r1: 不该发生 (${outcome})` });
      }

      // 门卫挡住了 → 一个 commit 都没多, 脏文件 B 原样留在工作树里等人审。
      expect(Number(git(root, ['rev-list', '--count', 'HEAD']))).toBe(baselineCount);
      expect(git(root, ['status', '--porcelain'])).toContain('b.txt');
      // ★ 反向自检 (已实测会红): 把 run-worktree.ts 的 shouldAutoCommit 白名单加上本 outcome
      //   (如 `|| run.outcome === 'not-converged'`) → 门卫放行 → commitRunArtifacts 把 b.txt 收走
      //   → 上面两条断言同时红。
    });
  }
});
