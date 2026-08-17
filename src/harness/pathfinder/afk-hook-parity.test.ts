/**
 * afk-hook ↔ run-tickets parity (contract 切片 1, 契约 (3)):
 * 同一份 goal 结果 body 喂两条路, 断言两侧产票一致。
 *
 * ## (a) 五格 NON_DISCOVERY_OUTCOMES 对应 body → 两侧票集都为 0
 *
 * S-1 词表的判据在两路都得是**同一份**:非发现 outcome (not-needed /
 * missing-capability / blocked / budget-exhausted / cancelled) 喂进词表
 * 不该开出 `[未收敛·<stage>]` 那行 ticket 票 —— 否则每档 simple 成功 run
 * 都会冒 `research / survey 不必跑` 这种 O-3 噪声票。run-tickets 侧
 * 早已用 NON_DISCOVERY_OUTCOMES 过滤 discoveries;afk-hook 侧在同一张表
 * 上对齐过滤后, 两侧票集应都为 0。
 *
 * ## (b) "3 轮未收敛" 类真信号 body → 两侧都开票, 票文一致
 *
 * 真信号必须开票。两路**必须**产同形 discovery (`type` + 票文主体),
 * 唯一差是 afk-hook 侧在 caller 处统一挂 `· resume: dag_goal resume=<runId>`
 * (G-2 把手指 grep) —— runId 真, 不允许 fixture 兜底。两路票文主体一致 →
 * 同一份判据同解。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { reflowGoalResults } from './afk-hook';
import { collectRunTickets, NON_DISCOVERY_OUTCOMES } from './run-tickets';
import { researchResultPath } from './dispatch';
import type { GoalStage, GoalStageName, RunGoalResult } from '../goal/run-goal';
import type { PathBackend } from './backend';
import type { PathMap } from './types';
import type { SuggestionDraft, ApplySuggestionsResult } from './suggest';

/** 非 fixture 真 runId (INV-S1-2 suggestedBy → runId 双向可达)。 */
const RUN = 'run-c0ff33';
const SLUG = 'm1';
const TICKET_ID = 'g9';

function mkResult(over: Partial<RunGoalResult> = {}): RunGoalResult {
  return {
    goal: 'parity 测试: 加东西',
    tier: 'complex',
    acceptance: { kind: 'executable', command: 'bun test', expectExit: 0 },
    stages: [],
    sources: [],
    repoContext: '',
    converged: false,
    rounds: 3,
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

type TicketShape = { type: string; title: string };
const shape = (xs: Array<{ type: string; title: string }>): TicketShape[] =>
  xs.map((d) => ({ type: d.type, title: d.title }));

/**
 * 把 body 写盘成 `outcome: <kind>\nrunId: <id>\n<body>`, 给一张 ruled goal 票,
 * stub 一个只收 `suggest` 草稿的最简后端, 喂 reflowGoalResults。
 * 返回: afk-hook 侧 suggest 收到的草稿 (按 shape 压成 type+title)。
 */
function runReflow(body: string, outcome: 'not-needed' | 'missing-capability' | 'blocked' | 'budget-exhausted' | 'cancelled' | 'not-converged'): TicketShape[] {
  const cwd = mkdtempSync(join(tmpdir(), 'parity-'));
  try {
    const map: PathMap = {
      destination: 'd',
      slug: SLUG,
      tickets: [{ id: TICKET_ID, type: 'prototype', title: 'goal', blockedBy: [], status: 'ruled', executorKind: 'goal' }],
      decisionsLog: [],
    };
    const resultPath = researchResultPath(cwd, SLUG, TICKET_ID);
    mkdirSync(dirname(resultPath), { recursive: true });
    writeFileSync(resultPath, `outcome: ${outcome}\nrunId: ${RUN}\n\n${body}`);

    const drafts: SuggestionDraft[] = [];
    const stubBackend: PathBackend = {
      kind: 'md',
      listMaps: () => [],
      readMap: () => map,
      createMap: () => map,
      addTicket: () => { throw new Error('parity stub: addTicket not used'); },
      suggest: (_c, _s, ds): ApplySuggestionsResult => {
        drafts.push(...ds);
        return { added: [], deduped: [], dropped: 0, summary: `建议入图 ${ds.length}` };
      },
      rule: () => {},
      markDelivered: () => {},
      collectResearchResults: () => [],
      ackResearchResult: () => {},
    };

    reflowGoalResults(stubBackend, cwd, SLUG, { at: '2026-08-11T00:00:00.000Z' });
    return shape(drafts);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

describe('⑤ parity — 非发现 outcome 对应 body (5 格, 票集都为 0)', () => {
  /**
   * 每格给一条 stage 行, 喂 afk-hook 路抽出票, 同时把等价的 RunGoalResult 喂 run-tickets 路。
   * 五格同时验, 一组任一 cell 红即整个 describe 失败 —— 守住 NON_DISCOVERY_OUTCOMES 表漂移。
   */
  const cases: Array<{
    outcome: 'not-needed' | 'missing-capability' | 'blocked' | 'budget-exhausted' | 'cancelled';
    stageName: GoalStageName;
    summary: string;
  }> = [
    { outcome: 'not-needed', stageName: 'research', summary: 'simple 档: 直接 Execute→Verify (D-5)' },
    { outcome: 'missing-capability', stageName: 'survey', summary: '无 agentRunner → 无仓内事实' },
    { outcome: 'blocked', stageName: 'execute', summary: '3 轮阻塞: 需要 owner 定 API key' },
    { outcome: 'budget-exhausted', stageName: 'execute', summary: 'token 预算 80% 触顶' },
    { outcome: 'cancelled', stageName: 'execute', summary: 'owner 协作式取消' },
  ];

  // 锁死表的形状 (顺序 + 大小写): 漂一格立刻红。
  test('NON_DISCOVERY_OUTCOMES = { not-needed, missing-capability, blocked, budget-exhausted, cancelled }', () => {
    const want: typeof NON_DISCOVERY_OUTCOMES extends Set<infer T> ? T[] : never = [
      'blocked',
      'budget-exhausted',
      'cancelled',
      'missing-capability',
      'not-needed',
    ];
    expect([...NON_DISCOVERY_OUTCOMES].sort()).toEqual(want);
  });

  for (const c of cases) {
    test(`[${c.outcome}] 阶段行 body → 两侧票集都为 0`, () => {
      const body = `  [${c.outcome}] ${c.stageName} — ${c.summary}\n`;
      const afk = runReflow(body, c.outcome);
      const r = mkResult({
        outcome: c.outcome,
        stages: [stage({ stage: c.stageName, outcome: c.outcome, summary: c.summary })],
      });
      const rt = shape(collectRunTickets(r, { runId: RUN }));
      expect(afk).toHaveLength(0);
      expect(rt).toHaveLength(0);
    });
  }
});

describe('⑥ parity — "3 轮未收敛" 类真信号 (两路都开票 + 票体一致 + AFK 挂 resume 锚)', () => {
  /**
   * 构造 outcome=not-converged, rounds=3, execute 阶段非占位 summary 的真信号:
   *   - afk-hook 路: reflowGoalResults 喂 stage 行 → suggest 草稿
   *   - run-tickets 路: collectRunTickets(r, { runId: RUN }) 喂 RunGoalResult
   *
   * 断言三条:
   *   (1) 两路都得开票, 数量相等且 > 0 (真信号必须开票);
   *   (2) 票文主体一致 (`type` + `title` 去锚后) —— 同一份判据同解;
   *   (3) afk-hook 侧每张票文挂 `· resume: dag_goal resume=` + 真 runId (G-2 把手, INV-S1-2 双向)。
   *
   * 不以 blocked 真信号当正向 (合同: 那是 ③ 的真信号, 不当 ② parity 的对照臂),
   * 用 not-converged 是 S-1 词表的"未收敛"那一支 —— 词表两侧同解的真信号形态。
   */
  test('双方各开票, 主体一致, AFK 挂 resume 锚 + 真 runId', () => {
    const SUMMARY = '3 轮未收敛: 需要 owner 定 API key';
    const body = `  [not-converged] execute — ${SUMMARY}\n`;
    const afk = runReflow(body, 'not-converged');
    const r = mkResult({
      outcome: 'not-converged',
      stages: [stage({ stage: 'execute', outcome: 'not-converged', summary: SUMMARY })],
    });
    const rt = shape(collectRunTickets(r, { runId: RUN }));

    // (1) 两路都得开票, 且数量一致
    expect(afk.length).toBeGreaterThan(0);
    expect(rt.length).toBeGreaterThan(0);
    expect(afk.length).toBe(rt.length);

    // (2) 票文主体一致: 同一份词表同解
    const ANCHOR = ` · resume: dag_goal resume=${RUN}`;
    for (let i = 0; i < rt.length; i++) {
      expect(rt[i]!.type).toBe(afk[i]!.type);
      expect(afk[i]!.title).toBe(rt[i]!.title + ANCHOR);
    }

    // (3) AFK 侧每张票文挂同一 resume 锚 + 同一真 runId
    const ANCHOR_FRAGMENT = '· resume: dag_goal resume=';
    for (const t of afk) {
      expect(t.title).toContain(ANCHOR_FRAGMENT);
      expect(t.title).toContain(RUN);
    }
    // 不允许 fixture 兜底 ('run-123' 是上一版的 fallback, 已删)
    for (const t of afk) {
      expect(t.title).not.toContain('run-123');
    }
  });
});
