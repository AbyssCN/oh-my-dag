/**
 * omd 自身仓根 + 留痕库锚点 (2026-08-05 owner 定盘)。
 *
 * GWT: 从**任何 cwd** 发的 omd 跑 → 记录落**同一份** dag-runs.db (= omd 自己仓根那份)。
 *
 * 本次修改前是 `join(cwd, '.omd', 'dag-runs.db')`, 三个调用点各写一份。于是从别的 repo 的
 * session 发的跑, 记录进的是**那个 repo** 的库 —— 实测 `/home/nick/repos/bluebell` 底下真有
 * 一份, 而且是老 schema 连 `claim_check` 列都没有。读数板只读其中一份, 缺的数**长得像
 * "引擎没记"**, 而不是"记在别处了"。
 *
 * 证伪方式 (每次改这块先跑一遍): 把 `ledgerPath()` 改回 `join(process.cwd(), '.omd', ...)`
 * → 「与 cwd 无关」那条当场红。把 `omdRepoRoot` 里的 worktree 重定向拿掉 → worktree 那条当场红。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ledgerPath } from './dag/dag-record';
import { mainRepoRootOfWorktree, omdRepoRoot } from './repo-root';

const origCwd = process.cwd();
afterEach(() => process.chdir(origCwd));

/**
 * 期望的仓根 —— **拿 git 自己当 oracle**,独立于被测实现(不循环论证)。
 *
 * `--git-common-dir` 在主仓与 linked worktree 里指向**同一个** `.git`,它的父目录正是
 * `omdRepoRoot()` 按定义该返回的那个根(worktree 重定向就是冲这个去的)。
 *
 * ⚠ 此前下面两条 ★ 把期望值直接写成 `origCwd` —— 在主仓里两者恰好相等,所以一直绿;
 * 在 **worktree 里必假红**,而代码行为完全正确(`repo-root.ts:55` 的重定向)。
 * 实测代价(2026-08-14):worktree 全量恒红 2 条,红的理由与它们要守的东西无关。
 *
 * fail-open: 没有 git / 不在仓里 → 退回 cwd(= 改这条之前的老口径)。
 */
function repoRootByGit(): string {
  try {
    const r = Bun.spawnSync(['git', '-C', origCwd, 'rev-parse', '--path-format=absolute', '--git-common-dir']);
    const out = r.stdout.toString().trim();
    return r.exitCode === 0 && out ? realpathSync(dirname(out)) : realpathSync(origCwd);
  } catch {
    return realpathSync(origCwd);
  }
}

/** 造 `<root>/package.json` + `<root>/a/b` 的临时树 (macOS 的 /var→/private/var 用 realpath 归一)。 */
function pkgTree(): { root: string; deep: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'omd-reporoot-')));
  const deep = join(root, 'a', 'b');
  mkdirSync(deep, { recursive: true });
  writeFileSync(join(root, 'package.json'), '{"name":"fake"}\n');
  return { root, deep };
}

describe('omdRepoRoot — 锚点是模块位置, 不是 cwd', () => {
  test('深层子目录起 → 向上找到含 package.json 的那一层', () => {
    const { root, deep } = pkgTree();
    expect(omdRepoRoot(deep)).toBe(root);
  });

  test('一路没有 package.json → fail-open 退回 process.cwd() (不抛)', () => {
    const bare = realpathSync(mkdtempSync(join(tmpdir(), 'omd-bare-')));
    const deep = join(bare, 'x', 'y');
    mkdirSync(deep, { recursive: true });
    expect(omdRepoRoot(deep)).toBe(process.cwd());
  });

  test('名叫 package.json 的**目录**不算锚点 (isFile 而非 exists)', () => {
    // existsSync 对目录也返 true —— 5851c8b 那条 worktree 病根就是同一格类型混淆, 别再犯。
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'omd-pkgdir-')));
    const outer = join(base, 'outer');
    const inner = join(outer, 'inner');
    mkdirSync(join(inner, 'package.json'), { recursive: true }); // 目录!
    writeFileSync(join(outer, 'package.json'), '{"name":"real"}\n');
    expect(omdRepoRoot(inner)).toBe(outer);
  });

  test('★ 无参调用 = 本仓根, 且**改 cwd 不影响** (这次改动的核心)', () => {
    const anchored = omdRepoRoot();
    const { deep } = pkgTree();
    process.chdir(deep);
    expect(omdRepoRoot()).toBe(anchored);
    expect(realpathSync(anchored)).toBe(repoRootByGit());
  });
});

// ── linked worktree: 与 config 发现层同一个 helper (两处各算一份必漂) ──────────────

/** 造「主仓 + linked worktree」的形状 (不需要真 git: 判据只看 `.git` 文件的内容)。 */
function worktreeTree(gitdir?: string): { main: string; wt: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'omd-wtroot-')));
  const main = join(base, 'main');
  const wt = join(base, 'wt');
  mkdirSync(join(main, '.git'), { recursive: true });
  mkdirSync(wt, { recursive: true });
  writeFileSync(join(wt, 'package.json'), '{"name":"fake"}\n');
  writeFileSync(join(wt, '.git'), `gitdir: ${gitdir ?? join(main, '.git', 'worktrees', 'wt')}\n`);
  return { main, wt };
}

describe('omdRepoRoot — linked worktree 回主仓', () => {
  test('★ worktree 里起 → 返**主仓**根 (否则 .omd/ 是 gitignored, 库又分裂一次)', () => {
    const { main, wt } = worktreeTree();
    expect(omdRepoRoot(wt)).toBe(main);
  });

  test('★ submodule 的 `.git` 也是文件, 但**不许**重定向到宿主仓', () => {
    const { wt } = worktreeTree('../.git/modules/foo');
    expect(omdRepoRoot(wt)).toBe(wt);
  });

  test('`.git` 读不懂 → fail-open 回落, 不抛', () => {
    const { wt } = worktreeTree('');
    expect(omdRepoRoot(wt)).toBe(wt);
  });

  test('普通仓 (`.git` 是目录) → 不重定向', () => {
    const { root } = pkgTree();
    mkdirSync(join(root, '.git'), { recursive: true });
    expect(omdRepoRoot(root)).toBe(root);
    expect(mainRepoRootOfWorktree(join(root, '.git'))).toBeNull();
  });
});

describe('ledgerPath — 留痕库只有一个位置', () => {
  test('★ 从任何 cwd 调用都返同一个绝对路径 (= 老口径 join(cwd,…) 会红的那条)', () => {
    const first = ledgerPath();
    const { deep } = pkgTree();
    process.chdir(deep);
    expect(ledgerPath()).toBe(first);
    expect(first.startsWith('/')).toBe(true);
    expect(first).toBe(join(omdRepoRoot(), '.omd', 'dag-runs.db'));
  });

  test('落在 omd 仓根下的 .omd/ 里 (不是 src/harness/.omd, 也不是 tmp)', () => {
    expect(ledgerPath()).toBe(join(repoRootByGit(), '.omd', 'dag-runs.db'));
  });
});
