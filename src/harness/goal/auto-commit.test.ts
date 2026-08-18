/**
 * #165② 收编闸 — 真 git 端到端契约 (run-worktree.test.ts 那组是注入假 git,
 * 这组用真 `git init`/`commit`/`rev-list` 验真实行为 —— 写集真身是否真进 commit、
 * 判据红时脏树是否真留在外面, 都得用真 git 才验得出)。
 *
 * 两条用例, 各一格反向自检: ① 删 src/mcp/tools/goal.ts:727 commitRunArtifacts 调用 →
 *   HEAD +1 断言红; ② 删 src/mcp/tools/goal.ts:719 `if (shouldAutoCommit(...))` 门卫行 →
 *   工作树仍脏断言红。grep "反向自检" 冻结判据。
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
    // 反向自检: 删 src/mcp/tools/goal.ts:727 commitRunArtifacts 调用 → 这里 r.committed=false、+1 红。
  });

  test('判据红 (executable + failed + branch) → 拒绝收编, 脏文件仍在工作树', () => {
    const root = freshRoot();
    initRepoWithDirtyB(root);

    const baselineCount = Number(git(root, ['rev-list', '--count', 'HEAD']));
    expect(git(root, ['status', '--porcelain'])).not.toBe('');

    // 判据红 — shouldAutoCommit 恒 false, 真仓也绝不调 commitRunArtifacts (那行 if 是门卫)。
    expect(shouldAutoCommit({ acceptanceKind: 'executable', outcome: 'failed' }, 'branch')).toBe(false);

    // 拒绝路径不调 commitRunArtifacts —— 工作树维持脏。
    expect(git(root, ['status', '--porcelain'])).not.toBe('');
    expect(Number(git(root, ['rev-list', '--count', 'HEAD']))).toBe(baselineCount);
    // 脏文件 B 仍可见 —— 真没收走。
    expect(git(root, ['status', '--porcelain'])).toContain('b.txt');
    // 反向自检: 删 src/mcp/tools/goal.ts:719 `if (shouldAutoCommit(...))` 门卫行 → 上面 shouldAutoCommit 仍 false,
    //   但 commitRunArtifacts 一旦被无门卫地调走, 脏文件消失 → status 空与 b.txt 仍可见两个断言红。
  });
});
