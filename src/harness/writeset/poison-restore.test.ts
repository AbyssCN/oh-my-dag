/**
 * `defaultPoisonRestore` —— 毒集回滚里**跟踪文件还原到基线**那一半的真 git 用例
 * (2026-08-21, run `58df6b9e` 复盘)。
 *
 * ## 为什么这一条必须用真 git,不许注入假 runner
 *
 * `planPoisonRollback` 那边全部零 IO,因为那里的价值是"与门一条都不许塌"。
 * 这里的价值相反:它的**全部**内容就是 `git checkout <基线> -- <路径>` 到底干了什么。
 * 拿注入的假 git 去测,测的是我对 git 语义的记忆,不是它的行为 —— 同 `run-landed.test.ts`
 * 头注那条理由。
 *
 * ## 它治的现场
 *
 * run `58df6b9e` 的 9 条声明产物**全是 git 跟踪的既有文件** → 老判据全部"没撤" →
 * 重跑的 leaf 看见实装还在,判「已经做完了」,一次写工具都没用 → `empty-artifact` →
 * 5 个下游 dep-skip(含最终验收节点)。还原这一半就是补它。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { applyPoisonRollback, defaultPoisonRestore, planPoisonRollback } from './poison-rollback';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const git = (root: string, args: string[]): void => {
  const r = Bun.spawnSync(['git', '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')} 失败 (${r.exitCode}): ${new TextDecoder().decode(r.stderr).trim()}`);
};

const write = (root: string, rel: string, body: string): void => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
};

const read = (root: string, rel: string): string => readFileSync(join(root, rel), 'utf8');

/** 一棵"隔离 worktree"的替身:HEAD 上有实装基线,树里有本轮改出来的脏改动。 */
function treeWithBaseline(): string {
  const root = mkdtempSync(join(tmpdir(), 'omd-poison-restore-'));
  dirs.push(root);
  git(root, ['init', '-q', '-b', 'main']);
  write(root, 'src/impl.ts', 'export const V = 1;\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-m', 'baseline']);
  return root;
}

describe('defaultPoisonRestore —— 真 git 还原', () => {
  test('★ 跟踪文件被本轮改过 → 还原到基线, 内容逐字回到 HEAD', () => {
    // 怎么让它红: 把 defaultPoisonRestore 的 `git checkout` 换成 no-op 返回 null → 内容不回退, 这条红。
    const root = treeWithBaseline();
    write(root, 'src/impl.ts', 'export const V = 2; // 被否决节点写的\n');
    expect(read(root, 'src/impl.ts')).toContain('V = 2');

    const err = defaultPoisonRestore('HEAD', ['src/impl.ts'], root);

    expect(err).toBeNull();
    expect(read(root, 'src/impl.ts')).toBe('export const V = 1;\n');
  });

  test('★ 还原**只碰点名的路径**, 同轮其它文件一个字不动', () => {
    // 与门④(存活节点的产物不许毁)在 plan 层拦; 这条钉的是 apply 层不会顺手多改 ——
    // 怎么让它红: 把 `git checkout <base> -- <paths>` 改成 `git reset --hard <base>` → 这条红。
    // 那正是"整树 reset"与"按路径还原"的分野, 也是我一开始想错的那一版。
    const root = treeWithBaseline();
    write(root, 'src/impl.ts', 'export const V = 2;\n');
    write(root, 'src/other.ts', 'export const KEEP = true;\n'); // 未跟踪, 存活节点的产物

    const err = defaultPoisonRestore('HEAD', ['src/impl.ts'], root);

    expect(err).toBeNull();
    expect(read(root, 'src/impl.ts')).toBe('export const V = 1;\n');
    expect(existsSync(join(root, 'src/other.ts'))).toBe(true); // 没被 reset --hard 顺手抹掉
    expect(read(root, 'src/other.ts')).toBe('export const KEEP = true;\n');
  });

  test('★ 路径在基线里不存在 → 返回 git 的错误原文, **不抛**(fail-open 但不吞证据)', () => {
    // 回滚失败不许把 run 带塌; 但"失败了"必须能从返回值看出来 ——
    // 怎么让它红: 把 catch/非零分支改成返回 null → 这条红(错误被吞成"成功")。
    const root = treeWithBaseline();
    const err = defaultPoisonRestore('HEAD', ['src/never-existed.ts'], root);
    expect(err).not.toBeNull();
    expect(err).toMatch(/pathspec|did not match|does not exist/i);
  });
});

describe('applyPoisonRollback —— 两种动作端到端(删新建 + 还原跟踪)', () => {
  test('★ 同一轮里: 新建文件被删, 跟踪文件被还原, 两者都真落在盘上', () => {
    // 这是 run 58df6b9e 的完整形状: 被否决节点既新建了测试文件, 又改了既有实装。
    // 老行为下**两样都留在盘上**, 于是重跑的 leaf 看见"活已经干完"。
    // 怎么让它红: 把 goal.ts 的 rollbackBaseline 摘掉 → restore 恒空, 实装不回退, 这条红。
    const root = treeWithBaseline();
    write(root, 'src/impl.ts', 'export const V = 2;\n'); // 跟踪文件, 被改
    write(root, 'src/impl.test.ts', 'test stub\n'); // 新建文件

    const hashOf = (abs: string): string | null => (existsSync(abs) ? Bun.hash(readFileSync(abs, 'utf8')).toString(16) : null);
    const dropped = [
      {
        node: 'slice1',
        outputPaths: ['src/impl.ts', 'src/impl.test.ts'],
        artifactHashes: {
          'src/impl.ts': hashOf(join(root, 'src/impl.ts'))!,
          'src/impl.test.ts': hashOf(join(root, 'src/impl.test.ts'))!,
        },
      },
    ];
    const plan = planPoisonRollback(dropped, new Set(), root, {
      hashOf,
      existsInHead: (rel) => Bun.spawnSync(['git', 'cat-file', '-e', `HEAD:${rel}`], { cwd: root, stdout: 'ignore', stderr: 'ignore' }).exitCode === 0,
    }, 'HEAD');

    expect(plan.restore.map((r) => r.path)).toEqual(['src/impl.ts']);
    expect(plan.remove.map((r) => r.path)).toEqual(['src/impl.test.ts']);
    expect(plan.skipped).toEqual([]);

    applyPoisonRollback(plan, root, { baseline: 'HEAD' });

    expect(read(root, 'src/impl.ts')).toBe('export const V = 1;\n'); // 还原
    expect(existsSync(join(root, 'src/impl.test.ts'))).toBe(false); // 删除
  });

  test('★ 有 restore 但没给 baseline → 降级留证, **不许静默当成撤过了**', () => {
    // 缺席 ≠ 零跟踪文件 (本仓 NULL≠0≠不适用 那一条)。
    // 怎么让它红: 把 apply 里 `o.baseline ? … : '未接线'` 改成无基线时直接跳过 → 盘上照样是脏的
    // 而日志一个字不说, 这条红。
    const root = treeWithBaseline();
    write(root, 'src/impl.ts', 'export const V = 2;\n');
    const plan = { remove: [], restore: [{ path: 'src/impl.ts', node: 'slice1' }], skipped: [] };

    applyPoisonRollback(plan, root, {}); // 没给 baseline

    expect(read(root, 'src/impl.ts')).toBe('export const V = 2;\n'); // 盘上没动 —— 而这一点必须留证
  });
});
