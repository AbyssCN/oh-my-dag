/**
 * src/harness/repo-root —— 「omd 自己装在哪」与「这个 .git 是不是 linked worktree」两个问题的**唯一**答案。
 *
 * 这两件事此前各有各的算法(config 发现层有一份 worktree 识别;留痕库压根没算、直接吃 cwd),
 * 而它们答的是同一个问题。收进一处,免得再漂(本仓惯例:两处各算一份必漂)。
 *
 * ⚠ 注意区分本模块与 `project-scope`:
 *   - `project-scope` 答的是「**当前项目**是谁」(从 cwd 走 git toplevel)—— 随 cwd 走,天经地义。
 *   - 本模块答的是「**omd 自己**在哪」(从模块自身位置走)—— **不随 cwd 走**,这正是重点。
 */
import { readFileSync, statSync } from 'node:fs';
import { dirname, join, parse, sep } from 'node:path';

/**
 * linked worktree 的 `.git` **文件** → 主仓根目录(不是 worktree 就返 null)。
 *
 * 文件内容形如 `gitdir: /path/to/main/.git/worktrees/<name>`。判据取 `/.git/worktrees/` 这个
 * 中缀 —— **submodule 的 `.git` 也是文件**(`gitdir: ../.git/modules/foo`),而 submodule 是
 * 另一个仓,它的配置本就不该跟宿主仓共用。只认 worktree 那一种,别的原样走老路。
 *
 * fail-open: 读不到 / 格式不认 → null → 回落原行为(宁可"没修好", 不可因为读一个文件失败就崩)。
 */
export function mainRepoRootOfWorktree(gitPath: string): string | null {
  try {
    if (statSync(gitPath).isDirectory()) return null; // 普通仓, 不是 worktree
    const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(gitPath, 'utf8'));
    const gitdir = m?.[1]?.trim();
    if (!gitdir) return null;
    const marker = `${sep}.git${sep}worktrees${sep}`;
    const at = gitdir.indexOf(marker);
    return at > 0 ? gitdir.slice(0, at) : null;
  } catch {
    return null;
  }
}

/**
 * **omd 自己的仓根** —— 从本模块的磁盘位置往上找 `package.json`,与 cwd 无关。
 *
 * 为什么不用 cwd:omd 经 MCP 可以从**任何** repo 的 session 发跑(实测:一个 cwd 在
 * `/home/nick/repos/bluebell` 的 daemon 正在跑 omd)。凡是"引擎自己的东西"(读数留痕库)
 * 若按 cwd 写盘,就会碎成一堆互相看不见的库 —— 而那种缺数**长得像"引擎没记"**。
 *
 * linked worktree 同 config 发现层的口径:worktree 是同一个仓 → 回主仓(否则 `.omd/` 是
 * gitignored,worktree 里必然是空的,等于又分裂一次)。
 *
 * fail-open: 一路找不到 `package.json` → 退回 `process.cwd()`(= 2026-08-05 之前的老行为)。
 * 宁可"没修好"也不因为找不到锚点就崩。
 */
export function omdRepoRoot(startDir: string = import.meta.dir): string {
  const fsRoot = parse(startDir).root;
  let dir = startDir;
  for (;;) {
    if (existsFile(join(dir, 'package.json'))) {
      const main = mainRepoRootOfWorktree(join(dir, '.git'));
      return main && main !== dir ? main : dir;
    }
    if (dir === fsRoot) break;
    dir = dirname(dir);
  }
  return process.cwd();
}

/** `existsSync` 的"必须是文件"版 —— 目录名恰好叫 package.json 不算数。 */
function existsFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}
