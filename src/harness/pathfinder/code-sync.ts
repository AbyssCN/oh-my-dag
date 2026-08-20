/**
 * src/harness/pathfinder/code-sync —— 「代码落地了, 票没收尾」的对账核。
 *
 * ## 为什么要有它
 *
 * gh 后端把票的终态记在**标签**上(`backend-gh.ts` 的 `baseStatus`):
 *
 *   - CLOSED + `path:delivered` → `delivered`(终态, 不再入区域)
 *   - CLOSED **无** `path:delivered` → `ruled`  ← **这一格是坑**
 *
 * 而 `readyRegion`(`src/mcp/tools/pathfinder.ts`)编下一次 `map_deliver` 的 slice 时, 选的正是
 * **`ruled` 的 task/prototype 票**。于是一张「活干完了、issue 也关了、只是没人贴 `path:delivered`」
 * 的票会被**重新编进图再跑一遍** —— 实测: #182 (H1 prompt 快照锁) 代码已在 main、issue 已 CLOSED,
 * 而 `readyRegion` 仍把它算进 slice。
 *
 * 自动路(`afk-hook.ts` 的回流)会贴这个标签, 但它**只认经 omd 自己派发的票** —— 靠
 * `.omd/goal-results/` 里的 result 文件认领。人/别的 agent 直接往 main 提交的活, 这条路一次都不会跑,
 * 于是标签永远补不上。本文件就是补这个洞的对账核。
 *
 * ## 两类漂移, 强度**不同**(刻意不混为一谈)
 *
 * - **`closed-not-delivered` = 硬闸(零假阳性)**。CLOSED 的 task/prototype 票缺 `path:delivered`
 *   在任何情况下都是错的 —— 它的唯一后果就是被重跑。判据不依赖任何人的意图。
 * - **`code-landed-issue-open` = 提示(不判红)**。main 上有 `feat(#N):` 这样的**主题行**认领了 N,
 *   而 N 还开着。它**可能**只是分期交付的中间一笔(#206 就有三笔), 所以这是一张待人扫的清单,
 *   不是判词。把它当硬闸会天天误杀在建的票。
 *   ⚠ 只认**主题行前缀**的认领, 不认正文里的 `#N` —— 正文提及是"相关", 不是"这一笔做了它"。
 *   实证: `feat(#190)` 与 `feat(#211)` 的正文都提到 #189, 而 #189 是另一张还没开工的票。
 */

/** 一条 main 上的提交, 及它**主题行**认领的票号。 */
export interface CommitClaim {
  sha: string;
  subject: string;
  /** 主题行 `type(#N):` 前缀认领的票号(可能多个, 如 `feat(#203+#198)`)。 */
  issues: number[];
}

/** 一张 gh 票的现状(read 方向, 由调用方从 gh 抓)。 */
export interface IssueState {
  number: number;
  state: 'OPEN' | 'CLOSED';
  labels: string[];
  /**
   * 它所属地图 issue 的开闭态。省略 = 未知, **按 OPEN 处理**(宁可多报一条待人扫, 不漏真风险)。
   *
   * ⚠ 为什么要这一格: `listMaps` (backend-gh.ts:586) 用的是 `--state open` —— 图 issue 一关,
   * 整张图退场, 它的票再也不会被 `readyRegion` 编进任何 slice。所以**退役图上的票没有重跑风险**,
   * 硬报它们就是纯噪声。实测: 不分图态时 20 条硬漂移里 12 条来自已退役的图 #14 (60% 噪声) ——
   * 一个 60% 是噪声的闸会被人学会无视, 那就等于没有闸。
   */
  mapState?: 'OPEN' | 'CLOSED';
}

export type SyncDrift =
  /** 硬闸: CLOSED 的 task/prototype 票没贴 delivered → 会被 readyRegion 重新编进 slice 再跑一遍。 */
  | { kind: 'closed-not-delivered'; issue: number; severity: 'error' }
  /** 提示: main 上有提交认领了它, 而票还开着 → 可能只是分期交付的一笔, 待人扫。 */
  | { kind: 'code-landed-issue-open'; issue: number; commits: string[]; severity: 'warn' };

/** 进 `readyRegion` 的票型 —— 只有这两型会被重新编图, 硬闸也只管这两型。 */
const REEXECUTABLE_TYPES = ['task', 'prototype'] as const;

/**
 * 从提交主题行抽认领的票号。只认 `<type>(#N):` / `<type>(#N+#M):` 这种**前缀**形。
 *
 * 认: `feat(#185): ...` · `fix(#206): ...` · `feat(#203+#198): ...` · `test(#197): ...`
 * 不认: `merge: #197 executorKind ...`(不是前缀括号形) · 正文里的任何 `#N`。
 */
export function parseSubjectClaims(subject: string): number[] {
  const m = /^[a-z]+(?:\([^)]*\))?\(([^)]*#\d[^)]*)\)!?:/.exec(subject) ?? /^[a-z]+\(([^)]*#\d[^)]*)\):/.exec(subject);
  if (!m) return [];
  const inner = m[1]!;
  const nums = inner.match(/#(\d+)/g) ?? [];
  return [...new Set(nums.map((n) => Number(n.slice(1))))];
}

/** 票型标签 → 型名(`path:task` → `task`);没有票型标签 = 不是票(如 map issue)。 */
function ticketTypeOf(labels: string[]): string | null {
  for (const l of labels) {
    if (l === 'path:map' || l === 'path:delivered' || l === 'path:suggested' || l === 'path:escalated') continue;
    if (l.startsWith('path:')) return l.slice('path:'.length);
  }
  return null;
}

/**
 * 对账。`commits` = main 上的提交(带主题行认领), `issues` = 这些票的现状。
 *
 * 返回按「硬闸在前」排好的漂移表。空表 = 票与代码一致。
 */
export function reconcileCodeAndTickets(commits: CommitClaim[], issues: IssueState[]): SyncDrift[] {
  const byNumber = new Map(issues.map((i) => [i.number, i]));
  const errors: SyncDrift[] = [];
  const warns: SyncDrift[] = [];

  // ── 硬闸: CLOSED 的 task/prototype 票缺 delivered 标签 ──────────────────────
  // 不看提交 —— 这一格与"有没有人提交过"无关, 票自己的形状就已经错了。
  for (const issue of issues) {
    if (issue.state !== 'CLOSED') continue;
    if (issue.mapState === 'CLOSED') continue; // 图已退役 → 这张票进不了任何 slice, 报它是噪声
    const type = ticketTypeOf(issue.labels);
    if (type === null || !(REEXECUTABLE_TYPES as readonly string[]).includes(type)) continue;
    if (issue.labels.includes('path:delivered')) continue;
    errors.push({ kind: 'closed-not-delivered', issue: issue.number, severity: 'error' });
  }

  // ── 提示: 有提交认领, 票还开着 ──────────────────────────────────────────────
  const claimed = new Map<number, string[]>();
  for (const c of commits) {
    for (const n of c.issues) {
      if (!claimed.has(n)) claimed.set(n, []);
      claimed.get(n)!.push(c.sha);
    }
  }
  for (const [number, shas] of [...claimed].sort((a, b) => a[0] - b[0])) {
    const issue = byNumber.get(number);
    if (!issue || issue.state !== 'OPEN') continue;
    if (ticketTypeOf(issue.labels) === null) continue; // 不是票(map issue 之类)
    warns.push({ kind: 'code-landed-issue-open', issue: number, commits: shas, severity: 'warn' });
  }

  return [...errors, ...warns];
}

/** 人读的判词(CI 日志 / 本地跑都用这一份, 别两处各拼一次)。 */
export function formatDrift(d: SyncDrift): string {
  if (d.kind === 'closed-not-delivered') {
    return `#${d.issue}: 票已 CLOSED 但没有 path:delivered → baseStatus 读回 'ruled', readyRegion 会把它重新编进下一次 map_deliver 的 slice 再跑一遍。修: gh issue edit ${d.issue} --add-label path:delivered`;
  }
  return `#${d.issue}: main 上 ${d.commits.join(', ')} 的主题行认领了它, 而票还开着 → 活干完了就关票贴标签; 若只是分期交付的一笔则忽略本行。`;
}
