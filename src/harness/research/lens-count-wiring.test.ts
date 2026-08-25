/**
 * lensCount 旋钮保真 (A1) 的接线闸:
 * 节点 `research.lensCount` 经 conductor plan 的 zod 解析, 经 engine 的 research 调用 →
 * ResearchLeafRunner input → `researchWebFanout` 的 `opts.lensCount` 全链路透传。
 *
 * ## 反向自检 (逐条写在各测试注释)
 *
 * · 删 schema 里的 lensCount → 解析绿了 → schema-accept 测试红;
 *   放宽到 1..max → 边界 9 通过解析 → schema-reject 测试红。
 * · 删 engine.ts 那行 `...(node.research?.lensCount !== undefined ? { lensCount } : {})` →
 *   runner 收到的 input 没有 lensCount → wiring-accept 测试红。
 * · 删 assemble.ts 那行 `...(input.lensCount !== undefined ? { lensCount } : {})` →
 *   _webFanout 桩收到的 opts 没有 lensCount → wiring-fullchain 测试红。
 *
 * ## 测试结构
 *
 * ① **schema 闸**: PlanSchema 接受 1..6, 拒绝 0/7/9/字符串/缺数。纯数据, 无 env 依赖。
 * ② **wiring 闸**: 经 `createDefaultResearchRunner` 的 `_webFanout` 注入口验证 lensCount
 *    透传到 `WebFanoutOpts.lensCount`。env 必须配齐座位 (同 mcp-research-node.test.ts 的契约)。
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlanSchema } from '../conductor-plan';
import { createDefaultResearchRunner } from '../../mcp/assemble';

// ── 装配点要解 conductor / lens / reason / expand / distill 座位, 缺一即 throw (INV-MODEL-5)。
//   `createModelQueryExpander({})` 与 `createModelSourceDistiller({})` 读 process.env, 不接受
//   注入 env (装配点的 env 字段只供 resolveRoleModelConfigured 自己用) —— 所以这里改 process.env,
//   afterAll 复原。同 mcp-research-node.test.ts 的预存环境假设 (那套测试在没配齐 env 的 env 也挂)。
const FAKE_SEATS: Record<string, string> = {
  OMD_CONDUCTOR_MODEL: 'fake:conductor',
  OMD_LENS_MODEL: 'fake:lens',
  OMD_REASON_MODEL: 'fake:reason',
  OMD_FUSION_MODEL: 'fake:fusion',
  OMD_GRAFT_MODEL: 'fake:graft',
  OMD_REDUCE_MODEL: 'fake:reduce',
  OMD_JUDGE_MODEL: 'fake:judge',
  OMD_EXPAND_MODEL: 'fake:expand',
  OMD_DISTILL_MODEL: 'fake:distill',
  OMD_ADVISOR_MODEL: 'fake:advisor',
};
const SAVED: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const [k, v] of Object.entries(FAKE_SEATS)) {
    SAVED[k] = process.env[k];
    process.env[k] = v;
  }
});
afterAll(() => {
  for (const [k, v] of Object.entries(SAVED)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

// ── schema 闸 ──────────────────────────────────────────────────────────────

describe('PlanSchema: research.lensCount 边界 (A1)', () => {
  const baseNode = {
    goal: 'g',
    executor: 'research' as const,
  };
  const wrap = (research: unknown) =>
    PlanSchema.safeParse({
      name: 'p',
      nodes: { n1: { ...baseNode, research } },
    });

  test('★ lensCount 4 通过解析 (GWT-5 happy path)', () => {
    const r = wrap({ lensCount: 4 });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.nodes.n1!.research!.lensCount).toBe(4);
  });

  test('★ lensCount 9 被 zod 拒 (GWT-5 越界)', () => {
    const r = wrap({ lensCount: 9 });
    expect(r.success).toBe(false);
    // 错误路径必须落在 research.lensCount (而非别的字段) — 便于 caller 定位。
    const paths = r.success ? [] : r.error.issues.map((i) => i.path.join('.'));
    expect(paths.some((p) => p.includes('lensCount'))).toBe(true);
  });

  test('边界 1 与 6 通过 (1..6 inclusive)', () => {
    expect(wrap({ lensCount: 1 }).success).toBe(true);
    expect(wrap({ lensCount: 6 }).success).toBe(true);
  });

  test('边界外 0 与 7 被拒', () => {
    expect(wrap({ lensCount: 0 }).success).toBe(false);
    expect(wrap({ lensCount: 7 }).success).toBe(false);
  });

  test('非整数与非数被拒 (zod int 校验)', () => {
    expect(wrap({ lensCount: 1.5 }).success).toBe(false);
    expect(wrap({ lensCount: '4' }).success).toBe(false);
    expect(wrap({ lensCount: null }).success).toBe(false);
  });

  test('省略 lensCount 通过 (零回归 — 存量 plan 不写 lensCount 仍可解析)', () => {
    expect(wrap({ rounds: 2 }).success).toBe(true);
    expect(wrap({}).success).toBe(true);
  });

  test('k 与 lensCount 同存互不干扰 (A1 修法: 不改 k 接线, 只加新旋钮)', () => {
    const r = wrap({ k: 8, lensCount: 3, rounds: 2 });
    expect(r.success).toBe(true);
    if (r.success) {
      const rd = r.data.nodes.n1!.research!;
      expect(rd.k).toBe(8);
      expect(rd.lensCount).toBe(3);
      expect(rd.rounds).toBe(2);
    }
  });
});

// ── wiring 闸 ──────────────────────────────────────────────────────────────

/** 装配点要解座位, 缺一即 throw (INV-MODEL-5)。`resolveRoleModelConfigured` 读的是**传入** env
 *  (assemble.ts:226-228 用的是 deps.env 而非 process.env), 所以座位模型必须进 testEnv。
 *  `createModelQueryExpander` / `createModelSourceDistiller` 又只读 process.env (它们没接 env 字段),
 *  所以**同一组座位 env 也要写到 process.env** (beforeAll) —— 两边都覆盖, 装配点才能跑通。
 */
const testEnv = {
  TAVILY_API_KEY: 'x',
  ...FAKE_SEATS,
} as unknown as NodeJS.ProcessEnv;

const fakeStack = (() => ({ searchPool: {}, fetchProviders: [], cleaner: {}, quota: {} })) as never;

/** _webFanout 桩返一份最小可用结果: 不读 corpus, 只要 sources 非空就过 INV-GOAL-2。*/
const fakeWebResult = () =>
  ({
    question: 'q',
    retrieval: { sources: [{ url: 'https://x.test/a', body: 'body' }], markdown: 'm' },
    seedRetrievals: [],
    fanout: {
      final: 'f',
      lensChampions: [],
      synthCandidates: [],
      judgeCritiques: [],
      fusionAnalysis: '',
      leafCount: 1,
      roundsRun: 1,
      secondPass: [],
      costStats: {
        totalUsd: 0,
        totalSavingsUsd: 0,
        perModel: { 'fake:lens': { calls: 1, in: 1, out: 1, cacheHit: 0, cacheHitRate: 0, costUsd: 0 } },
      },
    },
  }) as never;

describe('lensCount 全链路透传 (engine → ResearchLeafRunner → WebFanoutOpts.lensCount)', () => {
  test('★ GWT-5 happy path: runner 收到 lensCount=4 时, _webFanout 桩的 opts.lensCount === 4', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-lens-count-'));
    let captured: { lensCount?: number } = {};
    const runner = createDefaultResearchRunner({
      cwd,
      env: testEnv,
      _webStack: fakeStack,
      _webFanout: (async (_s: unknown, _q: string, o: typeof captured) => {
        captured = o;
        return fakeWebResult();
      }) as never,
    });
    // env 配齐了 → runner 不为 undefined; 若 undefined 说明座位解析挂了, 此测试前提不成立。
    expect(runner).toBeDefined();
    await runner!({ question: 'q', lensCount: 4 });
    expect(captured.lensCount).toBe(4);
  });

  test('★ 边界: lensCount=1 与 lensCount=6 都透传 (1..6 inclusive)', async () => {
    for (const v of [1, 6]) {
      const cwd = mkdtempSync(join(tmpdir(), 'omd-lens-count-'));
      let captured: { lensCount?: number } = {};
      const runner = createDefaultResearchRunner({
        cwd,
        env: testEnv,
        _webStack: fakeStack,
        _webFanout: (async (_s: unknown, _q: string, o: typeof captured) => {
          captured = o;
          return fakeWebResult();
        }) as never,
      });
      expect(runner).toBeDefined();
      await runner!({ question: 'q', lensCount: v });
      expect(captured.lensCount).toBe(v);
    }
  });

  test('INV-5 缺省路径: 省略 lensCount 时 opts.lensCount 仍是 undefined (零回归)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-lens-count-'));
    let captured: { lensCount?: number } = {};
    const runner = createDefaultResearchRunner({
      cwd,
      env: testEnv,
      _webStack: fakeStack,
      _webFanout: (async (_s: unknown, _q: string, o: typeof captured) => {
        captured = o;
        return fakeWebResult();
      }) as never,
    });
    expect(runner).toBeDefined();
    await runner!({ question: 'q' });
    expect(captured.lensCount).toBeUndefined();
  });

  test('k 与 lensCount 共存时分别透传, 不互串 (A1: k 接线零变化)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-lens-count-'));
    let captured: { k?: number; lensCount?: number } = {};
    const runner = createDefaultResearchRunner({
      cwd,
      env: testEnv,
      _webStack: fakeStack,
      _webFanout: (async (_s: unknown, _q: string, o: typeof captured) => {
        captured = o;
        return fakeWebResult();
      }) as never,
    });
    expect(runner).toBeDefined();
    await runner!({ question: 'q', k: 8, lensCount: 3 });
    expect(captured.k).toBe(8);
    expect(captured.lensCount).toBe(3);
  });
});
