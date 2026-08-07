/**
 * leaf 携带原始任务上下文 —— 补的是**图的一条结构缺口**(2026-08-04,r2 实测)。
 *
 * 缺口长什么样:节点的世界原本只有「自己的 goal + 上游输出」,而 conductor 是看着任务写 goal 的,
 * 于是写出「从可信任务上下文逐字复制 q1–q8 题义」这种节点根本做不到的话。
 * **agent 档一直在替图自救**(实测老跑 24 节点里 6 个、18 节点里 5 个自己去读了任务文件),
 * g1 把读盘换成 command+leaf 后自救通道断掉,当场现形:33 节点全绿而交付物是「未提供题义」。
 *
 * 反向自检:本组在加这条通道**之前**跑过 —— 「leaf prompt 里有原始任务」按预期红。
 */
import { describe, expect, test } from 'bun:test';
import { buildLeafPrompt, TASK_CONTEXT_MAX_CHARS } from './dag/planner';
import { runExecutorDag, runExecutorDagWithPlan } from './dag/engine';
import type { ConductorPlan } from './conductor-plan';
import type { ExecutorDagConfig, GenerateFn } from './dag/types';

const node = { goal: '按契约作答' } as ConductorPlan['nodes'][string];

describe('buildLeafPrompt 的原始任务块', () => {
  test('给了任务 → prompt 含全文, 且框成背景不是新指令', () => {
    const p = buildLeafPrompt('n1', node, {}, undefined, '回答 q1: 初始 Elo 分是多少?');
    expect(p).toContain('回答 q1: 初始 Elo 分是多少?');
    expect(p).toContain('<original-task');
    expect(p).toContain('你只负责下面 Goal 那一步');
    // 顺序: 任务块在 Goal 之前 (Goal 更近 = 更强), 收尾的"只交本步产出"仍在最后
    expect(p.indexOf('<original-task')).toBeLessThan(p.indexOf('Goal:'));
  });

  test('不给 → 逐字回到旧 prompt (零回归)', () => {
    expect(buildLeafPrompt('n1', node, {})).toBe(buildLeafPrompt('n1', node, {}, undefined, undefined));
    expect(buildLeafPrompt('n1', node, {})).not.toContain('<original-task');
  });

  test('空白任务不产生空块', () => {
    expect(buildLeafPrompt('n1', node, {}, undefined, '   \n ')).not.toContain('<original-task');
  });

  test('超长任务显式标注截断 (No-silent-caps)', () => {
    const long = 'x'.repeat(TASK_CONTEXT_MAX_CHARS + 137);
    const p = buildLeafPrompt('n1', node, {}, undefined, long);
    expect(p).toContain('已截断 137 字符');
    expect(p).not.toContain('x'.repeat(TASK_CONTEXT_MAX_CHARS + 1)); // 真截了, 不是只写了句话
  });
});

describe('引擎接线', () => {
  const capture = (prompts: string[]): GenerateFn => async (req) => {
    const sys = req.messages.find((m) => m.role === 'system');
    const user = req.messages.find((m) => m.role === 'user');
    const text = typeof user?.content === 'string' ? user.content : '';
    if (typeof sys?.content === 'string' && sys.content.includes('CONDUCTOR')) {
      return { text: JSON.stringify({ name: 'p', nodes: { a: { goal: '做这一步' } } }), usage: { in: 1, out: 1 } };
    }
    prompts.push(text);
    return { text: 'ok', usage: { in: 1, out: 1 } };
  };
  const cfg = (generate: GenerateFn, extra: Partial<ExecutorDagConfig> = {}): ExecutorDagConfig => ({
    conductorModel: 'c:m',
    leafModel: 'l:m',
    generate,
    agentTemplates: new Map(),
    ...extra,
  });

  test('默认: 任务原文到达 leaf', async () => {
    const prompts: string[] = [];
    await runExecutorDag('把 docs/x.md 里的三条结论列出来', cfg(capture(prompts)));
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('把 docs/x.md 里的三条结论列出来');
  });

  test('leafTaskContext:false → 旧行为 (逃生口真的能关)', async () => {
    const prompts: string[] = [];
    await runExecutorDag('把 docs/x.md 里的三条结论列出来', cfg(capture(prompts), { leafTaskContext: false }));
    expect(prompts[0]).not.toContain('<original-task');
  });

  // 预构造 plan 路径的 "task" 是 deriveTaskFromPlan 合成的**图大纲**(逐条列出每个节点的 goal),
  // 不是用户任务 —— 注进去等于让每个节点看见别人在干什么。2026-08-04 由 fault-injection 夹具
  // 当场抓到 (它按 prompt 里的 `NODE=x` 认节点, 注入后每个节点都先看到别人的 NODE=)。
  test('预构造 plan 路径默认不注入 (合成大纲不是用户任务), 但显式 true 仍可开', async () => {
    const plan = { name: 'p', nodes: { a: { goal: 'ALPHA 做这一步' }, b: { goal: 'BETA 做那一步' } } } as unknown as ConductorPlan;
    const off: string[] = [];
    await runExecutorDagWithPlan(plan, cfg(capture(off)));
    expect(off).toHaveLength(2);
    expect(off.every((p) => !p.includes('<original-task'))).toBe(true);
    expect(off.find((p) => p.includes('Goal: ALPHA'))).not.toContain('BETA'); // 不串味

    const on: string[] = [];
    await runExecutorDagWithPlan(plan, cfg(capture(on), { leafTaskContext: true }));
    expect(on[0]).toContain('<original-task');
  });
});
