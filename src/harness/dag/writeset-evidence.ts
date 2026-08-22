/**
 * src/harness/dag/writeset-evidence —— 修复轮写集判据 (SDD s1 切片 1, 2026-08-22)
 *
 * **本模块解决的根死因**: 隔离档 (`branchStrategy:'branch'`) 下被点名的叶子进毒集后重跑,
 * 看见活已经在盘上干完,于是**理性地**只读不写 —— 闸却判「本轮 filesTouched 空 → empty-done」。
 * 后果: 下游全 skip, run 0 产出。
 *
 * **判据换成**: 「**本 run** 有没有动过写集里点名的文件」,而不是「**本轮** 有没有敲几下键盘」。
 * 证据 = git,不是 mtime(后者已在 mtime 那条救援②上覆盖**本节点窗口**,而本片要的是**跨轮**)。
 *
 * 三条不许救的 (D-4 承重):
 *   - 节点没有 `write_set` ⇒ 没合同就没判据, 不救
 *   - 写集文件相对 baseline 没有改动 ⇒ 那就是真 empty-done
 *   - git 起不来 / 不是 git 仓 ⇒ fail-closed, 且 reason 必带错误原文 (本仓纪律: 不许吞证据)
 *
 * **只在隔离档启用** (D-2): 调用方需要在 `continuity.rollbackBaseline` 缺席时整个跳过本模块,
 * —— 行为逐字同旧。今天 helper 自己**不**做这个短路, 把这个判断留在调用方 (engine.ts 救援③ 那段):
 * 写成「helper 不挑环境」更易测, 写成「helper 自带 no-baseline 短路」更易复用, 我们选前者
 * (INV-1: baseline 缺席时 helper 直接返 no-baseline)。
 */

import { spawnSync } from 'node:child_process';

/**
 * 调 git 拿写集相对 baseline 的状态行 (--porcelain 输出)。
 *
 * 测试可注入: 默认跑真 `git status --porcelain -- <paths>`, cwd = `root`。
 */
export type RunGit = (args: { root: string; paths: string[] }) => {
  exitCode: number;
  stdout: string;
  stderr: string;
};

const defaultRunGit: RunGit = ({ root, paths }) => {
  const r = spawnSync('git', ['status', '--porcelain', '--', ...paths], {
    cwd: root,
    encoding: 'utf-8',
  });
  return {
    exitCode: r.status ?? -1,
    stdout: typeof r.stdout === 'string' ? r.stdout : '',
    stderr: typeof r.stderr === 'string' ? r.stderr : '',
  };
};

/**
 * 写集相对 baseline 的改动探测。返回 `{ changed, reason? }`。
 *
 * - `changed` 是**写集里**、相对 baseline 有改动的相对路径 (含未跟踪)。
 * - `reason` 是 fail-closed / 短路 的判词 (下游日志里要带)。
 *
 * INV 表 (来自 SDD C-1):
 *   INV-1 baseline 缺席 ⇒ changed 空, reason='no-baseline'
 *   INV-2 writeSet 空 ⇒ changed 空, reason='no-write-set'
 *   INV-3 git 退出码非 0 ⇒ changed 空, reason 带 git 错误原文
 *   INV-4 git 输出非空 ⇒ 解析出的路径 (与写集求交) 进 changed
 *   INV-5 git 输出空 ⇒ changed 空, reason='no-change' —— 真 empty-done 走这条
 */
export type WriteSetEvidenceArgs = {
  /** git 树根 (隔离档 = execRoot, 不是 repoRoot)。 */
  root: string;
  /** 节点声明的写集 (相对路径)。 */
  writeSet: readonly string[];
  /** 本 run 的回滚基线 commit (隔离档才有, 缺失 = head 档 = 不救)。 */
  baseline?: string;
  /** 测试注入点。默认真 git。 */
  runGit?: RunGit;
};

export type WriteSetEvidence = {
  changed: string[];
  reason?: string;
};

export function writeSetChangedSinceBaseline(args: WriteSetEvidenceArgs): WriteSetEvidence {
  // INV-1 — D-2 承重: 缺席 baseline ⇒ head 档, 一律不启用本判据。
  if (!args.baseline) return { changed: [], reason: 'no-baseline' };

  // INV-2 — D-4 承重: 没有写集就没合同, 不救。
  const ws = (args.writeSet ?? []).filter((p) => typeof p === 'string' && p.length > 0);
  if (ws.length === 0) return { changed: [], reason: 'no-write-set' };

  const runGit = args.runGit ?? defaultRunGit;
  const r = runGit({ root: args.root, paths: [...ws] });

  // INV-3 — D-4 承重: git 退非 0 = fail-closed, reason 必带错误原文。
  // 不许把这条写成空 reason: 那正是 fail-open 吞证据的死法 (本仓纪律 §3)。
  if (r.exitCode !== 0) {
    const detail = (r.stderr || r.stdout || `exit=${r.exitCode}`).trim();
    return { changed: [], reason: `git-failed: ${detail}` };
  }

  // git --porcelain 每行格式: "XY <path>" (rename/copy 占 2 列), path 可带 " -> "。
  // 我们要的是写集里点名的路径 — 与 writeSet 求交, 不引入写集外的文件 (D-4 承重)。
  const wsSet = new Set(ws);
  const changed: string[] = [];
  const seen = new Set<string>();
  for (const line of r.stdout.split('\n')) {
    if (!line) continue;
    // 截路径部分: 前缀 2-3 列 (XY / XY<SP>) + 空格后的 path
    // porcelain 1: ' M path' / '?? path' / 'R  old -> new' ...
    // 跳过 rename 第二段 (' -> ') — 用 -> 之前的段去匹配。
    const pathPart = line.length > 3 ? line.slice(3) : '';
    if (!pathPart) continue;
    const candidate = pathPart.includes(' -> ') ? pathPart.split(' -> ')[0]! : pathPart;
    if (wsSet.has(candidate) && !seen.has(candidate)) {
      seen.add(candidate);
      changed.push(candidate);
    }
  }

  // INV-5 — 真 empty-done 走这条。
  if (changed.length === 0) return { changed: [], reason: 'no-change' };

  return { changed };
}