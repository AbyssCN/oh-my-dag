/**
 * #147 点火锚预检 (2026-08-17) —— goal 文本里的别仓路径**不改执行锚**。
 *
 * B0 实测 (runId `f5984f2b`): goal 写明 `/home/dev/repos/other-repo`, 而 MCP solve 的锚是 server
 * 自己的 cwd (oh-my-dag) —— branch worktree / 验收命令 / continuity 全落锚仓, 目标仓的
 * `packages/engine` 在锚仓里不存在, 两轮必红, 烧完 1.11M in 才看得见; 且症状与"活没干成"
 * 同形 (验收 grep 红), 点火到烧完没有任何一处提示锚不匹配。
 *
 * 判据 (issue #147, 便宜那一半): goal 文本中的绝对路径, 其最近 git toplevel 存在 ∧ ≠ 锚仓
 * toplevel → 报锚不匹配。零模型调用, 纯字符串 + stat。
 *
 * 反向自检 (仓规: 新闸必须当场证伪): `anchor-precheck.test.ts` 构造两个真临时仓,
 * 证明含他仓路径的 goal 真的会红、含本仓路径的不红。
 */
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * `dir` 所在 git 仓的 toplevel (最近含 `.git` 的祖先; `.git` 是文件也算 —— worktree 形态)。
 * 不在任何仓里 / 路径不存在 → null。
 */
export function gitToplevelOf(dir: string): string | null {
  let cur: string;
  try {
    cur = realpathSync(dir);
  } catch {
    return null;
  }
  for (;;) {
    if (existsSync(join(cur, '.git'))) return cur;
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

/** 绝对路径候选: `/a/b` 起步的 ≥2 段 ASCII 路径 (段字符到空白/CJK/引号即止, 够住仓路径的形状)。 */
const ABS_PATH_RE = /\/(?:[\w.@+-]+\/)+[\w.@+-]+/g;

export interface AnchorMismatch {
  /** 锚仓 toplevel (realpath)。 */
  anchorRoot: string;
  /** goal 文本里提到的、锚仓之外的 git toplevel (去重, realpath)。 */
  foreign: string[];
}

/**
 * goal 文本 × 执行锚的错配检测。候选路径可以不存在 (goal 常写 `<仓>/packages/…` 这类
 * 还没建出来的子路径) —— 取最近**存在**的祖先再找 toplevel。
 * 锚自己不在 git 仓里 → 比不出"别仓", 闸缺席 (fail-open, 返 null)。
 */
export function detectAnchorMismatch(goalText: string, anchorDir: string): AnchorMismatch | null {
  const anchorRoot = gitToplevelOf(anchorDir);
  if (!anchorRoot) return null;
  const foreign = new Set<string>();
  for (const candidate of goalText.match(ABS_PATH_RE) ?? []) {
    let p = candidate;
    while (p !== '/' && !existsSync(p)) p = dirname(p);
    const root = gitToplevelOf(p);
    if (root && root !== anchorRoot) foreign.add(root);
  }
  return foreign.size ? { anchorRoot, foreign: [...foreign] } : null;
}
