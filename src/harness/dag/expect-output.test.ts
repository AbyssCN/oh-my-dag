/**
 * `expect_output` —— 判据不只判退出码,还判输出长什么样(2026-08-26, RED)。
 *
 * ## 它补的洞
 *
 * `expect_exit` 只看退出码,于是「命令根本没跑到该跑的东西」与「跑了而且过了」在判据眼里
 * 一模一样。本仓实测过这个形态:`bun test <路径写错>` 空匹配 **exit 0** —— 一条什么都没测的
 * 命令,判据判它绿。
 *
 * 此前的挡法是要求契约把 verify 写成 `ugrep -q '<锚>' <文件> && bun test <文件>` 两段式,
 * 靠**写契约的人每次记得**。写契约的是模型时,这条纪律就是一句没有闸的散文。
 *
 * `expect_output` 把它变成判据格式的一部分:退出码对**且**输出含期望串,两者都要。
 *
 * ## 判据取子串而不是正则
 *
 * 子串写不错,正则写得错 —— 而写错的正则恰好是「恒真」的那种(`.*`),会把判据变成永绿。
 * 需要模式匹配时在命令里用 grep,让 shell 负责,退出码自然会说话。
 *
 * ## 反向自检(实跑)
 *
 * 把 engine 里 `outputMatched` 那一行改成恒 true ⇒ 第二、四条红;
 * 把它改成恒 false ⇒ 第一、三条红。
 */
import { describe, expect, it } from 'bun:test';
import { runExecutorDagWithPlan } from './engine';
import type { ConductorPlan } from '../conductor-plan';
import type { ExecutorDagConfig } from './types';

const cfg = (text: string, exitCode: number): ExecutorDagConfig => ({
  conductorModel: 'c:m',
  leafModel: 'l:m',
  generate: async () => ({ text: 'unused', usage: { in: 0, out: 0 } }),
  agentTemplates: new Map(),
  commandRunner: async () => ({ text, usage: { in: 0, out: 0 }, timedOut: false, signal: null, exitCode }),
});

const plan = (node: Record<string, unknown>): ConductorPlan => ({
  name: 'p',
  nodes: { a: { goal: '跑判据', executor: 'command', command: 'bun test ./x.test.ts', ...node } },
});

describe('expect_output:退出码对不等于判据过', () => {
  it('★ 退出码对 + 输出含期望串 → done', async () => {
    const r = await runExecutorDagWithPlan(
      plan({ expect_exit: 0, expect_output: '12 pass' }),
      cfg('12 pass 0 fail\n', 0),
    );
    expect(r.results.a?.status).toBe('done');
  });

  it('★ 退出码对但输出不含期望串 → failed(这正是空匹配假绿的形态)', async () => {
    // `bun test <路径写错>` 的真实形态: 一个测试都没跑, 照样 exit 0。
    const r = await runExecutorDagWithPlan(
      plan({ expect_exit: 0, expect_output: '12 pass' }),
      cfg('0 pass 0 fail\nRan 0 tests across 0 files.\n', 0),
    );
    expect(r.results.a?.status).toBe('failed');
  });

  it('★ 输出含期望串但退出码不对 → failed(两个条件是与, 不是或)', async () => {
    const r = await runExecutorDagWithPlan(
      plan({ expect_exit: 0, expect_output: '12 pass' }),
      cfg('12 pass 3 fail\n', 1),
    );
    expect(r.results.a?.status).toBe('failed');
  });

  it('★ 不写 expect_output → 只判退出码(零回归: 存量 plan 行为逐字节不变)', async () => {
    const r = await runExecutorDagWithPlan(plan({ expect_exit: 0 }), cfg('whatever\n', 0));
    expect(r.results.a?.status).toBe('done');
  });

  it('★ 期望非零退出码时同样与 expect_output 取交(verify-red 也要证明跑到了东西)', async () => {
    const red = await runExecutorDagWithPlan(
      plan({ expect_exit: 1, expect_output: 'x.test.ts' }),
      cfg('0 pass 0 fail\n', 1),
    );
    expect(red.results.a?.status, '退出码是 1 了, 但根本没跑到那个测试文件').toBe('failed');
  });
});
