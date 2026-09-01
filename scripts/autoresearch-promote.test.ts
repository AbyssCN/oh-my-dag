/**
 * autoresearch-promote.test —— 晋升闸三格判词 (契约 INV-5 / GWT-5a·5b·5c)。
 *
 * held-out 回放与护栏两件都注入替身: 本文件零 LLM 零子进程。测的是**判词**本身。
 *
 * 「两侧都写」在这里是硬要求: 每一格都配一条正例与一条反例 —— 只测 promoted 的闸和
 * 只测 held 的闸一样没有判别力。反向自检读数见文末。
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AggregatedFitness } from '../src/eval/replay/fitness';
import type { CardResult, SessionsRunResult } from './autoresearch-night-sessions';
import {
  FITNESS_DIRECTIONS,
  SOLVE_DELIVERED_OUTCOMES,
  notWorse,
  parsePromoteArgs,
  promote,
  type PromoteDeps,
  type PromoteOpts,
} from './autoresearch-promote';

const OPTS: PromoteOpts = {
  cwd: '/tmp',
  date: '2026-09-02',
  manifestPath: 'runs/autoresearch/corpus/manifest.json',
};

function agg(over: Partial<AggregatedFitness> = {}): AggregatedFitness {
  return {
    planValidityRate: 0.8,
    fakeSerialPairsTotal: 4,
    speedupTheoreticalMedian: 1.5,
    speedupCostBasis: 'unit',
    shapeDeclarationRate: 0.2,
    planningTokensTotal: 1000,
    n: 10,
    ...over,
  };
}

function evolveResult(over: Partial<CardResult> = {}): CardResult {
  return {
    cardId: 'card-1',
    substrate: 'S1',
    mainObjective: 'speedupTheoreticalMedian',
    stopReason: 'maxGenerations',
    winnerIds: ['baseline-g1-c0'],
    curve: [],
    wallMs: 1000,
    ...over,
  };
}

function codeResult(over: Partial<CardResult> = {}): CardResult {
  return {
    cardId: 'card-s3',
    substrate: 'S3',
    mainObjective: 'planValidityRate',
    stopReason: 'success',
    winnerIds: [],
    curve: [],
    wallMs: 2000,
    branch: 'night/card-s3',
    ...over,
  };
}

/** 注入: baseline / winner 各给一份读数, 护栏默认绿, artifact 写进 tmpdir。 */
function deps(
  baseline: AggregatedFitness,
  winner: AggregatedFitness,
  guardOk = true,
): PromoteDeps & { artifacts: string[] } {
  const artifacts: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'omd-promote-'));
  return {
    artifacts,
    evaluateHeldout: async (variant) => (variant === 'baseline' ? baseline : winner),
    runGuardrails: () => (guardOk ? { ok: true, detail: 'tsc 0' } : { ok: false, detail: 'tsc 退出 2' }),
    writeArtifact: (variant, _o, cardId) => {
      const p = join(dir, `${cardId}.json`);
      Bun.write(p, JSON.stringify({ variant }));
      artifacts.push(p);
      return p;
    },
  };
}

describe('notWorse (方向表)', () => {
  test('五维方向与 session 的目标集逐条同', () => {
    expect(FITNESS_DIRECTIONS).toEqual({
      planValidityRate: 'maximize',
      fakeSerialPairsTotal: 'minimize',
      speedupTheoreticalMedian: 'maximize',
      shapeDeclarationRate: 'maximize',
      planningTokensTotal: 'minimize',
    });
  });

  test('maximize 维: 升与持平算不降, 降不算', () => {
    const b = agg({ speedupTheoreticalMedian: 1.5 });
    expect(notWorse('speedupTheoreticalMedian', agg({ speedupTheoreticalMedian: 1.6 }), b)).toBe(true);
    expect(notWorse('speedupTheoreticalMedian', agg({ speedupTheoreticalMedian: 1.5 }), b)).toBe(true);
    expect(notWorse('speedupTheoreticalMedian', agg({ speedupTheoreticalMedian: 1.4 }), b)).toBe(false);
  });

  test('minimize 维: 降算不降 (方向反过来), 升不算', () => {
    const b = agg({ planningTokensTotal: 1000 });
    expect(notWorse('planningTokensTotal', agg({ planningTokensTotal: 900 }), b)).toBe(true);
    expect(notWorse('planningTokensTotal', agg({ planningTokensTotal: 1100 }), b)).toBe(false);
  });

  test('null 投影成该维最坏值 (fail-closed: 读不到不算赢)', () => {
    const b = agg({ speedupTheoreticalMedian: 1.5 });
    expect(notWorse('speedupTheoreticalMedian', agg({ speedupTheoreticalMedian: null }), b)).toBe(false);
    // 反面: baseline 也读不到时, winner 读不到算持平 (两边同尺, 不是「赢了」)
    expect(
      notWorse(
        'speedupTheoreticalMedian',
        agg({ speedupTheoreticalMedian: null }),
        agg({ speedupTheoreticalMedian: null }),
      ),
    ).toBe(true);
  });

  test('最坏值是 -Inf 而不是 0 —— baseline 恰为 0 时两种投影判词相反', () => {
    // 这条用例是**证伪试出来的**: 上一条在 baseline=1.5 时, `null → 0` 与 `null → -Inf`
    // 判词相同 (0 与 -Inf 都 < 1.5), 于是把 project 改成 `return 0` 竟然 0 fail。
    // baseline=0 是两种投影**唯一**分得开的那一格: -Inf >= 0 为假 (fail-closed 该有的判词),
    // 0 >= 0 为真 (把「读不到」判成了「持平」)。留着它, 这道闸才有判别力。
    const b = agg({ speedupTheoreticalMedian: 0 });
    expect(notWorse('speedupTheoreticalMedian', agg({ speedupTheoreticalMedian: null }), b)).toBe(false);
  });
});

describe('promote 三格判词', () => {
  test('GWT-5b: winner 两维都不降 → promoted, artifact 文件存在', async () => {
    const d = deps(
      agg({ speedupTheoreticalMedian: 1.5, planValidityRate: 0.8 }),
      agg({ speedupTheoreticalMedian: 1.9, planValidityRate: 0.85 }),
    );
    const r = await promote({ cards: [evolveResult()] }, OPTS, d);
    expect(r.verdicts[0]!.verdict).toBe('promoted');
    expect(r.verdicts[0]!.artifact).toBeDefined();
    expect(existsSync(r.verdicts[0]!.artifact!)).toBe(true);
    // 晋升那一侧也把两份读数留下 —— 事后要能复核判的是哪一对数
    expect(r.verdicts[0]!.heldout?.baseline.speedupTheoreticalMedian).toBe(1.5);
    expect(r.verdicts[0]!.heldout?.winner.speedupTheoreticalMedian).toBe(1.9);
  });

  test('GWT-5a: 主目标降 → held, reason 含 heldout, 两份读数都在', async () => {
    const d = deps(
      agg({ speedupTheoreticalMedian: 2.0 }),
      agg({ speedupTheoreticalMedian: 1.1 }),
    );
    const r = await promote({ cards: [evolveResult()] }, OPTS, d);
    const v = r.verdicts[0]!;
    expect(v.verdict).toBe('held');
    expect(v.reason).toContain('heldout');
    expect(v.reason).toContain('speedupTheoreticalMedian');
    expect(v.heldout!.baseline.speedupTheoreticalMedian).toBe(2.0);
    expect(v.heldout!.winner.speedupTheoreticalMedian).toBe(1.1);
    expect(d.artifacts).toHaveLength(0); // held 不写产物
  });

  test('validity 降而主目标升 → 仍然 held (两维都要不降, 不是只看主尺)', async () => {
    const d = deps(
      agg({ speedupTheoreticalMedian: 1.0, planValidityRate: 0.9 }),
      agg({ speedupTheoreticalMedian: 3.0, planValidityRate: 0.4 }),
    );
    const v = (await promote({ cards: [evolveResult()] }, OPTS, d)).verdicts[0]!;
    expect(v.verdict).toBe('held');
    expect(v.reason).toContain('planValidityRate');
  });

  test('两维都不降但护栏红 → held, reason 说是护栏不是 heldout', async () => {
    const d = deps(agg(), agg({ speedupTheoreticalMedian: 2.0 }), false);
    const v = (await promote({ cards: [evolveResult()] }, OPTS, d)).verdicts[0]!;
    expect(v.verdict).toBe('held');
    expect(v.reason).toContain('护栏红');
    expect(d.artifacts).toHaveLength(0);
  });

  test('GWT-5c: winnerIds = [baseline] → skipped (没有可晋升的东西)', async () => {
    const d = deps(agg(), agg());
    const v = (await promote({ cards: [evolveResult({ winnerIds: ['baseline'] })] }, OPTS, d))
      .verdicts[0]!;
    expect(v.verdict).toBe('skipped');
    expect(v.heldout).toBeUndefined(); // 没判过就不该有读数 (NULL ≠ 0)
  });

  test('session 出错 → skipped, 判词带回错误原文', async () => {
    const d = deps(agg(), agg());
    const v = (await promote({ cards: [evolveResult({ error: '变异 provider 断供' })] }, OPTS, d))
      .verdicts[0]!;
    expect(v.verdict).toBe('skipped');
    expect(v.reason).toContain('变异 provider 断供');
  });

  test('held-out 回放自身抛 → skipped 而不是整夜炸掉', async () => {
    const r = await promote({ cards: [evolveResult()] }, OPTS, {
      evaluateHeldout: () => {
        throw new Error('语料 hash 对不上');
      },
    });
    expect(r.verdicts[0]!.verdict).toBe('skipped');
    expect(r.verdicts[0]!.reason).toContain('语料 hash 对不上');
  });
});

describe('promote S3 卡 (无 held-out 可量, 判 solve 终态)', () => {
  test('交付词表内 → promoted, artifact = 分支名', async () => {
    for (const outcome of SOLVE_DELIVERED_OUTCOMES) {
      const v = (await promote({ cards: [codeResult({ stopReason: outcome })] }, OPTS, deps(agg(), agg())))
        .verdicts[0]!;
      expect(v.verdict).toBe('promoted');
      expect(v.artifact).toBe('night/card-s3');
      // delivered-with-red 原样带出词, 不抹成 success (红节点要人审)
      expect(v.reason).toContain(outcome);
    }
  });

  test('not-converged → held (闸不是恒放行)', async () => {
    const v = (await promote({ cards: [codeResult({ stopReason: 'not-converged' })] }, OPTS, deps(agg(), agg())))
      .verdicts[0]!;
    expect(v.verdict).toBe('held');
    expect(v.reason).toContain('not-converged');
  });
});

describe('promote 批级', () => {
  test('逐卡判词保序, 一张判不了不带走其余', async () => {
    const results: SessionsRunResult = {
      cards: [
        evolveResult({ cardId: 'a', error: 'boom' }),
        codeResult({ cardId: 'b', stopReason: 'success' }),
      ],
    };
    const r = await promote(results, OPTS, deps(agg(), agg()));
    expect(r.verdicts.map((v) => `${v.cardId}:${v.verdict}`)).toEqual(['a:skipped', 'b:promoted']);
    expect(r.date).toBe('2026-09-02');
  });

  test('零卡 → 零判词 (不编一条「今晚没事」的假判词)', async () => {
    const r = await promote({ cards: [], reason: 'no-cards' }, OPTS, deps(agg(), agg()));
    expect(r.verdicts).toEqual([]);
  });

  test('参数: results 路径与 --out 都必填', () => {
    expect(() => parsePromoteArgs(['--out', 'x'])).toThrow('results.json');
    expect(() => parsePromoteArgs(['r.json'])).toThrow('--out');
  });
});

/**
 * 反向自检 —— **真跑读数** (改一处, 跑本文件 + autoresearch-night-sessions.test.ts 共 32 条):
 *  · `notWorse` 的 `>=`/`<=` 改成 `>`/`<`            → 3 fail (持平被判成降)
 *  · `project` 的 null 分支改成 `return 0`           → 1 fail (「-Inf 而不是 0」那条)
 *  · `!validityOk` 判删掉                            → 1 fail (validity 降而主目标升)
 *  · 护栏红那一支改成 `if (false)`                   → 1 fail
 *  · winners 不滤 baseline                           → 1 fail (GWT-5c)
 *  · `SOLVE_DELIVERED_OUTCOMES` 加进 'not-converged' → 1 fail (闸恒放行)
 *
 * ⚠ 「-Inf 而不是 0」那条用例是**证伪试出来的**, 不是一开始就想到的: 第一版只测 baseline=1.5,
 *   而在那个点上两种投影判词相同, 于是 `return 0` 跑出 0 fail —— 一道当时读不出的假闸。
 */
