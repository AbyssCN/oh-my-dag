/**
 * **内环 judge 判词写入磁盘 + No-silent-caps**(片 1, #227, 2026-08-23)。
 *
 * ## 它治的是什么
 *
 * 今天盘上 `NodeLoopJournal.verdicts` 记**两道闸各说了什么**(criterion × judge),
 * 但**没说它们说了什么话** —— 判词原文只在内存里, 跑完即丢。resume 读不回来,
 * verifier 与读数板只能看到"那一轮 judge 说没成", 看不到理由。
 *
 * 补完之后, journal 这一档也按 No-silent-caps 守: 判词超长 → 全文写入磁盘 + 指针,
 * 与 `capFanin` / `renderHandoff`(#226)同形。
 *
 * ## GWT(从 SDD 直接搬)
 *
 * · 多轮内环, judge 每轮返回可辨认判词 → journal.verdicts 每轮的 reason 逐字 = judge 判词。
 * · 某轮走 `gate-rejected` → 该轮 reason ≠ judge 判词(闸合成的, judge 没被问过)。
 * · 判词超长 → journal 里存告示 + 全文指针路径, 指针文件里能读到全文。
 *
 * ## ⚠ 实装前天然红(执行体约定, 不许删/注释/回滚既有行为来制造红)
 *
 *  · 删掉 `roundVerdicts.push({...,reason,...})` 那行 → 三条全红(reason 缺席);
 *  · 把 `gate-rejected` 也写成 judge 的 failureReason → 第二条红(它等于 judge 判词);
 *  · 把超长判词的全文本直接塞进 journal(reason 没做 spill) → 第三条红(无告示无指针,
 *    或即便没塞全文也只是普通截断, 没"全文在 *.txt"那条告示)。
 *
 * ## 既有闸(对照: 这份测试之前 `NodeLoopJournal` 在全仓无人引用, 见 #227 现场)
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runExecutorDagWithPlan } from '../../src/harness/dag/engine';
import { CheckpointManager } from '../../src/harness/continuity/checkpoint-manager';
import { PLAN_BOUNDARY } from '../../src/harness/conductor-plan';
import type { ConductorPlan } from '../../src/harness/conductor-plan';
import type { ExecutorDagConfig, GenerateFn } from '../../src/harness/dag/types';

const RUN = 'verdict-reason';
let root: string;
let manager: CheckpointManager;
let saved: string | undefined;

beforeEach(() => {
  saved = process.env.OMD_DATA_HOME;
  delete process.env.OMD_DATA_HOME;
  root = mkdtempSync(join(tmpdir(), 'omd-vreason-'));
  manager = new CheckpointManager(root);
});
afterEach(() => {
  if (saved === undefined) delete process.env.OMD_DATA_HOME;
  else process.env.OMD_DATA_HOME = saved;
  rmSync(root, { recursive: true, force: true });
});

/**
 * 子图: 一个命令节点。
 *   · 命令退出 0 → D-4 不触发(给"正常 judge 投反对票"那条用);
 *   · 命令退出 1 + 声称「全部完成」→ D-4 合成拒绝(给"gate-rejected"那条用)。
 * claim 文本沿用 `false-completion-wiring.test.ts` 的 `LIAR_CLAIM`, 双面命中。
 */
const SUB_PLAN = JSON.stringify({
  name: 'sub',
  nodes: { 'run-check': { goal: '跑一次自检', executor: 'command', command: 'bun test' } },
});
const LIAR_CLAIM = '全部完成, 测试全部通过';

function makeGenerate(): GenerateFn {
  return async (req) => {
    const user = String(req.messages.find((m) => m.role === 'user')?.content ?? '');
    if (user.includes(PLAN_BOUNDARY.trim().split('\n')[0]!) || user.includes('TASK (dynamic')) {
      return { text: SUB_PLAN, usage: { in: 1, out: 1 } };
    }
    return { text: 'out', usage: { in: 1, out: 1 } };
  };
}

const plan = (rounds: number, judgeFinal = false): ConductorPlan =>
  ({ name: 'outer', nodes: { C: { goal: '把这件事做完', executor: 'conductor', max_rounds: rounds, ...(judgeFinal ? { judge_final: true } : {}) } } }) as ConductorPlan;

/** judge fake: 第 n 次调用返 `reasons[n]`, 调用顺序对齐 → 写出来的 round N 对应 reasons[N-1]。 */
const judgeOf = (reasons: string[]): NonNullable<ExecutorDagConfig['judgeSend']> => {
  let n = 0;
  return (async () => {
    const reason = reasons[n++] ?? reasons[reasons.length - 1] ?? '';
    const v = { converged: false, score: 0, failureReason: reason, rejectedNodes: [] };
    return { text: JSON.stringify(v), parsed: v, usage: { in: 1, out: 1 } };
  }) as never;
};

const baseCfg = (over: Partial<ExecutorDagConfig>): ExecutorDagConfig => ({
  conductorModel: 'c:m',
  leafModel: 'l:m',
  agentTemplates: new Map(),
  generate: makeGenerate(),
  // §8.4 动作级熔断调高: 同图连跑多轮不要被它提前打断, 那是另一个纪律。
  repeatedActionThreshold: 99,
  // 子命令退出 0: 让正常判词路径(a / c)不被 D-4 抢走。
  commandRunner: async ({ command }: { command: string }) =>
    ({ text: 'ok', usage: { in: 0, out: 0 }, timedOut: false, signal: null, exitCode: command === 'true' ? 0 : 0 }),
  continuity: { manager, runId: RUN, repoRoot: root },
  ...over,
} as unknown as ExecutorDagConfig);

describe('片 1: 内环 judge 判词落盘 (No-silent-caps 在 journal 这一档)', () => {
  test('★ 多轮内环, 每轮 reason 逐字 = judge 判词 (不许再"判了但没记话")', async () => {
    const REASONS = [
      '【轮 1】先把这个做完 —— 步骤 A, 步骤 B, 收尾验证',
      '【轮 2】方向调整 —— 这次走 X 而不是 Y, 并把缺口补上',
    ];
    await runExecutorDagWithPlan(plan(2), baseCfg({ judgeSend: judgeOf(REASONS) }));
    const j = manager.loadNodeLoopJournal(RUN, 'C');
    const verdicts = j?.verdicts ?? [];
    expect(verdicts).toHaveLength(2);
    // 关键断言: 每轮 reason 逐字等于该轮 judge 返回的判词。
    // 实装前 reason 字段缺席 → undefined !== REASONS[i], 红。
    expect((verdicts[0] as unknown as { reason?: string } | undefined)?.reason).toBe(REASONS[0]);
    expect((verdicts[1] as unknown as { reason?: string } | undefined)?.reason).toBe(REASONS[1]);
  });

  test('★ gate-rejected 这一轮: reason ≠ judge 判词 (闸合成的, judge 没被问过)', async () => {
    // D-4 谎报完成闸触发: 子命令红 (exit 1) + 声称「全部完成」 → synthetic='false-completion'。
    // freeze 绿 → 环按判据收敛 (D-I), 但该轮 reason 是闸合成的, 不该被冒充成 judge 的票。
    const JUDGE_REASON = 'judge 自己说的判词 (这一轮用不上, 闸抢在前面)';
    let judgeCalls = 0;
    const js = (async () => {
      judgeCalls++;
      const v = { converged: false, score: 0, failureReason: JUDGE_REASON, rejectedNodes: [] };
      return { text: JSON.stringify(v), parsed: v, usage: { in: 1, out: 1 } };
    }) as never;
    await runExecutorDagWithPlan(plan(1), baseCfg({
      judgeSend: js,
      freezeCriterion: { command: 'true' },
      commandRunner: async ({ command }: { command: string }) => ({
        text: LIAR_CLAIM,
        usage: { in: 0, out: 0 },
        timedOut: false,
        signal: null,
        // freeze='true' → 0 (判据绿); 'bun test' → 1 (子命令实败) → D-4 合成拒绝。
        exitCode: command === 'true' ? 0 : 1,
      }),
    }));
    expect(judgeCalls).toBe(0); // D-4 确定性先行, judge 一次都不烧
    const j = manager.loadNodeLoopJournal(RUN, 'C');
    const v = (j?.verdicts ?? [])[0];
    expect(v).toBeDefined();
    expect(v!.judge).toBe('gate-rejected'); // 钉死这一格, 否则下面 reason 断言没意义
    // ★ 这一轮的 reason 不等于 judge 判词 —— 它是闸合成的。
    // 实装前 reason 字段缺席 → undefined, 第一条红; 实装后 reason = 闸合成, 第二条也红 if 写错。
    expect((v! as unknown as { reason?: string }).reason).toBeDefined();
    expect((v! as unknown as { reason?: string }).reason).not.toEqual(JUDGE_REASON);
  });

  test('★ 判词超长 → journal 存告示 + 全文指针路径, 指针文件里能读到原文 (与 #226 同形)', async () => {
    // 一个 6000 字符的可辨认判词 (HEAD..TAIL), judge 返回它 → journal 那一格不能塞原文,
    // 必须给告示 + 指针, 指针文件里能找到 TAIL(头部被切走的那一半)。
    const HEAD = '【超长判词】开头可辨认部分-';
    const TAIL = '-结尾可辨认部分-必须在盘上找回';
    const long = HEAD + '数'.repeat(6000 - HEAD.length - TAIL.length) + TAIL;
    // judge_final: 单轮档才走得通 (D-F): 不配的话单轮档被早退 (engine.ts:2569), 不会请 judge,
    // verdicts 数组空, 下面 reason 断言根本走不到 —— 那是测试的语义错, 不是我们要的红。
    await runExecutorDagWithPlan(plan(1, true), baseCfg({ judgeSend: judgeOf([long]) }));
    const j = manager.loadNodeLoopJournal(RUN, 'C');
    const v = (j?.verdicts ?? [])[0];
    expect(v).toBeDefined();
    const reason = (v! as unknown as { reason?: string }).reason ?? '';
    // ① 告示: 必须有"已截断 / 超界 / cap"或同义提示, 不可静默。
    expect(reason).toMatch(/截断|超界|过长|cap/i);
    // ② 指针路径: 告示里必有一个能 readFileSync 的 .txt 路径(绝对或相对 CWD 都行)。
    const path = /([\/\w\-\.]+\.txt)/.exec(reason)?.[1];
    expect(path, '告示里必须有全文指针路径').toBeTruthy();
    // ③ 指针文件里能找到被切掉的尾部 (与交接超界那条同形态)。
    expect(readFileSync(path!, 'utf8')).toContain(TAIL);
  });
});