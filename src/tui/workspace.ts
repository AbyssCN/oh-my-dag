/**
 * src/tui/workspace —— 底栏行①的工作区读数(切片②):仓名/分支/脏数/worktree + ssh/tmux。
 *
 * 只在**启动时与每轮结束后**读,不在 render 里读 —— render 每帧都调,那会变成每帧三次 spawn。
 * 读不出(不是 git 仓 / git 不在)→ 对应段 `null`,底栏那段**不画**(segment 模型)。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { WorkspaceInfo } from './render/statusbar';

const git = (cwd: string, ...args: string[]): string | null => {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).trim();
  } catch {
    return null; // 不是 git 仓 / git 不在 —— 段不画, 不是错误
  }
};

/** 隔离 run/worktree 的目录名可能是 UUID;项目 package 名存在时比物理目录名更能标识仓库。 */
function repoName(root: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { name?: unknown };
    if (typeof pkg.name === 'string' && pkg.name.trim()) return pkg.name.trim();
  } catch {
    // 非 JS 仓或坏 package.json → 回落 git 根目录名,工作区读数不能拖垮 TUI。
  }
  return basename(root);
}

export function readWorkspaceInfo(cwd: string): WorkspaceInfo | null {
  const branchRaw = git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD');
  if (branchRaw === null) return null;
  // detached HEAD 时 --abbrev-ref 给字面量 'HEAD' → 换短 SHA(那才是能回答"在哪"的数)。
  const branch = branchRaw === 'HEAD' ? git(cwd, 'rev-parse', '--short', 'HEAD') : branchRaw;
  const porcelain = git(cwd, 'status', '--porcelain');
  const dirty = porcelain ? porcelain.split('\n').filter(Boolean).length : 0;
  // worktree 判定: git-dir 形如 `<主仓>/.git/worktrees/<名>` 才是链接工作树。
  const gitDir = git(cwd, 'rev-parse', '--git-dir');
  const wtMatch = gitDir?.match(/\/\.git\/worktrees\/([^/]+)$/);
  const root = git(cwd, 'rev-parse', '--show-toplevel') ?? cwd;
  return {
    repo: repoName(root),
    branch,
    dirty,
    worktree: wtMatch?.[1] ?? null,
  };
}

/** ssh 段:经 SSH 连着 → 本机 hostname(接进来的是这台机器);本地跑 → `null`(不画)。 */
export function sshSegment(env: Record<string, string | undefined> = process.env, hostname?: string): string | null {
  if (!env.SSH_CONNECTION && !env.SSH_TTY) return null;
  return hostname ?? env.HOSTNAME ?? 'remote';
}

/** tmux 里跑着(Q3:先 `--attach` 包 tmux 的读数面)。 */
export function inTmux(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env.TMUX);
}
