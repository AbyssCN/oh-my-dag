#!/usr/bin/env bun
/**
 * scripts/autoresearch-promote —— 晋升闸 (契约切片 3, D-5)。
 *
 *   bun scripts/autoresearch-promote.ts <night>/results.json --out <night>/promotion.json
 *
 * ## 晋升到 staging, 进 main 仍然是人 (D-5)
 *
 * 这道闸能做的只有一件事: 把「够格给人看」的产物挑出来放进 `runs/autoresearch/promoted/<date>/`。
 * 它**不**合并任何分支, **不**改任何尺子。三个判词各占一格, 不互相顶替:
 *
 *  - `promoted` 该给人看   · `held` 跑了但没够格   · `skipped` 压根没有可判的东西
 *
 * `held` 与 `skipped` 分开是判据不是修辞: 前者要人读读数, 后者只说明今晚这张卡没产出赢家。
 *
 * ## held-out 段为什么必须量
 *
 * 内环 (screen/main 段) 是变异算子看得见的段, 在它上面赢可能只是过拟合。held-out 是内环
 * **看不见**的那段 —— 主目标与 validity 两维在这一段上都不降, 才算这次演进不是自己骗自己。
 * 两份读数 (baseline / winner) 一律原样写进判词, 塌与不塌都写。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import type { AggregatedFitness } from '../src/eval/replay/fitness';
import type { FitnessField } from '../src/eval/replay/session-card';
import { readVariant } from '../src/eval/replay/variant';
import { evaluateSplit } from './autoresearch-replay';
import { loadCorpusFromPath } from './autoresearch-replay';
import { SESSION_BASELINE_VARIANT } from './autoresearch-session';
import type { CardResult, SessionsRunResult } from './autoresearch-night-sessions';

/** 每一维「更好」是哪个方向 (与 autoresearch-session.ts:SESSION_DEFAULT_OBJECTIVES 逐条同)。 */
export const FITNESS_DIRECTIONS: Record<FitnessField, 'maximize' | 'minimize'> = {
  planValidityRate: 'maximize',
  fakeSerialPairsTotal: 'minimize',
  speedupTheoreticalMedian: 'maximize',
  shapeDeclarationRate: 'maximize',
  planningTokensTotal: 'minimize',
};

/**
 * solve 的终态词表里「算交付了」的两格。
 *
 * ✎ 契约 D-5 写的是「verified/delivered」; 仓里 `src/harness/run-outcome.ts` 的真词表没有这两个词,
 * 对应的是 `success` 与 `delivered-with-red`。后者是「判据说交付达标而图内有节点红」——
 * 它进晋升, 但红节点要人审, 所以判词里原样带出这个词, 不抹成 success。
 */
export const SOLVE_DELIVERED_OUTCOMES: readonly string[] = ['success', 'delivered-with-red'];

export interface PromotionVerdict {
  cardId: string;
  verdict: 'promoted' | 'held' | 'skipped';
  reason: string;
  heldout?: { baseline: AggregatedFitness; winner: AggregatedFitness };
  /** promoted 变体的落点路径, 或 S3 的分支名。 */
  artifact?: string;
}

export interface PromotionReport {
  date: string;
  verdicts: PromotionVerdict[];
}

export interface PromoteOpts {
  cwd: string;
  /** 本夜日期, 决定 promoted 落点 `runs/autoresearch/promoted/<date>/`。 */
  date: string;
  manifestPath: string;
}

export interface PromoteDeps {
  /** held-out 段回放一个变体 → 聚合 fitness。 */
  evaluateHeldout?: (variant: string, opts: PromoteOpts) => Promise<AggregatedFitness>;
  /** 护栏 (tsc + replay 套件)。 */
  runGuardrails?: (opts: PromoteOpts) => { ok: boolean; detail: string };
  /** 把赢家变体写进 promoted 目录, 返回落点路径。 */
  writeArtifact?: (variant: string, opts: PromoteOpts, cardId: string) => string;
}

/** null 投影成该维最坏值 (与 select.ts 同款 fail-closed: 读不到不算赢)。 */
function project(v: number | null, direction: 'maximize' | 'minimize'): number {
  if (v !== null) return v;
  return direction === 'maximize' ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
}

/** winner 在某一维上「不降」(允许持平)。 */
export function notWorse(
  field: FitnessField,
  winner: AggregatedFitness,
  baseline: AggregatedFitness,
): boolean {
  const d = FITNESS_DIRECTIONS[field];
  const w = project(winner[field] as number | null, d);
  const b = project(baseline[field] as number | null, d);
  return d === 'maximize' ? w >= b : w <= b;
}

export const PROMOTED_DIR = 'runs/autoresearch/promoted';

function defaultWriteArtifact(variant: string, opts: PromoteOpts, cardId: string): string {
  const dir = join(opts.cwd, PROMOTED_DIR, opts.date);
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, `${cardId}.json`);
  const spec = readVariant(join(opts.cwd, 'runs', 'autoresearch', 'variants'), variant);
  writeFileSync(dest, `${JSON.stringify({ cardId, variant, spec }, null, 2)}\n`);
  return dest;
}

async function defaultEvaluateHeldout(
  variant: string,
  opts: PromoteOpts,
): Promise<AggregatedFitness> {
  const loaded = loadCorpusFromPath(join(opts.cwd, opts.manifestPath), true);
  const { aggregate } = await evaluateSplit({
    loaded,
    split: 'heldout',
    rawTextProvider: (_id, _prompt) =>
      Promise.resolve(JSON.stringify({ name: variant, description: variant, nodes: {} })),
  });
  return aggregate;
}

function defaultRunGuardrails(opts: PromoteOpts): { ok: boolean; detail: string } {
  const tsc = spawnSync('bunx', ['tsc', '--noEmit'], { cwd: opts.cwd, encoding: 'utf8' });
  if (tsc.status !== 0) return { ok: false, detail: `tsc 退出 ${tsc.status}` };
  const t = spawnSync('bun', ['test', 'src/eval/replay/'], { cwd: opts.cwd, encoding: 'utf8' });
  if (t.status !== 0) return { ok: false, detail: `bun test src/eval/replay/ 退出 ${t.status}` };
  return { ok: true, detail: 'tsc 0 · replay 套件绿' };
}

/** 一张进化卡的判词。 */
async function judgeEvolve(
  card: CardResult,
  opts: PromoteOpts,
  deps: Required<Pick<PromoteDeps, 'evaluateHeldout' | 'runGuardrails' | 'writeArtifact'>>,
): Promise<PromotionVerdict> {
  const winners = card.winnerIds.filter((w) => w !== SESSION_BASELINE_VARIANT);
  if (winners.length === 0) {
    return {
      cardId: card.cardId,
      verdict: 'skipped',
      reason: `winnerIds 里只有 ${SESSION_BASELINE_VARIANT} —— 本卡没有产出可晋升的变体`,
    };
  }
  const winner = winners[0]!;
  const baselineFit = await deps.evaluateHeldout(SESSION_BASELINE_VARIANT, opts);
  const winnerFit = await deps.evaluateHeldout(winner, opts);
  const heldout = { baseline: baselineFit, winner: winnerFit };

  const mainOk = notWorse(card.mainObjective, winnerFit, baselineFit);
  const validityOk = notWorse('planValidityRate', winnerFit, baselineFit);
  if (!mainOk || !validityOk) {
    const which = [!mainOk ? card.mainObjective : null, !validityOk ? 'planValidityRate' : null]
      .filter(Boolean)
      .join(' / ');
    return {
      cardId: card.cardId,
      verdict: 'held',
      reason: `heldout 段上 ${which} 相对 baseline 下降 —— 内环赢在 held-out 上没兑现`,
      heldout,
    };
  }

  const guard = deps.runGuardrails(opts);
  if (!guard.ok) {
    return {
      cardId: card.cardId,
      verdict: 'held',
      reason: `heldout 两维都不降, 但护栏红: ${guard.detail}`,
      heldout,
    };
  }
  return {
    cardId: card.cardId,
    verdict: 'promoted',
    reason: `heldout 段主目标 ${card.mainObjective} 与 planValidityRate 均不降 · 护栏 ${guard.detail}`,
    heldout,
    artifact: deps.writeArtifact(winner, opts, card.cardId),
  };
}

/** 一张代码卡的判词 (无 held-out 可量 —— 判的是 solve 终态)。 */
function judgeCode(card: CardResult): PromotionVerdict {
  if (SOLVE_DELIVERED_OUTCOMES.includes(card.stopReason)) {
    return {
      cardId: card.cardId,
      verdict: 'promoted',
      reason: `solve 终态 ${card.stopReason} —— 分支待人审后进 main`,
      ...(card.branch ? { artifact: card.branch } : {}),
    };
  }
  return {
    cardId: card.cardId,
    verdict: 'held',
    reason: `solve 终态 ${card.stopReason}, 不在交付词表 (${SOLVE_DELIVERED_OUTCOMES.join(' | ')})`,
  };
}

/** 逐卡判词。**永不抛** —— 一张卡判不了不许带走整夜的报告。 */
export async function promote(
  results: SessionsRunResult,
  opts: PromoteOpts,
  deps: PromoteDeps = {},
): Promise<PromotionReport> {
  const resolved = {
    evaluateHeldout: deps.evaluateHeldout ?? defaultEvaluateHeldout,
    runGuardrails: deps.runGuardrails ?? defaultRunGuardrails,
    writeArtifact: deps.writeArtifact ?? defaultWriteArtifact,
  };
  const verdicts: PromotionVerdict[] = [];
  for (const card of results.cards) {
    if (card.error !== undefined) {
      verdicts.push({
        cardId: card.cardId,
        verdict: 'skipped',
        reason: `session 出错, 无可判读数: ${card.error}`,
      });
      continue;
    }
    try {
      verdicts.push(
        card.substrate === 'S3' ? judgeCode(card) : await judgeEvolve(card, opts, resolved),
      );
    } catch (e) {
      verdicts.push({
        cardId: card.cardId,
        verdict: 'skipped',
        reason: `晋升判定自身出错: ${(e as Error).message}`,
      });
    }
  }
  return { date: opts.date, verdicts };
}

// ── CLI ───────────────────────────────────────────────────────────────────

export interface PromoteArgs {
  resultsPath: string;
  out: string;
  cwd: string;
  date: string;
  manifestPath: string;
}

const USAGE =
  'usage: bun scripts/autoresearch-promote.ts <results.json> --out <promotion.json> ' +
  '[--cwd <dir>] [--date YYYY-MM-DD] [--manifest <path>]';

export function parsePromoteArgs(argv: readonly string[]): PromoteArgs {
  let resultsPath = '';
  let out = '';
  let cwd = process.cwd();
  let date = new Date().toISOString().slice(0, 10);
  let manifestPath = 'runs/autoresearch/corpus/manifest.json';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} 缺值`);
      return v;
    };
    if (a === '--out') out = next();
    else if (a === '--cwd') cwd = next();
    else if (a === '--date') date = next();
    else if (a === '--manifest') manifestPath = next();
    else if (a.startsWith('--')) throw new Error(`认不出的参数: ${a}`);
    else resultsPath = a;
  }
  if (resultsPath === '') throw new Error('results.json 路径必填');
  if (out === '') throw new Error('--out 必填');
  return { resultsPath, out, cwd, date, manifestPath };
}

if (import.meta.main) {
  let args: PromoteArgs;
  try {
    args = parsePromoteArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n${USAGE}\n`);
    process.exit(2);
  }
  const results: SessionsRunResult = existsSync(args.resultsPath)
    ? (JSON.parse(readFileSync(args.resultsPath, 'utf8')) as SessionsRunResult)
    : { cards: [], reason: 'results.json 不在' };
  const report = await promote(results, {
    cwd: args.cwd,
    date: args.date,
    manifestPath: args.manifestPath,
  });
  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`[promote] ${report.verdicts.length} 条判词 → ${args.out}\n`);
  for (const v of report.verdicts) {
    process.stdout.write(`  · ${v.cardId}: ${v.verdict} —— ${v.reason}\n`);
  }
  process.exit(0);
}
