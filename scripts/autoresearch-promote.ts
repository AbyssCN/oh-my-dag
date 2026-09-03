#!/usr/bin/env bun
/**
 * scripts/autoresearch-promote —— 晋升闸 (契约切片 3, D-5)。
 *
 *   bun scripts/autoresearch-promote.ts <night>/results.json --out <night>/promotion.json
 *
 * ## 晋升到 staging, 进 main 仍然是人 (D-5)
 *
 * 2026-09-04: S1/S2 进化卡随 v1 规划式 conductor 退役, 这道闸只剩 S3 代码卡的机械审计 (恒 held, 人审后进 main)。
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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { CardResult, SessionsRunResult } from './autoresearch-night-sessions';

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
  /** promoted 变体的落点路径, 或 S3 的分支名。 */
  artifact?: string;
  /** S3 卡的机械审计读数 (Q1②③④), 人审读它, 不读散文。 */
  audit?: CodeAudit;
}

/**
 * S3 代码卡的机械审计 (2026-09-03, 夜链 Q1)。四格各自可缺席, 缺席 ≠ 绿:
 *  - `branchExists`: results.json 记的分支在盘上真有 (2026-09-02 夜两卡记了不存在的名字, 改动落在主树);
 *  - `files`: 分支相对 merge-base 改了哪些文件;
 *  - `forbidden`: 其中触碰夜链禁改路径的 (原 verify 节点的散文 claim, 这里做成确定性判定);
 *  - `testOnlyGreen`: **判据虚探针** —— 把分支里**只有测试文件**的那部分贴到干净基线世界, 跑冻结判据:
 *    仍绿 = 测试不依赖实装 (与实装同一次改动产出、互相背书, `docs/silent-failures.md` 静默坑 3),
 *    判据就是虚的。null = 没探成 (无判据 / 无分支 / 探针自身失败), 原因在 `notes`。
 */
export interface CodeAudit {
  branchExists: boolean;
  files: string[];
  forbidden: string[];
  testOnlyGreen: boolean | null;
  notes: string[];
}

export interface PromotionReport {
  date: string;
  verdicts: PromotionVerdict[];
}

export interface PromoteOpts {
  cwd: string;
  /** 本夜日期。 */
  date: string;
}

export interface PromoteDeps {
  /** S3 机械审计 (git + 判据虚探针); 测试注入假件, 生产走 `defaultAuditCode`。 */
  auditCode?: (card: CardResult, opts: PromoteOpts) => Promise<CodeAudit>;
}

/** 夜链自动产物不许碰的路径 (改尺子 = 作弊)。与 buildNightChain 的 verify claim 同一张表。 */
export const S3_FORBIDDEN_PATHS: readonly string[] = [
  'docs/plan/autoresearch-objective.md',
  'src/eval/replay/',
  'runs/autoresearch/corpus/',
  'scripts/autoresearch-',
];

export function isForbiddenPath(file: string): boolean {
  return S3_FORBIDDEN_PATHS.some((p) => (p.endsWith('/') || p.endsWith('-') ? file.startsWith(p) : file === p));
}

/** 测试文件判定: 贴进基线世界的只有这些。 */
export function isTestPath(file: string): boolean {
  return (
    /\.test\.[cm]?[jt]sx?$/.test(file) ||
    /(^|\/)__tests__\//.test(file) ||
    /(^|\/)tests?\//.test(file) ||
    /(^|\/)test_[^/]*\.py$/.test(file) ||
    /_test\.py$/.test(file)
  );
}

/** 生产审计: git 事实 + 判据虚探针。永不抛 —— 探不成写进 notes, 让判词判 held 而不是让整夜报告塌。 */
export async function defaultAuditCode(card: CardResult, opts: PromoteOpts): Promise<CodeAudit> {
  const git = (args: string[], cwd = opts.cwd) => spawnSync('git', args, { cwd, encoding: 'utf8' });
  const audit: CodeAudit = { branchExists: false, files: [], forbidden: [], testOnlyGreen: null, notes: [] };
  if (!card.branch) {
    audit.notes.push('results.json 无 branch (solve 没写出 runId → 分支名派生不出)');
    return audit;
  }
  if (git(['rev-parse', '--verify', '--quiet', `refs/heads/${card.branch}`]).status !== 0) {
    audit.notes.push(`分支 ${card.branch} 在盘上不存在`);
    return audit;
  }
  audit.branchExists = true;
  const base = git(['merge-base', 'HEAD', card.branch]).stdout.trim();
  if (!base) {
    audit.notes.push(`merge-base HEAD ${card.branch} 取不到`);
    return audit;
  }
  audit.files = git(['diff', '--name-only', `${base}..${card.branch}`]).stdout.split('\n').filter(Boolean);
  audit.forbidden = audit.files.filter(isForbiddenPath);
  if (!card.criterion) {
    audit.notes.push('result-out 无 criterion 头 (非 executable 分型或旧格式) → 判据虚探针不适用');
    return audit;
  }
  const testFiles = audit.files.filter(isTestPath);
  const world = mkdtempSync(join(tmpdir(), 'omd-promote-probe-'));
  try {
    const add = git(['worktree', 'add', '--detach', world, base]);
    if (add.status !== 0) {
      audit.notes.push(`探针世界建不出: ${add.stderr.trim().slice(0, 200)}`);
      return audit;
    }
    // 基线世界没有依赖树; 与 run-worktree.ts 同款: 仓根 node_modules 软链进去 (只链仓根, 子包不管)。
    const nm = join(opts.cwd, 'node_modules');
    if (existsSync(nm) && !existsSync(join(world, 'node_modules'))) symlinkSync(nm, join(world, 'node_modules'));
    if (testFiles.length > 0) {
      const patch = git(['diff', `${base}..${card.branch}`, '--', ...testFiles]).stdout;
      const applied = spawnSync('git', ['apply', '--whitespace=nowarn', '-'], { cwd: world, input: patch, encoding: 'utf8' });
      if (applied.status !== 0) {
        audit.notes.push(`只贴测试文件失败: ${applied.stderr.trim().slice(0, 200)}`);
        return audit;
      }
    }
    const run = spawnSync('bash', ['-lc', card.criterion.command], { cwd: world, encoding: 'utf8', timeout: 10 * 60_000 });
    if (run.status === null) {
      audit.notes.push('判据在探针世界里被信号带走 (超时/杀), 无判词');
      return audit;
    }
    audit.testOnlyGreen = run.status === card.criterion.expectExit;
    audit.notes.push(
      `判据虚探针: 基线世界 + ${testFiles.length} 个测试文件 → 退出码 ${run.status} (期望 ${card.criterion.expectExit})`,
    );
    return audit;
  } finally {
    git(['worktree', 'remove', '--force', world]);
    rmSync(world, { recursive: true, force: true });
  }
}

/**
 * 一张代码卡的判词。**S3 永远到不了 `promoted`** (2026-09-03, Q1①): 它的主目标 (`mainObjective`) 在
 * 这道闸里没有 held-out 读数可量 —— 量不出的不许叫晋升, 只能是 `held` (跑了, 要人读读数)。
 * 2026-09-02 夜两张 S3 卡按「solve 终态 success 即 promoted」放行, 人审一张是主目标 no-op、一张是
 * 判据虚 —— 那条判词就是这样退役的。
 *
 * held 的**理由分档**, 人审先读第一句: 终态不在词表 → 分支不存在 → 触碰禁改路径 → 判据虚 → 机械审计绿。
 */
async function judgeCode(
  card: CardResult,
  opts: PromoteOpts,
  auditCode: NonNullable<PromoteDeps['auditCode']>,
): Promise<PromotionVerdict> {
  const held = (reason: string, audit?: CodeAudit): PromotionVerdict => ({
    cardId: card.cardId,
    verdict: 'held',
    reason,
    ...(card.branch ? { artifact: card.branch } : {}),
    ...(audit ? { audit } : {}),
  });
  if (!SOLVE_DELIVERED_OUTCOMES.includes(card.stopReason)) {
    return held(`solve 终态 ${card.stopReason}, 不在交付词表 (${SOLVE_DELIVERED_OUTCOMES.join(' | ')})`);
  }
  const audit = await auditCode(card, opts);
  if (!audit.branchExists) {
    return held(`分支缺席或不存在 (${audit.notes.join('; ')}) —— 改动可能落在主工作树, 无可审产物`, audit);
  }
  if (audit.forbidden.length > 0) {
    return held(`触碰禁改路径 (改尺子): ${audit.forbidden.join(', ')}`, audit);
  }
  if (audit.testOnlyGreen === true) {
    return held(
      `判据虚: 只把测试文件贴进基线世界, 冻结判据 \`${card.criterion?.command ?? '?'}\` 就已经绿 —— ` +
        '测试不依赖实装 (与实装同一次改动产出、互相背书)',
      audit,
    );
  }
  const probe = audit.testOnlyGreen === false ? '判据在基线世界红 (探针过)' : `判据虚探针未探成 (${audit.notes.join('; ')})`;
  return held(
    `solve 终态 ${card.stopReason} · 主目标 ${card.mainObjective} 未量 (S3 无 held-out 回放) · ` +
      `机械审计: 分支 ${card.branch} 改 ${audit.files.length} 文件, 禁改路径零触碰, ${probe} —— 分支待人审后进 main`,
    audit,
  );
}

/** 逐卡判词。**永不抛** —— 一张卡判不了不许带走整夜的报告。 */
export async function promote(
  results: SessionsRunResult,
  opts: PromoteOpts,
  deps: PromoteDeps = {},
): Promise<PromotionReport> {
  const auditCode = deps.auditCode ?? defaultAuditCode;
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
      verdicts.push(await judgeCode(card, opts, auditCode));
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
}

const USAGE =
  'usage: bun scripts/autoresearch-promote.ts <results.json> --out <promotion.json> ' +
  '[--cwd <dir>] [--date YYYY-MM-DD]';

export function parsePromoteArgs(argv: readonly string[]): PromoteArgs {
  let resultsPath = '';
  let out = '';
  let cwd = process.cwd();
  let date = new Date().toISOString().slice(0, 10);
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
    else if (a.startsWith('--')) throw new Error(`认不出的参数: ${a}`);
    else resultsPath = a;
  }
  if (resultsPath === '') throw new Error('results.json 路径必填');
  if (out === '') throw new Error('--out 必填');
  return { resultsPath, out, cwd, date };
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
  });
  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`[promote] ${report.verdicts.length} 条判词 → ${args.out}\n`);
  for (const v of report.verdicts) {
    process.stdout.write(`  · ${v.cardId}: ${v.verdict} —— ${v.reason}\n`);
  }
  process.exit(0);
}
