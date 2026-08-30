/**
 * src/harness/dag/handoff-prior-rounds.test.ts —— G1「更早几轮的判词摘要」(2026-08-28)。
 *
 * ## 缺陷本身
 *
 * 到本片为止, 第 N 轮的 conductor **只看得见第 N-1 轮**的判词 —— `prevReason` 是标量, 每轮覆写。
 * 第 1 轮为什么被拒, 第 3 轮的它不知道, 于是完全合法地把第 1 轮那条死路再走一遍。
 * 毒集拦得住**节点指纹**复用, 拦不住**同一条思路**被重画出来 (换 id / 换措辞 ⇒ 指纹就变)。
 * 数据一直在盘上 (`RoundVerdict[]` 随 journal 写入磁盘), 只是 `at(-1)` 之外没人读 —— 算了不喂 = 没算。
 *
 * ## 四条 GWT
 *
 *   · **GWT-1** 第 3 轮 prompt 含第 1 轮判词摘要 + 当时的四态标签; 第 2 轮 prompt **不含**
 *               (那时还没有"更早轮")。
 *   · **GWT-2** 上一轮不重复挂: 第 3 轮的摘要块里**没有**第 2 轮 (它整段在 `<上一轮未通过>` 里)。
 *   · **GWT-3** 独立预算: 判词灌到远超 `HANDOFF_CAP_CHARS` 时, 摘要块仍在, 且上一轮那段的额度
 *               一个字符没被它吃掉 (单一变量的实证)。
 *   · **GWT-4** 缺席零字节: 单轮环 (`max_rounds: 1`) 的 prompt 里连块标题都不许出现。
 *
 * ## 反向自检 (仓规: 永远绿的闸不是闸)
 *
 *   · GWT-1: 把 `retryCtx` 里的 `renderPriorRounds(...)` 删掉 → 第 3 轮 prompt 不含摘要块 → 红。
 *   · GWT-2: 把 `earlier` 的过滤从 `v.round < currentRound - 1` 放宽成 `v.round < currentRound`
 *            → 上一轮被重复挂一遍 → 红。
 *   · GWT-4: 把 `if (earlier.length === 0) return ''` 删掉 → 空块标题漏出去 → 红。
 *
 * 脚手架承 `handoff-freeze-fail.test.ts`: 单 conductor + judgeSend stub + capturing generate,
 * 零真实模型调用。
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runExecutorDagWithPlan } from './engine';
import type { ConductorPlan } from '../conductor-plan';
import type { ExecutorDagConfig, GenerateFn } from './types';
import type { ModelResponse } from '../../model/types';
import { CheckpointManager } from '../continuity/checkpoint-manager';

const TMP_ROOT = mkdtempSync(join(tmpdir(), 'handoff-prior-rounds-'));
const SAVED_OMD_DATA_HOME = process.env.OMD_DATA_HOME;
delete process.env.OMD_DATA_HOME; // 理由同 handoff-freeze-fail.test.ts 的同名注
afterAll(() => {
  rmSync(TMP_ROOT, { recursive: true, force: true });
  if (SAVED_OMD_DATA_HOME !== undefined) process.env.OMD_DATA_HOME = SAVED_OMD_DATA_HOME;
});

const VALID_SUBPLAN_JSON = '{"name":"x","nodes":{"a":{"goal":"noop"}}}';
const BLOCK_OPEN = '<更早几轮的判词摘要>';

function makeCapturingGenerate(prompts: string[]): GenerateFn {
  return async (req) => {
    const userMsg = req.messages.find((m) => m.role === 'user');
    const content = typeof userMsg?.content === 'string' ? userMsg.content : JSON.stringify(userMsg?.content ?? '');
    prompts.push(content);
    return { text: VALID_SUBPLAN_JSON, usage: { in: 0, out: 0 } };
  };
}

/** 每轮给**不同**判词 —— 分得出第 3 轮看见的到底是第 1 轮那条还是第 2 轮那条。 */
const makePerRoundJudge = (reasons: string[]): NonNullable<ExecutorDagConfig['judgeSend']> => {
  let n = 0;
  return async (): Promise<ModelResponse> => {
    const failureReason = reasons[Math.min(n, reasons.length - 1)]!;
    n++;
    return {
      text: '',
      parsed: { converged: false, score: 0, failureReason, rejectedNodes: [] },
      usage: { in: 0, out: 0 },
      raw: {},
      model: 'stub:judge',
      attempts: 1,
    };
  };
};

const plan = (nodes: ConductorPlan['nodes']): ConductorPlan => ({ name: 'p', nodes });

/** conductor 的 prompt = 含 `<上一轮未通过>` 的那些 (leaf prompt 不含)。 */
const conductorPrompts = (prompts: string[]): string[] => prompts.filter((p) => p.includes('<上一轮未通过>'));

async function runRounds(opts: { maxRounds: number; reasons: string[]; tag: string }): Promise<string[]> {
  const root = mkdtempSync(join(TMP_ROOT, `${opts.tag}-`));
  const prompts: string[] = [];
  await runExecutorDagWithPlan(
    plan({ execute: { goal: 'root', executor: 'conductor', max_rounds: opts.maxRounds } }),
    {
      conductorModel: 'test:conductor',
      leafModel: 'test:leaf',
      generate: makeCapturingGenerate(prompts),
      agentTemplates: new Map(),
      judgeSend: makePerRoundJudge(opts.reasons),
      continuity: { manager: new CheckpointManager(root), runId: `${opts.tag}-run`, repoRoot: root },
    } as ExecutorDagConfig,
  );
  return prompts;
}

describe('G1 — 更早几轮的判词摘要进 conductor prompt', () => {
  test('★ GWT-1/2 第 3 轮看得见第 1 轮; 第 2 轮没有"更早轮"; 上一轮不重复挂', async () => {
    const R1 = 'R1-死路-把配置写进了只读目录';
    const R2 = 'R2-另一条死路-改了不该改的测试';
    const R3 = 'R3-还是没成';
    const cps = conductorPrompts(await runRounds({ maxRounds: 3, reasons: [R1, R2, R3], tag: 'gwt12' }));
    // round 1 没有 retryCtx (prevReason 空) → conductor prompt 只有 round 2 / round 3 两条。
    expect(cps).toHaveLength(2);
    const [round2, round3] = cps as [string, string];

    // GWT-1a: 第 2 轮时唯一的历史就是上一轮 → 摘要块整个缺席 (缺席零字节)。
    expect(round2).not.toContain(BLOCK_OPEN);
    expect(round2).toContain(R1); // 但上一轮判词照常在 `<上一轮未通过>` 里

    // GWT-1b: 第 3 轮的摘要块里有第 1 轮, 且带着当时的四态标签。
    expect(round3).toContain(BLOCK_OPEN);
    const summary = round3.slice(round3.indexOf(BLOCK_OPEN), round3.indexOf('</更早几轮的判词摘要>'));
    expect(summary).toContain(R1);
    expect(summary).toContain('第 1 轮');
    expect(summary).toContain('judge rejected'); // 四态逐字, 不压成"没过"

    // GWT-2: 上一轮 (R2) **不在**摘要块里 —— 它整段在 `<上一轮未通过>` 里, 挂两遍是浪费预算。
    expect(summary).not.toContain(R2);
    expect(round3).toContain(R2);
  });

  test('★ GWT-3 独立预算: 判词远超 1500 时摘要块仍在, 且上一轮那段的额度没被吃掉', async () => {
    // 每轮判词都灌到 2000 (> HANDOFF_CAP_CHARS=1500) → 上一轮那段必然触发截断告示。
    const long = (tag: string): string => `${tag}-${'X'.repeat(2000)}`;
    const cps = conductorPrompts(
      await runRounds({ maxRounds: 3, reasons: [long('R1'), long('R2'), long('R3')], tag: 'gwt3' }),
    );
    const round3 = cps[1]!;
    // 摘要块在, 且里面是**摘过**的 (240 字符额度), 不是 2000 字全文。
    expect(round3).toContain(BLOCK_OPEN);
    const summary = round3.slice(round3.indexOf(BLOCK_OPEN), round3.indexOf('</更早几轮的判词摘要>'));
    expect(summary).toContain('R1-');
    expect(summary.length).toBeLessThan(1200 + 400); // 独立预算 PRIOR_ROUNDS_CAP_CHARS + 块头
    // 上一轮那段照旧走自己的 1500 额度 + 截断告示 —— 本片一个字符没动它 (单一变量)。
    expect(round3).toContain('交接硬上限');
  });

  test('★ GWT-4 缺席零字节: 单轮环的 prompt 里连块标题都不出现', async () => {
    const prompts = await runRounds({ maxRounds: 1, reasons: ['只跑一轮'], tag: 'gwt4' });
    for (const p of prompts) expect(p).not.toContain(BLOCK_OPEN);
  });
});
