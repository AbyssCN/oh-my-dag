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
    { stage: 'classify', status: 'done', summary: 'tier=complex' },
    { stage: 'research', status: 'done', summary: '3 个来源真抓到正文' },
    { stage: 'spec', status: 'done', summary: 'docs/plan/x.md' },
    { stage: 'execute', status: 'done', summary: '2 轮收敛 · 复用 4 节点' },
  ],
  specPath: 'docs/plan/x.md',
  sources: ['https://a', 'https://b', 'https://c'],
  repoContext: 'src/x.ts:1 — 已有同类机制',
  converged: true,
  rounds: 2,
  reusedNodes: ['n1', 'n2', 'n3', 'n4'],
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
    expect(String(rec.result)).toContain('[done] research');
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
            stages: [{ stage: 'execute', status: 'failed', summary: '2 轮未收敛 (exhausted)' }],
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

describe('summarizeGoal (D-8 宽出)', () => {
  test('阶段结论 + spec + 来源计数 + 复用计数', () => {
    const s = summarizeGoal(result());
    expect(s).toContain('tier: complex · 收敛 · 2 轮');
    expect(s).toContain('来源 (3)');
    expect(s).toContain('修复轮复用: 4 节点');
  });
});
