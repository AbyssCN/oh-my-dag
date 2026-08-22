/**
 * 切片 1 验收 — conductor 内环留轮边界时间戳 (2026-08-23, 引擎自纠错片 1)。
 *
 * 三条判词 (C-1):
 *   - 轮开始 / 轮结束 — 每轮各恰好一条, 共 N 轮
 *   - 内环收尾       — 环定局那条 (settle 唯一埋点, 所有正常出口都过)
 *
 * 锚: SDD `docs/plan/2026-08-23-next-session-引擎自纠错.md` 片 1。
 * 反向自检: 把 `roundStampNow` 替成常量 → at 不再递增 + 百分比断言当场红。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { runExecutorDagWithPlan } from './engine';
import { setCoreLogger, type CoreLogger } from '../logger';
import { PLAN_BOUNDARY } from '../conductor-plan';
import type { ConductorPlan } from '../conductor-plan';
import type { ContentPart } from '../../model/gateway';
import type { ExecutorDagConfig, GenerateFn } from './types';

const contentText = (c: string | ContentPart[] | undefined): string =>
  typeof c === 'string' ? (c ?? '') : (c ?? []).map((p) => (p.type === 'text' ? p.text : '')).join('\n');

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const SUB_PLAN = JSON.stringify({ name: 'sub', nodes: { 'leaf-a': { goal: '干 A' } } });

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

/** 假 judge — 形状照 `inner-loop-stop-evidence.test.ts:43` 抄。 */
const fakeJudgeResponse = (converged: boolean) => ({
  text: '',
  parsed: {
    converged,
    score: converged ? 9 : 3,
    ...(converged ? {} : { failureReason: '还差一点' }),
    rejectedNodes: [],
  },
  usage: { in: 0, out: 0 },
  raw: {},
  model: 'judge:fake',
  attempts: 1,
});

describe('切片 1 · conductor 内环留轮边界时间戳', () => {
  let cap: ReturnType<typeof captureLogger>;

  beforeEach(() => {
    cap = captureLogger();
    setCoreLogger(cap.logger);
  });
  afterEach(() => {
    setCoreLogger(dumpLogger());
  });

  test('GWT-1 · 2 轮 (round 1 不收 / round 2 收), round 2 刻意慢 5 倍 → 2 轮开始 + 2 轮结束 + 1 内环收尾, at 严格递增, round2.ms / loopMs > 0.5', async () => {
    let leafCalls = 0;
    let judgeCalls = 0;
    const generate: GenerateFn = async (req) => {
      const user = contentText(req.messages.find((m) => m.role === 'user')?.content);
      if (user.includes(PLAN_BOUNDARY.trim().split('\n')[0]!) || user.includes('TASK (dynamic')) {
        // conductor 调用 —— round 2 的 user message 里含「还差一点」(judge round 1 的失败原因),
        // 借这条信号给 leaf goal 加后缀, 让内容寻址 id 跨轮**不同** → 不会被 D-21 跨轮复用
        // 跳过 generate, 否则 sleep(100) 落不到 round 2 上。
        const isRound2 = user.includes('还差一点');
        const leafGoal = isRound2 ? '干 A 第二次更慢' : '干 A';
        const sub = JSON.stringify({ name: 'sub', nodes: { 'leaf-a': { goal: leafGoal } } });
        return { text: sub, usage: { in: 1, out: 1 } };
      }
      const n = leafCalls++;
      // 第 1 轮 leaf ≈ 20ms, 第 2 轮 leaf ≈ 100ms (5×)。零延迟两轮会落同一毫秒, 断言"严格
      // 递增"就 flaky —— 不是闸的问题, 是测试没给尺子留刻度。
      await sleep(n === 0 ? 20 : 100);
      return { text: `leaf-${n}`, usage: { in: 1, out: 1 } };
    };
    const cfg = {
      conductorModel: 'c:m',
      leafModel: 'l:m',
      generate,
      agentTemplates: new Map(),
      judgeSend: (async () => {
        const k = judgeCalls++;
        return fakeJudgeResponse(k === 1); // round 1 (k=0) 不收; round 2 (k=1) 收
      }) as unknown as NonNullable<ExecutorDagConfig['judgeSend']>,
    } as unknown as ExecutorDagConfig;
    const plan: ConductorPlan = { name: 'p', nodes: { P: { goal: 'g', executor: 'conductor', max_rounds: 2 } } };

    await runExecutorDagWithPlan(plan, cfg);

    const starts = cap.lines.filter((l) => l.msg === '[omd/executor-dag] 轮开始');
    const ends = cap.lines.filter((l) => l.msg === '[omd/executor-dag] 轮结束');
    const closes = cap.lines.filter((l) => l.msg === '[omd/executor-dag] 内环收尾');

    expect(starts).toHaveLength(2);
    expect(ends).toHaveLength(2);
    expect(closes).toHaveLength(1);

    const at = (l: Captured): number => Date.parse(l.payload.at as string);
    expect(Number.isFinite(at(starts[0]!))).toBe(true);
    // 递增 (SDD GWT-1)。**哪一跳能用严格 `<` 取决于那一跳里有没有真的花时间**:
    //   · 轮内 (轮开始→轮结束) 有 sleep 撑着 → `<` 站得住;
    //   · 轮末 judge → 下一轮开始, 以及轮结束→内环收尾, **中间什么都不做** →
    //     同毫秒是正常的, 只能 `<=`。
    // ⚠ 这一行原先写的是 `<`, 而 run 75c39d15 的 accept 就红在它上面 (两个 at 同为
    //   1787403265170) —— 契约把「严格递增」一刀切写在 5 条边上, 是**契约错了不是实装错了**。
    // 反向自检不依赖被放宽的这两跳: roundStampNow 替成常量 → at 全相等 → 上面轮内那两条
    // `<` 当场红, 判别力不减。
    expect(at(starts[0]!)).toBeLessThan(at(ends[0]!));
    expect(at(ends[0]!)).toBeLessThanOrEqual(at(starts[1]!));
    expect(at(starts[1]!)).toBeLessThan(at(ends[1]!));
    expect(at(ends[1]!)).toBeLessThanOrEqual(at(closes[0]!));

    const end2Ms = ends[1]!.payload.ms as number;
    const loopMs = closes[0]!.payload.loopMs as number;
    expect(end2Ms).toBeGreaterThan(0);
    expect(loopMs).toBeGreaterThan(0);
    // 第 2 轮占总墙钟的百分比 — 本片的交付物。
    const ratio = end2Ms / loopMs;
    expect(ratio).toBeGreaterThan(0.5);
  });

  test('GWT-2 · 轮结束.nodes 等于该轮子图落地节点数 (非 0)', async () => {
    let leafCalls = 0;
    let judgeCalls = 0;
    const generate: GenerateFn = async (req) => {
      const user = contentText(req.messages.find((m) => m.role === 'user')?.content);
      if (user.includes(PLAN_BOUNDARY.trim().split('\n')[0]!) || user.includes('TASK (dynamic')) {
        return { text: SUB_PLAN, usage: { in: 1, out: 1 } };
      }
      leafCalls++;
      await sleep(10);
      return { text: `leaf-${leafCalls}`, usage: { in: 1, out: 1 } };
    };
    const cfg = {
      conductorModel: 'c:m',
      leafModel: 'l:m',
      generate,
      agentTemplates: new Map(),
      judgeSend: (async () => {
        const k = judgeCalls++;
        return fakeJudgeResponse(k === 1);
      }) as unknown as NonNullable<ExecutorDagConfig['judgeSend']>,
    } as unknown as ExecutorDagConfig;
    const plan: ConductorPlan = { name: 'p', nodes: { P: { goal: 'g', executor: 'conductor', max_rounds: 2 } } };

    await runExecutorDagWithPlan(plan, cfg);

    const ends = cap.lines.filter((l) => l.msg === '[omd/executor-dag] 轮结束');
    expect(ends).toHaveLength(2);
    expect(ends[0]!.payload.nodes).toBe(1); // 每轮 1 leaf
    expect(ends[1]!.payload.nodes).toBe(1);
  });

  test('GWT-3 · max_rounds=1 且首轮就收敛 → 1 轮开始 + 1 轮结束 + 1 内环收尾 (INV-5)', async () => {
    const generate: GenerateFn = async (req) => {
      const user = contentText(req.messages.find((m) => m.role === 'user')?.content);
      if (user.includes(PLAN_BOUNDARY.trim().split('\n')[0]!) || user.includes('TASK (dynamic')) {
        return { text: SUB_PLAN, usage: { in: 1, out: 1 } };
      }
      return { text: 'leaf-out', usage: { in: 1, out: 1 } };
    };
    const cfg = {
      conductorModel: 'c:m',
      leafModel: 'l:m',
      generate,
      agentTemplates: new Map(),
      judgeSend: (async () => fakeJudgeResponse(true)) as unknown as NonNullable<ExecutorDagConfig['judgeSend']>,
    } as unknown as ExecutorDagConfig;
    const plan: ConductorPlan = { name: 'p', nodes: { P: { goal: 'g', executor: 'conductor', max_rounds: 1 } } };

    await runExecutorDagWithPlan(plan, cfg);

    const starts = cap.lines.filter((l) => l.msg === '[omd/executor-dag] 轮开始');
    const ends = cap.lines.filter((l) => l.msg === '[omd/executor-dag] 轮结束');
    const closes = cap.lines.filter((l) => l.msg === '[omd/executor-dag] 内环收尾');

    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);
    expect(closes).toHaveLength(1);
  });
});
