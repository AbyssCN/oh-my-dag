/**
 * src/harness/dag/handoff-freeze-fail.test.ts —— #245 冻结判据失败明细必达块 (C-2)。
 *
 * 缺陷本身 (S1 run e63f47ea): 第 3 轮修复被写集闸瘫痪, R2→R3 交接 16k 被截到 1.5k,
 * 9 条失败明细 (conductor 没看全) 整个被切掉。本闸盯的是那 9 条**结构化失败明细**——
 * 冻结判据红时, `(fail)` 测试名集合 + 命令 + 退出码作为**第三种必达块**进下一轮 prompt,
 * 不参与 1500 字符截断预算 (与 #228 nextSteps / NOVELTY_COLLAPSE_LINE 同款纪律)。
 *
 * 四条 GWT 钉死三件事 (INV-4 / INV-5 / INV-6 / INV-7 / INV-8 / INV-9):
 *   · **GWT-1**   红 ∧ 输出含 (fail) → 下一轮 prompt 含 FREEZE_FAIL_PREFIX 块 + 名字 + exit,
 *                  且 reason 灌到 >1500 时该块仍完整 (必达块不参与预算的实证)。
 *   · **GWT-2**   绿 / 未配 → 下一轮 prompt 不含该块 (缺席零字节, INV-6)。
 *   · **GWT-3**   reason 超 cap ∧ 有 continuity → 写入磁盘的全文含该块 (INV-7, 当时整份交接不缺角)。
 *   · **GWT-4**   输出无 (fail) 行 → 块只带命令与退出码, 不带原文 (有界构造)。
 *
 * 驱动先例: `engine-accept-waiver.test.ts` (GWT-5) —— 单 conductor + freezeCriterion + commandRunner
 * stub + CheckpointManager, 零模型调用 (judgeSend 也是 stub)。
 *
 * generate 必须返**合法 plan** (parsePlan: "plan must have ≥1 node", conductor-plan.ts:1066)。
 * 返 `{"name":"x","nodes":{"a":{"goal":"noop"}}}` → 1 inproc leaf → leaf 调 generate 拿一段文本
 * 当 output → leaf.status='done' → judgeConductorRound 真问 judgeSend (而不是 synthetic 短路) →
 * reason 走真 judge 那条 → prevReason / prevNextSteps / prevCriterionFailDetail 都按正常路径更新。
 *
 * ⚠ 反向自检 (仓规: 永远绿的闸不是闸):
 *   · GWT-1: 把 freezeGreen 闭包内 `if (!ok && !blocked && !waivedHere) { freezeFailDetail = ... }`
 *     整块删了 → round 2 prompt 不含 FREEZE_FAIL_PREFIX → 期望红。
 *   · GWT-2 (绿): 把 `if (!ok && !blocked && !waivedHere)` 误写成 `if (!ok)` → 绿路径也构造 →
 *     GWT-2 红。
 *   · GWT-3: 把 `fullText = ... ${tailForFull}` 改成 `fullText = reason` → saveHandoffFull 全文不含
 *     必达块 → GWT-3 红。
 *   · GWT-4: 把 `freezeFailDetail = failSet.length ? ... : head` 改成无条件 `head + '\n' + cr.text` →
 *     必达块塞进原文, 失去「有界」纪律 → GWT-4 红。
 *   · INV-9: 把 `prevCriterionFailDetail = freezeFailDetail;` 误写成 `prevCriterionFailDetail =
 *     prevCriterionFailDetail ?? freezeFailDetail` (或类似「保留残值」的写法) → round 3 prompt 还会
 *     挂着 round 1 的 [A] → 期望红 (round 3 prompt 不应含 [A], 应只含 round 2 的 [B])。
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runExecutorDagWithPlan } from './engine';
import type { ConductorPlan } from '../conductor-plan';
import type { ExecutorDagConfig, GenerateFn } from './types';
import type { ModelResponse } from '../../model/types';
import { CheckpointManager } from '../continuity/checkpoint-manager';

/** `bun test` 输出里 `(fail) <name>` 的标准格式 —— 与 accept-delta.ts:47 同源正则口径。 */
const failOutput = (names: string[]): string => names.map((n) => `(fail) ${n}`).join('\n');

/** mkdtemp 临时夹具根 —— 各 describe 自取自清, 跨 describe 用 afterAll 兜底。 */
const TMP_ROOT = mkdtempSync(join(tmpdir(), 'handoff-freeze-fail-'));
/**
 * **OMD_DATA_HOME 隔离** —— 引擎的 CheckpointManager 在环境变量被设时会走 `dataPath('continuity')`
 * (cwd-relative `.omd/continuity`, 因为 test 模式没注册 `_active` scope), 与本测试 reader 的
 * `repoRoot/.omd/continuity` 解析路径**不一致**: 写盘到 cwd, 读盘找 tmp → 全 null。统一关掉
 * (生产 entry 设此 env 的路径是 `_active` scope 路径, 与本 reader 走的 `repoRoot` 分支是两件事)。
 */
const SAVED_OMD_DATA_HOME = process.env.OMD_DATA_HOME;
delete process.env.OMD_DATA_HOME;
afterAll(() => {
  rmSync(TMP_ROOT, { recursive: true, force: true });
  if (SAVED_OMD_DATA_HOME !== undefined) process.env.OMD_DATA_HOME = SAVED_OMD_DATA_HOME;
});

/**
 * 给定 root + runId, 在 CheckpointManager 的 runDir 里找 handoff 全文文件并读出来。
 * 文件名前缀 `handoff-`, 后缀 `-r<round>.txt` (checkpoint-manager.ts:262-275 saveTextArtifact)。
 * 注: `repoRoot` 在 CheckpointManager 上是 private, 这里用 mkdtemp 的根直接拼路径。
 */
const readHandoffFull = (root: string, runId: string, round: number): string | null => {
  // CheckpointManager.runDir: 未设 OMD_DATA_HOME 时走 `<repoRoot>/.omd/continuity/<runId>`。
  const dir = process.env.OMD_DATA_HOME?.trim()
    ? join(process.env.OMD_DATA_HOME, 'continuity', runId)
    : join(root, '.omd', 'continuity', runId);
  if (!existsSync(dir)) return null;
  const file = readdirSync(dir).find((f) => f.startsWith('handoff-') && f.endsWith(`-r${round}.txt`));
  if (!file) return null;
  return readFileSync(join(dir, file), 'utf-8');
};

/**
 * 合法 1 inproc leaf 子 plan —— parsePlan 拒空 (`conductor-plan.ts:1066` plan must have ≥1 node),
 * 但 1 个无 command 的 inproc 节点会让 leaf 走 `generate()` 拿段文本当 output, 不递归展开。
 */
const VALID_SUBPLAN_JSON = '{"name":"x","nodes":{"a":{"goal":"noop"}}}';

/**
 * Stub generate: 每次返合法子 plan (让 parsePlan 通过)。把每次调用的 user message
 * 全文 push 进 prompts —— 测试按调用序过滤, 只看 conductor 的 prompt (含 `<上一轮未通过>` 标记
 * = retryCtx 进 prompt 的那一支; leaf prompt 不含)。
 */
function makeCapturingGenerate(prompts: string[]): GenerateFn {
  return async (req) => {
    const userMsg = req.messages.find((m) => m.role === 'user');
    const content = typeof userMsg?.content === 'string' ? userMsg.content : JSON.stringify(userMsg?.content ?? '');
    prompts.push(content);
    return { text: VALID_SUBPLAN_JSON, usage: { in: 0, out: 0 } };
  };
}

/**
 * Stub judgeSend: 经 Gateway.send 接缝注入, 走 responseSchema 的 zod 解析路径。
 * judge 用 `parsed.converged` / `parsed.failureReason` / `parsed.nextSteps` 三字段 (见 llm-judge.ts:18)。
 */
const makeRejectingJudge = (opts: { failureReason: string; nextSteps?: string }): NonNullable<ExecutorDagConfig['judgeSend']> =>
  async (): Promise<ModelResponse> => ({
    text: '',
    parsed: {
      converged: false,
      score: 0,
      failureReason: opts.failureReason,
      rejectedNodes: [],
      ...(opts.nextSteps ? { nextSteps: opts.nextSteps } : {}),
    },
    usage: { in: 0, out: 0 },
    raw: {},
    model: 'stub:judge',
    attempts: 1,
  });

/**
 * 一个标准「单 conductor + 冻结判据 + commandRunner + judgeSend + continuity」config 工厂。
 * generate 与 judgeSend 由调用方注入 (capture / reject 语义各不同), 其它走必填 default。
 */
function makeConfig(opts: {
  generate: GenerateFn;
  judgeSend: NonNullable<ExecutorDagConfig['judgeSend']>;
  commandRunner: NonNullable<ExecutorDagConfig['commandRunner']>;
  mgr: CheckpointManager;
  runId: string;
  freezeCriterion: ExecutorDagConfig['freezeCriterion'];
  root: string;
}): ExecutorDagConfig {
  return {
    conductorModel: 'test:conductor',
    leafModel: 'test:leaf',
    generate: opts.generate,
    agentTemplates: new Map(),
    commandRunner: opts.commandRunner,
    freezeCriterion: opts.freezeCriterion,
    judgeSend: opts.judgeSend,
    continuity: { manager: opts.mgr, runId: opts.runId, repoRoot: opts.root },
  };
}

const plan = (nodes: ConductorPlan['nodes']): ConductorPlan => ({ name: 'p', nodes });

/** 从 prompts 数组里筛出 conductor 的 prompt (含 `<上一轮未通过>` 标记 = retryCtx 进 prompt 的那一支)。 */
const conductorPrompts = (prompts: string[]): string[] =>
  prompts.filter((p) => p.includes('<上一轮未通过>'));

// ─────────────────────────────────────────────────────────────────────────────
// GWT-1 — 红 → 下一轮 prompt 含 FREEZE_FAIL_PREFIX 块 + 名字 + exit (INV-5/8)
//   reason 灌到 >1500 时该块仍完整 (INV-6: 必达块不参与预算)
// ─────────────────────────────────────────────────────────────────────────────
describe('GWT-1 — 冻结判据红 → 下一轮 prompt 含必达块', () => {
  test('★ 红 ∧ 输出含 2 个 (fail) ∧ reason 灌到 >1500 → round 2 conductor prompt 含块, 且块完整存活 (truncation 已发生)', async () => {
    const root = mkdtempSync(join(TMP_ROOT, 'gwt1-'));
    const mgr = new CheckpointManager(root);
    const runId = 'gwt1-red-long';
    const prompts: string[] = [];
    const longReason = 'X'.repeat(2000); // > HANDOFF_CAP_CHARS=1500, 触发截断
    const generate = makeCapturingGenerate(prompts);
    const judgeSend = makeRejectingJudge({ failureReason: longReason });
    const commandRunner: NonNullable<ExecutorDagConfig['commandRunner']> = async () => ({
      text: failOutput(['A > first', 'B > second']),
      usage: { in: 0, out: 0 },
      timedOut: false,
      signal: null,
      exitCode: 1,
    });

    await runExecutorDagWithPlan(
      plan({ execute: { goal: 'root', executor: 'conductor', max_rounds: 2 } }),
      makeConfig({
        generate, judgeSend, commandRunner, mgr, runId, root,
        freezeCriterion: { command: 'test' }, // 无 waiveRed → 红不赦免
      }),
    );

    // max_rounds=2 + freeze 红 → 跑满 2 轮 → 只有 round 2 含 `<上一轮未通过>` (round 1 无上轮)。
    // leaf 'a' 内容寻址 reuse → round 2 不再调 generate → prompts 里只有 round 1 conductor +
    // round 1 leaf + round 2 conductor = 3 条; cps = [round 2 conductor] = 1 条。
    const cps = conductorPrompts(prompts);
    expect(cps.length).toBe(1);
    const round2Prompt = cps[0]!;

    // (a) FREEZE_FAIL_PREFIX 块整块在 prompt 里 (前缀常量逐字比对, INV-6)
    expect(round2Prompt).toContain('上一轮冻结判据红的失败明细 (逐字, 不参与交接硬上限):');
    // (b) 命令 + 退出码 段
    expect(round2Prompt).toContain('冻结判据红 (test → exit 1)');
    // (c) 测试名集合 (extractFailSet 同源解析, INV-8)
    expect(round2Prompt).toContain('A > first');
    expect(round2Prompt).toContain('B > second');
    expect(round2Prompt).toContain('· 失败 2 条:');
    // (d) reason > 1500 → 截断已发生 (pointer 在场), 但必达块仍在 (mustReach 不参与预算)
    expect(round2Prompt).toContain('<上一轮未通过>');
    expect(round2Prompt).toContain('交接硬上限');
    // 必达块排在 <上一轮未通过>...</上一轮未通过> 之外, 在 tail 区, 所以前后都得有它:
    const failBlockIdx = round2Prompt.indexOf('上一轮冻结判据红的失败明细');
    const handoffCloseIdx = round2Prompt.lastIndexOf('</上一轮未通过>');
    expect(failBlockIdx).toBeGreaterThan(handoffCloseIdx); // 块在 handoff 闭合标签**之后** (mustReach 不被头切)

    // GWT-3 (INV-7): saveHandoffFull 全文含该块 (no-silent-caps: "当时整份交接" 不缺角)
    // renderHandoff 在 round N+1 启动时被调用, saveHandoffFull 拿的就是 N+1 → 文件 `-r<N+1>.txt`。
    const full = readHandoffFull(root, runId, 2); // round 2 启动时写的
    expect(full).not.toBeNull();
    expect(full).toContain('上一轮冻结判据红的失败明细 (逐字, 不参与交接硬上限):');
    expect(full).toContain('冻结判据红 (test → exit 1)');
    expect(full).toContain('A > first');
    expect(full).toContain('B > second');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GWT-2 — 绿 / 未配 → 下一轮 prompt 不含该块 (INV-6 缺席零字节)
// ─────────────────────────────────────────────────────────────────────────────
describe('GWT-2 — 冻结判据绿 / 未配 → 必达块缺席', () => {
  test('★ freeze 绿 (expectExit=0 ∧ commandRunner exitCode=0) → round 2 prompt 不含该块', async () => {
    // 注: freeze 绿 → loop 提前收敛 (engine.ts:2771), round 2 不会跑。这条断言的是 freezeFailDetail
    // **不构造** (缺席零字节), 而不是「绿后还能跑 round 2」。
    const root = mkdtempSync(join(TMP_ROOT, 'gwt2-green-'));
    const mgr = new CheckpointManager(root);
    const runId = 'gwt2-green';
    const prompts: string[] = [];
    const generate = makeCapturingGenerate(prompts);
    const judgeSend = makeRejectingJudge({ failureReason: 'never used' });
    const commandRunner: NonNullable<ExecutorDagConfig['commandRunner']> = async () => ({
      text: 'all green\n', usage: { in: 0, out: 0 }, timedOut: false, signal: null, exitCode: 0,
    });

    await runExecutorDagWithPlan(
      plan({ execute: { goal: 'root', executor: 'conductor', max_rounds: 2 } }),
      makeConfig({
        generate, judgeSend, commandRunner, mgr, runId, root,
        freezeCriterion: { command: 'test' }, // expectExit 缺省 0
      }),
    );

    // round 1 conductor 跑了 (没 handoff 因为 round 1 没上轮), 所以 cps = []. round 2 没跑 (绿短路径)。
    // 但 round 1 conductor 的 prompt **不含** `<上一轮未通过>` (无上轮), 所以 filter 把它扔了。
    const cps = conductorPrompts(prompts);
    expect(cps.length).toBe(0);
    // 绿 → freezeFailDetail 未构造 → 缺席零字节 (INV-6) — 任何 captured prompt 都不含该块
    for (const p of prompts) {
      expect(p).not.toContain('上一轮冻结判据红的失败明细');
      expect(p).not.toContain('冻结判据红');
    }
  });

  test('★ freezeCriterion 完全缺席 → 行为与今天逐字节相同 (round 2 prompt 不含该块)', async () => {
    const root = mkdtempSync(join(TMP_ROOT, 'gwt2-none-'));
    const mgr = new CheckpointManager(root);
    const runId = 'gwt2-none';
    const prompts: string[] = [];
    const generate = makeCapturingGenerate(prompts);
    const judgeSend = makeRejectingJudge({ failureReason: 'continuing' });
    await runExecutorDagWithPlan(
      plan({ execute: { goal: 'root', executor: 'conductor', max_rounds: 2 } }),
      makeConfig({
        generate, judgeSend,
        commandRunner: async () => ({ text: '', usage: { in: 0, out: 0 }, timedOut: false, signal: null, exitCode: 0 }),
        mgr, runId, root,
        freezeCriterion: undefined,
      }),
    );

    const cps = conductorPrompts(prompts);
    // max_rounds=2 → round 1 没 handoff 被 filter → cps = [round 2 conductor]
    expect(cps.length).toBe(1);
    expect(cps[0]!).not.toContain('上一轮冻结判据红的失败明细');
  });

  test('★ 闸拒 (exitCode=-1) → 不构造 (闸拒 ≠ 跑出红, INV-5)', async () => {
    const root = mkdtempSync(join(TMP_ROOT, 'gwt2-blocked-'));
    const mgr = new CheckpointManager(root);
    const runId = 'gwt2-blocked';
    const prompts: string[] = [];
    const generate = makeCapturingGenerate(prompts);
    const judgeSend = makeRejectingJudge({ failureReason: 'continuing' });
    const commandRunner: NonNullable<ExecutorDagConfig['commandRunner']> = async () => ({
      text: '[blocked: 危险命令]', usage: { in: 0, out: 0 }, timedOut: false, signal: null, exitCode: -1,
    });

    await runExecutorDagWithPlan(
      plan({ execute: { goal: 'root', executor: 'conductor', max_rounds: 2 } }),
      makeConfig({
        generate, judgeSend, commandRunner, mgr, runId, root,
        freezeCriterion: { command: 'test' },
      }),
    );

    const cps = conductorPrompts(prompts);
    expect(cps.length).toBe(1);
    expect(cps[0]!).not.toContain('上一轮冻结判据红的失败明细');
    expect(cps[0]!).not.toContain('冻结判据红');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GWT-4 — 输出无 (fail) 行 → 块只带命令与退出码, 不带原文 (有界构造)
// ─────────────────────────────────────────────────────────────────────────────
describe('GWT-4 — 输出无 (fail) 行 → 块只带命令与退出码', () => {
  test('★ 红 ∧ 输出无 (fail) 行 (编译错 / 跑不起来 / 超时) → 块只有 "冻结判据红 (<cmd> → exit <code>)", 不带原文', async () => {
    const root = mkdtempSync(join(TMP_ROOT, 'gwt4-'));
    const mgr = new CheckpointManager(root);
    const runId = 'gwt4-no-fail';
    const prompts: string[] = [];
    const generate = makeCapturingGenerate(prompts);
    const judgeSend = makeRejectingJudge({ failureReason: 'continuing' });
    const noisyOutput = 'error TS2322: 类型不匹配\n  at /x.ts:1:1\n\nSome compile noise here...';
    const commandRunner: NonNullable<ExecutorDagConfig['commandRunner']> = async () => ({
      text: noisyOutput, usage: { in: 0, out: 0 }, timedOut: false, signal: null, exitCode: 1,
    });

    await runExecutorDagWithPlan(
      plan({ execute: { goal: 'root', executor: 'conductor', max_rounds: 2 } }),
      makeConfig({
        generate, judgeSend, commandRunner, mgr, runId, root,
        freezeCriterion: { command: 'test' },
      }),
    );

    const cps = conductorPrompts(prompts);
    expect(cps.length).toBe(1);
    const round2Prompt = cps[0]!;
    // 块在
    expect(round2Prompt).toContain('上一轮冻结判据红的失败明细 (逐字, 不参与交接硬上限):');
    expect(round2Prompt).toContain('冻结判据红 (test → exit 1)');
    // failSet 空 → 「失败 N 条」行不出现
    expect(round2Prompt).not.toContain('· 失败 ');
    expect(round2Prompt).not.toContain('· 失败 0 条');
    // 原文一行都不进必达块 (有界纪律: 必达块不能塞无限长)
    expect(round2Prompt).not.toContain('TS2322');
    expect(round2Prompt).not.toContain('Some compile noise');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// INV-9 — 一轮一鲜, 不粘滞: round N 红的 fail 名**只**进 round N+1, 不进 round N+2。
//   (注: freeze 绿 → loop 提前收敛 (engine.ts:2771), 自然无法观察 round N+2;
//    故用「连续红」反证: round 1 红 [A] → round 2 含 [A]; round 2 红 [B] → round 3 含 [B] 不含 [A]。
//    粘滞写法会让 round 3 同时含 [A] 和 [B]。)
// ─────────────────────────────────────────────────────────────────────────────
describe('INV-9 — 必达块单轮线程, 不粘滞', () => {
  test('★ round 1 红 [A] → round 2 含 [A]; round 2 红 [B] → round 3 含 [B] 不含 [A] (不粘滞)', async () => {
    const root = mkdtempSync(join(TMP_ROOT, 'inv9-'));
    const mgr = new CheckpointManager(root);
    const runId = 'inv9-fresh';
    const prompts: string[] = [];
    const generate = makeCapturingGenerate(prompts);

    // commandRunner: 按调用序切名字 (round 1 → [A], round 2 → [B], round 3 → [C])
    let freezeRound = 0;
    const commandRunner: NonNullable<ExecutorDagConfig['commandRunner']> = async () => {
      freezeRound++;
      const failNames = freezeRound === 1 ? ['A'] : freezeRound === 2 ? ['B'] : ['C'];
      return { text: failOutput(failNames), usage: { in: 0, out: 0 }, timedOut: false, signal: null, exitCode: 1 };
    };

    // judgeSend: 每轮拒 (短 reason, 不截断, 便于 grep)
    const judgeSend = makeRejectingJudge({ failureReason: 'reject' });

    await runExecutorDagWithPlan(
      plan({ execute: { goal: 'root', executor: 'conductor', max_rounds: 3 } }),
      makeConfig({
        generate, judgeSend, commandRunner, mgr, runId, root,
        freezeCriterion: { command: 'test' },
      }),
    );

    const cps = conductorPrompts(prompts);
    // round 1 没 handoff → cps 是 [round2, round3] (round 1 没 `<上一轮未通过>`)
    expect(cps.length).toBe(2);

    // Round 2 conductor prompt: 含 round 1 的 [A], 不含 [B] (round 2 还没发生)
    expect(cps[0]).toContain('上一轮冻结判据红的失败明细');
    expect(cps[0]).toContain('· 失败 1 条: A');
    expect(cps[0]).not.toContain('· 失败 1 条: B');

    // Round 3 conductor prompt: 含 round 2 的 [B], **不含** round 1 的 [A] (不粘滞 — 一轮一鲜)
    expect(cps[1]).toContain('上一轮冻结判据红的失败明细');
    expect(cps[1]).toContain('· 失败 1 条: B');
    expect(cps[1]).not.toContain('· 失败 1 条: A');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 双重 block + nextSteps 共存 — 三种必达块同框时各自成块、不互相覆盖
// ─────────────────────────────────────────────────────────────────────────────
describe('三重必达块同框', () => {
  test('★ freeze 红 + nextSteps 给出 → FREEZE_FAIL 块与 NEXT_STEPS 块共存, 互不挤压', async () => {
    // 这条同时验证了:
    //   (a) FREEZE_FAIL_PREFIX 与 NEXT_STEPS_PREFIX 共存 (互不挤压);
    //   (b) 两块都进 mustReach, 都不参与 HANDOFF_CAP_CHARS 预算 (即使 reason 灌到 1800 > 1500)。
    const root = mkdtempSync(join(TMP_ROOT, 'triple-'));
    const mgr = new CheckpointManager(root);
    const runId = 'triple-block';
    const prompts: string[] = [];
    const generate = makeCapturingGenerate(prompts);
    const commandRunner: NonNullable<ExecutorDagConfig['commandRunner']> = async () => ({
      text: failOutput(['X']), usage: { in: 0, out: 0 }, timedOut: false, signal: null, exitCode: 1,
    });
    const judgeSend = makeRejectingJudge({ failureReason: 'Z'.repeat(1800), nextSteps: 'do X next' });

    await runExecutorDagWithPlan(
      plan({ execute: { goal: 'root', executor: 'conductor', max_rounds: 2 } }),
      makeConfig({
        generate, judgeSend, commandRunner, mgr, runId, root,
        freezeCriterion: { command: 'test' },
      }),
    );

    const cps = conductorPrompts(prompts);
    // max_rounds=2: round 1 没上轮 → 无 `<上一轮未通过>` 被 filter 掉; round 2 含 (round 2 启动时
    // renderHandoff 已截断 reason=1800 > 1500, 触发 mustReach 区), 所以 cps = [round 2] = 1 条。
    expect(cps.length).toBe(1);
    const p2 = cps[0]!;
    expect(p2).toContain('上一轮冻结判据红的失败明细 (逐字, 不参与交接硬上限):');
    expect(p2).toContain('冻结判据红 (test → exit 1)');
    expect(p2).toContain('· 失败 1 条: X');
    expect(p2).toContain('上一轮 judge 给的下一步 (机制级动作, 逐字):');
    expect(p2).toContain('do X next');
    // 两块都在 tail 区 (在 </上一轮未通过> 之后) — 验证必达块不参与预算, 同时两块都完整
    const handoffCloseIdx = p2.lastIndexOf('</上一轮未通过>');
    const failBlockIdx = p2.indexOf('上一轮冻结判据红的失败明细');
    const nextStepsBlockIdx = p2.indexOf('上一轮 judge 给的下一步');
    expect(failBlockIdx).toBeGreaterThan(handoffCloseIdx);
    expect(nextStepsBlockIdx).toBeGreaterThan(handoffCloseIdx);
  });
});

// `beforeAll` / `afterAll` 占位 —— TMP_ROOT 在文件顶层 afterAll 已清, 这里留钩子给将来扩展。
beforeAll(() => {});