#!/usr/bin/env bun
/**
 * scripts/probes/exec-fork-metrics.ts — exec-fork 实验读数抽取器 (契约 execute::3tliwmwch7vbj)。
 *
 * 职责: 从本机 checkpoint 账本 (`.omd/continuity/<runId>/<nodeId>.json`, 真源见
 * `src/harness/continuity/checkpoint-manager.ts` 的 `runDir()`) 抽取一路的 token in/out、
 * cache-read/-write 首值、墙钟、verify 结果, 写成契约 §5 定义的 `PathReading`。
 *
 * 不改 src/ 下任何文件、不发新的模型调用 —— 纯读账本 + 现有 verify 产物。
 *
 * ── 字段真源 (R6 核验过的锚点, 供下游改动前复核) ─────────────────────────────
 *   - ModelUsage {in,out,cacheHit?}      src/model/types.ts:83-91
 *   - Claude cacheHit = cache_read_input_tokens   src/model/claude-sdk-complete.ts:106-112,
 *     归一处 src/harness/claude-sdk-loop.ts:105-112 (`:107` const cacheHit = ...)
 *   - cacheHit ⊆ in, OUTPUT 不含缓存段         src/model/types.ts:88-89
 *   - checkpoint.tokenUsage / durationMs / createdAt   src/harness/continuity/types.ts:149,151
 *   - runDir() = OMD_DATA_HOME 设 → dataPath('continuity') / 未设 → repoRoot/.omd/continuity
 *     src/harness/continuity/checkpoint-manager.ts:41-46
 *   - loadAllGreen 遍历 <runDir>/<nodeId>.json, 跳过 .tmp / __rN 覆写归档
 *     src/harness/continuity/checkpoint-manager.ts:360-380
 *
 * ⚠ DeepSeek 侧 `prompt_cache_hit_tokens` 归一路径本仓未见任何真实赋值点 (rg 全库为空,
 *   仅 types.ts 注释提及) —— 若被测路径座位落在 DeepSeek, `cacheReadInputTokensFirst` 记
 *   `entry:"ran_miss"`, 不得凭注释假造数值。
 *
 * costUsd 不是信号 (契约 §6): 本文件不读取、不打印任何 costUsd 字段作为判据; --report 模式
 * 若需展示成本行, 必须显式标注"非信号"且不参与任何比较。
 */

import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

// ─── 类型 (与契约 §5 schema 逐字对齐, 不引入新字段) ─────────────────────────

type Entry = 'not_run' | 'ran_miss' | 'na' | 'ran';

interface QuotaWall {
  hit: boolean;
  rawError: string | null;
}

interface PathReading {
  pathId: string;
  goal: string;
  entry: Entry;
  wallclockMs: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
  cacheReadInputTokensFirst: number | null;
  cacheCreationInputTokensFirst: number | null;
  contextRebuilt: boolean | null;
  verifyPassed: boolean | null;
  quotaWall: QuotaWall;
}

// ── checkpoint 账本上的原始形状 (子集, 仅取本探针需要的字段) ─────────────────
interface RawModelUsage {
  in: number;
  out: number;
  cacheHit?: number;
}

interface RawCheckpoint {
  nodeId: string;
  leafKind: string;
  status: 'done' | 'failed' | 'skipped';
  model?: string;
  tokenUsage: RawModelUsage | null;
  summary: string;
  outputText?: string | null;
  durationMs: number;
  createdAt: string;
}

const QUOTA_WALL_RE = /GoUsageLimitError|insufficient_quota|usage_limit_reached|rate_limit|quota exceeded/i;

/** runDir 真源: src/harness/continuity/checkpoint-manager.ts:41-46 (OMD_DATA_HOME 优先)。 */
function runDir(repoRoot: string, runId: string): string {
  const dataHome = process.env.OMD_DATA_HOME?.trim();
  if (dataHome) {
    // dataPath() 内部拼 `<OMD_DATA_HOME>/<projectSlug>/continuity` — 本探针不复刻 slug 推导逻辑
    // (那属于 src/harness/project-scope.ts 内部机制), 只在未设 OMD_DATA_HOME 的常见路径上工作;
    // 设了但探针找不到目录时,调用方会看到 entry:"ran_miss" 而非静默假数据。
    return join(dataHome, 'continuity', runId);
  }
  return join(repoRoot, '.omd', 'continuity', runId);
}

/** 读某个 run 下某节点最新的 checkpoint JSON (跳过 .tmp / __rN 覆写归档,同 loadAllGreen 语义)。 */
function readCheckpoint(repoRoot: string, runId: string, nodeId: string): RawCheckpoint | null {
  const dir = runDir(repoRoot, runId);
  const file = join(dir, `${nodeId}.json`);
  if (!existsSync(file)) return null;
  try {
    const raw = readFileSync(file, 'utf-8');
    return JSON.parse(raw) as RawCheckpoint;
  } catch {
    return null; // 损坏/未完成写 → 视为不存在,调用方按 entry:"ran_miss" 处理
  }
}

/** 列出某 run 下所有 checkpoint 的 nodeId (用于 --run 模式自动发现)。 */
function listNodeIds(repoRoot: string, runId: string): string[] {
  const dir = runDir(repoRoot, runId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json') && f !== '_dag.json' && !f.endsWith('.tmp') && !/\.__r\d+\.json$/.test(f))
    .map((f) => f.slice(0, -5));
}

interface ExtractOpts {
  repoRoot: string;
  runId: string;
  nodeId: string;
  pathId: string;
  goal: string;
  /** worktree 路径 — 传了才做 verify.sh 重跑 + git status 审计 (契约 §5 verifyPassed 三条件)。 */
  worktree?: string;
  /** 上游 stall/quota 报错原文,没有就传 undefined。 */
  quotaError?: string;
}

/** 核心抽取: 一路 checkpoint → 一份 PathReading。缺项一律 null,entry 按三态判定,不补 0。 */
function extractPathReading(opts: ExtractOpts): PathReading {
  const cp = readCheckpoint(opts.repoRoot, opts.runId, opts.nodeId);

  const quotaHit = opts.quotaError !== undefined && QUOTA_WALL_RE.test(opts.quotaError);
  const quotaWall: QuotaWall = { hit: quotaHit, rawError: opts.quotaError ?? null };

  if (!cp) {
    // 没跑 或 跑了但账本上没有: 探针无法区分这两种 —— 上游调用方(实验脚本)若确知"没跑"
    // 应直接构造 entry:"not_run" 的记录,不经本函数。走到这里默认按"跑了但没记上"处理。
    return {
      pathId: opts.pathId,
      goal: opts.goal,
      entry: 'ran_miss',
      wallclockMs: null,
      tokensIn: null,
      tokensOut: null,
      cacheReadInputTokensFirst: null,
      cacheCreationInputTokensFirst: null,
      contextRebuilt: null,
      verifyPassed: null,
      quotaWall,
    };
  }

  if (cp.status !== 'done') {
    // failed/skipped checkpoint 确实存在但不是本契约要的"跑完"读数 —— 记 ran_miss,原文态保留在 quotaWall/summary 之外不重复搬运。
    return {
      pathId: opts.pathId,
      goal: opts.goal,
      entry: 'ran_miss',
      wallclockMs: cp.durationMs ?? null,
      tokensIn: cp.tokenUsage?.in ?? null,
      tokensOut: cp.tokenUsage?.out ?? null,
      cacheReadInputTokensFirst: cp.tokenUsage?.cacheHit ?? null,
      cacheCreationInputTokensFirst: null, // ModelUsage 无独立 cacheWrite 字段, 见 types.ts:83-91
      contextRebuilt: null,
      verifyPassed: false,
      quotaWall,
    };
  }

  const output = cp.summary ?? '';
  const contextRebuilt = /CONTRACT-FACT-3TLIWMWCH7VBJ/.test(output) ? true : null;
  // null 而非 false: summary 是 ≤800 字截断 (D-O), 事实可能落在被截掉的尾部 —— 探针只能证真,不能证伪。
  // 需要精确判否时,调用方应传 outputText 全文另行核验 (本探针不在此处重新实现 D-O 全文读取)。

  let verifyPassed: boolean | null = null;
  if (opts.worktree) {
    verifyPassed = auditVerify(opts.worktree, output);
  }

  return {
    pathId: opts.pathId,
    goal: opts.goal,
    entry: 'ran',
    wallclockMs: cp.durationMs ?? null,
    tokensIn: cp.tokenUsage?.in ?? null,
    tokensOut: cp.tokenUsage?.out ?? null,
    cacheReadInputTokensFirst: cp.tokenUsage?.cacheHit ?? null,
    cacheCreationInputTokensFirst: null,
    contextRebuilt,
    verifyPassed,
    quotaWall,
  };
}

/** 契约 §5 verifyPassed 三条件: (1) 本地重跑 verify.sh exit0 (2) 输出首行匹配 (3) worktree 审计只允许 ` M task.py`。 */
function auditVerify(worktree: string, output: string): boolean {
  const firstLine = output.split('\n')[0]?.trim();
  if (firstLine !== 'RESULT-STATUS: pass') return false;

  try {
    execFileSync('bash', ['verify.sh'], { cwd: worktree, stdio: 'ignore' });
  } catch {
    return false;
  }

  let status: string;
  try {
    status = execFileSync('git', ['-C', worktree, 'status', '--porcelain'], { encoding: 'utf-8' });
  } catch {
    return false;
  }
  const lines = status.split('\n').filter((l) => l.length > 0);
  return lines.length === 1 && lines[0] === ' M task.py';
}

// ─── --report 模式: 跨 arm 打印读数表 ────────────────────────────────────────

const READINGS_DIR = join(import.meta.dir, 'readings');
const AB_PROBE_FILE = join(READINGS_DIR, 'ab-probe.json');
const BASELINE_FILE = join(READINGS_DIR, 'baseline.json');
const CONTROL_FILE = join(READINGS_DIR, 'control.json');
const TREATMENT_FILE = join(READINGS_DIR, 'treatment.json');

/** 契约 §7 钉死的四个合法文件名 —— readdirSync 之外的任何 *.json 一律视为错名。 */
const EXPECTED_NAMES = new Set(['ab-probe.json', 'baseline.json', 'control.json', 'treatment.json']);
const VALID_ENTRIES = new Set(['not_run', 'ran_miss', 'na', 'ran']);

function loadArmFile(path: string): unknown | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

function fmt(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** 一行人读摘要 + 把违规原因推进 violations (不在此处决定退出码)。 */
function reportRow(label: string, path: string, violations: string[]): string {
  const data = loadArmFile(path);
  if (data === null) {
    violations.push(`${label}: 文件缺失或非法 JSON (${path})`);
    return `${label.padEnd(10)} | missing (${path})`;
  }
  const obj = data as Record<string, unknown>;
  const entry = obj.entry;
  if (typeof entry !== 'string' || !VALID_ENTRIES.has(entry)) {
    violations.push(`${label}: entry 缺失或非法 (${fmt(entry)}), 须 ∈ {${[...VALID_ENTRIES].join('|')}}`);
  }
  const wall = obj.armWallclockMaxMs ?? obj.wallclockMs ?? null;
  // entry 非 'ran' 时不该有已跑完的读数 —— wall===0 是"没跑却写成 0"的典型误编码, 该是 null。
  if (entry !== 'ran' && wall === 0) {
    violations.push(`${label}: entry=${fmt(entry)} 但墙钟读数=0 (应为 null, 缺项不得编码成 0)`);
  }
  return `${label.padEnd(10)} | entry=${fmt(entry)} armWallclockMaxMs=${fmt(wall)} raw_keys=${Object.keys(obj).join(',')}`;
}

/** 扫 readings/ 下所有 *.json, 揪出契约禁用的文件名 (如 ab-baseline.json / manifest.json)。 */
function checkStrayFiles(violations: string[]): void {
  if (!existsSync(READINGS_DIR)) return;
  for (const f of readdirSync(READINGS_DIR)) {
    if (!f.endsWith('.json')) continue;
    if (!EXPECTED_NAMES.has(f)) {
      violations.push(`stray 文件: readings/${f} 不在契约 §7 允许名单 {${[...EXPECTED_NAMES].join(',')}} 内`);
    }
  }
}

function runReport(): void {
  const violations: string[] = [];
  console.log('# exec-fork readings report (契约 execute::3tliwmwch7vbj §5/§7)');
  console.log('# 非信号提示: costUsd 不打印/不比较 — 订阅坐标 costUsd=null, 合计恒等于 deepseek 一条线。');
  console.log('');
  console.log(reportRow('ab-probe', AB_PROBE_FILE, violations));
  console.log(reportRow('baseline', BASELINE_FILE, violations));
  console.log(reportRow('control', CONTROL_FILE, violations));
  console.log(reportRow('treatment', TREATMENT_FILE, violations));
  checkStrayFiles(violations);
  console.log('');
  if (violations.length > 0) {
    console.log('# VIOLATIONS (§7 反向自检 — 文件名或 entry 缺失/非法, 或缺项被编码成 0):');
    for (const v of violations) console.log(`#   - ${v}`);
    process.exit(1);
  }
  console.log('# 四文件名与 entry 三态均合规, 退出码 0。');
  process.exit(0);
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

function main(): void {
  const args = process.argv.slice(2);
  if (args.includes('--report')) {
    runReport();
    return;
  }

  if (args.includes('--extract')) {
    // 用法: --extract --repoRoot R --runId ID --nodeId N --pathId P --goal G [--worktree W] [--quotaError E]
    const get = (flag: string): string | undefined => {
      const i = args.indexOf(flag);
      return i >= 0 ? args[i + 1] : undefined;
    };
    const repoRoot = get('--repoRoot');
    const runId = get('--runId');
    const nodeId = get('--nodeId');
    const pathId = get('--pathId');
    const goal = get('--goal');
    if (!repoRoot || !runId || !nodeId || !pathId || !goal) {
      console.error('缺必填参数: --repoRoot --runId --nodeId --pathId --goal');
      process.exit(1);
    }
    const reading = extractPathReading({
      repoRoot,
      runId,
      nodeId,
      pathId,
      goal,
      worktree: get('--worktree'),
      quotaError: get('--quotaError'),
    });
    console.log(JSON.stringify(reading, null, 2));
    return;
  }

  console.error('用法: bun run scripts/probes/exec-fork-metrics.ts --report');
  console.error('  或: bun run scripts/probes/exec-fork-metrics.ts --extract --repoRoot R --runId ID --nodeId N --pathId P --goal G [--worktree W] [--quotaError E]');
  process.exit(1);
}

main();

export { extractPathReading, readCheckpoint, listNodeIds, auditVerify, runDir };
export type { PathReading, Entry, QuotaWall, RawCheckpoint, ExtractOpts };

// 未使用 writeFileSync/mkdirSync/listNodeIds 若被 tsc noUnusedLocals 标红,保留是因为下游
// 调用方(三份 arm run 脚本)会 import 这些导出组装 manifest/arm JSON — 本文件只提供抽取原语。
void writeFileSync;
void mkdirSync;
