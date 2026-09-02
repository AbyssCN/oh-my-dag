/**
 * src/harness/hygiene/miners —— 九个矿源的**纯函数**面 (零 LLM, 零 IO, 零 spawn)。
 *
 * 契约 D-1: 每个矿源一个 `mine*(raw) → HygieneItem[]`, IO 与 spawn 全在 CLI
 * (`scripts/hygiene-scan.ts`) 里。这样切开的理由不是洁癖 ——
 * GWT-1 要求「扫描零 LLM」可被机械核实, 而一个不 import 任何模型件、不起进程的
 * 纯函数层, 是这条闸唯一能站住的地基 (见 hygiene-scan.test.ts 的 import 白名单)。
 *
 * ## id 稳定性 (棘轮做差集的前提)
 *
 * 同一处腐败跨两次扫描必须得到同一个 id。行号会漂, 所以带正文的类 (debt / todo /
 * test-health) 用 `<file>#<正文 djb2 hash>` 而不是 `<file>:<line>` —— 挪一行代码
 * 不该被棘轮读成"新增一条债"。行号仍然记进 `line` 字段, 只是不进 id。
 */
import { parseDebtLine } from '../slim/debt-scan';
import {
  BIG_FILE_LINE_THRESHOLD,
  MAX_CLUSTER_SAMPLES,
  STALE_PLAN_DAYS,
  type HygieneItem,
} from './types';

// ── 小工具 ────────────────────────────────────────────────────────────────

/** djb2, 8 位十六进制。只用来做 id 的稳定后缀, 不做安全用途。 */
export function shortHash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, '0');
}

/** 剥 ANSI —— 引擎判词进过终端, 原样进 id 会把颜色码当成内容。 */
export function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, '');
}

/** `file:line:text` 形状的 grep 行 → 三段 (不符合形状 → null, 如 "Binary file matches")。 */
export function parseGrepLine(line: string): { file: string; line: number; text: string } | null {
  const m = /^(.+?):(\d+):(.*)$/.exec(line);
  if (!m) return null;
  return { file: m[1]!, line: Number(m[2]), text: m[3]! };
}

// ── ① knip (四类) ─────────────────────────────────────────────────────────

/** `bunx knip --reporter json` 的行形状 (只取用得上的键; 其余忽略)。 */
export interface KnipIssueRow {
  file: string;
  files?: { name: string }[];
  exports?: { name: string; line?: number }[];
  types?: { name: string; line?: number }[];
  dependencies?: { name: string; line?: number }[];
  devDependencies?: { name: string; line?: number }[];
  unlisted?: { name: string }[];
}
export interface KnipReport {
  issues?: KnipIssueRow[];
}

/**
 * knip JSON → 四类 item (`knip-files` / `knip-exports` / `knip-types` / `knip-deps`)。
 * `dependencies` 与 `devDependencies` 合成 `knip-deps` 一类, 用 `metrics.dev` 区分
 * (0/1), 不合成一个抹平两者的字符串。
 */
export function mineKnip(raw: KnipReport): HygieneItem[] {
  const out: HygieneItem[] = [];
  for (const row of raw.issues ?? []) {
    for (const f of row.files ?? []) {
      out.push({
        id: `knip-files:${f.name}`,
        source: 'knip-files',
        path: f.name,
        summary: `死文件: ${f.name} 无任何 import 边`,
        evidence: [`knip files: ${f.name}`],
      });
    }
    for (const e of row.exports ?? []) {
      out.push({
        id: `knip-exports:${row.file}#${e.name}`,
        source: 'knip-exports',
        path: row.file,
        ...(e.line === undefined ? {} : { line: e.line }),
        symbol: e.name,
        summary: `死导出: ${row.file} 的 ${e.name} 无外部引用`,
        evidence: [`knip exports: ${row.file}:${e.line ?? '?'} ${e.name}`],
      });
    }
    for (const t of row.types ?? []) {
      out.push({
        id: `knip-types:${row.file}#${t.name}`,
        source: 'knip-types',
        path: row.file,
        ...(t.line === undefined ? {} : { line: t.line }),
        symbol: t.name,
        summary: `死类型: ${row.file} 的 ${t.name} 无外部引用`,
        evidence: [`knip types: ${row.file}:${t.line ?? '?'} ${t.name}`],
      });
    }
    const deps: { name: string; dev: number }[] = [
      ...(row.dependencies ?? []).map((d) => ({ name: d.name, dev: 0 })),
      ...(row.devDependencies ?? []).map((d) => ({ name: d.name, dev: 1 })),
    ];
    for (const d of deps) {
      out.push({
        id: `knip-deps:${d.name}`,
        source: 'knip-deps',
        path: row.file,
        symbol: d.name,
        summary: `未被引用的${d.dev ? ' devDependency' : '依赖'}: ${d.name}`,
        evidence: [`knip ${d.dev ? 'devDependencies' : 'dependencies'}: ${d.name}`],
        metrics: { dev: d.dev },
      });
    }
  }
  return out;
}

// ── ② ponytail: 债务台账 ──────────────────────────────────────────────────

/**
 * `ugrep -rnE '(#|//|/\*)\s*ponytail:'` 的输出行 → debt item。
 * 解析真理源仍是 `src/harness/slim/debt-scan.ts`(grep 只是候选定位), 与
 * `scripts/omd-debt.ts` 同一套 —— 两处对"什么算标记"的判断不许分叉。
 */
export function mineDebt(grepLines: string[]): HygieneItem[] {
  const out: HygieneItem[] = [];
  for (const line of grepLines) {
    const g = parseGrepLine(line);
    if (!g) continue;
    const parsed = parseDebtLine(g.text);
    if (!parsed) continue;
    out.push({
      id: `debt:${g.file}#${shortHash(`${parsed.ceiling}|${parsed.upgrade}`)}`,
      source: 'debt',
      path: g.file,
      line: g.line,
      summary: `ponytail 债: ${parsed.ceiling}`,
      evidence: [`${g.file}:${g.line} — ceiling: ${parsed.ceiling}. upgrade: ${parsed.upgrade}`],
      // upgrade 缺席 ('-') = 静默腐烂风险, 单独一列记, 别混进 summary 文字。
      metrics: { noUpgradeTrigger: parsed.upgrade === '-' ? 1 : 0 },
    });
  }
  return out;
}

// ── ③ TODO / FIXME / XXX / HACK ───────────────────────────────────────────

/** 认的四个词 (顺序进错误文本, 测试引用这个常量)。 */
export const TODO_MARKERS = ['TODO', 'FIXME', 'XXX', 'HACK'] as const;
const TODO_RE = new RegExp(`(?:#|//|/\\*|\\*)\\s*(${TODO_MARKERS.join('|')})\\b[:：]?\\s*(.*)$`);

/** grep 行 → todo item。前缀强制同 debt: 注释符后紧跟标记词才算。 */
export function mineTodo(grepLines: string[]): HygieneItem[] {
  const out: HygieneItem[] = [];
  for (const line of grepLines) {
    const g = parseGrepLine(line);
    if (!g) continue;
    const m = TODO_RE.exec(g.text);
    if (!m) continue;
    const body = m[2]!.replace(/\*\/\s*$/, '').trim();
    out.push({
      id: `todo:${g.file}#${shortHash(`${m[1]}|${body}`)}`,
      source: 'todo',
      path: g.file,
      line: g.line,
      symbol: m[1]!,
      summary: `${m[1]}: ${body || '(无正文)'}`,
      evidence: [`${g.file}:${g.line}: ${g.text.trim()}`],
    });
  }
  return out;
}

// ── ④ 超长文件 ────────────────────────────────────────────────────────────

/** 行数已知的文件清单 → 超阈值项 (严格大于 `BIG_FILE_LINE_THRESHOLD`)。 */
export function mineBigFiles(files: { path: string; lines: number }[]): HygieneItem[] {
  return files
    .filter((f) => f.lines > BIG_FILE_LINE_THRESHOLD)
    .sort((a, b) => b.lines - a.lines)
    .map((f) => ({
      id: `big-file:${f.path}`,
      source: 'big-file' as const,
      path: f.path,
      summary: `超长文件: ${f.path} 共 ${f.lines} 行 (阈值 ${BIG_FILE_LINE_THRESHOLD})`,
      evidence: [`${f.path}: ${f.lines} 行`],
      metrics: { lines: f.lines, threshold: BIG_FILE_LINE_THRESHOLD },
    }));
}

// ── ⑤ 陈旧 plan 文档 ──────────────────────────────────────────────────────

/**
 * `docs/plan/*.md` 里 mtime 早于 `STALE_PLAN_DAYS` 天 **且** 没被引用的。
 * `referencedText` = NOTES.md + docs-map.md 的正文拼接; 判"被引用"= 路径或文件名出现在里面。
 * 两个条件缺一不可 —— 老而仍被引用的决策记录不是腐败, 是档案。
 */
export function mineStalePlans(
  docs: { path: string; mtimeMs: number }[],
  referencedText: string,
  nowMs: number,
): HygieneItem[] {
  const cutoff = nowMs - STALE_PLAN_DAYS * 24 * 60 * 60 * 1000;
  const out: HygieneItem[] = [];
  for (const d of docs) {
    if (d.mtimeMs >= cutoff) continue;
    const base = d.path.split('/').pop() ?? d.path;
    if (referencedText.includes(d.path) || referencedText.includes(base)) continue;
    const ageDays = Math.floor((nowMs - d.mtimeMs) / (24 * 60 * 60 * 1000));
    out.push({
      id: `stale-plan:${d.path}`,
      source: 'stale-plan',
      path: d.path,
      summary: `陈旧 plan: ${base} 静置 ${ageDays} 天且未被 NOTES/docs-map 引用`,
      evidence: [`${d.path}: mtime 距今 ${ageDays} 天, 引用计数 0`],
      metrics: { ageDays, thresholdDays: STALE_PLAN_DAYS },
    });
  }
  return out;
}

// ── ⑥ seam 目录漂移 ───────────────────────────────────────────────────────

/** seam 目录的盘上路径 —— id 与 `path` 共用同一个值 (写两遍就会漂)。 */
export const SEAM_CATALOG_PATH = 'docs/architecture/seams.md';

/**
 * `bun scripts/gen-seam-catalog.ts --check` 的退出码 + 输出 → 0 或 1 条 item。
 * 退出 0 = 不漂 → 空数组 (不是"读不到", 那是 errors[] 的事)。
 */
export function mineSeamDrift(res: { code: number; out: string }): HygieneItem[] {
  if (res.code === 0) return [];
  return [
    {
      id: `seam-drift:${SEAM_CATALOG_PATH}`,
      source: 'seam-drift',
      path: SEAM_CATALOG_PATH,
      summary: 'seam 目录与类型真源漂移 (gen-seam-catalog --check 退出非 0)',
      evidence: [stripAnsi(res.out).trim().split('\n').slice(0, 5).join('\n')],
      metrics: { exitCode: res.code },
    },
  ];
}

// ── ⑦ 测试卫生 ────────────────────────────────────────────────────────────

/** `scripts/test-run-triage.ts` 的 `Triage` 的结构等价面 (避免 src → scripts 的 import 边)。 */
export interface TestTriageLike {
  failures: { kind: string; test: string; evidence: string }[];
  totals: { pass: number | null; fail: number | null; skip: number | null };
}

/**
 * 三类判词 → test-health item, 一条失败一项。
 * ⚠ `runner-timeout` 那一类在 summary 里标死「夹具的界漏了, 禁记 flaky」——
 * 分类语义的真源是 `scripts/test-run-triage.ts` 的文件头, 这里只是把它搬进票面。
 */
export function mineTestHealth(triage: TestTriageLike): HygieneItem[] {
  return triage.failures.map((f) => ({
    id: `test-health:${f.kind}:${shortHash(f.test)}`,
    source: 'test-health' as const,
    symbol: f.test,
    summary: `${f.kind}: ${f.test}`,
    evidence: [f.evidence],
    metrics: {
      pass: triage.totals.pass,
      fail: triage.totals.fail,
      skip: triage.totals.skip,
    },
  }));
}

// ── ⑧ 失败 run 台账 (聚类) ────────────────────────────────────────────────

export interface FailedRunRow {
  run_id: string;
  status: string;
  error: string | null;
  updated_at?: string | null;
}

/** 判词首行里的「终止原因: X」——引擎的机械分类, 优先于自由文本。 */
const REASON_RE = /终止原因:\s*([^\s(·]+)/;

/** 一条判词 → 簇名。有「终止原因」取它; 没有则取剥色后的首行前 60 字。 */
export function clusterKeyOf(error: string | null): string {
  if (!error) return '(无判词)';
  const first = stripAnsi(error).split('\n')[0]!.trim();
  const m = REASON_RE.exec(first);
  if (m) return m[1]!;
  return first.slice(0, 60) || '(空判词)';
}

/**
 * 失败 run 行 → **每簇一项** (D-7: 聚类成票, 不是逐条成票)。
 * `metrics.count` = 簇大小; evidence 头一条是首个判词原文, 后跟 ≤ 3 个样本 runId。
 */
export function mineFailedRuns(rows: FailedRunRow[]): HygieneItem[] {
  const byCluster = new Map<string, FailedRunRow[]>();
  for (const r of rows) {
    const k = clusterKeyOf(r.error);
    const arr = byCluster.get(k) ?? [];
    arr.push(r);
    byCluster.set(k, arr);
  }
  return [...byCluster.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([key, group]) => ({
      id: `failed-runs:${key}`,
      source: 'failed-runs' as const,
      symbol: key,
      summary: `失败 run 簇「${key}」共 ${group.length} 条`,
      evidence: [
        stripAnsi(group[0]!.error ?? '(无判词)').split('\n')[0]!.trim(),
        `样本 runId: ${group.slice(0, MAX_CLUSTER_SAMPLES).map((g) => g.run_id).join(', ')}`,
      ],
      metrics: { count: group.length },
    }));
}

// ── ⑨ owner-inbox 未裁 fork ───────────────────────────────────────────────

export interface ForkRowLike {
  id: string;
  run_id: string;
  question: string;
  created_at?: string | null;
}

/** 未裁 fork 逐条一项 (数量本来就小; D-7 的汇总票在 hygiene-tickets 里做)。 */
export function mineForks(rows: ForkRowLike[]): HygieneItem[] {
  return rows.map((r) => ({
    id: `forks:${r.id}`,
    source: 'forks' as const,
    symbol: r.id,
    summary: `未裁 fork: ${r.question.slice(0, 80)}`,
    evidence: [`fork ${r.id} (run ${r.run_id}) 自 ${r.created_at ?? '?'} 起 open`],
  }));
}
