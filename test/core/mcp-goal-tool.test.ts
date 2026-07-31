/**
 * test/core/mcp-goal-tool.test.ts — dag_goal 工具 (自主 goal 环 P1)。
 * 纯注入 (runGoal / registry / buildConfig fake), 不跑真环。
 */
import { describe, expect, test } from 'bun:test';
import { RunRegistry } from '../../src/mcp/run-registry';
import { createGoalTool, summarizeGoal } from '../../src/mcp/tools/goal';
import type { RunGoalResult } from '../../src/harness/goal/run-goal';

const result = (over: Partial<RunGoalResult> = {}): RunGoalResult => ({
  goal: 'g',
  tier: 'complex',
  acceptance: { kind: 'executable', command: 'bun test', expectExit: 0 },
  stages: [
    { stage: 'classify', status: 'done', outcome: 'success', summary: 'tier=complex' },
    { stage: 'research', status: 'done', outcome: 'success', summary: '3 个来源真抓到正文' },
    { stage: 'spec', status: 'done', outcome: 'success', summary: 'docs/plan/x.md' },
    { stage: 'execute', status: 'done', outcome: 'success', summary: '2 轮收敛 · 复用 4 节点' },
  ],
  specPath: 'docs/plan/x.md',
  sources: ['https://a', 'https://b', 'https://c'],
  repoContext: 'src/x.ts:1 — 已有同类机制',
  converged: true,
  rounds: 2,
  reusedNodes: ['n1', 'n2', 'n3', 'n4'],
  outcome: 'success',
  ...over,
});

type Res = { content: { text: string }[]; isError?: boolean };

/** ToolCallback 形状要 (args, extra); 测试只关心 args。 */
function call(deps: Partial<Parameters<typeof createGoalTool>[0]>, args: Record<string, unknown>): Promise<Res> {
  const t = createGoalTool({
    runGoal: async () => result(),
    runRegistry: new RunRegistry(),
    cwd: '/tmp',
    buildConfig: () => ({ conductorModel: 'c:m', leafModel: 'l:m' }),
    ...deps,
  });
  return (t.handler as unknown as (a: Record<string, unknown>) => Promise<Res>)(args);
}

const runIdOf = (text: string): string => /runId: ([\w-]+)/.exec(text)![1]!;
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('dag_goal', () => {
  test('缺 goal → MCP error (不注册 run)', async () => {
    const r = await call({}, {});
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain('goal 必填');
  });

  test('happy path → runId + running, 完成后 registry done 且摘要含阶段结论', async () => {
    const reg = new RunRegistry();
    const r = await call({ runRegistry: reg }, { goal: '给引擎加自主环' });
    expect(r.content[0]!.text).toContain('status: running');
    await settle();
    const rec = reg.getRecord(runIdOf(r.content[0]!.text))!;
    expect(rec.status).toBe('done');
    // N5 (2026-07-31): 这一行印的是 outcome 而不是 status —— 成了的阶段印 `[success]`,
    // 没成的那些还会跟一个 `/failed`。改这条断言是**跟着一个刻意的行为改动走**:
    // 上一跑 live 里一次判定正确的 BLOCKED 被 status 念成了 failed, N5 治的就是那个。
    expect(String(rec.result)).toContain('[success] research');
    expect(String(rec.result)).toContain('docs/plan/x.md');
  });

  // 谎报成功比失败更贵: 未收敛就是没达成 goal, 别让调用方以为它做完了。
  test('未收敛 → registry failed (摘要仍带全部阶段结论)', async () => {
    const reg = new RunRegistry();
    const r = await call(
      {
        runRegistry: reg,
        runGoal: async () =>
          result({
            converged: false,
            stages: [{ stage: 'execute', status: 'failed', outcome: 'not-converged', summary: '2 轮未收敛 (exhausted)' }],
          }),
      },
      { goal: 'g' },
    );
    await settle();
    const rec = reg.getRecord(runIdOf(r.content[0]!.text))!;
    expect(rec.status).toBe('failed');
    expect(rec.error).toContain('未收敛');
  });

  test('runGoal 抛错 → registry failed, 不崩 server', async () => {
    const reg = new RunRegistry();
    const r = await call(
      {
        runRegistry: reg,
        runGoal: async () => {
          throw new Error('自主环炸了');
        },
      },
      { goal: 'g' },
    );
    await settle();
    const rec = reg.getRecord(runIdOf(r.content[0]!.text))!;
    expect(rec.status).toBe('failed');
    expect(rec.error).toContain('自主环炸了');
  });

  // INV-MODEL-5: 座位未配 → 计划期响亮失败, 回 MCP error 而不是跑一半 402。
  test('buildConfig 抛 (座位未配) → isError 带出原因', async () => {
    const r = await call(
      {
        buildConfig: () => {
          throw new Error("座位 'conductor' 未配模型");
        },
      },
      { goal: 'g' },
    );
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("座位 'conductor' 未配模型");
  });

  test('旗标透传 (tier / maxRounds / researchRounds)', async () => {
    let got: Record<string, unknown> = {};
    await call(
      {
        runGoal: async (_g, c) => {
          got = c as unknown as Record<string, unknown>;
          return result();
        },
      },
      { goal: 'g', tier: 'simple', maxRounds: 3, researchRounds: 2 },
    );
    expect(got.tier).toBe('simple');
    expect(got.maxRounds).toBe(3);
    expect(got.researchRounds).toBe(2);
  });
});

/**
 * **活体进度**: `dag_goal` 此前一个节点事件都不发 —— 最长活的那条路 (research + 多轮执行) 在
 * `dag_status` 上全程 `planned 0 · started 0 · settled 0`, HUD 也是黑的。2026-07-30 取消冒烟
 * 撞出来的: 盘上明明有 2 份子节点 checkpoint、沙箱里文件都写了, 进度却报 0。
 */
describe('dag_goal 活体进度 (onNodeEvent → registry / HUD)', () => {
  test('引擎发的事件进 registry, dag_status 看得见节点在跑', async () => {
    const reg = new RunRegistry();
    const hudCalls: string[] = [];
    const r = await call(
      {
        runRegistry: reg,
        hudMirror: { write: (runId) => void hudCalls.push(runId) },
        runGoal: async (_g, c) => {
          const cfg = c as unknown as { dag: { onNodeEvent?: (e: unknown) => void } };
          cfg.dag.onNodeEvent?.({ type: 'planned', nodes: [{ id: 'execute', kind: 'conductor' }] });
          cfg.dag.onNodeEvent?.({ type: 'expanded', parent: 'execute', nodes: [{ id: 'execute::a', kind: 'agent', deps: [] }] });
          cfg.dag.onNodeEvent?.({ type: 'start', id: 'execute::a', kind: 'agent' });
          cfg.dag.onNodeEvent?.({ type: 'settle', id: 'execute::a', status: 'done', kind: 'agent' });
          return result();
        },
      },
      { goal: 'g' },
    );
    const runId = runIdOf(r.content[0]!.text);
    await settle();
    const p = reg.getRecord(runId)!.progress!;
    // 运行时展开的子节点也在 planned 里 (追加不覆盖) —— 否则进度分母永远是 1。
    expect(p.planned.map((n) => n.id)).toEqual(['execute', 'execute::a']);
    expect(p.settled.map((s) => s.id)).toEqual(['execute::a']);
    expect(hudCalls.length).toBeGreaterThan(0);
  });
});

describe('summarizeGoal (D-8 宽出)', () => {
  test('阶段结论 + spec + 来源计数 + 复用计数', () => {
    const s = summarizeGoal(result());
    expect(s).toContain('tier: complex · 收敛 · 2 轮');
    expect(s).toContain('来源 (3)');
    expect(s).toContain('修复轮复用: 4 节点');
  });
});
