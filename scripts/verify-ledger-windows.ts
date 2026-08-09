#!/usr/bin/env bun
/**
 * scripts/verify-ledger-windows —— 真实 omd transcript 窗口回归脚本 (契约 S6, 仅脚本不进 src)。
 *
 * 重跑 A/B 两窗口对拍实测报告基线 (docs/plan/2026-08-06-ledger-移植可行性-实测报告.md 表格):
 * A = d3d015a7-9991-474c-98f7-9fb49ae84e45.jsonl 窗口 1-191, B = 64ebe7dc-1308-43a9-b0c6-f4d7df672ee0.jsonl
 * 窗口 1-485 (仓外 ~/.claude/projects/, --transcript 可覆盖)。基线数值冻结自实测报告 (:15,:17,:25,:27,:40);
 * 任一行 FAIL → 退出码 1。
 *
 *   bun run scripts/verify-ledger-windows.ts --window a [--transcript <path>]
 *   bun run scripts/verify-ledger-windows.ts --window b [--transcript <path>]
 *
 * 双通道对拍:① 本脚本自扫原文 (usage 4 键数据侧覆盖 / line.type 分布 / tool_use 抽取材料 /
 * 三键 bucket 公式独立复算);② parseStopLedger (src/harness/session/stop-ledger.ts) 整窗解析 ——
 * 两条通道逐条对拍 tokenBucket (记账接缝一致性)。
 *
 * lastUserAsk 期望值按硬化后语义 (契约 D-4):A 窗口 skill 前导 @161 被 skip+continue 穿透到真实
 * ask @157 —— 旧实测报告记 blocked@161 为硬化前行为, 非回归。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { parseStopLedger, type LastUserAsk } from '../src/harness/session/stop-ledger';

// ─── 冻结基线 (实测报告数值, 勿改) ─────────────────────────────────────────────

const NAMED_TYPES = [
  'ai-title',
  'queue-operation',
  'attachment',
  'last-prompt',
  'mode',
  'permission-mode',
  'bridge-session',
  'file-history-snapshot',
  'custom-title',
] as const;

const FOUR_KEYS = ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'output_tokens'] as const;
const THREE_KEYS = ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'] as const;

const TRANSCRIPT_DIR = join(homedir(), '.claude', 'projects', '-home-nick-repos-oh-my-dag');

interface WindowSpec {
  readonly name: 'a' | 'b';
  readonly defaultTranscript: string;
  readonly start: number;
  readonly end: number;
  readonly windowLines: number;
  readonly assistant: number;
  readonly maxBucket: number;
  readonly maxBucketLine: number;
  readonly toolUse: number;
  readonly gitCommitBash: number;
  readonly typeKinds: number;
  readonly namedTypesSeen: number;
  readonly lastUserAskLine: number;
}

const WINDOWS: Record<'a' | 'b', WindowSpec> = {
  a: {
    name: 'a',
    defaultTranscript: join(TRANSCRIPT_DIR, 'd3d015a7-9991-474c-98f7-9fb49ae84e45.jsonl'),
    start: 1,
    end: 191,
    windowLines: 191,
    assistant: 82,
    maxBucket: 226451,
    maxBucketLine: 189,
    toolUse: 32,
    gitCommitBash: 0,
    typeKinds: 7,
    namedTypesSeen: 4,
    lastUserAskLine: 157,
  },
  b: {
    name: 'b',
    defaultTranscript: join(TRANSCRIPT_DIR, '64ebe7dc-1308-43a9-b0c6-f4d7df672ee0.jsonl'),
    start: 1,
    end: 485,
    windowLines: 485,
    assistant: 186,
    maxBucket: 190189,
    maxBucketLine: 484,
    toolUse: 75,
    gitCommitBash: 0,
    typeKinds: 12,
    namedTypesSeen: 9,
    lastUserAskLine: 403,
  },
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ─── 通道①: 原文自扫 ─────────────────────────────────────────────────────────

interface ScanResult {
  windowLines: number;
  malformed: number;
  assistant: number;
  usage4Key: number;
  nullBucket: number;
  maxBucket: number;
  maxBucketLine: number;
  toolUse: number;
  gitCommitBash: number;
  typeKinds: number;
  namedTypesSeen: number;
  parserOk: boolean;
  parserEntries: number;
  parserMaxBucket: number;
  bucketConsistent: boolean;
  lastUserAsk: LastUserAsk;
}

function scan(path: string, start: number, end: number): ScanResult {
  const lines = readFileSync(path, 'utf-8').split('\n').slice(start - 1, end);
  let malformed = 0;
  let assistant = 0;
  let usage4Key = 0;
  let nullBucket = 0;
  let maxBucket = -1;
  let maxBucketLine = 0;
  let toolUse = 0;
  let gitCommitBash = 0;
  const types = new Map<string, number>();
  const namedSeen = new Set<string>();
  const rawBuckets: Array<number | null> = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim()) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      malformed++;
      continue;
    }
    if (!isRecord(record)) continue; // 裸值/非 record → 忽略 (结构闸同语义)
    const type = String(record.type ?? '?');
    types.set(type, (types.get(type) ?? 0) + 1);
    if ((NAMED_TYPES as readonly string[]).includes(type)) namedSeen.add(type);
    if (type !== 'assistant') continue;
    assistant++;

    const msg = isRecord(record.message) ? record.message : null;
    const msgUsage = msg?.usage;
    const usage = isRecord(msgUsage) ? msgUsage : isRecord(record.usage) ? record.usage : null;
    if (usage && FOUR_KEYS.every((k) => typeof usage[k] === 'number' && Number.isFinite(usage[k]))) usage4Key++;
    const bucket =
      usage && THREE_KEYS.every((k) => typeof usage[k] === 'number' && Number.isFinite(usage[k]))
        ? THREE_KEYS.reduce((acc, k) => acc + (usage[k] as number), 0)
        : null;
    rawBuckets.push(bucket);
    if (bucket === null) nullBucket++;
    else if (bucket >= maxBucket) {
      maxBucket = bucket;
      maxBucketLine = start + i; // 同值重复取窗口内最后一条 (与实测报告口径一致)
    }

    const content = Array.isArray(msg?.content) ? (msg.content as Array<Record<string, unknown>>) : [];
    for (const block of content) {
      if (block.type !== 'tool_use') continue;
      toolUse++;
      const inp = isRecord(block.input) ? block.input : null;
      if (block.name === 'Bash' && typeof inp?.command === 'string' && (inp.command as string).includes('git commit')) {
        gitCommitBash++;
      }
    }
  }

  // 通道②: 生产 parser 整窗解析, 与自扫 bucket 逐条对拍。
  const parsed = parseStopLedger(lines.join('\n'));
  const parserMaxBucket = parsed.ok ? Math.max(-1, ...parsed.ledger.entries.map((e) => e.tokenBucket ?? -1)) : -1;
  const bucketConsistent =
    parsed.ok &&
    parsed.ledger.entries.length === rawBuckets.length &&
    parsed.ledger.entries.every((e, idx) => e.tokenBucket === rawBuckets[idx]);

  return {
    windowLines: lines.length,
    malformed,
    assistant,
    usage4Key,
    nullBucket,
    maxBucket,
    maxBucketLine,
    toolUse,
    gitCommitBash,
    typeKinds: types.size,
    namedTypesSeen: namedSeen.size,
    parserOk: parsed.ok,
    parserEntries: parsed.ok ? parsed.ledger.entries.length : -1,
    parserMaxBucket,
    bucketConsistent,
    lastUserAsk: parsed.ok ? parsed.ledger.lastUserAsk : { status: 'empty', value: null, sourceLine: null },
  };
}

// ─── 对拍输出 ────────────────────────────────────────────────────────────────

function compare(win: WindowSpec, s: ScanResult): Array<{ metric: string; expected: string; actual: string }> {
  return [
    { metric: '窗口行数', expected: String(win.windowLines), actual: String(s.windowLines) },
    { metric: 'malformed 行', expected: '0', actual: String(s.malformed) },
    { metric: 'assistant entry', expected: String(win.assistant), actual: String(s.assistant) },
    { metric: 'usage 4 键覆盖 (数据侧)', expected: String(win.assistant), actual: String(s.usage4Key) },
    { metric: 'tokenBucket=null entry', expected: '0', actual: String(s.nullBucket) },
    { metric: '最大 tokenBucket (冻结公式)', expected: String(win.maxBucket), actual: String(s.maxBucket) },
    { metric: '最大 bucket 源行', expected: String(win.maxBucketLine), actual: String(s.maxBucketLine) },
    { metric: 'tool_use 块', expected: String(win.toolUse), actual: String(s.toolUse) },
    { metric: '结构化 Bash git commit', expected: String(win.gitCommitBash), actual: String(s.gitCommitBash) },
    { metric: 'line.type 种类', expected: String(win.typeKinds), actual: String(s.typeKinds) },
    { metric: '点名 9 型出现数', expected: String(win.namedTypesSeen), actual: String(s.namedTypesSeen) },
    { metric: 'parser ok', expected: 'true', actual: String(s.parserOk) },
    { metric: 'parser entry 数', expected: String(win.assistant), actual: String(s.parserEntries) },
    { metric: 'parser 最大 bucket', expected: String(win.maxBucket), actual: String(s.parserMaxBucket) },
    {
      metric: 'bucket 双通道逐条一致',
      expected: `${win.assistant}/${win.assistant}`,
      actual: s.bucketConsistent ? `${win.assistant}/${win.assistant}` : '不一致',
    },
    { metric: 'lastUserAsk.sourceLine', expected: String(win.lastUserAskLine), actual: String(s.lastUserAsk.sourceLine ?? 'empty') },
  ];
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const winName = arg('window');
const win = winName === 'a' || winName === 'b' ? WINDOWS[winName] : undefined;
if (!win) {
  console.error('usage: bun run scripts/verify-ledger-windows.ts --window a|b [--transcript <path>]');
  process.exit(1);
}
const transcript = arg('transcript') ?? win.defaultTranscript;
if (!existsSync(transcript)) {
  console.error(`transcript 不可读: ${transcript} (可用 --transcript 指定)`);
  process.exit(1);
}

const s = scan(transcript, win.start, win.end);
const rows = compare(win, s);
let failed = 0;
console.log(`=== 窗口 ${win.name.toUpperCase()} (${win.start}-${win.end}) transcript: ${transcript} ===`);
for (const r of rows) {
  const ok = r.expected === r.actual;
  if (!ok) failed++;
  console.log(`${ok ? '✅' : '❌'} ${r.metric}: 期望=${r.expected} 实测=${r.actual}`);
}
if (s.parserOk && s.lastUserAsk.status === 'found') {
  console.log(`   lastUserAsk.value: ${s.lastUserAsk.value.slice(0, 80)}`);
}
console.log(failed === 0 ? 'PASS' : `FAIL (${failed} 项)`);
process.exit(failed === 0 ? 0 : 1);
