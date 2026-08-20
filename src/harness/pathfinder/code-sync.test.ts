/**
 * 「代码落地了, 票没收尾」对账核的闸(`code-sync.ts`)。
 *
 * 每条都配反向自检(本仓惯例 G-6: 一条永远绿的闸不是闸)。样本用的是**真实**形状 ——
 * 主题行取自 main 的提交, 票形状取自 gh 上 map #181 的两张真票(#182 / #185), 不是编的:
 *   - #182: CLOSED + `path:task`, **无** `path:delivered` → 硬闸该红(实测它确实会被 readyRegion 重编)
 *   - #185: OPEN  + `path:task`, 而 main 上有 `feat(#185):` → 提示该出
 *
 * 判别力锚(A-3 同族): 把 `#183`(CLOSED + delivered)摆进同一批, 它**不许**出现在任何一条漂移里 ——
 * 一个把所有 CLOSED 票都报一遍的"闸"量的是尺子, 不是被测物。
 */
import { describe, expect, test } from 'bun:test';
import {
  type CommitClaim,
  type IssueState,
  formatDrift,
  parseSubjectClaims,
  reconcileCodeAndTickets,
} from './code-sync';

describe('parseSubjectClaims — 只认主题行前缀的认领', () => {
  test('认 `type(#N):` 前缀(main 上的真实主题行)', () => {
    expect(parseSubjectClaims('feat(#185): H4 compaction 事务化 —— start/summary/replace/end 四步入日志')).toEqual([185]);
    expect(parseSubjectClaims('fix(#212): 「不回喂自己」把开场交接整个挡掉了')).toEqual([212]);
    expect(parseSubjectClaims('test(#197): 补上「两处各证一次」缺的那一处')).toEqual([197]);
  });

  test('一笔认领两张票 `feat(#203+#198):`(main 上真有这一条)', () => {
    expect(parseSubjectClaims('feat(#203+#198): gh 后端补派发锚 + 图退役')).toEqual([203, 198]);
  });

  test('★ 判别力: 不认正文式/非前缀的 `#N` —— 否则「相关」会被当成「做完了」', () => {
    // 反向自检: 把 parseSubjectClaims 换成裸 /#(\d+)/g 全文扫 → 这三条全红。
    // 实证依据: `feat(#190)` 与 `feat(#211)` 的**正文**都提到 #189, 而 #189 是另一张没开工的票。
    expect(parseSubjectClaims('merge: #197 executorKind 缺省即拒 (run 657f6804)')).toEqual([]);
    expect(parseSubjectClaims('feat(serve): 本体 conductor 工具面扩到 ⊇ MCP 装配面')).toEqual([]);
    expect(parseSubjectClaims('docs(plan): 记一下 #189 的前置')).toEqual([]);
  });

  test('无括号 / 无票号的普通提交 → 空', () => {
    expect(parseSubjectClaims('chore: bump deps')).toEqual([]);
    expect(parseSubjectClaims('')).toEqual([]);
  });
});

// ── 真实样本(map #181 上的三张票) ─────────────────────────────────────────────
const ISSUE_182: IssueState = { number: 182, state: 'CLOSED', labels: ['path:task'] };
const ISSUE_183: IssueState = { number: 183, state: 'CLOSED', labels: ['path:task', 'path:delivered'] };
const ISSUE_185: IssueState = { number: 185, state: 'OPEN', labels: ['path:task'] };
const COMMIT_185: CommitClaim = {
  sha: '59546b7',
  subject: 'feat(#185): H4 compaction 事务化 —— start/summary/replace/end 四步入日志',
  issues: [185],
};

describe('硬闸 — CLOSED 的 task 票缺 path:delivered', () => {
  test('★ #182 真实形状: 报 error(它就是会被 readyRegion 重编的那一格)', () => {
    const drift = reconcileCodeAndTickets([], [ISSUE_182]);
    expect(drift).toEqual([{ kind: 'closed-not-delivered', issue: 182, severity: 'error' }]);
  });

  test('★ 判别力: #183 贴了 delivered → 一条都不报(反向自检: 摘掉 delivered 判断 → 本条红)', () => {
    expect(reconcileCodeAndTickets([], [ISSUE_183])).toEqual([]);
  });

  test('grill / research 票 CLOSED 无 delivered → **不报**(它们进不了 readyRegion, 报了就是噪声)', () => {
    const grill: IssueState = { number: 188, state: 'CLOSED', labels: ['path:grill'] };
    expect(reconcileCodeAndTickets([], [grill])).toEqual([]);
  });

  test('map issue 本身 CLOSED → 不报(它不是票)', () => {
    const map: IssueState = { number: 181, state: 'CLOSED', labels: ['path:map'] };
    expect(reconcileCodeAndTickets([], [map])).toEqual([]);
  });

  test('OPEN 的 task 票没 delivered → 不报(开着的票本来就不该有终态标签)', () => {
    expect(reconcileCodeAndTickets([], [ISSUE_185]).filter((d) => d.kind === 'closed-not-delivered')).toEqual([]);
  });

  test('★ 图已退役(mapState CLOSED)→ 不报: 它进不了任何 slice, 没有重跑风险', () => {
    // 真实样本: 图 #14 (session-continuity) 已 close, 它的 #15–#26 全是这一格。
    // 反向自检: 摘掉 mapState 判断 → 本条红(而线上会多出 12 条纯噪声, 实测过)。
    const retired: IssueState = { number: 21, state: 'CLOSED', labels: ['path:task'], mapState: 'CLOSED' };
    expect(reconcileCodeAndTickets([], [retired])).toEqual([]);
  });

  test('图态未知(省略 mapState)→ 仍报(宁可多一条待人扫, 不漏真风险)', () => {
    expect(reconcileCodeAndTickets([], [ISSUE_182])).toEqual([
      { kind: 'closed-not-delivered', issue: 182, severity: 'error' },
    ]);
  });
});

describe('提示 — 有提交认领而票还开着', () => {
  test('★ #185 真实形状: main 上有 feat(#185) 而票 OPEN → 出提示, 且带上 sha', () => {
    const drift = reconcileCodeAndTickets([COMMIT_185], [ISSUE_185]);
    expect(drift).toEqual([{ kind: 'code-landed-issue-open', issue: 185, commits: ['59546b7'], severity: 'warn' }]);
  });

  test('票已 CLOSED → 不再提示(反向自检: 去掉 state 判断 → 本条红)', () => {
    const closed: IssueState = { ...ISSUE_185, state: 'CLOSED', labels: ['path:task', 'path:delivered'] };
    expect(reconcileCodeAndTickets([COMMIT_185], [closed])).toEqual([]);
  });

  test('认领了一个不在票集里的号(如外部 PR 号)→ 不报', () => {
    expect(reconcileCodeAndTickets([{ sha: 'abc1234', subject: 'feat(#9999): x', issues: [9999] }], [])).toEqual([]);
  });

  test('同一张票多笔提交 → 合成一条, sha 全带上', () => {
    const two = [COMMIT_185, { sha: 'deadbee', subject: 'fix(#185): 补一刀', issues: [185] }];
    const drift = reconcileCodeAndTickets(two, [ISSUE_185]);
    expect(drift).toEqual([{ kind: 'code-landed-issue-open', issue: 185, commits: ['59546b7', 'deadbee'], severity: 'warn' }]);
  });
});

describe('合起来 — 硬闸排在提示前面', () => {
  test('三张票一起过: 只有 #182 报 error, 只有 #185 出 warn, #183 一条都不占', () => {
    const drift = reconcileCodeAndTickets([COMMIT_185], [ISSUE_182, ISSUE_183, ISSUE_185]);
    expect(drift).toEqual([
      { kind: 'closed-not-delivered', issue: 182, severity: 'error' },
      { kind: 'code-landed-issue-open', issue: 185, commits: ['59546b7'], severity: 'warn' },
    ]);
    expect(drift.some((d) => d.issue === 183)).toBe(false);
  });

  test('判词点名票号 + 给出修法(INV-1 同族: 不说"有漂移", 说"哪一张、怎么修")', () => {
    const [hard, soft] = reconcileCodeAndTickets([COMMIT_185], [ISSUE_182, ISSUE_185]);
    expect(formatDrift(hard!)).toContain('#182');
    expect(formatDrift(hard!)).toContain('--add-label path:delivered');
    expect(formatDrift(soft!)).toContain('#185');
    expect(formatDrift(soft!)).toContain('59546b7');
  });
});
