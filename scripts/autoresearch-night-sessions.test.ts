/**
 * autoresearch-night-sessions.test —— 串行编排与「无卡不是失败」(契约 D-4 / INV-4 / GWT-4)。
 *
 * 两条执行路全部注入替身: 本文件零 LLM、零子进程、零磁盘语料。测的是**编排**本身 ——
 * 顺序 / 夜帽 / 单卡塌不带走整批 / 曲线怎么从代记录里取。
 *
 * 反向自检 (改一处再跑本文件, 应当转红) —— 读数见文末注释。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AggregatedFitness } from '../src/eval/replay/fitness';
import type { CodeCard, EvolveCard, SessionCard } from '../src/eval/replay/session-card';
import { freezeCorpus, writeManifest, type CorpusItem } from '../src/eval/replay/corpus';
import { VARIANT_VERSION } from '../src/eval/replay/variant';
import type { LiveProviderContext } from './autoresearch-replay';
import type { GenerationRecord } from './autoresearch-session';
import {
  NIGHT_BUDGET_STOP,
  NO_CARDS_REASON,
  curveOf,
  parseSessionsArgs,
  parseSolveResult,
  solveBranchName,
  readAcceptedCards,
  runCards,
  type CardResult,
  type SessionsDeps,
  type SessionsOpts,
} from './autoresearch-night-sessions';

const ROOT = join(import.meta.dir, '..');

const OPTS: SessionsOpts = {
  cwd: ROOT,
  manifestPath: 'runs/autoresearch/corpus/manifest.json',
  nightDir: '/tmp/omd-night-test',
  nightBudgetMinutes: 480,
};

function evolveCard(id: string, over: Partial<EvolveCard> = {}): EvolveCard {
  return {
    version: 1,
    id,
    substrate: 'S1',
    mainObjective: 'speedupTheoreticalMedian',
    objectiveRow: 'O3a',
    hypothesis: 'h',
    evidenceRefs: ['readout:speedup-null'],
    successSignal: 's',
    voidConditions: [],
    budgetMinutes: 60,
    K: 2,
    maxGenerations: 3,
    topM: 1,
    ...over,
  };
}

function codeCard(id: string): CodeCard {
  return {
    version: 1,
    id,
    substrate: 'S3',
    mainObjective: 'planValidityRate',
    objectiveRow: 'O3b',
    hypothesis: 'h',
    evidenceRefs: ['failed-runs:not-converged'],
    successSignal: 's',
    voidConditions: [],
    budgetMinutes: 90,
    goal: 'g',
    writeSet: ['src/harness/x.ts'],
    verify: 'bun test',
  };
}

function stubResult(card: SessionCard): Omit<CardResult, 'wallMs'> {
  return {
    cardId: card.id,
    substrate: card.substrate,
    mainObjective: card.mainObjective,
    stopReason: 'maxGenerations',
    winnerIds: ['w1'],
    curve: [],
  };
}

describe('runCards 编排 (D-4)', () => {
  test('GWT-4: 零卡 → { cards: [], reason: no-cards }, 不跑任何执行路', async () => {
    let called = 0;
    const deps: SessionsDeps = {
      runEvolve: async (c) => {
        called += 1;
        return stubResult(c);
      },
    };
    const r = await runCards([], OPTS, deps);
    expect(r).toEqual({ cards: [], reason: NO_CARDS_REASON });
    expect(called).toBe(0);
  });

  test('按卡序串行, 不并行 (进入顺序 = 卡序)', async () => {
    const order: string[] = [];
    const deps: SessionsDeps = {
      runEvolve: async (c) => {
        order.push(`in:${c.id}`);
        await new Promise((res) => setTimeout(res, 1));
        order.push(`out:${c.id}`);
        return stubResult(c);
      },
    };
    await runCards([evolveCard('a'), evolveCard('b')], OPTS, deps);
    // 并行的话 in:b 会插在 out:a 之前
    expect(order).toEqual(['in:a', 'out:a', 'in:b', 'out:b']);
  });

  test('S3 走 runCode, S1/S2 走 runEvolve (分派按基质, 不按顺序)', async () => {
    const seen: string[] = [];
    const deps: SessionsDeps = {
      runEvolve: async (c) => {
        seen.push(`evolve:${c.id}`);
        return stubResult(c);
      },
      runCode: async (c) => {
        seen.push(`code:${c.id}`);
        return stubResult(c);
      },
    };
    await runCards([codeCard('s3'), evolveCard('s1')], OPTS, deps);
    expect(seen).toEqual(['code:s3', 'evolve:s1']);
  });

  test('单卡塌不带走整批: 错误进 error 列, 后面的卡照跑', async () => {
    const deps: SessionsDeps = {
      runEvolve: async (c) => {
        if (c.id === 'boom') throw new Error('变异 provider 断供');
        return stubResult(c);
      },
    };
    const r = await runCards([evolveCard('boom'), evolveCard('ok')], OPTS, deps);
    expect(r.cards).toHaveLength(2);
    expect(r.cards[0]!.stopReason).toBe('error');
    expect(r.cards[0]!.error).toContain('变异 provider 断供');
    expect(r.cards[1]!.stopReason).toBe('maxGenerations');
  });

  test('夜帽用尽: 没轮到的卡记 night-budget, 与「跑了没成」分开', async () => {
    let t = 0;
    const deps: SessionsDeps = {
      // 每次读表推进 10 分钟 —— 第二张卡起跑时已过 15 分钟夜帽
      now: () => (t += 10 * 60_000),
      runEvolve: async (c) => stubResult(c),
    };
    const r = await runCards([evolveCard('a'), evolveCard('b')], { ...OPTS, nightBudgetMinutes: 15 }, deps);
    expect(r.cards[0]!.stopReason).toBe('maxGenerations');
    expect(r.cards[1]!.stopReason).toBe(NIGHT_BUDGET_STOP);
    expect(r.cards[1]!.error).toBeUndefined(); // 没轮到 ≠ 出错
  });

  test('wallMs 逐卡记 (夜链读数的其中一项)', async () => {
    let t = 0;
    const deps: SessionsDeps = {
      now: () => (t += 1000),
      runEvolve: async (c) => stubResult(c),
    };
    const r = await runCards([evolveCard('a')], OPTS, deps);
    expect(r.cards[0]!.wallMs).toBeGreaterThan(0);
  });
});

// ── 曲线 ──────────────────────────────────────────────────────────────────

function agg(over: Partial<AggregatedFitness>): AggregatedFitness {
  return {
    planValidityRate: 1,
    fakeSerialPairsTotal: 0,
    speedupTheoreticalMedian: null,
    speedupCostBasis: null,
    shapeDeclarationRate: 0,
    planningTokensTotal: 100,
    n: 3,
    ...over,
  };
}

function genRec(
  genIdx: number,
  fitnessByChild: Record<string, AggregatedFitness>,
  winnerIds: string[],
): GenerationRecord {
  const byChild: GenerationRecord['fitnessByChild'] = {};
  for (const [k, v] of Object.entries(fitnessByChild)) byChild[k] = { screen: v, main: v };
  return {
    genIdx,
    parentVariantNames: [],
    childVariantNames: Object.keys(fitnessByChild),
    fitnessByChild: byChild,
    frontIds: winnerIds,
    frontFitnessSignature: `sig-${genIdx}`,
    winnerIds,
    stopReason: 'running',
  };
}

describe('curveOf', () => {
  test('逐代取赢家的主目标与 validity', () => {
    const gens = [
      genRec(0, { baseline: agg({ speedupTheoreticalMedian: 1.2, planValidityRate: 0.8 }) }, ['baseline']),
      genRec(1, { 'c1': agg({ speedupTheoreticalMedian: 1.9, planValidityRate: 0.9 }) }, ['c1']),
    ];
    expect(curveOf(gens, 'speedupTheoreticalMedian')).toEqual([
      { gen: 0, main: 1.2, validity: 0.8 },
      { gen: 1, main: 1.9, validity: 0.9 },
    ]);
  });

  test('赢家是 baseline 而本代 fitnessByChild 不含它 → 从第 0 代解析得到 (不记 null)', () => {
    // session.ts 的 gen>=1 只把子代写进 fitnessByChild, baseline 只在 gen 0 被评估过。
    const gens = [
      genRec(0, { baseline: agg({ speedupTheoreticalMedian: 2.0, planValidityRate: 0.7 }) }, ['baseline']),
      genRec(1, { 'c1': agg({ speedupTheoreticalMedian: 0.5 }) }, ['baseline']),
    ];
    const c = curveOf(gens, 'speedupTheoreticalMedian');
    expect(c[1]).toEqual({ gen: 1, main: 2.0, validity: 0.7 });
  });

  test('主尺缺席原样记 null, 不补 0 (NULL ≠ 0)', () => {
    const gens = [genRec(0, { baseline: agg({ speedupTheoreticalMedian: null }) }, ['baseline'])];
    expect(curveOf(gens, 'speedupTheoreticalMedian')[0]!.main).toBeNull();
  });

  test('赢家 fitness 解析不到 → 两维都 null (不编数)', () => {
    const gens = [genRec(0, {}, ['ghost'])];
    expect(curveOf(gens, 'speedupTheoreticalMedian')[0]).toEqual({
      gen: 0,
      main: null,
      validity: null,
    });
  });
});

// ── 解析件 ────────────────────────────────────────────────────────────────

describe('parseSolveResult / readAcceptedCards / parseSessionsArgs', () => {
  test('solve result-out 首两行取 outcome + runId (真机形状)', () => {
    const text = 'outcome: not-converged\nrunId: e958cbe8-8059-4445-9b68-c9f5ea92bb69\n\ngoal: …';
    expect(parseSolveResult(text)).toEqual({
      outcome: 'not-converged',
      runId: 'e958cbe8-8059-4445-9b68-c9f5ea92bb69',
    });
  });

  test('头部 criterion / expectExit 两行解析成结构 (晋升闸判据虚探针的输入); 缺一行即缺席', () => {
    const text = 'outcome: success\nrunId: r1\nacceptance: executable\ncriterion: bun test tests/x.test.ts\nexpectExit: 0\n\ngoal: …';
    expect(parseSolveResult(text)).toEqual({ outcome: 'success', runId: 'r1', criterion: { command: 'bun test tests/x.test.ts', expectExit: 0 } });
    expect(parseSolveResult('outcome: success\nrunId: r1\ncriterion: bun test\n').criterion).toBeUndefined();
  });

  test('Q1④ 分支名从 runId 派生 = 引擎 prepareRunWorktree 的真名, 不再是 night/<cardId>', () => {
    expect(solveBranchName('e958cbe8')).toBe('omd/run/e958cbe8');
  });

  test('认不出 outcome → unclassified (不猜成 success)', () => {
    expect(parseSolveResult('乱七八糟').outcome).toBe('unclassified');
  });

  test('cards.json 缺席 → 空数组 (下游记 no-cards, 不抛)', () => {
    expect(readAcceptedCards('/nowhere/cards.json')).toEqual([]);
  });

  test('参数: cards 路径与 --out 都必填', () => {
    expect(() => parseSessionsArgs(['--out', 'x'])).toThrow('cards.json');
    expect(() => parseSessionsArgs(['c.json'])).toThrow('--out');
  });
});

describe('CLI (GWT-4 端到端: accepted 为空仍写出 results.json 并退 0)', () => {
  test('空 accepted 真跑一遍', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'omd-sessions-'));
    const cards = join(tmp, 'cards.json');
    const out = join(tmp, 'results.json');
    Bun.write(cards, JSON.stringify({ accepted: [], rejected: [] }));
    const r = spawnSync(
      'bun',
      [join(ROOT, 'scripts', 'autoresearch-night-sessions.ts'), cards, '--out', out],
      { cwd: ROOT, encoding: 'utf8', timeout: 120_000 },
    );
    expect(r.status).toBe(0);
    expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual({ cards: [], reason: NO_CARDS_REASON });
  });
});

// ── 缺口 1: S1/S2 真 live 接线 ────────────────────────────────────────────

/** 冻结语料的座位签名 —— live provider 与变异算子都必须拿到这一套, 不许各自另找。 */
const LIVE_SEATS: Record<string, string> = {
  conductor: 'minimax-cn:MiniMax-M3',
  worker: 'minimax-cn:MiniMax-M3',
  verifier: 'openai-codex:gpt-5.6-sol',
};

/** 写一份最小冻结语料 (screen 1 / main 1 / heldout 1), 返回可直接喂 runCards 的 opts。 */
function makeLiveFixture(): { root: string; opts: SessionsOpts } {
  const root = mkdtempSync(join(tmpdir(), 'omd-night-live-'));
  const items: CorpusItem[] = [0, 1, 2].map((i) => ({
    id: `item-${i}`,
    prompt: `synthetic prompt ${i}`,
    srcRunId: `run-${i}`,
  }));
  const manifest = freezeCorpus(items, { seats: LIVE_SEATS, targetCounts: [1, 1, 1] });
  writeManifest(join(root, 'manifest.json'), manifest);
  return {
    root,
    opts: {
      cwd: root,
      manifestPath: 'manifest.json',
      nightDir: join(root, 'night'),
      nightBudgetMinutes: 480,
    },
  };
}

describe('S1/S2 默认执行路真接 live (缺口 1)', () => {
  test('LIVE_SESSION_WIRED: 评估吃的是 liveProvider 的文本, 不是 stub 的 canned plan', async () => {
    const { opts } = makeLiveFixture();
    const seen: LiveProviderContext[] = [];
    const deps: SessionsDeps = {
      // 返一段不可解析为 plan 的文本 —— stub 的四个桶全都 parsePlan 通过 (validity=1),
      // 所以「validity 读作 0」= 评估真吃了 live 文本。反向自检见文末。
      liveProvider: async (_id, _prompt, ctx) => {
        seen.push(ctx);
        return 'NOT-A-PLAN';
      },
    };
    const r = await runCards([evolveCard('live-1', { K: 1, maxGenerations: 1 })], opts, deps);

    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(r.cards[0]!.error).toBeUndefined();
    expect(r.cards[0]!.curve[0]!.validity).toBe(0);
    // 座位取冻结 manifest, 不取 config 现值 (C-4 同源)。
    expect(seen[0]!.seats).toEqual(LIVE_SEATS);
    // variant 目录必须指向本夜目录 —— 指错了, 子代 spec 读不回来, 进化静默退化成基线复读。
    expect(seen[0]!.variantDir).toBe(join(opts.nightDir, 'variants'));
    expect(seen[0]!.variant).toBe('baseline');
  });

  test('MUTATION_SEATS_WIRED: manifest.seats 送进 MutationContext (缺 seats 时默认算子 fail-closed)', async () => {
    const { opts } = makeLiveFixture();
    const seatsSeen: (Record<string, string> | undefined)[] = [];
    const deps: SessionsDeps = {
      liveProvider: async () => 'NOT-A-PLAN',
      mutationProvider: async (_prompt, ctx) => {
        seatsSeen.push(ctx.seats);
        return JSON.stringify({
          version: VARIANT_VERSION,
          name: 'child',
          extraAppend: ['fake mutation'],
        });
      },
    };
    const r = await runCards([evolveCard('live-2', { K: 1, maxGenerations: 2 })], opts, deps);

    expect(r.cards[0]!.error).toBeUndefined();
    expect(seatsSeen.length).toBeGreaterThanOrEqual(1);
    expect(seatsSeen[0]).toEqual(LIVE_SEATS);
  });
});

/**
 * 反向自检 —— **真跑读数** (改一处, 跑本文件 + autoresearch-promote.test.ts 共 32 条):
 *  · `runCards` 开头的零卡短路删掉              → 2 fail (GWT-4 两条: reason 缺席)
 *  · `startedAt >= deadline` 判删掉             → 1 fail (夜帽用尽那条)
 *  · `curveOf` 的 `known` 累积表改成只查本代    → 1 fail (赢家是 baseline 那条)
 *  · `curveOf` 的 `?? null` 改成 `?? 0`         → 1 fail (NULL ≠ 0 那条)
 *  · 分派改成全走 `runEvolve`                   → 1 fail (按基质分派那条)
 *  · `defaultRunEvolve` 不传 `rawTextProvider` (退回 stub) → 1 fail
 *    (LIVE_SESSION_WIRED: liveProvider 计数 0 且 validity 读回 1)
 *  · `defaultRunEvolve` 不传 `seats`             → 1 fail (MUTATION_SEATS_WIRED: ctx.seats undefined)
 *  · `LiveProviderContext.variantDir` 不传       → 1 fail (variantDir 指回仓库默认目录)
 *
 * ⚠ 证伪脚本自己也要 fail-closed: 把分派条件**反过来** (而不是全路由到 runEvolve) 会让 S1 卡
 *   落进 `defaultRunCode`, 于是真起一个 solve 子进程 —— 实测把整个证伪跑挂住。改法要挑
 *   「不会退到真运行器」的那种。
 */
