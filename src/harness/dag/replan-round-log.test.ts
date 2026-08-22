/**
 * 切片 (2026-08-23, 引擎自纠错片 1 续) —— 重规划轮两行判词 (C-1 · C-2)。
 *
 * GWT 表 (SDD §契约):
 *   G-1  配 `deterministicReplan` + 假 verifier 第一轮 fail
 *        ⇒ 恰好一条 `重规划轮开始` + 一条 `重规划轮结束`;
 *          结束那条 mode === 'deterministic' / ms > 0 / sinceRunStartMs >= ms;
 *          两条 at 都能 Date.parse 且 start ≤ end。
 *   G-2  不配 `deterministicReplan` (走 patch/full)
 *        ⇒ mode 是 'patch' 或 'full' (不是写死的, 承重: 它得真反映走了哪条路)。
 *   G-3  verifier 第一轮就 pass (零重规划轮)
 *        ⇒ 两种判词一条都没有 (INV-4)。
 *
 * 判别力: 反向自检 (本片手做, 图上不放 falsify 节点, 锚拿不准别写进表)
 *   1. 把结束判词的 mode 写死成 'full' ⇒ G-1 当场红
 *   2. 把 ms 写死成 0 ⇒ G-1 当场红
 *   各自跑完还原, 复绿, 贴出红的用例。
 *
 * 锚: 沿用 deterministic-replan.test.ts 的 captureLogger + runExecutorDagWithPlan 夹具;
 *     round-2 计划用 `sleep 0.02` 让 `ms` 留出刻度, 否则 0-flaky。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { runExecutorDagWithPlan } from './engine';
import { setCoreLogger, type CoreLogger } from '../logger';
import { registerProvider } from '../../model/providers';
import type { ConductorPlan } from '../conductor-plan';
import type { GenerateFn } from './types';

interface Captured { msg: string; payload: Record<string, unknown> }

const captureLogger = (): { logger: CoreLogger; lines: Captured[] } => {
  const lines: Captured[] = [];
  return {
    lines,
    logger: {
      debug: () => {},
      info: (obj, msg) => lines.push({ msg: msg ?? '', payload: (obj ?? {}) as Record<string, unknown> }),
      warn: (obj, msg) => lines.push({ msg: msg ?? '', payload: (obj ?? {}) as Record<string, unknown> }),
      error: () => {},
    },
  };
};

const dumpLogger = (): CoreLogger => ({
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
});

/** round-1 计划: s1 (command) + accept (command, 冻结判据)。 */
const round1Plan = (): ConductorPlan => ({
  name: 'goal-execute-flat',
  nodes: {
    s1: { executor: 'command', command: 'echo S1_ROUND1', expect_exit: 0, depends_on: [], goal: 's1 干完活', detector: true },
    accept: { executor: 'command', command: 'echo ACCEPT_ROUND1', expect_exit: 0, depends_on: ['s1'], goal: '冻结判据 (环外确定性闸)' },
  },
});

/** G-1 用的 round-2 固定图: 加 sleep 0.02 给 `ms` 留刻度 (SDD 警告: 否则 0-flaky)。
 *  s1 必须带 `detector: true` 否则会被 #153② 串行 command 链合并吸进 accept。 */
const FIXED_PLAN_WITH_SLEEP: ConductorPlan = {
  name: 'goal-execute-flat',
  nodes: {
    s1: { executor: 'command', command: 'sleep 0.02; echo S1_DETERMINISTIC', expect_exit: 0, depends_on: [], goal: 's1 干完活 ★', detector: true },
    accept: { executor: 'command', command: 'sleep 0.02; echo ACCEPT_DETERMINISTIC', expect_exit: 0, depends_on: ['s1'], goal: '冻结判据 (环外确定性闸) ★' },
  },
};

/** G-2 (patch/full) 用的 generate: 返 no-op patch, 走 tryPatchReplan 路径, 让 planAndExecute 不必真跑。 */
const patchPathGenerate = (): GenerateFn => async (req) => {
  const tn = (req as { traceName?: string }).traceName ?? '';
  if (tn === 'escalation:repair') {
    return { text: JSON.stringify({ patch: {} }), usage: { in: 1, out: 1 } };
  }
  return { text: 'out:leaf', usage: { in: 1, out: 1 } };
};

/** 假 generate: 升级重规划段不该请 LLM, 拦 sentinel。其它 round-1 必走 conductor:plan, 返平铺图。 */
const deterministicGenerate = (): { generate: GenerateFn; calls: string[] } => {
  const calls: string[] = [];
  const generate: GenerateFn = async (req) => {
    const tn = (req as { traceName?: string }).traceName ?? '';
    calls.push(tn || 'unknown');
    if (tn.startsWith('escalation:')) {
      throw new Error(`重规划段不该调 generate, 但收到 traceName=${tn}`);
    }
    return { text: 'out:leaf', usage: { in: 1, out: 1 } };
  };
  return { generate, calls };
};

/** verifier: 首轮 fail (触发升级), 次轮 pass (收敛收尾)。 */
const twoRoundVerifier = () => {
  let n = 0;
  return (async () => {
    n++;
    if (n === 1) return { pass: false, reason: '节点没修干净', usage: { in: 1, out: 1 } };
    return { pass: true, reason: 'ok', usage: { in: 1, out: 1 } };
  }) as unknown as NonNullable<Parameters<typeof runExecutorDagWithPlan>[1] extends infer T ? T extends { verifier?: infer V } ? V : never : never>;
};

const oneShotPassVerifier = () => {
  return (async () => ({ pass: true, reason: 'ok', usage: { in: 1, out: 1 } })) as unknown as NonNullable<
    Parameters<typeof runExecutorDagWithPlan>[1] extends infer T ? T extends { verifier?: infer V } ? V : never : never
  >;
};

/** 从 capture 的 lines 中挑出匹配 msg 前缀的 (info only)。 */
const pick = (lines: Captured[], msgPrefix: string): Captured[] =>
  lines.filter((l) => l.msg === msgPrefix);

describe('重规划轮两行判词 (SDD 2026-08-23 · 引擎自纠错片 1 续)', () => {
  registerProvider('detm', { baseUrl: 'http://127.0.0.1:9', apiKey: 'test-key', api: 'openai-compatible' });

  let cap: ReturnType<typeof captureLogger>;
  beforeEach(() => { cap = captureLogger(); setCoreLogger(cap.logger); });
  afterEach(() => { setCoreLogger(dumpLogger()); });

  // G-1 ────────────────────────────────────────────────────────────────────────
  test('G-1: 配 deterministicReplan + verifier fail → 一条开始 + 一条结束; mode=deterministic, ms>0, sinceRunStartMs>=ms', async () => {
    const { generate } = deterministicGenerate();
    const verifier = twoRoundVerifier();
    const detReplan = () => FIXED_PLAN_WITH_SLEEP;
    const r = await runExecutorDagWithPlan(
      round1Plan(),
      {
        conductorModel: 'test:conductor',
        leafModel: 'test:leaf',
        generate,
        agentTemplates: new Map(),
        deterministicReplan: detReplan,
        verifier,
        conductorEscalationModel: 'detm:strong',
      },
    );
    expect(r.verification!.pass).toBe(true);
    expect(r.verification!.escalated).toBe(true);

    const starts = pick(cap.lines, '[omd/executor-dag] 重规划轮开始');
    const ends = pick(cap.lines, '[omd/executor-dag] 重规划轮结束');
    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);

    const s = starts[0]!.payload;
    const e = ends[0]!.payload;
    // at parseable
    expect(typeof s.at).toBe('string');
    expect(typeof e.at).toBe('string');
    const sAt = Date.parse(s.at as string);
    const eAt = Date.parse(e.at as string);
    expect(Number.isFinite(sAt)).toBe(true);
    expect(Number.isFinite(eAt)).toBe(true);
    expect(sAt).toBeLessThanOrEqual(eAt);
    // round = escCount = 1 (verifier fail 一次就升级一次)
    expect(s.round).toBe(1);
    expect(e.round).toBe(1);
    // poisoned + nodes 在开始那条
    expect(typeof s.poisoned).toBe('number');
    expect(typeof s.nodes).toBe('number');
    expect((s.nodes as number)).toBeGreaterThan(0);
    // 结束那条: mode=deterministic, ms>0, sinceRunStartMs>=ms
    expect(e.mode).toBe('deterministic');
    expect(typeof e.ms).toBe('number');
    expect(e.ms as number).toBeGreaterThan(0);
    expect(typeof e.sinceRunStartMs).toBe('number');
    expect(e.sinceRunStartMs as number).toBeGreaterThanOrEqual(e.ms as number);
    expect(typeof e.reuseHits).toBe('number');
  });

  // G-2 ────────────────────────────────────────────────────────────────────────
  test('G-2: 不配 deterministicReplan (走 patch/full) → mode 是 patch 或 full (承重: 真反映走了哪条路)', async () => {
    const generate = patchPathGenerate();
    const verifier = twoRoundVerifier();
    const r = await runExecutorDagWithPlan(
      round1Plan(),
      {
        conductorModel: 'test:conductor',
        leafModel: 'test:leaf',
        generate,
        agentTemplates: new Map(),
        // 故意不传 deterministicReplan
        verifier,
        conductorEscalationModel: 'detm:strong',
      },
    );
    expect(r.verification!.pass).toBe(true);

    const starts = pick(cap.lines, '[omd/executor-dag] 重规划轮开始');
    const ends = pick(cap.lines, '[omd/executor-dag] 重规划轮结束');
    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);

    const e = ends[0]!.payload;
    expect(['patch', 'full']).toContain(e.mode as string);
  });

  // G-3 ────────────────────────────────────────────────────────────────────────
  test('G-3: verifier 第一轮就 pass (零重规划轮) → 两种判词一条都没有 (INV-4)', async () => {
    const generate: GenerateFn = async () => ({ text: 'out:leaf', usage: { in: 1, out: 1 } });
    const verifier = oneShotPassVerifier();
    const r = await runExecutorDagWithPlan(
      round1Plan(),
      {
        conductorModel: 'test:conductor',
        leafModel: 'test:leaf',
        generate,
        agentTemplates: new Map(),
        deterministicReplan: () => FIXED_PLAN_WITH_SLEEP, // 即使配了, 零升级轮也不会进
        verifier,
        conductorEscalationModel: 'detm:strong',
      },
    );
    expect(r.verification!.pass).toBe(true);
    expect(r.verification!.escalated).toBeFalsy();

    const starts = pick(cap.lines, '[omd/executor-dag] 重规划轮开始');
    const ends = pick(cap.lines, '[omd/executor-dag] 重规划轮结束');
    expect(starts).toHaveLength(0);
    expect(ends).toHaveLength(0);
  });
});
