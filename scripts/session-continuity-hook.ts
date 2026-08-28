#!/usr/bin/env bun
/**
 * scripts/session-continuity-hook —— Stop / PreCompact hook 薄壳(#206 触发器)。
 *
 * 判定与派发装配在 `src/harness/session/continuity-hook.ts`(纯函数,可测);本件只干副作用:
 * 读 stdin → 记 ledger → detached spawn `scripts/session-writer.ts` → 吐 marker。
 *
 * ## 路径三条(写错就静默,见 #206 事实 3)
 *
 * - **checkpoint.md / ledger.jsonl** 走 `OMD_DATA_HOME`(script-bootstrap 置 `~/.omd`)
 *   → `~/.omd/projects/<slug>/session/<sessionId>/`;本件与 writer 用**同一条** `resolveProject`
 *   派生,否则 writer 尾读永远读不到本件写的 ledger。
 * - **facts(memory.db)** 走 `resolveMemoryDbPath` = `OMD_MEMORY_PATH ?? '.omd/memory.db'`,
 *   **不认 `OMD_DATA_HOME`** ⇒ 落 `<cwd>/.omd/memory.db`。所以 spawn 必须带 `cwd = input.cwd`:
 *   MCP 读面以 `cd "${CLAUDE_PROJECT_DIR:-$PWD}"` 起、走同一条解析,两面才同库。
 * - **引擎锚** = 本仓,不随 `cwd`(`engineRoot()`)。
 *
 * 安装(与冻结的 `docs/examples/claude-code/hooks/session-continuity.ts` **互斥**,别同装):
 *
 *   Stop / PreCompact → `bun run <omd>/scripts/session-continuity-hook.ts`
 *
 * 全程 fail-open:任何异常 exit 0、零写入,绝不阻断 session。
 */
import '../src/harness/script-bootstrap';
import { openSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { parseStopLedger } from '../src/harness/session/stop-ledger';
import { appendLedger } from '../src/harness/session/ledger';
import {
  buildSessionStartContext,
  decideContinuityTrigger,
  readLastFiredBucket,
  sessionDirOf,
  writeLastFiredBucket,
  writerArgv,
  type ContinuityHookInput,
} from '../src/harness/session/continuity-hook';
import { engineRoot, isSdkChildSession } from '../src/harness/session/continuity-hook';
import { gather } from '../src/harness/dream/gather';
import {
  AUTO_BATCH,
  acquireDreamLock,
  decideDreamTrigger,
  readDreamAttempt,
  writeDreamAttempt,
} from '../src/harness/dream/trigger';
import { createRunStore } from '../src/mcp/run-store';

/** dream 尝试记录的位置 —— 与 memory.db 并排(同一个仓一份)。 */
function dreamStatePath(cwd: string): string {
  return join(cwd, '.omd', 'dream-attempt.json');
}

/** 互斥锁位置 —— 与 attempt 记录并排, 一个仓一把。 */
function dreamLockPath(cwd: string): string {
  return join(cwd, '.omd', 'dream.lock');
}

/**
 * 判 + 派 dream(全程 fail-open,返回要贴给用户的 marker 或空串)。
 *
 * ## 为什么先跑 gather 再判
 *
 * 水位判据("脏了多少")只有 gather 才知道,而 gather 是**零 LLM** 的(纯读 runs.db /
 * ChatStore + 比 watermark)。所以判定这一步一分钱不花 —— 花钱的是判定为真之后 detached
 * 派出去那一批。
 *
 * ## 为什么 detached spawn 而不是 in-process await
 *
 * hook 是 CC 的同步阻塞点。dream 一批要打最多 12 次模型,秒到分钟级。在这里 await
 * 等于把用户的 Stop 卡住 —— 与交接 writer 同一条理由,同一个做法。
 */
async function maybeFireDream(cwd: string): Promise<string> {
  const statePath = dreamStatePath(cwd);
  // 判定前先看开关与自喂闸:两者都不需要开库、不需要 gather。
  const pre = decideDreamTrigger({
    dirtyTotal: 0,
    dirtySources: 0,
    attempt: readDreamAttempt(statePath),
    nowMs: Date.now(),
    isSdkChild: isSdkChildSession(),
  });
  if (!pre.fire && (pre.why.startsWith('OMD_DREAM_AUTO') || pre.why.startsWith('自喂闸'))) return '';

  // gather 与 CLI 的 `phaseGather` 同款装配(单一真源:同一个函数、同一个 runStore 路径)。
  const runStore = createRunStore({ path: join(cwd, '.omd', 'runs.db') });
  let dirtyTotal = 0;
  let dirtySources = 0;
  try {
    const report = await gather({ cwd, runStore });
    dirtyTotal = report.dirtyTotal;
    dirtySources = report.sources.filter((s) => s.state === 'dirty').length;
  } finally {
    runStore.close();
  }

  const trigger = decideDreamTrigger({
    dirtyTotal,
    dirtySources,
    attempt: readDreamAttempt(statePath),
    nowMs: Date.now(),
    isSdkChild: isSdkChildSession(),
  });
  if (!trigger.fire) {
    console.error(`[dream-trigger] 不点火: ${trigger.why}`);
    return '';
  }

  // 互斥:已经有一个 dream 在跑就不点(2026-08-28 实测撞过 —— hook 派的批与手起的 drain
  // 同时跑,同一批语料被抽两遍、水位互相覆盖)。锁由**被派出去的那个进程**负责放,
  // 所以这里只拿不放;它崩了由 STALE_LOCK_MS 兜底。
  if (!acquireDreamLock(dreamLockPath(cwd))) {
    console.error('[dream-trigger] 不点火: 已有一个 dream 在跑(锁被占)');
    return '';
  }

  // ⚠ 冷却在**掏钱之前**开始计时(见 trigger.ts 护栏②):先写 attempt,再 spawn。
  // 反过来的话进程中途被杀 = 没记过 = 下一次 Stop 立刻又烧一批。
  writeDreamAttempt(statePath, { lastAttemptAt: Date.now(), lastOutcome: null });

  const logDir = join(cwd, '.omd');
  mkdirSync(logDir, { recursive: true });
  const fd = openSync(join(logDir, 'dream.log'), 'a');
  spawn('bun', ['run', join(engineRoot(), 'scripts', 'omd-dream.ts'), 'all', '--cwd', cwd, '--batch', String(AUTO_BATCH)], {
    cwd,
    detached: true,
    stdio: ['ignore', fd, fd],
  }).unref();

  const m = `🌙 dream 固化 · ${dirtySources} 个脏源 / 本批 ≤${AUTO_BATCH} · [固化 pending]`;
  console.error(`[dream-trigger] ${m} — ${trigger.why}`);
  return m;
}

let marker = '';
let eventName = 'Stop';
try {
  const input = JSON.parse(await new Response(Bun.stdin).text()) as ContinuityHookInput;
  if (typeof input.hook_event_name === 'string') eventName = input.hook_event_name;
  const transcript = typeof input.transcript_path === 'string' ? input.transcript_path : '';
  const sessionId = typeof input.session_id === 'string' ? input.session_id : '';
  const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd();
  if (!transcript || !sessionId) throw new Error('缺 transcript_path / session_id');

  // SessionStart 是**注入面**不是写入面:读 persona + 上一段交接,吐回给 CC 当开场上下文。
  // 它不碰 ledger、不派 writer —— 与下面那条写入路完全分开(memory-hub 那边也是两个文件)。
  if (eventName === 'SessionStart') {
    const ctx = buildSessionStartContext({ cwd });
    if (ctx) {
      marker = ctx;
      console.error(`[continuity-hook] SessionStart 注入 ${ctx.length} 字符`);
    }
    process.stdout.write(
      marker ? JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: marker } }) : '{}',
    );
    process.exit(0);
  }

  const parsed = parseStopLedger(await Bun.file(transcript).text());
  if (!parsed.ok) throw new Error(`transcript 不可解析 (line ${parsed.error.line}): ${parsed.error.message}`);

  // 记账(offset 去重 + O_EXCL 锁);失败只记 stderr,不改变触发判定 —— 记账与触发是两件事。
  const appended = appendLedger({ ledger: parsed.ledger, sessionId, cwd });
  if (!appended.ok) console.error(`[continuity-hook] ledger append 跳过 (fail-open): ${appended.error}`);

  // 基准是**盘上记着的「已存到第几档」**, 不是历史读数的最高档 —— 后者会让中途装上的 hook
  // 永远哑掉(2026-08-19 实测:ledger 372 行 / ctx 408k / 零 checkpoint)。
  const lastFiredBucket = readLastFiredBucket(sessionId, cwd);
  const trigger = decideContinuityTrigger(input, parsed.ledger, { lastFiredBucket });
  if (trigger.fire) {
    const contDir = sessionDirOf(sessionId, cwd);
    mkdirSync(contDir, { recursive: true });
    const logFd = openSync(join(contDir, 'writer.log'), 'a');
    spawn('bun', writerArgv(transcript, sessionId, trigger.mode), {
      cwd,
      detached: true,
      stdio: ['ignore', logFd, logFd],
    }).unref();

    // 确定性 inline 标记:蒸馏在后台,这一行同步发,不靠模型记得说自己存过档。
    // 档位状态只由**档位触发**更新:precompact / final 是"到点就存", 与档位无关,
    // 拿它们的 bucket=0 去覆盖会把已存档位擦回 0, 下一轮就又存一次。
    if (trigger.mode === 'rolling') writeLastFiredBucket(sessionId, trigger.bucket, cwd);
    const trig = trigger.mode === 'rolling' ? `${trigger.bucket} 档` : trigger.mode;
    marker = `💾 continuity checkpoint · 触发=${trig} · [distill pending]`;
    console.error(`[continuity-hook] ${marker}`);
  }

  // ── dream 自动固化(2026-08-28)──────────────────────────────────────────
  // 与上面的交接**完全独立**:交接失败不该拦住固化,固化失败更不该拦住交接。所以另一个
  // try,而不是并进上面那条链。默认关(`OMD_DREAM_AUTO=1` 才开)—— 它要打真模型。
  try {
    const dreamMarker = await maybeFireDream(cwd);
    if (dreamMarker) marker = marker ? `${marker}\n${dreamMarker}` : dreamMarker;
  } catch (e) {
    console.error(`[dream-trigger] 跳过 (fail-open): ${e instanceof Error ? e.message : String(e)}`);
  }
} catch (e) {
  // fail-open 吞异常,但**不吞证据**(仓规坑②):留一行原文。
  console.error(`[continuity-hook] 跳过 (fail-open): ${e instanceof Error ? e.message : String(e)}`);
}

process.stdout.write(
  marker
    ? JSON.stringify({ hookSpecificOutput: { hookEventName: eventName, additionalContext: marker } })
    : '{}',
);
process.exit(0);
