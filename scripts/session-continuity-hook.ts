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
    const ctx = buildSessionStartContext({ cwd, sessionId });
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
