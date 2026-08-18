#!/usr/bin/env bun
/**
 * scripts/probes/fswatch-wsl2-probe.ts —— WSL2 上 fs.watch 触发可靠性探针 (单文件, 零依赖)。
 *
 * 目的: 测 await-node.ts:132 主触发通道 fs.watch (盯 .omd 目录, persistent:false) 在 WSL2
 *       上的到达率与首见延迟, 以 await-node.ts:73 的 30s 全量重读 poll 为对照基线。
 *
 * 流程: os.tmpdir() 下 mkdtemp 建沙盒 → 沙盒内建 .omd/run-board.jsonl → writer 每 5s 追加
 *       一条带单调递增 seq 的 JSON 行 (openSync(path,'a') + 单次 writeSync, 与 run-board.ts
 *       appendRaw 同形态, 不 fsync), 共 N=12 条 → watch 臂盯 .omd 目录, 每次回调只做两件事:
 *       取 process.hrtime.bigint() 时间戳、全量重读 run-board.jsonl 按 seq 记首见 (首见即到达);
 *       另独立累加原始回调次数 R (inotify 合并语义的证据), 到达数与 R 分开记不许混算 →
 *       poll 臂每 30s 独立全量重读同一文件记每 seq 首见 → 末次追加后 drain 45s → 向 stdout
 *       打印 JSON 摘要 → 清理沙盒 (全程零写仓库、零改 src/)。
 *
 * 用法: bun scripts/probes/fswatch-wsl2-probe.ts
 * 退出码: 0 = 两臂读数都记下并打印 (watch 臂到达 0 条也是合法读数, 照常 0)
 *         1 = 探针自身断言红 (追加没写满 N 条 / 两臂之一没挂上 / poll 对照没看全 N 条)
 *         2 = 环境不可用 (mkdtemp/权限/必需 API 缺失)
 * 红线: 退出码只判探针自身完整性, 绝不把 "fs.watch 可靠" 这个待验假设写进断言。
 *
 * 日志: 追加到 /tmp/fswatch-wsl2-probe.log
 */
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statfsSync,
  watch,
  writeFileSync,
  writeSync,
  type FSWatcher,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ─── 冻结参数 ────────────────────────────────────────────────────────────────

const N = 12; // 追加条数
const APPEND_INTERVAL_MS = 5_000; // writer 追加间隔
const DRAIN_MS = 45_000; // 末次追加后事件排空时长
const POLL_MS = 30_000; // poll 臂周期 (对齐 await-node.ts DEFAULT_POLL_MS)
const LOG_PATH = '/tmp/fswatch-wsl2-probe.log';
const PROC_VERSION_PATH = '/proc/version';

// ─── 时钟: 一律单调, 不用 Date.now() ─────────────────────────────────────────

const T0 = process.hrtime.bigint();
const now = (): bigint => process.hrtime.bigint();
const nsToMs = (ns: bigint): number => Number(ns) / 1e6;

/** O_APPEND + 单次 write: 与 run-board.ts appendRaw 同形态 (不 fsync)。 */
function appendRaw(path: string, line: string): void {
  const fd = openSync(path, 'a');
  try {
    writeSync(fd, Buffer.from(`${line}\n`, 'utf8'));
  } finally {
    closeSync(fd);
  }
}

const log = (m: string): void => {
  try {
    appendRaw(LOG_PATH, `[fswatch-wsl2 ${nsToMs(now() - T0).toFixed(1)}ms] ${m}`);
  } catch {
    /* 日志失败不劫持读数; 首次写入能力在 main 开头单独验过 */
  }
};

function envFail(reason: string): never {
  console.error(`fswatch-wsl2-probe ENV FAIL: ${reason}`);
  try {
    appendRaw(LOG_PATH, `[fswatch-wsl2] ENV FAIL: ${reason}`);
  } catch {
    /* 日志不可写也不掩盖 stderr 原因 */
  }
  process.exit(2);
}

/** statfs magic → 文件系统名 (见 statfs(2) / linux/magic.h)。 */
function fsTypeName(magic: number): string {
  switch (magic) {
    case 0xef53: return 'ext2/ext3/ext4';
    case 0x01021994: return 'tmpfs';
    case 0x794c7630: return 'overlayfs';
    case 0x9123683e: return 'btrfs';
    case 0x58465342: return 'xfs';
    case 0x01021997: return '9p';
    case 0x4d44: return 'msdos/vfat';
    case 0x5346544e: return 'ntfs';
    default: return 'unknown';
  }
}

/** 全量重读板文件, 返回其中全部合法 seq; 坏行/半行跳过 (readBoard 同语义)。 */
function readSeqs(path: string): number[] {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  const out: number[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const j: unknown = JSON.parse(line);
      const seq = (j as { seq?: unknown } | null)?.seq;
      if (typeof seq === 'number') out.push(seq);
    } catch {
      /* 半行/坏行: 跳过, 下一拍全量重读自愈 */
    }
  }
  return out;
}

/** 按 seq 记首见 (首见即到达), 返回本次新见条数。 */
function recordFirstSeen(
  seenTs: (bigint | null)[],
  seen: boolean[],
  t: bigint,
  seqs: number[],
): number {
  let fresh = 0;
  for (const s of seqs) {
    if (s >= 1 && s <= N && !seen[s]) {
      seen[s] = true;
      seenTs[s] = t;
      fresh++;
    }
  }
  return fresh;
}

function countSeen(seen: boolean[]): number {
  let c = 0;
  for (let s = 1; s <= N; s++) if (seen[s]) c++;
  return c;
}

/**
 * seq → 首见延迟毫秒 (自 append 完成时刻起算); 不可见 = null (不伪装成任何数值)。
 * 返回数组 0-based, 下标 = seq - 1。
 */
function latencyMs(seenTs: (bigint | null)[], appendTs: (bigint | null)[]): (number | null)[] {
  const out: (number | null)[] = [];
  for (let s = 1; s <= N; s++) {
    const a = appendTs[s];
    const t = seenTs[s];
    out.push(a != null && t != null ? nsToMs(t - a) : null);
  }
  return out;
}

/** 最近秩分位数; 无有限样本 → null。 */
function quantile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? null;
}

function stats(lat: (number | null)[]): { p50: number | null; p95: number | null; max: number | null } {
  const finite = lat.filter((x): x is number => x !== null).sort((a, b) => a - b);
  return {
    p50: quantile(finite, 0.5),
    p95: quantile(finite, 0.95),
    max: finite.length > 0 ? (finite[finite.length - 1] ?? null) : null,
  };
}

function readProcVersion(): string {
  try {
    return readFileSync(PROC_VERSION_PATH, 'utf8').trim();
  } catch (e) {
    return `unavailable: ${(e as Error).message}`;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  // ── 环境自检: 必需 API 缺失 = exit 2 ──
  if (typeof statfsSync !== 'function') envFail('node:fs.statfsSync 不可用');
  try {
    appendRaw(LOG_PATH, `[fswatch-wsl2] start pid=${process.pid} N=${N} interval=${APPEND_INTERVAL_MS}ms poll=${POLL_MS}ms drain=${DRAIN_MS}ms`);
  } catch (e) {
    envFail(`日志不可写 ${LOG_PATH}: ${(e as Error).message}`);
  }

  // ── 沙盒: os.tmpdir() 下 mkdtemp, 零写仓库 ──
  let sandbox: string;
  try {
    sandbox = mkdtempSync(join(tmpdir(), 'fswatch-wsl2-'));
  } catch (e) {
    envFail(`mkdtempSync(${tmpdir()}) 失败: ${(e as Error).message}`);
  }
  log(`sandbox=${sandbox}`);

  const omdDir = join(sandbox, '.omd');
  const boardPath = join(omdDir, 'run-board.jsonl');
  try {
    mkdirSync(omdDir, { recursive: true });
    writeFileSync(boardPath, '', { flag: 'w' });
  } catch (e) {
    envFail(`建 ${boardPath} 失败: ${(e as Error).message}`);
  }

  // ── 读数簿: watch 臂与 poll 臂分簿, 不许混算 ──
  const appendTs: (bigint | null)[] = new Array(N + 1).fill(null);
  const watchTs: (bigint | null)[] = new Array(N + 1).fill(null);
  const pollTs: (bigint | null)[] = new Array(N + 1).fill(null);
  const watchSeen = new Array<boolean>(N + 1).fill(false);
  const pollSeen = new Array<boolean>(N + 1).fill(false);
  let rawCallbacks = 0; // R: 原始回调次数 (inotify 合并语义的证据, 与到达数分列)
  let watchErrorCount = 0;
  let pollTicks = 0;

  // ── watch 臂: 镜像 await-node.ts:132 —— 盯 .omd 目录, persistent:false ──
  let watcher: FSWatcher | null = null;
  let watchAttached = true;
  try {
    watcher = watch(omdDir, { persistent: false }, () => {
      // 回调只做两件事: 取单调时间戳 → 全量重读并按 seq 记首见; R 独立累加
      const t = now();
      rawCallbacks++;
      const fresh = recordFirstSeen(watchTs, watchSeen, t, readSeqs(boardPath));
      log(`watch cb #${rawCallbacks} fresh=${fresh} seen=${countSeen(watchSeen)}/${N}`);
    });
    watcher.on('error', (e: Error) => {
      watchErrorCount++;
      log(`watch error: ${e.message}`);
    });
  } catch (e) {
    watchAttached = false;
    log(`watch 未挂上: ${(e as Error).message}`);
  }

  // ── poll 臂 (对照基线): 独立定时全量重读同一文件 ──
  let pollAttached = true;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  try {
    pollTimer = setInterval(() => {
      const t = now();
      pollTicks++;
      const fresh = recordFirstSeen(pollTs, pollSeen, t, readSeqs(boardPath));
      log(`poll tick #${pollTicks} fresh=${fresh} seen=${countSeen(pollSeen)}/${N}`);
    }, POLL_MS);
  } catch (e) {
    pollAttached = false;
    log(`poll 定时器未挂上: ${(e as Error).message}`);
  }

  // ── writer: N 次追加, 间隔 5s, 不 fsync ──
  let writerError: string | null = null;
  try {
    for (let seq = 1; seq <= N; seq++) {
      const line = JSON.stringify({ seq, ts: now().toString() });
      appendRaw(boardPath, line);
      appendTs[seq] = now(); // 打点于 writeSync 返回后: 行已落板
      log(`append seq=${seq}`);
      if (seq < N) await sleep(APPEND_INTERVAL_MS);
    }
  } catch (e) {
    writerError = (e as Error).message;
    log(`writer 追加失败: ${writerError}`);
  }

  // ── 末次追加后 drain 45s (≥1 个 poll 周期 + 事件排空) ──
  await sleep(DRAIN_MS);

  // ── 完整性断言: 只判探针自身, 绝不把 "fs.watch 可靠" 写进退出码 ──
  let exitCode = 0;
  const present = new Array<boolean>(N + 1).fill(false);
  for (const s of readSeqs(boardPath)) if (s >= 1 && s <= N) present[s] = true;
  const missing: number[] = [];
  for (let s = 1; s <= N; s++) if (!present[s]) missing.push(s);

  const watchArrivals = countSeen(watchSeen);
  const pollArrivals = countSeen(pollSeen);

  if (writerError !== null || missing.length > 0) {
    log(`❌ 追加没写满 N 条 (writerError=${writerError ?? 'null'} missing=[${missing.join(',')}])`);
    exitCode = 1;
  }
  if (!watchAttached) {
    log('❌ watch 臂没挂上');
    exitCode = 1;
  }
  if (!pollAttached) {
    log('❌ poll 臂没挂上');
    exitCode = 1;
  }
  if (pollArrivals < N) {
    log(`❌ poll 对照没看全 N (${pollArrivals}/${N})`);
    exitCode = 1;
  }

  const watchLatencyMs = latencyMs(watchTs, appendTs);
  const pollLatencyMs = latencyMs(pollTs, appendTs);
  const st = statfsSync(sandbox);

  const summary = {
    N,
    appendIntervalMs: APPEND_INTERVAL_MS,
    pollMs: POLL_MS,
    drainMs: DRAIN_MS,
    watchAttached,
    watchArrivals,
    rawCallbacks,
    watchErrorCount,
    pollAttached,
    pollArrivals,
    pollTicks,
    watchLatencyMs,
    pollLatencyMs,
    watchStats: stats(watchLatencyMs),
    pollStats: stats(pollLatencyMs),
    bunVersion: Bun.version,
    procVersion: readProcVersion(),
    sandbox,
    fsType: `${fsTypeName(st.type)} (magic=0x${st.type.toString(16)})`,
    exitCode,
  };
  console.log(JSON.stringify(summary, null, 2));

  // ── 收臂 + 清理沙盒 (清理失败不吞读数) ──
  if (watcher) {
    try {
      watcher.close();
    } catch {
      /* 关不掉不掩盖读数 */
    }
  }
  if (pollTimer) clearInterval(pollTimer);
  try {
    rmSync(sandbox, { recursive: true, force: true });
    log(`SUMMARY exit=${exitCode} watch=${watchArrivals}/${N} R=${rawCallbacks} poll=${pollArrivals}/${N} 沙盒已清理`);
  } catch (e) {
    log(`SUMMARY exit=${exitCode} watch=${watchArrivals}/${N} R=${rawCallbacks} poll=${pollArrivals}/${N} 沙盒清理失败: ${(e as Error).message}`);
  }

  process.exit(exitCode);
}

main().catch((e: unknown) => {
  const m = e instanceof Error ? e.message : String(e);
  console.error(`fswatch-wsl2-probe CRASH: ${m}`);
  try {
    appendRaw(LOG_PATH, `[fswatch-wsl2] CRASH: ${m}`);
  } catch {
    /* ignore */
  }
  process.exit(1);
});
