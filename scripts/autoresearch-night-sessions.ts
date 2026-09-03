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
 * ## 只剩一种基质 (2026-09-04)
 *
 *  - S3 (代码卡): 子进程 `bun run src/harness/cli.ts solve …`, 走 worktree 分支。
 *  - S1/S2 (进化卡: 变异 v1 conductor prompt 再回放) 随 v1 规划式 conductor 退役删除 —— 被试对象已不存在。
 *
 * 执行路由 `SessionsDeps` 注入 —— 测试跑完整条编排, 零 LLM 零子进程。
 *
 * ## 无卡不是失败 (D-3 / GWT-4)
 *
 * `cards.json` 的 `accepted` 为空 → 写 `{ cards: [], reason: 'no-cards' }` 并退 0。
 * 提案席今晚没提出能过闸的卡, 这是一条**读数**, 不是一次故障。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import type { CodeCard, FitnessField, SessionCard, Substrate } from '../src/eval/replay/session-card';

/** 一代的曲线点 (S1/S2 的遗产字段; S3 卡恒空数组, 附录渲染仍认这个形状)。 */
export interface CurvePoint {
  gen: number;
  main: number | null;
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
  /**
   * ✎ 同为加项: D-5 要求 S3 晋升「记分支名」, 而分支名只有跑的人知道。
   * 2026-09-03 (Q1④): 名字从 solve 的 runId 派生 (`omd/run/<runId>`, 引擎 prepareRunWorktree 的真名),
   * 不再自己编 `night/<cardId>` —— 那个名字从来没有对应的分支, 晋升闸对着空名判了两夜。
   * runId 读不到就缺席 (缺席 ≠ 空串: 晋升闸把缺席判 held)。
   */
  branch?: string;
  /** solve 冻结的可执行判据 (result-out 头 `criterion:` / `expectExit:`), 晋升闸的判据虚探针要它。 */
  criterion?: { command: string; expectExit: number };
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
  /** 本夜目录, result-out 落点挂在它下面。 */
  nightDir: string;
  /** 夜墙钟总闸 (分钟)。超了的卡不起跑。 */
  nightBudgetMinutes: number;
}

/** 执行路 + 时钟, 全部可注入 (测试跑真编排, 零 LLM 零子进程)。 */
export interface SessionsDeps {
  runCode?: (card: CodeCard, opts: SessionsOpts) => Promise<Omit<CardResult, 'wallMs'>>;
  now?: () => number;
}

/**
 * solve 的 result-out 头是键值行: `outcome:` / `runId:` / `acceptance:` / (executable 时) `criterion:` +
 * `expectExit:` (见 runs/autoresearch/*-result.json 与 `src/mcp/tools/goal.ts` 的写侧)。
 */
export function parseSolveResult(text: string): {
  outcome: string;
  runId?: string;
  criterion?: { command: string; expectExit: number };
} {
  const outcome = /^outcome:\s*(\S+)/m.exec(text)?.[1] ?? 'unclassified';
  const runId = /^runId:\s*(\S+)/m.exec(text)?.[1];
  const command = /^criterion:\s*(.+)$/m.exec(text)?.[1]?.trim();
  const expectRaw = /^expectExit:\s*(-?\d+)/m.exec(text)?.[1];
  const criterion =
    command && expectRaw !== undefined ? { command, expectExit: Number(expectRaw) } : undefined;
  return {
    outcome,
    ...(runId === undefined ? {} : { runId }),
    ...(criterion === undefined ? {} : { criterion }),
  };
}

/** S3 分支真名 = 引擎 prepareRunWorktree 的命名 (`src/mcp/tools/goal.ts` 回执里的 `omd/run/<runId>`)。 */
export function solveBranchName(runId: string): string {
  return `omd/run/${runId}`;
}

/** S3: 子进程 solve, worktree 分支 (D-4)。 */
async function defaultRunCode(
  card: CodeCard,
  opts: SessionsOpts,
): Promise<Omit<CardResult, 'wallMs'>> {
  const resultOut = join(opts.nightDir, `${card.id}-result.json`);
  mkdirSync(dirname(resultOut), { recursive: true });
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
      // 词表是 branch|head (与 solve MCP 同源); 此前传的 `worktree` 不在词表里, 而旧 CLI 又不认这个
      // flag, 于是被静默丢掉 → 写落主树 (2026-09-02 夜两卡)。现在 CLI 认 flag 且非法值响亮拒。
      '--branch-strategy',
      'branch',
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
    ...(parsed.runId ? { runId: parsed.runId, branch: solveBranchName(parsed.runId) } : {}),
    ...(parsed.criterion ? { criterion: parsed.criterion } : {}),
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
      const partial = await runCode(card, opts);
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
  nightBudgetMinutes: number;
}

const USAGE =
  'usage: bun scripts/autoresearch-night-sessions.ts <cards.json> --out <results.json> ' +
  '[--cwd <dir>] [--night-budget-minutes 480]';

export function parseSessionsArgs(argv: readonly string[]): SessionsArgs {
  let cardsPath = '';
  let out = '';
  let cwd = process.cwd();
  let nightBudgetMinutes = 480;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} 缺值`);
      return v;
    };
    if (a === '--out') out = next();
    else if (a === '--cwd') cwd = next();
    else if (a === '--night-budget-minutes') nightBudgetMinutes = Number(next());
    else if (a.startsWith('--')) throw new Error(`认不出的参数: ${a}`);
    else cardsPath = a;
  }
  if (cardsPath === '') throw new Error('cards.json 路径必填');
  if (out === '') throw new Error('--out 必填');
  return { cardsPath, out, cwd, nightBudgetMinutes };
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
  const result = await runCards(cards, {
    cwd: args.cwd,
    nightDir: dirname(args.out),
    nightBudgetMinutes: args.nightBudgetMinutes,
  });
  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`[sessions] ${result.cards.length} 张卡 → ${args.out}${result.reason ? ` (${result.reason})` : ''}\n`);
  for (const c of result.cards) {
    process.stdout.write(
      `  · ${c.cardId} [${c.substrate}] ${c.stopReason} · ${Math.round(c.wallMs / 1000)}s` +
        `${c.error ? ` · error: ${c.error}` : ''}\n`,
    );
  }
  process.exit(0);
}
