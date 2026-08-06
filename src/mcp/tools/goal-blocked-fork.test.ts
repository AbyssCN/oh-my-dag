/**
 * **S3 收件箱那条链的第一环** —— goal 跑以 `blocked` 收场,岔口进得了收件箱吗(2026-08-06)。
 *
 * ## 为什么单开一条
 *
 * 收件箱模块(`owner-inbox.test.ts`)与 MCP 调用面(`dag_triage` / `dag_rule`)**各自测得很全**,
 * 而**没有一条从「一次真的 goal 跑」起头** —— 于是链条第一环(`goal.ts` 里那个
 * `if (r.blocked && deps.inbox)`)只有代码,没有网。
 *
 * 那一环恰恰是生产上**从没触发过**的那一环:2026-08-06 实测 **0 forks / 0 directives / 34 个 run**,
 * 查因是 blocked 4 次**全部来自 `dag_run`**(同步入口,不铸票),goal 路径 **0 次**。
 * 也就是说这条链**端到端从来没跑通过一次** —— 那是「没机会」不是「路断了」,
 * 但**没机会 ≠ 通着**:没跑过的链上有没有断点,只有网说得清。
 *
 * ## 这条网钉的四件
 *
 * ① blocked → **铸票**,且票挂在 `runId` 上(不挂子节点 —— 子图每轮重画);
 * ② 票带 `blocking: true` 与 BLOCKED 原话(owner 要判的是"卡在哪",复述会丢证据);
 * ③ **converged 的跑不铸票**(证明它不是恒铸 —— 一条永远响的铃不是铃);
 * ④ 铸完之后 `dag_triage` **真看得见** —— 第一环接上第二环。
 *
 * ⚠ 不碰 `dag_rule` 那半:它已有网(`owner-inbox.test.ts`)。这里补的是**没人测过的那一环**。
 */
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGoalTool } from './goal';
import { createTriageTools } from './triage';
import { createOwnerInbox } from '../owner-inbox';
import { RunRegistry } from '../run-registry';
import type { RunGoalResult } from '../../harness/goal/run-goal';

const result = (goal: string, over: Partial<RunGoalResult> = {}): RunGoalResult => ({
  goal,
  tier: 'simple',
  acceptance: { kind: 'executable', command: 'bun test', expectExit: 0 },
  stages: [],
  sources: [],
  repoContext: '',
  converged: true,
  outcome: 'success' as const,
  rounds: 1,
  reusedNodes: [],
  ...over,
});

const make = (goalResult: (goal: string) => RunGoalResult) => {
  const root = mkdtempSync(join(tmpdir(), 'omd-blocked-fork-'));
  const inbox = createOwnerInbox({ db: new Database(':memory:') });
  const tool = createGoalTool({
    runGoal: async (goal: string) => goalResult(goal),
    runRegistry: new RunRegistry(),
    cwd: root,
    buildConfig: () => ({ conductorModel: 'c:m', leafModel: 'l:m' }),
    inbox,
  } as never);
  return { tool, inbox, root };
};

const call = (tool: ReturnType<typeof createGoalTool>, args: Record<string, unknown>) =>
  tool.handler(args as never, {} as never) as Promise<{ content: { text?: string }[] }>;
/** runGoal 是 fire-and-forget(handler 不等它)—— 让出一轮再看收件箱。 */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

describe('★ S3 收件箱第一环: goal 跑 blocked → 岔口进收件箱', () => {
  test('★ blocked → 铸票, 挂在 runId 上, 且**带得住 BLOCKED 原话**', async () => {
    const { tool, inbox, root } = make((g) =>
      result(g, { converged: false, outcome: 'blocked', blocked: '材料自相矛盾: A 说 X, B 说非 X — 需要 owner 拍板', rounds: 2 }),
    );
    try {
      await call(tool, { goal: '把这件事做完' });
      await settle();
      const forks = inbox.openForks();
      // ① 铸了票 —— 这一环生产上从没触发过, 所以它值一条网
      expect(forks).toHaveLength(1);
      const f = forks[0]!;
      // 岔口挂在 run 级 (goal 语义位), 不挂子节点: 子图每轮重画, 挂上去下一轮就没对应物了
      expect(f.nodeId).toBe('goal');
      expect(f.runId).toBeTruthy();
      // ② 原话逐字带住 —— owner 要判的是"卡在哪", 复述会把证据摘掉
      expect(f.question).toContain('材料自相矛盾');
      expect(f.question).toContain('需要 owner 拍板');
      expect(f.blocking).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('★ converged 的跑**不铸票** —— 证明它不是恒铸 (一条永远响的铃不是铃)', async () => {
    const { tool, inbox, root } = make((g) => result(g));
    try {
      await call(tool, { goal: '顺利做完' });
      await settle();
      expect(inbox.openForks()).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('★ 铸完之后 `dag_triage` **真看得见** —— 第一环接上第二环', async () => {
    const { tool, inbox, root } = make((g) => result(g, { converged: false, outcome: 'blocked', blocked: '缺一个外部凭证', rounds: 1 }));
    try {
      await call(tool, { goal: '要凭证的活' });
      await settle();
      const triage = createTriageTools({ inbox, runRegistry: new RunRegistry() } as never).find((t) => t.name === 'dag_triage')!;
      const r = (await triage.handler({} as never, {} as never)) as { content: { text?: string }[] };
      const text = r.content.map((c) => c.text ?? '').join('\n');
      // 这一行是本用例的全部意义: 票铸出来但 triage 看不见 = 链断在两环之间, 而那正是
      // 生产上没跑通过所以谁也没发现的那种断点。
      expect(text).toContain('缺一个外部凭证');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
