/**
 * src/harness/dag/contract-gate.test.ts —— G2 契约闸 (2026-08-28)。
 *
 * ## 缺陷本身
 *
 * 内环 judge 判的一直是「这一轮**照 goal** 做到了没有」, 而 goal 是从原题派生的 —— **派生这一跳
 * 没有任何一轮回头查过**。本仓 §静默坑 3 的实测样本正是这个形状: `tsc` 干净 + 2159 测试全绿,
 * 而状态映射的标签是反的、配套测试把它固化了。机械闸与 judge 都以契约为准, 契约错了它们一起错
 * 并且互相背书。
 *
 * 治法**不是**新加一层验收环 (那条早被拒过, 理由是回边破坏无环), 而是给**已有的**判官多一位
 * 控制头: judge 顺手拿原题回查 goal, 出 `aligned|unknown|needs_revision|invalid`。
 *
 * ## 四条 GWT
 *
 *   · **GWT-1** `invalid` → 停轮, journal 记 `stop.kind='blocked'` (不是 not-converged: 加轮数没用)。
 *   · **GWT-2** 与 `converged` **正交**: `converged=true ∧ invalid` 照样拦 —— 那是最坏一格
 *               (活干完了, 干的是另一件事)。
 *   · **GWT-3** `unknown` **不**拦 —— 「我不知道」不是「它错了」, 拦了就把一次犹豫变成一次误停。
 *   · **GWT-4** 契约结论逐轮进 `RoundVerdict.contract`; judge 没答 → 该列**缺席**, 不补 aligned。
 *
 * ## 反向自检 (仓规: 永远绿的闸不是闸)
 *
 *   · GWT-1: 把闸的条件删掉 → 环跑满 max_rounds, stop 不是 blocked → 红。
 *   · GWT-2: 把闸挪到 `if (!verdict.converged)` 里面 (即"收敛了就不查契约") → 红。
 *   · GWT-3: 把条件放宽成 `!== 'aligned'` (把 unknown 也拦上) → 红。
 *   · GWT-4: 把 `...(verdict.contractVerdict ? {contract:…} : {})` 改成无条件
 *            `contract: verdict.contractVerdict ?? 'aligned'` → GWT-4 后半红 (仓规坑①)。
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
import { setCoreLogger, type CoreLogger } from '../logger';

const TMP_ROOT = mkdtempSync(join(tmpdir(), 'contract-gate-'));
const SAVED_OMD_DATA_HOME = process.env.OMD_DATA_HOME;
delete process.env.OMD_DATA_HOME; // 理由同 handoff-freeze-fail.test.ts 的同名注
afterAll(() => {
  rmSync(TMP_ROOT, { recursive: true, force: true });
  if (SAVED_OMD_DATA_HOME !== undefined) process.env.OMD_DATA_HOME = SAVED_OMD_DATA_HOME;
});

const VALID_SUBPLAN_JSON = '{"name":"x","nodes":{"a":{"goal":"noop"}}}';

const capturingGenerate = (prompts: string[]): GenerateFn => async (req) => {
  const userMsg = req.messages.find((m) => m.role === 'user');
  prompts.push(typeof userMsg?.content === 'string' ? userMsg.content : '');
  return { text: VALID_SUBPLAN_JSON, usage: { in: 0, out: 0 } };
};

/** 每轮一个答案; 用尽后重复最后一个 (环转多久都答得上)。 */
const judgeSaying = (...perRound: Record<string, unknown>[]): NonNullable<ExecutorDagConfig['judgeSend']> => {
  let n = 0;
  return async (): Promise<ModelResponse> => {
    const parsed = perRound[Math.min(n, perRound.length - 1)]!;
    n++;
    return {
      text: '',
      parsed: { score: 0.9, rejectedNodes: [], ...parsed },
      usage: { in: 0, out: 0 },
      raw: {},
      model: 'stub:judge',
      attempts: 1,
    };
  };
};

const plan = (nodes: ConductorPlan['nodes']): ConductorPlan => ({ name: 'p', nodes });

/** 闸登记对账 (INV-11) 要求每道闸有「真开火过」的用例 —— 所以判词整串要被捕到并断言。 */
const captureLogger = (lines: string[]): CoreLogger => ({
  debug: () => {},
  info: (_o, msg) => lines.push(msg ?? ''),
  warn: (_o, msg) => lines.push(msg ?? ''),
  error: () => {},
});
const dumpLogger = (): CoreLogger => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} });

async function run(opts: { parsed: Record<string, unknown> | Record<string, unknown>[]; tag: string; maxRounds?: number }) {
  const root = mkdtempSync(join(TMP_ROOT, `${opts.tag}-`));
  const mgr = new CheckpointManager(root);
  const runId = `${opts.tag}-run`;
  const prompts: string[] = [];
  const logLines: string[] = [];
  setCoreLogger(captureLogger(logLines));
  const res = await runExecutorDagWithPlan(
    plan({ execute: { goal: '把 a 写进 out.md', executor: 'conductor', max_rounds: opts.maxRounds ?? 3 } }),
    {
      conductorModel: 'test:conductor',
      leafModel: 'test:leaf',
      generate: capturingGenerate(prompts),
      agentTemplates: new Map(),
      judgeSend: judgeSaying(...(Array.isArray(opts.parsed) ? opts.parsed : [opts.parsed])),
      continuity: { manager: mgr, runId, repoRoot: root },
    } as ExecutorDagConfig,
  );
  setCoreLogger(dumpLogger());
  return { res, prompts, logLines, journal: mgr.loadNodeLoopJournal(runId, 'execute') };
}

describe('G2 契约闸 — judge 拿原题回查 goal', () => {
  test('★ GWT-1 invalid → 停轮, journal 记 blocked (加轮数没用), 并留一条 observation', async () => {
    const { res, journal, logLines } = await run({
      tag: 'gwt1',
      parsed: { converged: false, failureReason: '没做完', contractVerdict: 'invalid', contractIssue: '原题要求写 out.md, goal 写成了 tmp.md' },
    });
    expect(journal?.stop?.kind).toBe('blocked');
    expect(journal?.stop?.evidence).toContain('G2 契约闸');
    expect(journal?.stop?.evidence).toContain('tmp.md');
    // 停在第 1 轮 —— 不许把剩下 2 轮烧在同一份歪契约上。
    expect(journal?.completedRounds).toBe(1);
    expect((res.observations ?? []).some((o) => o.kind === 'contract-misaligned')).toBe(true);
    // 闸登记对账 (INV-11): 判词**整串**逐字 —— 登记表里的 id 与源码里的这一串是同一件事,
    // 只断言"含 contract-gate" 会让改文案的漂移悄悄溜过去。
    expect(logLines).toContain(
      '[omd/executor-dag][contract-gate] G2: goal 相对原题写歪 → 停轮交人改契约 (加轮数没用)',
    );
  });

  test('★ GWT-2 与 converged 正交: converged=true ∧ invalid 照样拦 (最坏那格)', async () => {
    const { journal } = await run({
      tag: 'gwt2',
      parsed: { converged: true, contractVerdict: 'invalid', contractIssue: '干完了另一件事' },
    });
    expect(journal?.stop?.kind).toBe('blocked');
    expect(journal?.converged).not.toBe(true); // 不许拿一份写歪的契约给出"成功"
  });

  test('★ GWT-3 单轮 unknown 不拦 —— 「我不知道」≠「它错了」', async () => {
    // 第 1 轮 unknown, 第 2 轮 aligned → streak 断掉, 既不走契约闸也不走 ask 出口。
    const { journal } = await run({
      tag: 'gwt3',
      maxRounds: 2,
      parsed: [
        { converged: false, failureReason: '还差一点', contractVerdict: 'unknown' },
        { converged: false, failureReason: '还差一点', contractVerdict: 'aligned' },
      ],
    });
    expect(journal?.stop?.kind).not.toBe('blocked');
    expect(journal?.completedRounds).toBe(2); // 照常转满
  });

  test('★ GWT-4 契约结论逐轮入账; judge 没答 → 该列缺席, 不补 aligned', async () => {
    const withAns = await run({
      tag: 'gwt4a',
      maxRounds: 2,
      parsed: { converged: false, failureReason: 'x', contractVerdict: 'aligned' },
    });
    expect(withAns.journal?.verdicts?.map((v) => v.contract)).toEqual(['aligned', 'aligned']);

    const noAns = await run({ tag: 'gwt4b', maxRounds: 2, parsed: { converged: false, failureReason: 'x' } });
    for (const v of noAns.journal?.verdicts ?? []) expect('contract' in v).toBe(false);
  });
});

/**
 * ask 出口 (2026-08-28) —— 连续两轮判官说不准这活对不对 → 停轮问 owner。
 *
 * 承 LH-Harness 的 `Next: ask` (manager.py:581) 一等路由, 但**触发权归引擎**:
 * judge 只写问题内容 (`askOwner`), 停不停由这里数 streak 决定。反过来做就是给模型一个
 * "我想停就停"的按钮 —— 一个爱提问的座位能把每一跑停在第 1 轮, 而这一格没有机械证据能反驳它。
 *
 * ## 四条 GWT
 *   · **ASK-1** 连续 2 轮 unknown → 停轮 (`blocked`), 问题原文进 stop.evidence + observation。
 *   · **ASK-2** judge 判 unknown 却**没写**问题 → 照样停, 但如实说"它没写出要问什么" (不编问题)。
 *   · **ASK-3** streak 必须**连续**: unknown → aligned → unknown 不触发 (见 GWT-3 的对称面)。
 *   · **ASK-4** `askOwner` 单独**不是**触发器: 只有 1 轮 unknown 时哪怕写了问题也不停。
 *
 * ## 反向自检
 *   · ASK-1: `ASK_UNKNOWN_STREAK` 改成 99 → 永不触发 → 红。
 *   · ASK-2: 把缺席分支改成编一个占位问题 → 红 (仓规坑①: 编的问题比没问题更坏)。
 *   · ASK-4: 把触发判据从 streak 改成 `verdict.askOwner` 在不在 → 红 (模型拿到了停机按钮)。
 */
describe('ask 出口 — 连续两轮说不准 → 停轮问 owner', () => {
  const unknownWith = (q?: string) => ({
    converged: false,
    failureReason: '判不了',
    contractVerdict: 'unknown',
    ...(q ? { askOwner: q } : {}),
  });

  test('★ ASK-1 连续 2 轮 unknown → blocked, 问题原文进 stop.evidence 与 observation', async () => {
    const q = '原题里的"导出"指的是导出 CSV 还是导出整个工程?';
    const { res, journal, logLines } = await run({
      tag: 'ask1',
      maxRounds: 4,
      parsed: [unknownWith(q), unknownWith(q)],
    });
    expect(journal?.stop?.kind).toBe('blocked');
    expect(journal?.stop?.evidence).toContain('ask 出口');
    expect(journal?.stop?.evidence).toContain(q);
    // 停在第 2 轮 —— 剩下 2 轮不许烧在一个再转也消不掉的歧义上。
    expect(journal?.completedRounds).toBe(2);
    expect((res.observations ?? []).some((o) => o.kind === 'owner-question')).toBe(true);
    // 闸登记对账 (INV-11): 判词整串逐字。
    expect(logLines).toContain(
      '[omd/executor-dag][ask-owner] 连续两轮契约 unknown → 停轮问 owner (再转一轮消不掉这个歧义)',
    );
  });

  test('★ ASK-2 判了 unknown 却没写问题 → 照样停, 但如实说它没写 (不编一个问题)', async () => {
    const { journal } = await run({ tag: 'ask2', maxRounds: 4, parsed: [unknownWith(), unknownWith()] });
    expect(journal?.stop?.kind).toBe('blocked');
    expect(journal?.stop?.evidence).toContain('没写出要问什么');
    expect(journal?.completedRounds).toBe(2);
  });

  test('★ ASK-3 streak 必须连续: unknown → aligned → unknown 不触发', async () => {
    const { journal } = await run({
      tag: 'ask3',
      maxRounds: 3,
      parsed: [
        unknownWith('q1'),
        { converged: false, failureReason: 'x', contractVerdict: 'aligned' },
        unknownWith('q2'),
      ],
    });
    expect(journal?.stop?.kind).not.toBe('blocked');
    expect(journal?.completedRounds).toBe(3); // 转满, 没被中途停
  });

  test('★ ASK-4 askOwner 不是触发器: 只有 1 轮 unknown 时写了问题也不停', async () => {
    const { journal } = await run({
      tag: 'ask4',
      maxRounds: 2,
      parsed: [unknownWith('我很想问一句'), { converged: false, failureReason: 'x', contractVerdict: 'aligned' }],
    });
    expect(journal?.stop?.kind).not.toBe('blocked');
    expect(journal?.completedRounds).toBe(2);
  });
});
