#!/usr/bin/env bun
/**
 * scripts/autoresearch-night-sessions —— 按卡**串行**跑 session (契约切片 3, D-4)。
 *
 *   bun scripts/autoresearch-night-sessions.ts <night>/cards.json --out <night>/results.json
 *
 * ## 为什么串行 (D-4)
 *
 * 每张卡都会占满 M3 渠道, 并行既不快, 又把 token 账混成一笔算不开的糊涂账。
 * 于是按卡序跑, 每张卡烧自己那份预算, 夜帽是**总闸**: 超了的卡不起跑, 记 `night-budget`
 * 而不是记失败 —— 「没轮到」与「跑了没成」是两件事。
 *
 * ## 两种基质两条路
 *
 *  - S1/S2 (进化卡): 进程内调 `runSession` (autoresearch-session.ts 已导出);
 *  - S3   (代码卡): 子进程 `bun run src/harness/cli.ts solve …`, 走 worktree 分支。
 *
 * 两条路都由 `SessionsDeps` 注入 —— 测试跑完整条编排, 零 LLM 零子进程。
 *
 * ## 无卡不是失败 (D-3 / GWT-4)
 *
 * `cards.json` 的 `accepted` 为空 → 写 `{ cards: [], reason: 'no-cards' }` 并退 0。
 * 提案席今晚没提出能过闸的卡, 这是一条**读数**, 不是一次故障。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import type { AggregatedFitness } from '../src/eval/replay/fitness';
import type {
  CodeCard,
  EvolveCard,
  FitnessField,
  SessionCard,
  Substrate,
} from '../src/eval/replay/session-card';
import type { MutationProvider } from '../src/eval/replay/mutate';
import { defaultLiveProvider, loadCorpusFromPath, type LiveProvider } from './autoresearch-replay';
import {
  SESSION_BASELINE_VARIANT,
  runSession,
  type GenerationRecord,
  type SessionResult,
} from './autoresearch-session';

/** 一代的曲线点。主目标那一维本来就可能读作 null (主尺缺席), 原样带出去不补 0。 */
export interface CurvePoint {
  gen: number;
  main: number | null;
  /**
   * 该代赢家的 planValidityRate。
   *
   * ✎ 契约冻结接口写的是 `validity: number`。改成可空的理由与主尺同: 赢家的 fitness 记录
   * 取不到时 (记录残缺), 「合格率是 0」与「合格率没读到」是两件事, 编一个 0 事后分不开
   * (仓规 §静默坑 1)。正常路径上永不为 null —— baseline 从第 0 代取, 子代从本代取。
   */
  validity: number | null;
}

/** 一张卡跑完的读数。塌与不塌都写 —— 只记好消息的实验没有信息量。 */
export interface CardResult {
  cardId: string;
  substrate: Substrate;
  /**
   * ✎ 冻结接口外的**加项**: 晋升闸要判「主目标不降」, 而它只拿得到 results.json
   * (契约的 promote CLI 只收这一个入参)。不带这一列, 判词就得靠猜是哪一维。
   */
  mainObjective: FitnessField;
  sessionId?: string;
  runId?: string;
  /** ✎ 同为加项: D-5 要求 S3 晋升「记分支名」, 而分支名只有跑的人知道。 */
  branch?: string;
  stopReason: string;
  winnerIds: string[];
  curve: CurvePoint[];
  wallMs: number;
  error?: string;
}

/** `results.json` 整档。`reason` 只在整批没跑时出现 (今天只有 `no-cards` 一种)。 */
export interface SessionsRunResult {
  cards: CardResult[];
  reason?: string;
}

export const NO_CARDS_REASON = 'no-cards';
/** 夜帽用尽后, 没轮到的卡记这个 —— 与「跑了没成」分开。 */
export const NIGHT_BUDGET_STOP = 'night-budget';

export interface SessionsOpts {
  cwd: string;
  /** 冻结语料 manifest (座位与语料 hash 的真源)。 */
  manifestPath: string;
  /** 本夜目录, variant / journal / session 落点都挂在它下面。 */
  nightDir: string;
  /** 夜墙钟总闸 (分钟)。超了的卡不起跑。 */
  nightBudgetMinutes: number;
  /** 回放并发 (透传 runSession.replayConcurrency)。缺省 = DEFAULT_REPLAY_CONCURRENCY。 */
  replayConcurrency?: number;
}

/**
 * 回放默认并发。2026-09-02 烟测: M3 conductor 一题中位 95s (out 中位 14K token), 串行一个
 * variant 27 题 ≈ 43 min, K=4 一代 ≈ 3h; 4 路并发把一代压到 ~45 min。env OMD_REPLAY_CONCURRENCY 可覆盖。
 */
export const DEFAULT_REPLAY_CONCURRENCY = 4;

/** 两条执行路 + 两个 LLM 注入点 + 时钟, 全部可注入 (测试跑真编排, 零 LLM 零子进程)。 */
export interface SessionsDeps {
  runEvolve?: (card: EvolveCard, opts: SessionsOpts) => Promise<Omit<CardResult, 'wallMs'>>;
  runCode?: (card: CodeCard, opts: SessionsOpts) => Promise<Omit<CardResult, 'wallMs'>>;
  /**
   * S1/S2 的联机提供器。缺省 = `defaultLiveProvider` (真烧 token)。
   * 测试装 fake → 整条 session 编排真跑, 零 HTTP。
   */
  liveProvider?: LiveProvider;
  /**
   * S1/S2 的变异算子。缺省 = `defaultMutationProvider` (由 `runSession` 兜底, 也真烧 token)。
   * 测试装 fake → 变异这一跳也零 HTTP。
   */
  mutationProvider?: MutationProvider;
  now?: () => number;
}

// ── 曲线 ──────────────────────────────────────────────────────────────────

/**
 * 逐代取**赢家**在主目标与 validity 上的读数。
 *
 * 赢家解析是全的: `baseline` 只在第 0 代被评估过 (session.ts 的 gen≥1 只把子代写进
 * `fitnessByChild`), 于是这里维护一张「变体 → 最近一次已知 fitness」的表, 边走边补。
 * 查不到 → 两维都记 null, 不编数。
 */
export function curveOf(
  generations: readonly GenerationRecord[],
  mainObjective: FitnessField,
): CurvePoint[] {
  const known = new Map<string, AggregatedFitness>();
  const points: CurvePoint[] = [];
  for (const g of generations) {
    for (const [name, fit] of Object.entries(g.fitnessByChild)) known.set(name, fit.main);
    const winner = g.winnerIds[0] ?? SESSION_BASELINE_VARIANT;
    const fit = known.get(winner);
    points.push({
      gen: g.genIdx,
      main: fit ? ((fit[mainObjective] as number | null) ?? null) : null,
      validity: fit ? fit.planValidityRate : null,
    });
  }
  return points;
}

// ── 默认两条执行路 ────────────────────────────────────────────────────────

function evolveResultToCard(card: EvolveCard, r: SessionResult): Omit<CardResult, 'wallMs'> {
  return {
    cardId: card.id,
    substrate: card.substrate,
    mainObjective: card.mainObjective,
    sessionId: r.sessionId,
    stopReason: r.stopReason,
    winnerIds: [...r.winnerIds],
    curve: curveOf(r.generations, card.mainObjective),
  };
}

/**
 * S1/S2: 进程内 runSession, 语料/journal/session 全挂在本夜目录下 (不污染主账本)。
 *
 * ## 两个 LLM 座都在这里接上 (缺口 1)
 *
 * `runSession` 的两个 provider 都是**可注入且有默认**的, 而两个默认值指向相反的方向:
 * rawText 默认回落 `stubVariantToRawText` (canned plan, 零 LLM —— 曲线照样有数, 但那是
 * 假 fitness, 没有一处会红), 变异默认 `defaultMutationProvider` (缺 seats 直接抛)。
 * 于是这条路必须**两个都显式装**: live provider 送 (variant, id, prompt) 进联机装配,
 * `manifest.seats` 送进变异上下文。少装哪一个, 都由本文件配套测试的两条守着。
 *
 * variant 读盘根目录跟着本夜目录走 —— 指回仓库默认目录, 子代 spec 读不回来, 每个子代的
 * 系统提示与基线逐字节相同, 进化静默退化成基线复读。
 */
async function defaultRunEvolve(
  card: EvolveCard,
  opts: SessionsOpts,
  deps: SessionsDeps = {},
): Promise<Omit<CardResult, 'wallMs'>> {
  const corpus = loadCorpusFromPath(join(opts.cwd, opts.manifestPath), false);
  const seats = corpus.manifest.seats;
  const variantDir = join(opts.nightDir, 'variants');
  const liveProvider = deps.liveProvider ?? defaultLiveProvider;
  const r = await runSession({
    corpus,
    K: card.K,
    maxGenerations: card.maxGenerations,
    topM: card.topM,
    budgetMs: card.budgetMinutes * 60_000,
    sessionId: `night-${card.id}`,
    variantDir,
    journalPath: join(opts.nightDir, 'journal.md'),
    sessionsDir: join(opts.nightDir, 'sessions'),
    seats,
    replayConcurrency: opts.replayConcurrency ?? DEFAULT_REPLAY_CONCURRENCY,
    rawTextProvider: (variant, id, prompt) =>
      liveProvider(id, prompt, { seats, variant, id, variantDir }),
    ...(deps.mutationProvider ? { mutationProvider: deps.mutationProvider } : {}),
  });
  return evolveResultToCard(card, r);
}

/** solve 的 result-out 首两行是 `outcome:` / `runId:` (见 runs/autoresearch/*-result.json)。 */
export function parseSolveResult(text: string): { outcome: string; runId?: string } {
  const outcome = /^outcome:\s*(\S+)/m.exec(text)?.[1] ?? 'unclassified';
  const runId = /^runId:\s*(\S+)/m.exec(text)?.[1];
  return runId === undefined ? { outcome } : { outcome, runId };
}

/** S3: 子进程 solve, worktree 分支 (D-4)。 */
async function defaultRunCode(
  card: CodeCard,
  opts: SessionsOpts,
): Promise<Omit<CardResult, 'wallMs'>> {
  const resultOut = join(opts.nightDir, `${card.id}-result.json`);
  mkdirSync(dirname(resultOut), { recursive: true });
  const branch = `night/${card.id}`;
  const r = spawnSync(
    'bun',
    [
      'run',
      'src/harness/cli.ts',
      'solve',
      card.goal,
      '--budget-minutes',
      String(card.budgetMinutes),
      '--result-out',
      resultOut,
      '--branch-strategy',
      'worktree',
    ],
    { cwd: opts.cwd, encoding: 'utf8', timeout: card.budgetMinutes * 60_000 },
  );
  const text = existsSync(resultOut) ? readFileSync(resultOut, 'utf8') : '';
  const parsed = parseSolveResult(text);
  const base: Omit<CardResult, 'wallMs'> = {
    cardId: card.id,
    substrate: 'S3',
    mainObjective: card.mainObjective,
    stopReason: parsed.outcome,
    winnerIds: [],
    curve: [],
    branch,
    ...(parsed.runId ? { runId: parsed.runId } : {}),
  };
  if (text === '') {
    return { ...base, error: `solve 没写出 result-out (${resultOut}); 退出码 ${r.status ?? 'null'}` };
  }
  return base;
}

// ── 编排 ──────────────────────────────────────────────────────────────────

/**
 * 按卡序串行跑。**永不抛** —— 单张卡塌进 `error` 那一列, 后面的卡照跑。
 * 夜帽超了 → 剩下的卡记 `night-budget` 并跳过。
 */
export async function runCards(
  cards: readonly SessionCard[],
  opts: SessionsOpts,
  deps: SessionsDeps = {},
): Promise<SessionsRunResult> {
  if (cards.length === 0) return { cards: [], reason: NO_CARDS_REASON };

  const now = deps.now ?? Date.now;
  const runEvolve =
    deps.runEvolve ?? ((card: EvolveCard, o: SessionsOpts) => defaultRunEvolve(card, o, deps));
  const runCode = deps.runCode ?? defaultRunCode;
  const deadline = now() + opts.nightBudgetMinutes * 60_000;

  const out: CardResult[] = [];
  for (const card of cards) {
    const startedAt = now();
    if (startedAt >= deadline) {
      out.push({
        cardId: card.id,
        substrate: card.substrate,
        mainObjective: card.mainObjective,
        stopReason: NIGHT_BUDGET_STOP,
        winnerIds: [],
        curve: [],
        wallMs: 0,
      });
      continue;
    }
    try {
      const partial =
        card.substrate === 'S3' ? await runCode(card, opts) : await runEvolve(card, opts);
      out.push({ ...partial, wallMs: now() - startedAt });
    } catch (e) {
      // fail-open 可以吞异常, 不许吞证据: cardId + 错误原文都在。
      out.push({
        cardId: card.id,
        substrate: card.substrate,
        mainObjective: card.mainObjective,
        stopReason: 'error',
        winnerIds: [],
        curve: [],
        wallMs: now() - startedAt,
        error: (e as Error).message,
      });
    }
  }
  return { cards: out };
}

// ── CLI ───────────────────────────────────────────────────────────────────

export interface SessionsArgs {
  cardsPath: string;
  out: string;
  cwd: string;
  manifestPath: string;
  nightBudgetMinutes: number;
  replayConcurrency: number;
}

const USAGE =
  'usage: bun scripts/autoresearch-night-sessions.ts <cards.json> --out <results.json> ' +
  '[--cwd <dir>] [--manifest <path>] [--night-budget-minutes 480] [--replay-concurrency 4]';

export const DEFAULT_MANIFEST = 'runs/autoresearch/corpus/manifest.json';

export function parseSessionsArgs(argv: readonly string[]): SessionsArgs {
  let cardsPath = '';
  let out = '';
  let cwd = process.cwd();
  let manifestPath = DEFAULT_MANIFEST;
  let nightBudgetMinutes = 480;
  let replayConcurrency = Number(process.env.OMD_REPLAY_CONCURRENCY ?? DEFAULT_REPLAY_CONCURRENCY);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} 缺值`);
      return v;
    };
    if (a === '--out') out = next();
    else if (a === '--cwd') cwd = next();
    else if (a === '--manifest') manifestPath = next();
    else if (a === '--night-budget-minutes') nightBudgetMinutes = Number(next());
    else if (a === '--replay-concurrency') replayConcurrency = Number(next());
    else if (a.startsWith('--')) throw new Error(`认不出的参数: ${a}`);
    else cardsPath = a;
  }
  if (cardsPath === '') throw new Error('cards.json 路径必填');
  if (out === '') throw new Error('--out 必填');
  if (!Number.isInteger(replayConcurrency) || replayConcurrency < 1) {
    throw new Error(`--replay-concurrency 须为 ≥1 的整数, 收到 ${replayConcurrency}`);
  }
  return { cardsPath, out, cwd, manifestPath, nightBudgetMinutes, replayConcurrency };
}

/** 从 cards.json (校卡闸产物) 取 accepted。文件缺席 / 形状不对 → 空数组 (下游记 no-cards)。 */
export function readAcceptedCards(path: string): SessionCard[] {
  if (!existsSync(path)) return [];
  const raw = JSON.parse(readFileSync(path, 'utf8')) as { accepted?: SessionCard[] };
  return Array.isArray(raw.accepted) ? raw.accepted : [];
}

if (import.meta.main) {
  let args: SessionsArgs;
  try {
    args = parseSessionsArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n${USAGE}\n`);
    process.exit(2);
  }
  const cards = readAcceptedCards(args.cardsPath);
  const results = await runCards(cards, {
    cwd: args.cwd,
    manifestPath: args.manifestPath,
    nightDir: dirname(args.out),
    nightBudgetMinutes: args.nightBudgetMinutes,
    replayConcurrency: args.replayConcurrency,
  });
  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, `${JSON.stringify(results, null, 2)}\n`);
  process.stdout.write(
    `[night-sessions] ${results.cards.length} 张卡跑完${results.reason ? ` (${results.reason})` : ''} → ${args.out}\n`,
  );
  for (const c of results.cards) {
    process.stdout.write(
      `  · ${c.cardId} [${c.substrate}] ${c.stopReason} · ${Math.round(c.wallMs / 1000)}s` +
        `${c.error ? ` · 错误: ${c.error}` : ''}\n`,
    );
  }
  process.exit(0);
}
