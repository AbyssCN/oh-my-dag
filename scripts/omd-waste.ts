#!/usr/bin/env bun
/**
 * scripts/omd-waste —— **C-2 浪费尺子 CLI** (2026-08-20, P0 尺子与并发地基)。
 *
 * 零 LLM。读 `.omd/dag-runs.db`,印四个数 (nodeWasteTokens / handoffTax /
 * cacheHitRate / waveWidth),每个数带 `n` 与 `unknownRuns`(INV-5)。
 *
 * 库为空 / 文件不在 / 表缺列 → 印零 + unknownRuns=0,不抛异常 (GWT-2b)。
 *
 * ## 覆盖面边界 (INV-6)
 *
 * 本尺子只看 `omd_dag_runs` 的 C-1 五列(`tokensIn`/`Out`/`cacheHit`/`durationMs`/
 * `turns`),与 `seat-usage.jsonl` **不交叉校验** —— 后者的 `entry:'call' / 'node'`
 * 行由 INV-2 / GWT-1b 钉(本片不接)。`dream/extract-*` 直调 `callModel` 而不经 `send`,
 * 仍未纳入采集,**按座位求和是下界** —— 这一行必须原样印出。
 *
 * ## 用法
 *
 *   bun run scripts/omd-waste.ts                       # 默认 .omd/dag-runs.db
 *   bun run scripts/omd-waste.ts --db <path>           # 显式指定
 *   bun run scripts/omd-waste.ts --json                # 机器可读
 *
 * 退出码: 0 成功 (空库合法) · 1 内部错。
 */
import { ledgerPath } from '../src/harness/dag-record';
import {
  computeWaste,
  readDagRuns,
  type WasteMetric,
  type WasteReport,
  type WaveWidthHistogram,
} from '../src/harness/waste/report';

function parseArgs(argv: string[]): { dbPath: string; json: boolean } {
  let dbPath = ledgerPath();
  let json = false;
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--db' && i + 1 < argv.length) {
      dbPath = argv[++i]!;
    } else if (a === '--json') {
      json = true;
    } else if (a === '--help' || a === '-h') {
      console.log('用法: bun run scripts/omd-waste.ts [--db <path>] [--json]');
      process.exit(0);
    } else {
      console.error(`omd-waste: 未知参数 ${a}`);
      process.exit(2);
    }
  }
  return { dbPath, json };
}

function formatRatio(v: number): string {
  return `${(v * 100).toFixed(2)}%`;
}

function formatHist(h: WaveWidthHistogram | null): string {
  if (h === null) return '(null)';
  if (h.length === 0) return '(空)';
  return h.map((b) => `${b.width}:${b.runs}`).join(' ');
}

function formatMetric<T>(label: string, m: WasteMetric<T>, fmt: (v: T | null) => string): string {
  return `${label.padEnd(16)} ${fmt(m.value).padStart(10)}   n=${m.n}  unknownRuns=${m.unknownRuns}`;
}

/** INV-6 边界声明 —— 字面照搬,标点也照搬(契约那一行就是这么写的)。 */
const COVERAGE_BOUNDARY = 'dream/extract-* 未纳入采集, 按座位求和是下界';

function fmtRatio(v: number | null): string {
  return v === null ? '(null)' : formatRatio(v);
}

function printHuman(report: WasteReport): void {
  console.log('omd-waste — 浪费尺子 (C-2, 2026-08-20)');
  console.log('');
  console.log(formatMetric('nodeWasteTokens', report.nodeWasteTokens, fmtRatio));
  console.log(formatMetric('handoffTax', report.handoffTax, fmtRatio));
  console.log(formatMetric('cacheHitRate', report.cacheHitRate, fmtRatio));
  console.log(formatMetric('waveWidth', report.waveWidth, formatHist));
  console.log('');
  // 顶层 missingColumns —— 解释 value=null 的原因;C-2 契约明文要求印出。
  console.log(`missingColumns: ${report.missingColumns.length === 0 ? '(无)' : report.missingColumns.join(', ')}`);
  console.log('');
  console.log(COVERAGE_BOUNDARY);
}

function printJson(report: WasteReport): void {
  console.log(JSON.stringify({ ...report, coverageBoundary: COVERAGE_BOUNDARY }, null, 2));
}

if (import.meta.main) {
  try {
    const { dbPath, json } = parseArgs(process.argv);
    const records = readDagRuns(dbPath);
    const report = computeWaste(records);
    if (json) printJson(report);
    else printHuman(report);
  } catch (err) {
    console.error(`omd-waste: 内部错 — ${(err as Error).message}`);
    process.exit(1);
  }
}