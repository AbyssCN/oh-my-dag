/**
 * D-K `expect_exit` —— command 节点判 done 的期望退出码 (2026-07-29)。
 *
 * 补的是 TDD 回路里**证红**那一步的表达手段: "新写的测试现在必须是红的" 的成功判据 = 非 0 退出。
 * 此前表达不出来 —— shell 取反整族 (`!` / `;` / `$?`) 被 command-leaf 的注入闸全拒
 * (`command-leaf.ts:145`), 而"让模型自己说测试红了"是拿 LLM 自证换掉确定性 oracle。
 *
 * 本闸盯三件事: ① 缺省 0 零回归 ② 期望非 0 时真按它判 ③ **闸拒 (退出码 < 0) 恒 failed** ——
 * 那是安全拒绝, 不是命令的退出码, 不许被一个 expect_exit 翻译成 done。
 */
import { describe, expect, test } from 'bun:test';
import { runExecutorDagWithPlan } from './dag/engine';
import { PlanSchema } from './conductor-plan';
import { nodeFieldsKey } from './plan-passes/semantic-key';
import type { ConductorPlan } from './conductor-plan';
import type { ExecutorDagConfig, GenerateFn } from './dag/types';

const generate: GenerateFn = async () => ({ text: 'leaf-out', usage: { in: 1, out: 1 } });

/** 定值 command runner (注入式: 不跑真 CLI)。 */
const runnerReturning = (exitCode: number, text = 'cmd-out'): ExecutorDagConfig['commandRunner'] =>
  async () => ({ text, usage: { in: 0, out: 0 }, exitCode, timedOut: false, signal: null });

const cfg = (exitCode: number, text?: string): ExecutorDagConfig => ({
  conductorModel: 'c:m',
  leafModel: 'l:m',
  generate,
  agentTemplates: new Map(),
  commandRunner: runnerReturning(exitCode, text),
});

/** expect_exit 走 `as` 绕开类型 —— 负值用例刻意造**预构造 plan** (不经 zod) 的越界输入。 */
const cmdPlan = (expectExit?: number): ConductorPlan => ({
  name: 'p',
  nodes: {
    v: {
      goal: '跑测试',
      executor: 'command',
      command: 'bun test',
      ...(expectExit === undefined ? {} : { expect_exit: expectExit }),
    },
  },
});

describe('D-K expect_exit — 执行语义', () => {
  test('不设 expect_exit + 退出 0 → done (零回归)', async () => {
    const r = await runExecutorDagWithPlan(cmdPlan(), cfg(0));
    expect(r.results.v?.status).toBe('done');
    expect(r.results.v?.output).toBe('cmd-out');
  });

  test('不设 expect_exit + 退出 1 → failed (零回归)', async () => {
    const r = await runExecutorDagWithPlan(cmdPlan(), cfg(1));
    expect(r.results.v?.status).toBe('failed');
    // 缺省档的失败不加 expect_exit 前缀 (它就是普通的命令失败, 败因全文留给 heal)。
    expect(r.results.v?.output).toBe('cmd-out');
  });

  test('expect_exit:1 + 退出 1 → done (verify-red 成立)', async () => {
    const r = await runExecutorDagWithPlan(cmdPlan(1), cfg(1, '3 tests failed'));
    expect(r.results.v?.status).toBe('done');
    expect(r.results.v?.output).toBe('3 tests failed');
  });

  test('expect_exit:1 + 退出 0 → failed, 且输出说清"本该红却绿了"', async () => {
    const r = await runExecutorDagWithPlan(cmdPlan(1), cfg(0, 'all tests passed'));
    expect(r.results.v?.status).toBe('failed');
    // 下游只看到一串正常的测试输出时判不出这是失败 → 判据必须写进 output。
    expect(r.results.v?.output).toContain('expect_exit 1, 实得 0');
    expect(r.results.v?.output).toContain('all tests passed');
  });

  test('expect_exit:2 + 退出 1 → failed (只认那一个码, 不是"非 0 即可")', async () => {
    const r = await runExecutorDagWithPlan(cmdPlan(2), cfg(1));
    expect(r.results.v?.status).toBe('failed');
  });

  test('闸拒 (退出码 -1) 恒 failed —— expect_exit 不得把安全拒绝翻译成 done', async () => {
    // 预构造 plan 不经 zod, 故 -1 能进到执行器 —— 这条硬闸就是为它准备的。
    const r = await runExecutorDagWithPlan(cmdPlan(-1), cfg(-1, '[blocked not-allowed]'));
    expect(r.results.v?.status).toBe('failed');
    expect(r.results.v?.output).toContain('命令被闸拒');
  });

  test('设在非 command 节点上 → 忽略, 不改变执行 (fail-open + WARN)', async () => {
    const r = await runExecutorDagWithPlan(
      { name: 'p', nodes: { a: { goal: '普通 leaf', expect_exit: 1 } } },
      cfg(0),
    );
    expect(r.results.a?.status).toBe('done');
    expect(r.results.a?.output).toBe('leaf-out');
  });
});

describe('D-K expect_exit — 声明面', () => {
  test('zod: 0..255 接受, 负值/超界/非整数拒 (POSIX 退出码域; -1 是闸拒返回值)', () => {
    const mk = (v: unknown): unknown => ({ name: 'p', nodes: { v: { goal: 'g', expect_exit: v } } });
    expect(PlanSchema.safeParse(mk(0)).success).toBe(true);
    expect(PlanSchema.safeParse(mk(1)).success).toBe(true);
    expect(PlanSchema.safeParse(mk(255)).success).toBe(true);
    expect(PlanSchema.safeParse(mk(-1)).success).toBe(false);
    expect(PlanSchema.safeParse(mk(256)).success).toBe(false);
    expect(PlanSchema.safeParse(mk(1.5)).success).toBe(false);
  });

  test('语义指纹对 expect_exit 敏感 (verify-red 与 verify-green 不得判重)', () => {
    const node = (e?: number): ConductorPlan['nodes'][string] => ({
      goal: '跑测试',
      executor: 'command',
      command: 'bun test',
      ...(e === undefined ? {} : { expect_exit: e }),
    });
    expect(nodeFieldsKey(node(1))).not.toBe(nodeFieldsKey(node(0)));
    expect(nodeFieldsKey(node(0))).not.toBe(nodeFieldsKey(node()));
    expect(nodeFieldsKey(node(1))).toBe(nodeFieldsKey(node(1)));
  });

});
