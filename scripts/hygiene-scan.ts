#!/usr/bin/env bun
/**
 * scripts/hygiene-scan —— 仓库治理链的**零 LLM 扫描器 + 棘轮闸** (契约 D-1 / D-2)。
 *
 *   bun scripts/hygiene-scan.ts --out runs/hygiene/2026-09-02/scan.json
 *   bun scripts/hygiene-scan.ts --check      # 与 runs/hygiene/baseline.json 比, 任一类升 → exit 1
 *   bun scripts/hygiene-scan.ts --rebase     # 重写基线 (人手动; 不自动)
 *   bun scripts/hygiene-scan.ts --randomize  # 附加跑 bun test --randomize (周用, 默认不跑)
 *
 * ## 这里为什么零 LLM 是可核实的, 不是自称的
 *
 * 全部判断力在 `src/harness/hygiene/miners.ts` 的纯函数里; 本文件只做三件事:
 * 取原料 (fs / spawn / sqlite) → 喂纯函数 → 拼 `HygieneScan`。取原料那三件全部走
 * `ScanIO` 注入, 于是测试能在**零外部进程**下跑完整条扫描 (GWT-1)。
 * 「没有 LLM」这句话由 `hygiene-scan.test.ts` 的 import 白名单闸机械核实, 不靠这段注释。
 *
 * ## fail-open 留证据 (仓规 §静默坑 2)
 *
 * 任一矿源读不到 → 进 `errors[]` 并带错误原文, 该类 counts 停在 0, 扫描**照常退出 0**。
 * 「这类真是零」与「这类没读到」靠 errors 分辨, 不靠 counts 猜 (§静默坑 1)。
 */
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import {
  mineBigFiles,
  mineDebt,
  mineFailedRuns,
  mineForks,
  mineKnip,
  mineSeamDrift,
  mineStalePlans,
  mineTestHealth,
  mineTodo,
  type FailedRunRow,
  type ForkRowLike,
  type KnipReport,
} from '../src/harness/hygiene/miners';
import {
  HYGIENE_SOURCES,
  emptyCounts,
  ratchet,
  renderRatchet,
  type HygieneItem,
  type HygieneScan,
  type HygieneSource,
} from '../src/harness/hygiene/types';
import { triageTestLog } from './test-run-triage';

// ── 路径与遍历常量 (测试引用这些, 不写字面) ─────────────────────────────────

export const HYGIENE_DIR = 'runs/hygiene';
export const BASELINE_PATH = `${HYGIENE_DIR}/baseline.json`;

/** 遍历时整棵跳过的目录名 —— 产物/依赖/账本, 不是仓库源码。 */
export const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.omd',
  '.work',
  'runs',
  'dist',
  'build',
  '.next',
  'coverage',
]);

/** 债务/TODO 扫描的根 (与 scripts/omd-debt.ts 默认根同集合)。 */
export const MARKER_ROOTS = ['src', 'scripts', 'skills', 'docs'];
/** 债务/TODO 认的后缀。 */
export const MARKER_EXTS = ['.ts', '.tsx', '.js', '.mjs', '.sh', '.md'];
/** 超长文件扫描的根与后缀。 */
export const BIG_FILE_ROOTS = ['src', 'scripts'];
export const BIG_FILE_EXTS = ['.ts', '.tsx'];
/** 陈旧文档扫的目录, 与判"被引用"读的两份真源。 */
export const PLAN_DIR = 'docs/plan';
export const REFERENCE_DOCS = ['docs/plan/NOTES.md', 'docs/docs-map.md'];

// ── IO 注入面 (取原料的三件全在这里, 测试给替身) ───────────────────────────

export interface ScanIO {
  cwd: string;
  nowMs: number;
  /** knip 报告。失败 → `ok:false` + 错误原文 (进 errors[], 不中断)。 */
  knip: () => { ok: true; report: KnipReport } | { ok: false; error: string };
  /** seam 目录漂移闸的退出码 + 输出。 */
  seamCheck: () => { ok: true; code: number; out: string } | { ok: false; error: string };
  /** `.omd/runs.db` 两张表。缺库 / 缺表 → `ok:false`。 */
  db: () =>
    | { ok: true; failedRuns: FailedRunRow[]; openForks: ForkRowLike[] }
    | { ok: false; error: string };
  /** 最近一份全量 `bun test` 日志原文。取不到 → `ok:false`。 */
  testLog: () => { ok: true; log: string } | { ok: false; error: string };
  /** HEAD sha (取不到 → 空串, 不编)。 */
  headSha: () => string;
  /**
   * 一批路径的**最近一次改动时刻** (ms)。默认取 git 提交时刻, 不是 fs mtime ——
   * worktree / 全新 clone 会把全仓 mtime 重置成 checkout 时刻, 那时 fs mtime 量的是
   * "什么时候 checkout 的", 不是"这份文档多久没动过", 陈旧类会恒为 0 (量到尺子)。
   * 取不到的路径**不进返回值** (缺席 ≠ 0), 调用方退回 fs mtime。
   */
  lastChangeMs: (paths: string[]) => Record<string, number>;
}

// ── 默认 IO: 真进程 / 真 sqlite / 真 fs ────────────────────────────────────

function runCapture(argv: string[], cwd: string): { code: number; out: string } {
  const proc = Bun.spawnSync(argv, { cwd, stdout: 'pipe', stderr: 'pipe' });
  const dec = new TextDecoder();
  return { code: proc.exitCode ?? 1, out: `${dec.decode(proc.stdout)}${dec.decode(proc.stderr)}` };
}

export function defaultScanIO(cwd: string): ScanIO {
  return {
    cwd,
    nowMs: Date.now(),
    knip: () => {
      // knip 有 finding 时退出 1 —— 那是正常读数, 不是故障。2+ 才是配置/运行错。
      const r = runCapture(['bunx', 'knip', '--no-progress', '--reporter', 'json'], cwd);
      if (r.code > 1) return { ok: false, error: `knip 退出 ${r.code}: ${r.out.slice(0, 400)}` };
      try {
        const start = r.out.indexOf('{');
        if (start < 0) return { ok: false, error: `knip 输出里没有 JSON: ${r.out.slice(0, 200)}` };
        return { ok: true, report: JSON.parse(r.out.slice(start)) as KnipReport };
      } catch (e) {
        return { ok: false, error: `knip JSON 解析失败: ${(e as Error).message}` };
      }
    },
    seamCheck: () => {
      const r = runCapture(['bun', 'scripts/gen-seam-catalog.ts', '--check'], cwd);
      return { ok: true, code: r.code, out: r.out };
    },
    db: () => {
      const path = join(cwd, '.omd/runs.db');
      if (!existsSync(path)) return { ok: false, error: `.omd/runs.db 缺席 (${path})` };
      try {
        const db = new Database(path, { readonly: true });
        try {
          const failedRuns = db
            .query(`SELECT run_id, status, error, updated_at FROM omd_runs WHERE status = 'failed'`)
            .all() as FailedRunRow[];
          let openForks: ForkRowLike[] = [];
          try {
            openForks = db
              .query(`SELECT id, run_id, question, created_at FROM omd_owner_forks WHERE status = 'open'`)
              .all() as ForkRowLike[];
          } catch (e) {
            // fork 表缺席是独立事实, 不该把失败 run 那一半也拖成"读不到"。
            openForks = [];
            console.error(`[hygiene-scan] omd_owner_forks 读取失败 (forks 计为 0): ${(e as Error).message}`);
          }
          return { ok: true, failedRuns, openForks };
        } finally {
          db.close();
        }
      } catch (e) {
        return { ok: false, error: `runs.db 读取失败: ${(e as Error).message}` };
      }
    },
    testLog: () => {
      // test-run-triage --run 把全文写在 /tmp/omd-test-run-<ts>.txt; 取最新一份。
      try {
        const files = readdirSync('/tmp')
          .filter((f) => f.startsWith('omd-test-run-') && f.endsWith('.txt'))
          .map((f) => ({ f, m: statSync(join('/tmp', f)).mtimeMs }))
          .sort((a, b) => b.m - a.m);
        if (files.length === 0) {
          return { ok: false, error: '没有 /tmp/omd-test-run-*.txt —— 先跑 bun run test:full' };
        }
        return { ok: true, log: readFileSync(join('/tmp', files[0]!.f), 'utf-8') };
      } catch (e) {
        return { ok: false, error: `测试日志读取失败: ${(e as Error).message}` };
      }
    },
    headSha: () => runCapture(['git', 'rev-parse', 'HEAD'], cwd).out.trim().slice(0, 12),
    lastChangeMs: (paths) => {
      if (paths.length === 0) return {};
      // 一趟 git log 拿全部路径的最新提交时刻 (逐文件 spawn 会是 N 次进程)。
      const r = runCapture(['git', 'log', '--format=@%ct', '--name-only', '--', ...paths], cwd);
      if (r.code !== 0) {
        console.error(`[hygiene-scan] git log 取改动时刻失败 (退回 fs mtime): ${r.out.slice(0, 200)}`);
        return {};
      }
      const out: Record<string, number> = {};
      let ts = 0;
      for (const line of r.out.split('\n')) {
        if (line.startsWith('@')) {
          ts = Number(line.slice(1)) * 1000;
          continue;
        }
        const f = line.trim();
        // git log 由新到旧 —— 首次见到某路径就是它的最新一次改动。
        if (f && ts && out[f] === undefined) out[f] = ts;
      }
      return out;
    },
  };
}

// ── fs 遍历 (纯本地, 无 spawn) ─────────────────────────────────────────────

/** 递归列文件 (相对 cwd 的 posix 路径), 跳过 SKIP_DIRS 与非目标后缀。 */
export function walkFiles(cwd: string, root: string, exts: string[]): string[] {
  const abs = join(cwd, root);
  if (!existsSync(abs)) return [];
  const out: string[] = [];
  const stack = [abs];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // 权限/竞态: 跳过这一层, 不让整趟扫描塌
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push(join(dir, e.name));
        continue;
      }
      if (!e.isFile()) continue;
      if (!exts.some((x) => e.name.endsWith(x))) continue;
      out.push(relative(cwd, join(dir, e.name)));
    }
  }
  return out.sort();
}

/** 把文件读成 `file:line:text` 的 grep 形状行 —— 喂给 mineDebt / mineTodo 的原料。 */
function grepShapedLines(cwd: string, files: string[], needle: RegExp): string[] {
  const out: string[] = [];
  for (const rel of files) {
    let text: string;
    try {
      text = readFileSync(join(cwd, rel), 'utf-8');
    } catch {
      continue;
    }
    if (!needle.test(text)) continue;
    text.split('\n').forEach((line, i) => {
      if (needle.test(line)) out.push(`${rel}:${i + 1}:${line}`);
    });
  }
  return out;
}

const DEBT_NEEDLE = /ponytail:/;
const TODO_NEEDLE = /TODO|FIXME|XXX|HACK/;

// ── 扫描主体 ──────────────────────────────────────────────────────────────

/** 九个矿源跑一遍 → HygieneScan。**纯装配**: 判断力全在 miners 里。 */
export function collectScan(io: ScanIO): HygieneScan {
  const items: HygieneItem[] = [];
  const errors: { source: HygieneSource; error: string }[] = [];

  // ① knip 四类
  const knip = io.knip();
  if (knip.ok) items.push(...mineKnip(knip.report));
  else for (const s of ['knip-files', 'knip-exports', 'knip-types', 'knip-deps'] as const) {
    errors.push({ source: s, error: knip.error });
  }

  // ② ponytail 债 / ③ TODO 家族 —— 同一趟文件清单, 两个不同的纯函数
  const markerFiles = MARKER_ROOTS.flatMap((r) => walkFiles(io.cwd, r, MARKER_EXTS));
  items.push(...mineDebt(grepShapedLines(io.cwd, markerFiles, DEBT_NEEDLE)));
  items.push(...mineTodo(grepShapedLines(io.cwd, markerFiles, TODO_NEEDLE)));

  // ④ 超长文件
  const bigCandidates = BIG_FILE_ROOTS.flatMap((r) => walkFiles(io.cwd, r, BIG_FILE_EXTS)).map((rel) => {
    let lines = 0;
    try {
      lines = readFileSync(join(io.cwd, rel), 'utf-8').split('\n').length;
    } catch {
      lines = 0;
    }
    return { path: rel, lines };
  });
  items.push(...mineBigFiles(bigCandidates));

  // ⑤ 陈旧 plan 文档
  const planPaths = walkFiles(io.cwd, PLAN_DIR, ['.md']);
  const gitTimes = io.lastChangeMs(planPaths);
  const planDocs = planPaths.map((rel) => ({
    path: rel,
    // git 提交时刻优先; 未入库的文件退回 fs mtime; 两者都取不到 → 当作"刚动过"
    // (宁可漏报不误报 —— 陈旧类的代价是删错文档)。
    mtimeMs:
      gitTimes[rel] ??
      (() => {
        try {
          return statSync(join(io.cwd, rel)).mtimeMs;
        } catch {
          return io.nowMs;
        }
      })(),
  }));
  const referenceText = REFERENCE_DOCS.map((p) => {
    try {
      return readFileSync(join(io.cwd, p), 'utf-8');
    } catch {
      return '';
    }
  }).join('\n');
  items.push(...mineStalePlans(planDocs, referenceText, io.nowMs));

  // ⑥ seam 目录漂移
  const seam = io.seamCheck();
  if (seam.ok) items.push(...mineSeamDrift({ code: seam.code, out: seam.out }));
  else errors.push({ source: 'seam-drift', error: seam.error });

  // ⑦ 测试卫生
  const log = io.testLog();
  if (log.ok) items.push(...mineTestHealth(triageTestLog(log.log)));
  else errors.push({ source: 'test-health', error: log.error });

  // ⑧ 失败 run 台账 / ⑨ 未裁 fork
  const db = io.db();
  if (db.ok) {
    items.push(...mineFailedRuns(db.failedRuns));
    items.push(...mineForks(db.openForks));
  } else {
    errors.push({ source: 'failed-runs', error: db.error });
    errors.push({ source: 'forks', error: db.error });
  }

  const counts = emptyCounts();
  for (const i of items) counts[i.source] += 1;
  return {
    version: 1,
    generatedAt: new Date(io.nowMs).toISOString(),
    sha: io.headSha(),
    counts,
    items,
    errors,
  };
}

// ── 基线 (D-2) ────────────────────────────────────────────────────────────

export interface Baseline {
  version: 1;
  generatedAt: string;
  sha: string;
  counts: Record<HygieneSource, number>;
  /** 每类的 id 清单 —— 棘轮做**真差集**的依据 (只记计数就只能列全部, 见 types.ratchet 注释)。 */
  ids: Record<HygieneSource, string[]>;
}

export function buildBaseline(scan: HygieneScan): Baseline {
  const ids = Object.fromEntries(
    HYGIENE_SOURCES.map((s) => [s, scan.items.filter((i) => i.source === s).map((i) => i.id)]),
  ) as Record<HygieneSource, string[]>;
  return { version: 1, generatedAt: scan.generatedAt, sha: scan.sha, counts: scan.counts, ids };
}

export function loadBaseline(path: string): Baseline | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as Baseline;
  } catch (e) {
    console.error(`[hygiene-scan] 基线解析失败 (${path}): ${(e as Error).message}`);
    return null;
  }
}

/** 人读的一页 counts 表 (报告与 stdout 共用)。 */
export function renderCounts(scan: HygieneScan): string {
  const lines = [`hygiene scan @ ${scan.sha || '(无 sha)'} · ${scan.generatedAt}`, '| 类 | 计数 |', '|---|---|'];
  for (const s of HYGIENE_SOURCES) lines.push(`| ${s} | ${scan.counts[s]} |`);
  lines.push(`| **合计** | **${scan.items.length}** |`);
  if (scan.errors.length) {
    lines.push('', '读不到的矿源 (counts 停在 0, 与"真是零"是两回事):');
    for (const e of scan.errors) lines.push(`  · ${e.source}: ${e.error}`);
  }
  return lines.join('\n');
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

// ── CLI ───────────────────────────────────────────────────────────────────

const USAGE = `usage: bun scripts/hygiene-scan.ts [--out <scan.json>] [--check] [--rebase] [--randomize]
  --out       写扫描结果 JSON
  --check     与 ${BASELINE_PATH} 比; 任一类计数高于基线 → 退出 1
  --rebase    用本次扫描重写基线 (人手动; 链里不自动跑)
  --randomize 附加跑 bun test --randomize --seed <日期> 抓序依赖 (周用, 默认不跑)`;

if (import.meta.main) {
  const argv = process.argv.slice(2);
  if (argv.includes('--help')) {
    console.log(USAGE);
    process.exit(0);
  }
  const flag = (name: string): boolean => argv.includes(`--${name}`);
  const val = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const cwd = val('cwd') ?? process.cwd();
  const io = defaultScanIO(cwd);

  if (flag('randomize')) {
    const seed = new Date(io.nowMs).toISOString().slice(0, 10).replace(/-/g, '');
    process.stderr.write(`[hygiene-scan] --randomize: bun test --randomize --seed ${seed} (可能很久)\n`);
    const r = runCapture(['bun', 'test', '--randomize', '--seed', seed], cwd);
    const out = `/tmp/omd-test-run-${Date.now()}.txt`;
    writeFileSync(out, r.out);
    process.stderr.write(`[hygiene-scan] 随机序日志: ${out} (退出 ${r.code})\n`);
  }

  const scan = collectScan(io);
  const outPath = val('out');
  if (outPath) writeJson(outPath, scan);
  console.log(renderCounts(scan));

  if (flag('rebase')) {
    writeJson(join(cwd, BASELINE_PATH), buildBaseline(scan));
    console.log(`基线已重写: ${BASELINE_PATH}`);
    process.exit(0);
  }

  if (flag('check')) {
    const base = loadBaseline(join(cwd, BASELINE_PATH));
    if (!base) {
      console.error(`[hygiene-scan] --check 需要基线 ${BASELINE_PATH}; 先跑一次 --rebase`);
      process.exit(1);
    }
    const verdict = ratchet(base.counts, scan, base.ids);
    console.log(renderRatchet(verdict));
    process.exit(verdict.ok ? 0 : 1);
  }
  process.exit(0);
}
