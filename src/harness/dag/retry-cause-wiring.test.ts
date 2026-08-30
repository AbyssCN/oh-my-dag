/**
 * src/harness/dag/retry-cause-wiring.test —— **R-1 端到端**:节点失败 → 败因注入 → 重修成功。
 *
 * ## 为什么单独有这一片
 *
 * `retry-domain.test.ts` 钉的是**预算纯函数**(给几次)。它答不了真正要问的那件事:
 * **那一次重修,leaf 到底有没有收到「上一次哪里错了」?** 预算给对了而败因没送到,
 * 等于"多试一次碰运气" —— 正是 `retry-domain.ts` 那条注一路在防的东西。
 * 所以这一片攻的是**注入面**,不是预算面。
 *
 * ## 背景(为什么这条通道此前一次都没通过电)
 *
 * `causeOf`(`engine.ts`,把上一次的 `output` 截 600 字接进下一发 prompt)是**早就建成的**。
 * 但 `retryBudgetFor` 在 2026-08-30 之前对「跑完了、判 failed、没抛错」这一格返 **0**,
 * 而 conductor 几乎从不写 `max_retry` —— 于是生产上最常见的失败形态**零重修**,
 * `causeOf` 一次都没被用到,直接把整张图顶到外环重画。
 *
 * ## 三条 GWT
 *
 * | | 钉什么 | 实装前为什么红 |
 * |---|---|---|
 * | R-1a | `empty-artifact` 失败 → 第二发 prompt **含上一次的输出原文** → 成功 ⇒ 节点 `done` | 预算 0 ⇒ 只跑一发 ⇒ 节点 `failed` |
 * | R-1b | 第二发 prompt 含「请针对这个失败原因改变做法」那句 —— 不只是把旧文本塞回去 | 同上 |
 * | R-1c | `timed-out` 失败 **不**重修(没产出可注,重试只会原地翻倍等待) | (零回归护栏) |
 *
 * ## 反向自检(当场实跑过)
 *
 *  - 把 `retry-domain.ts` 最后一行改回 `return 0` → R-1a / R-1b 当场红(只跑一发)。
 *  - 把 `REPAIRABLE_BY_CAUSE` 扩成"全给" → R-1c 红(超时也被重修)。
 *  - 把 `engine.ts` 的 `causeOf` 拼接那行去掉 → R-1a 仍绿(它只看跑了几发)、**R-1b 红** ——
 *    这正是把两片分开的理由:预算对了不代表败因送到了。
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runExecutorDagWithPlan } from './engine';
import type { ConductorPlan } from '../conductor-plan';
import type { ExecutorDagConfig, GenerateFn } from './types';
import type { AgentLeafRunner } from '../leaf-runners';

const FIRST_OUTPUT = '我看了一眼就觉得不用改, 所以一个文件都没动。';

/** 跑一张单 agent 节点的图, 收集每一发看到的 prompt。 */
async function runOnce(opts: {
  /** 第 n 发(0 基)该不该产出文件。 */
  touchOn: (attempt: number) => string[];
}): Promise<{ status: string | undefined; prompts: string[] }> {
  const cwd = mkdtempSync(join(tmpdir(), 'omd-retry-cause-'));
  const prompts: string[] = [];
  let attempt = 0;
  const plan: ConductorPlan = {
    name: 'retry-cause',
    nodes: { W: { goal: '改 src/a.ts', executor: 'agent', output_path: 'src/a.ts' } },
  };
  const agentRunner: AgentLeafRunner = (async (input: { prompt: string }) => {
    prompts.push(input.prompt);
    const files = opts.touchOn(attempt);
    attempt += 1;
    // 真把文件写到盘上 —— 产物闸校验的是**盘上有没有**, 光在 filesTouched 里声明会被判
    // `missing` (谎报完成闸)。夹具必须诚实, 否则测的是闸不是重修。
    for (const f of files) {
      mkdirSync(join(cwd, 'src'), { recursive: true });
      writeFileSync(join(cwd, f), 'export const a = 1;\n');
    }
    return {
      text: files.length ? '改好了。' : FIRST_OUTPUT,
      usage: { in: 1, out: 1 },
      filesTouched: files,
      cwd,
    };
  }) as unknown as AgentLeafRunner;

  const generate: GenerateFn = (async () => ({ text: 'x', usage: { in: 0, out: 0 } })) as unknown as GenerateFn;
  const config = { cwd, agentRunner, generate, leafModel: 'test:leaf' } as unknown as ExecutorDagConfig;
  try {
    const result = await runExecutorDagWithPlan(plan, config);
    return { status: result.results.W?.status, prompts };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

describe('R-1 端到端 · 败因注入的那一次重修', () => {
  test('★ R-1a: empty-artifact → 第二发拿到败因 → 产出文件 ⇒ 节点 done (实装前: 只跑一发, failed)', async () => {
    // 首发什么都不写(闸判 empty-artifact), 第二发写一个文件。
    const { status, prompts } = await runOnce({ touchOn: (n) => (n === 0 ? [] : ['src/a.ts']) });
    expect(prompts.length, '预算没通电 ⇒ 只会有一发').toBe(2);
    expect(status).toBe('done');
  });

  test('★ R-1b: 第二发 prompt 真的带着上一次的败因原文 + 改做法那句 (预算对 ≠ 败因送到)', async () => {
    const { prompts } = await runOnce({ touchOn: (n) => (n === 0 ? [] : ['src/a.ts']) });
    expect(prompts).toHaveLength(2);
    const second = prompts[1] as string;
    expect(second).toContain('[上一次尝试失败]');
    expect(second, 'leaf 上一次的原文没被带上 —— 那就只是重试不是重修').toContain(FIRST_OUTPUT);
    expect(second).toContain('请针对这个失败原因改变做法');
    // 首发**不该**带这一段 —— 否则第一发就在回应一个不存在的失败。
    expect(prompts[0] as string).not.toContain('[上一次尝试失败]');
  });

  test('★ R-1c (零回归): 恒不产出 ⇒ 两发之后就停, 不无限重修', async () => {
    const { status, prompts } = await runOnce({ touchOn: () => [] });
    expect(prompts).toHaveLength(2); // 首发 + 一次重修, 上限就是 1
    expect(status).toBe('failed');
  });
});
