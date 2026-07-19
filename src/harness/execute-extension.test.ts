/**
 * execute-extension 测试 —— fake-pi + 注入 deps (verify-gate-extension.test 同范式)。
 * 覆盖: 无规划产物提示 /sdd · SDD → DAG → 验收 brief (四选一 + 摘要) · --redraw 追加失败要点 ·
 *       ledger 回退 · plan mode 程序化退出。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createExecuteExtension,
  findLatestSdd,
  resolveConductorDefault,
  finalizePlan,
  executeSlice,
  type ExecuteExtensionOpts,
} from './execute-extension';
import type { IterateResult } from './plan/iterate';
import type { ExecutorDagResult, GenerateFn } from './executor-dag';
import type { ConductorPlan } from './conductor-plan';
import type { ModelResponse } from '../model';
import { compileSlice } from './pathfinder/slice-compiler';
import type { PathMap } from './pathfinder/types';
import { createPlanModeState } from './plan/mode';
import { PlanLedger } from './plan/ledger';

/** 最小 ExecutorDagResult (summarizeDagResult / sumUsage 消费的字段齐)。 */
function fakeDagResult(output = 'leaf ok'): ExecutorDagResult {
  return {
    plan: { name: 'fake-plan' },
    sessionId: 's1',
    levels: [['n1']],
    results: { n1: { status: 'done', output } },
    usage: { conductor: { in: 10, out: 5 }, leavesIn: 100, leavesOut: 50, leavesCacheHit: 20 },
  } as unknown as ExecutorDagResult;
}

function fakeIterateResult(converged = true): IterateResult {
  const result = fakeDagResult();
  const round = { round: 1, result, verdict: { converged, reason: 'ok' } };
  return {
    rounds: [round],
    finalRound: round,
    converged,
    status: converged ? 'converged' : 'exhausted',
  } as IterateResult;
}

/** 假 pi harness: 收集 registerCommand / sendUserMessage / appendEntry, 手工驱动 /execute。 */
function harness(opts: Partial<ExecuteExtensionOpts> & { cwd: string }, iterateResult?: IterateResult) {
  let handler: ((args: string, ctx: unknown) => Promise<void>) | null = null;
  const sent: string[] = [];
  const entries: { type: string; data: unknown }[] = [];
  const notifies: { msg: string; level?: string }[] = [];
  const setModelCalls: unknown[] = [];
  const setThinkingCalls: unknown[] = [];
  const iterateCalls: { task: string; config: Record<string, unknown> }[] = [];
  const recorded: { question?: string }[] = [];

  const pi = {
    registerCommand(name: string, def: { handler: typeof handler }) {
      if (name === 'execute') handler = def.handler;
    },
    sendUserMessage(content: string) {
      sent.push(content);
    },
    appendEntry(type: string, data: unknown) {
      entries.push({ type, data });
    },
    setModel(model: unknown) {
      setModelCalls.push(model);
      return Promise.resolve(true);
    },
    setThinkingLevel(l: unknown) {
      setThinkingCalls.push(l);
    },
  };

  const factory = createExecuteExtension(
    {
      conductorModel: 'fake:conductor',
      leafModel: 'fake:leaf',
      ...opts,
    },
    {
      iterateExecutorDag: async (task, config) => {
        iterateCalls.push({ task, config: config as unknown as Record<string, unknown> });
        // 生产路径每轮 onComplete → recorder.record; fake 里模拟单轮。
        const r = iterateResult ?? fakeIterateResult();
        if (config.onComplete && r.finalRound) await config.onComplete(r.finalRound.result);
        return r;
      },
      createDagRecorder: () => ({
        record: (_res, meta) => {
          recorded.push({ question: meta?.question });
          return 'run-1';
        },
        get: () => null,
        list: () => [],
        close: () => {},
      }),
    },
  );
  factory(pi as never);

  const ctx = { cwd: opts.cwd, ui: { notify: (msg: string, level?: string) => notifies.push({ msg, level }), setStatus: () => {} } };
  const run = (args = '') => handler!(args, ctx);
  return { run, sent, entries, notifies, setModelCalls, setThinkingCalls, iterateCalls, recorded };
}

/** 临时 cwd (可选带一个 SDD 文件)。 */
function makeCwd(sddContent?: string, sddName = '2026-07-19-测试契约.md'): string {
  const cwd = mkdtempSync(join(tmpdir(), 'omd-exec-'));
  if (sddContent !== undefined) {
    mkdirSync(join(cwd, 'docs', 'plan'), { recursive: true });
    writeFileSync(join(cwd, 'docs', 'plan', sddName), sddContent);
  }
  return cwd;
}

describe('execute-extension', () => {
  test('无 SDD 且无台账 → 提示先 /sdd, 不跑 DAG', async () => {
    const h = harness({ cwd: makeCwd() });
    await h.run();
    expect(h.iterateCalls.length).toBe(0);
    expect(h.sent.length).toBe(0);
    expect(h.notifies.some((n) => n.msg.includes('/sdd') && n.level === 'warning')).toBe(true);
  });

  test('有 SDD → SDD 全文作 task 喂 DAG, 完成后发验收 brief (四选一 + 摘要 + 收敛态)', async () => {
    const sdd = '# 测试契约\n\n## Contracts\n不变量 X 必须保持';
    const h = harness({ cwd: makeCwd(sdd) });
    await h.run();

    // task = SDD 全文
    expect(h.iterateCalls.length).toBe(1);
    expect(h.iterateCalls[0]!.task).toBe(sdd);

    // 验收 brief 经 sendUserMessage 交 runtime 模型: 四选一 + DAG 摘要 + 收敛态 + token 用量
    expect(h.sent.length).toBe(1);
    const brief = h.sent[0]!;
    expect(brief).toContain('接受 (accept)');
    expect(brief).toContain('重画 (redraw)');
    expect(brief).toContain('迭代 (iterate)');
    expect(brief).toContain('直接修 (direct fix)');
    expect(brief).toContain('--redraw');
    expect(brief).toContain('fake-plan'); // summarizeDagResult 的 plan 名
    expect(brief).toContain('leaf ok'); // leaf 输出摘要
    expect(brief).toContain('converged=true');
    expect(brief).toContain('conductor 10→5');

    // appendEntry 留痕 + dag-record 留痕 (question 带契约来源)
    expect(h.entries.some((e) => e.type === 'execute-acceptance')).toBe(true);
    expect(h.recorded.length).toBe(1);
    expect(h.recorded[0]!.question).toContain('execute ');
    expect(h.recorded[0]!.question).toContain('测试契约');
  });

  test('多个 SDD → findLatestSdd 取最新 (mtime)', () => {
    const cwd = makeCwd('旧契约', '2026-07-01-old.md');
    const dir = join(cwd, 'docs', 'plan');
    // 第二个文件 mtime 更新 (写入更晚)
    writeFileSync(join(dir, '2026-07-19-new.md'), '新契约');
    const hit = findLatestSdd(dir);
    expect(hit?.path).toContain('2026-07-19-new.md');
    expect(hit?.text).toBe('新契约');
  });

  test('--redraw "<失败要点>" → 要点追加进 task, 留痕标记 redraw', async () => {
    const h = harness({ cwd: makeCwd('# 契约') });
    await h.run('--redraw "n1 节点漏了边界校验"');
    expect(h.iterateCalls.length).toBe(1);
    const task = h.iterateCalls[0]!.task;
    expect(task).toContain('# 契约');
    expect(task).toContain('REDRAW FEEDBACK');
    expect(task).toContain('n1 节点漏了边界校验');
    expect(h.recorded[0]!.question).toContain('(redraw)');
  });

  test('无 SDD 但共享 planState 台账有货 → 回退 ledger.crystallize 作契约', async () => {
    const ledger = new PlanLedger({ goal: '把 X 接进 Y' });
    ledger.note('决策A: 走接缝 Z');
    const state = createPlanModeState(ledger);
    const h = harness({ cwd: makeCwd(), planState: state });
    await h.run();
    expect(h.iterateCalls.length).toBe(1);
    const task = h.iterateCalls[0]!.task;
    expect(task).toContain('把 X 接进 Y');
    expect(task).toContain('决策A: 走接缝 Z');
    expect(h.sent[0]!).toContain('plan ledger');
  });

  test('plan mode 在开 → 程序化干净退出 (还原 model/thinking, status 翻 normal)', async () => {
    const state = createPlanModeState(new PlanLedger({ goal: 'g' }));
    state.status = 'plan';
    state.savedModel = { id: 'runtime-model' };
    state.savedThinking = 'high';
    const h = harness({ cwd: makeCwd('# 契约'), planState: state });
    await h.run();
    expect(state.status as string).toBe('normal');
    expect(state.savedModel).toBeNull();
    expect(state.savedThinking).toBeNull();
    expect(h.setModelCalls).toEqual([{ id: 'runtime-model' }]);
    expect(h.setThinkingCalls).toEqual(['high']);
  });

  test('未注入 planState → brief 附 shift+tab 退出提示', async () => {
    const h = harness({ cwd: makeCwd('# 契约') });
    await h.run();
    expect(h.sent[0]!).toContain('shift+tab');
  });

  test('DAG 抛错 → error notify, 不发 brief', async () => {
    let handler: ((args: string, ctx: unknown) => Promise<void>) | null = null;
    const notifies: { msg: string; level?: string }[] = [];
    const sent: string[] = [];
    const pi = {
      registerCommand: (name: string, def: { handler: typeof handler }) => {
        if (name === 'execute') handler = def.handler;
      },
      sendUserMessage: (c: string) => sent.push(c),
      appendEntry: () => {},
      setModel: () => Promise.resolve(true),
      setThinkingLevel: () => {},
    };
    createExecuteExtension(
      { conductorModel: 'f:c', leafModel: 'f:l', cwd: makeCwd('# 契约') },
      {
        iterateExecutorDag: async () => {
          throw new Error('conductor 崩了');
        },
        createDagRecorder: () => ({ record: () => 'x', get: () => null, list: () => [], close: () => {} }),
      },
    )(pi as never);
    await handler!('', { cwd: '/', ui: { notify: (msg: string, level?: string) => notifies.push({ msg, level }), setStatus: () => {} } });
    expect(sent.length).toBe(0);
    expect(notifies.some((n) => n.level === 'error' && n.msg.includes('conductor 崩了'))).toBe(true);
  });
});

// ── D-8: conductor 默认 = runtime 坐标 (廉价 conductor 拆除) ──────────────────────
describe('resolveConductorDefault (D-8)', () => {
  const save = { ...process.env };
  const reset = () => {
    delete process.env.OMD_ITER_CONDUCTOR_MODEL;
    delete process.env.OMD_RUNTIME_PROVIDER;
    delete process.env.OMD_RUNTIME_MODEL;
  };

  test('默认 = runtime 坐标 (OMD_RUNTIME_PROVIDER:OMD_RUNTIME_MODEL)', () => {
    reset();
    process.env.OMD_RUNTIME_PROVIDER = 'deepseek';
    process.env.OMD_RUNTIME_MODEL = 'deepseek-v4-pro';
    expect(resolveConductorDefault()).toBe('deepseek:deepseek-v4-pro');
    Object.assign(process.env, save);
  });

  test('已设 env 覆盖 (OMD_ITER_CONDUCTOR_MODEL) 优先于 runtime 坐标', () => {
    reset();
    process.env.OMD_RUNTIME_PROVIDER = 'deepseek';
    process.env.OMD_RUNTIME_MODEL = 'deepseek-v4-pro';
    process.env.OMD_ITER_CONDUCTOR_MODEL = 'mimo:mimo-v2.5-pro';
    expect(resolveConductorDefault()).toBe('mimo:mimo-v2.5-pro');
    Object.assign(process.env, save);
  });

  test('env 全未配 → 空串 (caller 若真需 conductor 会自行报缺)', () => {
    reset();
    expect(resolveConductorDefault()).toBe('');
    Object.assign(process.env, save);
  });
});

// ── D-7 step 2: runtime-finalize (默认 OFF) ──────────────────────────────────────
describe('finalizePlan (runtime-finalize, D-7 step 2)', () => {
  const draft: ConductorPlan = { name: 'draft', description: 'demo', nodes: { a: { agent: 'x', goal: 'do a' } } };

  test('finalize OFF (默认) → 原样返回 draft, 零 LLM 调用', async () => {
    let called = 0;
    const call = async () => {
      called++;
      return {} as ModelResponse;
    };
    const out = await finalizePlan(draft, {}, { call });
    expect(out).toBe(draft); // 同一引用, 未改
    expect(called).toBe(0); // 未启用 → 不调模型
  });

  test('finalize ON → 调模型 + 输出重过 PlanSchema (返回定稿 plan)', async () => {
    let called = 0;
    const finalized = { name: 'finalized', nodes: { a: { agent: 'x', goal: 'do a (细化)', executor: 'leaf' }, verify: { agent: 'x', executor: 'command', command: 'bun test', depends_on: ['a'] } } };
    const call = async () => {
      called++;
      return { text: JSON.stringify(finalized) } as ModelResponse;
    };
    const out = await finalizePlan(draft, { finalize: true, finalizeModel: 'fake:runtime' }, { call });
    expect(called).toBe(1);
    expect(out.name).toBe('finalized');
    expect(Object.keys(out.nodes).sort()).toEqual(['a', 'verify']);
  });

  test('finalize ON 但输出未过 PlanSchema → best-effort 回退 draft (不丢 compiled slice)', async () => {
    const call = async () => ({ text: 'not a plan at all {' }) as unknown as ModelResponse;
    const out = await finalizePlan(draft, { finalize: true }, { call });
    expect(out).toBe(draft);
  });

  test('finalize ON 但模型调用抛错 → best-effort 回退 draft', async () => {
    const call = async () => {
      throw new Error('provider down');
    };
    const out = await finalizePlan(draft, { finalize: true }, { call });
    expect(out).toBe(draft);
  });
});

// ── D-7: executeSlice — 编译好的 slice 直执 (跳过 conductor) ──────────────────────
describe('executeSlice (D-7)', () => {
  const LEAF = 'deepseek:deepseek-v4-flash';

  /** 两票小地图 (t1 → t2), 经 slice-compiler 编成 ConductorPlan。 */
  function compiledPlan(): ConductorPlan {
    const map: PathMap = {
      destination: 'demo 目的地',
      slug: 'demo',
      tickets: [
        { id: 't1', type: 'task', title: 'do t1', blockedBy: [], status: 'ruled', ruling: 'implement t1', executorKind: 'inproc' },
        { id: 't2', type: 'task', title: 'do t2', blockedBy: ['t1'], status: 'ruled', ruling: 'implement t2', executorKind: 'inproc' },
      ],
      decisionsLog: [],
    };
    return compileSlice(map, ['t1', 't2']);
  }

  test('编译 slice → 端到端执行 (fake leaf runner), 全 done + 留痕, conductor 从未被调用', async () => {
    const plan = compiledPlan();
    const calls: { model: string }[] = [];
    const gen: GenerateFn = async ({ model }) => {
      calls.push({ model });
      return { text: 'leaf done', usage: { in: 1, out: 1 } };
    };
    const recorded: { question?: string }[] = [];
    const res = await executeSlice(plan, {
      conductorModel: 'fake:conductor',
      leafModel: LEAF,
      generate: gen,
      recorder: { record: (_r, meta) => (recorded.push({ question: meta?.question }), 'run-1') },
    });

    // 两节点全 done, fan-in 边保留 (t2 dep t1)。
    expect(Object.keys(res.results).sort()).toEqual(['t1', 't2']);
    expect(Object.values(res.results).every((r) => r.status === 'done')).toBe(true);
    // conductor 模型**从未**被调用 (预构造 plan 直执, 无重分解)。
    expect(calls.every((c) => c.model === LEAF)).toBe(true);
    expect(calls.filter((c) => c.model === 'fake:conductor').length).toBe(0);
    // 留痕经 onComplete → recorder.record。
    expect(recorded.length).toBe(1);
    expect(recorded[0]!.question).toContain('executeSlice');
  });

  test('注入 runDagWithPlan + finalize=OFF → 传入的正是编译 plan (未经 conductor)', async () => {
    const plan = compiledPlan();
    const captured: { plan?: ConductorPlan } = {};
    const res = await executeSlice(
      plan,
      { leafModel: LEAF },
      {
        runDagWithPlan: async (p) => {
          captured.plan = p;
          return { plan: p, sessionId: 's', levels: [], results: {}, usage: { conductor: { in: 0, out: 0 }, leavesIn: 0, leavesOut: 0, leavesCacheHit: 0 } } as ExecutorDagResult;
        },
      },
    );
    expect(captured.plan).toBe(plan); // finalize OFF → draft 直传
    expect(res.plan.name).toContain('pathfinder-slice');
  });

  test('finalize ON → executeSlice 先定稿再执行 (定稿 plan 进 runDag)', async () => {
    const plan = compiledPlan();
    const finalized: ConductorPlan = { name: 'finalized-slice', nodes: { t1: { agent: 'x', goal: 'refined' } } };
    let seenName = '';
    const res = await executeSlice(
      plan,
      { leafModel: LEAF, finalize: true },
      {
        finalizePlan: async () => finalized,
        runDagWithPlan: async (p) => {
          seenName = p.name;
          return { plan: p, sessionId: 's', levels: [], results: {}, usage: { conductor: { in: 0, out: 0 }, leavesIn: 0, leavesOut: 0, leavesCacheHit: 0 } } as ExecutorDagResult;
        },
      },
    );
    expect(seenName).toBe('finalized-slice');
    expect(res.plan.name).toBe('finalized-slice');
  });
});
