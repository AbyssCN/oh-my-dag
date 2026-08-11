/**
 * run-tickets 纯核契约测试 (D-2 散雾出口三条, SDD 2026-08-11-control-plane-unification 切片 1)。
 * fixture 手搓 RunGoalResult 字面量, 零 IO 零 live。
 *
 * 端到端的 G-1/G-2 (真 md 后端 + 真 map 落盘 + 前沿) 在 `src/harness/goal/run-goal.test.ts`
 * ——那里才有 runGoal 的接线; 本文件钉的是判据本身。
 */
import { describe, expect, test } from 'bun:test';
import { collectRunTickets, parseOpenItems } from './run-tickets';
import { extractGoalDiscoveries } from './afk-hook';
import { applySuggestions } from './suggest';
import { summarizeGoal } from '../../mcp/tools/goal';
import type { PathMap } from './types';
import type { GoalStage, RunGoalResult } from '../goal/run-goal';

function mkResult(over: Partial<RunGoalResult> = {}): RunGoalResult {
  return {
    goal: '给 omd 加个东西',
    tier: 'complex',
    acceptance: { kind: 'executable', command: 'bun test', expectExit: 0 },
    stages: [],
    sources: [],
    repoContext: '',
    converged: false,
    rounds: 2,
    reusedNodes: [],
    outcome: 'not-converged',
    ...over,
  };
}
const stage = (s: Partial<GoalStage> & Pick<GoalStage, 'stage' | 'outcome'>): GoalStage => ({
  status: s.outcome === 'success' ? 'done' : 'failed',
  summary: '',
  ...s,
});

const RUN = 'run-abc123';

describe('② execute 发现物 — 词表复用, 不另造第二套', () => {
  /**
   * **反漂移闸 (G-6)**: 本模块自己渲染 stage 行喂给 S-1 词表 (不能 import summarizeGoal — 会成环),
   * 于是"渲染形状与 summarizeGoal 一致"这句话必须有人守。这条测试就是那个守门人:
   * 两侧同一份 RunGoalResult, 一侧走真 summarizeGoal + 词表, 一侧走 collectRunTickets。
   *
   * 违规样本 (2026-08-11 实跑证伪, 两个各跑过一次): 把 run-tickets.stageLine 里的 ` — ` 改成 ` - `
   * → 3 fail; 把 `[${s.outcome}…]` 改成 `[${s.status}]` → 2 fail。两次本条都在红名单里
   * (词表的 stage 正则不再命中 → 右侧变空数组)。
   */
  test('stage 行渲染与 summarizeGoal 逐字节一致 (词表两侧同解)', () => {
    const r = mkResult({
      stages: [
        stage({ stage: 'classify', outcome: 'success', summary: 'tier=complex' }),
        stage({ stage: 'survey', outcome: 'empty-result', summary: '勘察步空输出 (跑了但什么都没找到)' }),
        stage({ stage: 'execute', outcome: 'not-converged', summary: '2 轮未收敛 (failed)' }),
      ],
    });
    const viaSummarize = extractGoalDiscoveries(summarizeGoal(r));
    const viaCollect = collectRunTickets(r, { runId: RUN }).map((d) => ({ type: d.type, title: d.title }));
    expect(viaCollect).toEqual(viaSummarize);
    expect(viaCollect.map((d) => d.title)).toEqual([
      '[未收敛·survey] 勘察步空输出 (跑了但什么都没找到)',
      '[未收敛·execute] 2 轮未收敛 (failed)',
    ]);
  });

  test('not-needed / missing-capability 不是发现物 — simple 档成功 run 零票 (O-3 噪声闸)', () => {
    const r = mkResult({
      tier: 'simple',
      converged: true,
      outcome: 'success',
      stages: [
        stage({ stage: 'research', outcome: 'not-needed', summary: 'simple 档: 直接 Execute→Verify (D-5)' }),
        stage({ stage: 'spec', outcome: 'missing-capability', summary: '无 agentRunner → 不产 spec' }),
        stage({ stage: 'execute', outcome: 'success', summary: '1 轮收敛' }),
      ],
    });
    expect(collectRunTickets(r, { runId: RUN })).toEqual([]);
  });

  test('每张票携 runId 锚 (INV-S1-2 suggestedBy = 票→runId→回执)', () => {
    const r = mkResult({ stages: [stage({ stage: 'execute', outcome: 'oracle-failed', summary: '判词说成了但判据没过' })] });
    expect(collectRunTickets(r, { runId: RUN }).map((d) => d.suggestedBy)).toEqual([RUN]);
  });
});

describe('① 契约段未决', () => {
  const SPEC = [
    '# 某 SDD',
    '',
    '## 决策 (Decisions)',
    '',
    '- **D-1 这条不是未决**, 别收。',
    '',
    '## 未决 (Open)',
    '',
    '- **O-1(待 owner)** waiting_human 默认超时时长与升级动作形态。',
    '- **O-2(待实测)** suggested 票的接受率读数。',
    '  · 续行不单独成票 (一条未决 = 一张票)。',
    '',
    '## 非目标 (Non-goals)',
    '',
    '- 不动内环形态。',
  ].join('\n');

  test('只收未决段的顶格条目 (决策/非目标段不越界, 续行不拆票)', () => {
    expect(parseOpenItems(SPEC)).toEqual([
      'O-1(待 owner) waiting_human 默认超时时长与升级动作形态。',
      'O-2(待实测) suggested 票的接受率读数。',
    ]);
  });

  test('未决 → grill 票, 标题自足 (条目原文即可判, 不需读 transcript)', () => {
    const r = mkResult({ specPath: '/repo/docs/plan/2026-08-11-x.md', outcome: 'success', converged: true });
    const drafts = collectRunTickets(r, { runId: RUN, specText: SPEC });
    expect(drafts).toHaveLength(2);
    expect(drafts[0]!.type).toBe('grill');
    expect(drafts[0]!.title).toBe('[未决] O-1(待 owner) waiting_human 默认超时时长与升级动作形态。');
    expect(drafts[0]!.suggestedBy).toBe(RUN);
  });

  /**
   * **静默折票闸** (2026-08-11 首跑当场抓到的缺陷, 这条是它的守门人):
   * 标题挂上 `· spec: <文件名>` 这种**共同尾巴**后, 两条内容完全不同的未决在 hashEmbed 词袋空间里
   * cosine 从 [0.3,0.4) 抬到 [0.5,0.6)(短条目 ≥0.8), 撞穿 applySuggestions 默认阈值 0.6 →
   * 第二条起被静默折进第一条, 症状是"两条未决只落一张票"。
   *
   * 违规样本 (实跑证伪): 把 collectRunTickets 里的 `[未决] ${item}` 改回
   * `[未决] ${item} · spec: ${basename(r.specPath)}` → 本条 expect 当场红 (实测 got 1, expected 2)。
   * ⚠ 这条闸量的是**真机器**: drafts 走真 applySuggestions 落真 map, 不是比字符串。
   */
  test('两条不同未决不得被语义去重折成一张 (标题共同尾巴 = 静默折票)', () => {
    const r = mkResult({ specPath: '/repo/docs/plan/2026-08-11-x.md', outcome: 'success', converged: true });
    const drafts = collectRunTickets(r, { runId: RUN, specText: SPEC });
    const map: PathMap = { destination: 'd', slug: 's', tickets: [], decisionsLog: [] };
    const res = applySuggestions(map, drafts, { at: '2026-08-11T00:00:00.000Z' });
    expect(res.added).toHaveLength(2);
    expect(res.deduped).toEqual([]);
  });

  /** NULL≠0 (仓规第一条): 没喂 spec 正文 = 这条出口缺席, 不冒充"这份 spec 零未决"。 */
  test('无 specText → 无未决票 (缺席 ≠ 零未决)', () => {
    const r = mkResult({ specPath: '/repo/docs/plan/x.md', outcome: 'success', converged: true });
    expect(collectRunTickets(r, { runId: RUN })).toEqual([]);
  });

  test('没有未决段的 spec → 零条 (与"没读到" 由调用方分辨)', () => {
    expect(parseOpenItems('# 只有标题\n\n## 决策\n\n- D-1 啥的')).toEqual([]);
  });
});

describe('③ 终态面 — 原因 + blame 摘要 + resume 把手 (G-2)', () => {
  const CIRCUIT = { pass: false, reason: 'conductor 只修不发明却新增 cache_evidence 节点', circuitBroken: true };

  test('同因熔断 → 票带原因 + blame + resume, 且排在最前 (perRunCap 从尾巴丢)', () => {
    const r = mkResult({
      outcome: 'not-converged',
      stages: [stage({ stage: 'execute', outcome: 'not-converged', summary: '3 轮未收敛' })],
    });
    const drafts = collectRunTickets(r, {
      runId: RUN,
      verification: CIRCUIT,
      blameRetry: { blameSize: 2, closureSize: 5, reuseHits: 3, rerunWallMs: 1000 },
    });
    expect(drafts[0]!.title).toBe(
      `[同因熔断] conductor 只修不发明却新增 cache_evidence 节点 · blame 2 节点/失效闭包 5 · resume: dag_goal resume=${RUN}`,
    );
    expect(drafts[0]!.type).toBe('grill');
    expect(drafts[0]!.suggestedBy).toBe(RUN);
    // 熔断票在前, 发现物票在后。
    expect(drafts[1]!.title).toBe('[未收敛·execute] 3 轮未收敛');
  });

  test('未熔断 (verification.pass=false 但没连撞) → 不开熔断票', () => {
    const r = mkResult({ stages: [] });
    expect(collectRunTickets(r, { runId: RUN, verification: { pass: false, reason: '判据没过' } })).toEqual([]);
  });

  test('blocked → 标题主体走 S-1 词表, 尾巴挂 resume; execute stage 不再开第二张', () => {
    const r = mkResult({
      outcome: 'blocked',
      blocked: '需要 owner 定 API key 从哪来',
      stages: [stage({ stage: 'execute', outcome: 'blocked', summary: '2 轮阻塞: 需要 owner 定 API key 从哪来' })],
    });
    const drafts = collectRunTickets(r, { runId: RUN });
    expect(drafts).toHaveLength(1); // 同一件事不开两张 (③ 是 ② 的超集)
    expect(drafts[0]!.title).toBe(`[阻塞] 需要 owner 定 API key 从哪来 · resume: dag_goal resume=${RUN}`);
    expect(drafts[0]!.type).toBe('grill');
  });

  test('预算停 → task 票 (词表定的类型) + resume 把手', () => {
    const r = mkResult({ outcome: 'budget-exhausted', budgetStopped: 'token 预算 80% 触顶' });
    const drafts = collectRunTickets(r, { runId: RUN, resumeHandle: 'dag_goal resume=x --budget 2x' });
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.type).toBe('task');
    expect(drafts[0]!.title).toBe('[预算停] token 预算 80% 触顶 · resume: dag_goal resume=x --budget 2x');
  });

  /** blame 缺席 ≠ blameSize 0: 「没被打回过」与「打回但点名 0 个 (fail-open 走整轮)」是两件事。 */
  test('无 blameRetry → 标题不编一个 blame 0', () => {
    const r = mkResult({ outcome: 'blocked', blocked: 'x' });
    expect(collectRunTickets(r, { runId: RUN })[0]!.title).not.toContain('blame');
  });
});
