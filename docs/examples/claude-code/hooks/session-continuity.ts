/**
 * docs/examples/claude-code/hooks/session-continuity —— W2 opt-in session-continuity hook(Open-1/Open-5 冻结)。
 *
 * 冻结契约(见 docs/plan/session-continuity-follow-on.md §3;Markdown 仍是行为真源):
 * - 只导出 `SessionContinuityStopInput` / `SessionContinuityStopOutput` / `evaluateSessionContinuityStop`;
 * - 决策 = token bucket 唯一主触发(Open-3):无 HEAD bonus、无 transcript grep、无 shell 搜索、
 *   无 raw-text regex 替代;`assistantText` 对决策不透明(classifier 只属 W3,skill preamble 保持 OPEN);
 * - opt-in 事件门:仅 `hook_event_name === 'Stop'` 决策;SessionStart / PreCompact / SessionEnd
 *   与缺省事件一律不决策;
 * - 守卫不是触发:`stop_hook_active: true`(CC loop guard 防递归)/ `writer_locked: true`
 *   (writer 双写排除)→ 一律不决策;
 * - fail-open:空 ledger / 缺 token / 阈值配置坏 / 输入不可读 → 不伪造 token、不抛、零写入
 *   (W4 no-op:无 sink / SQLite / checkpoint 旁路);
 * - 跨档一次性:只看最新 entry —— 最新 tokenBucket ≥ 档位且(无更早 entry 或前一条 < 档位)→ block;
 *   同档延续不重复触发;最新一条无 usage → 不决策。
 *
 * 本文件可与标准 hook 输入(stdin JSON)与 transcript 同文件读取,再调 W3 `parseStopLedger`
 * (冻结授权);决策本身是纯函数,不触碰文件系统、不 grep transcript 原文。
 * S1 接线(SDD 契约 D-4):解析成功后经 `appendLedger`(src/harness/session/ledger.ts)
 * 把本轮记账 serialized 进 ledger.jsonl —— W1 writer 尾读的唯一数据源;全程 fail-open,
 * 写失败只记 stderr,不影响决策输出。
 *
 * @module
 */

import { parseStopLedger, type StopLedger } from '../../../../src/harness/session/stop-ledger';
import { appendLedger } from '../../../../src/harness/session/ledger';

// ─── Public types(冻结 API)─────────────────────────────────────────────────

export interface SessionContinuityStopInput {
  readonly transcript_path: string;
  readonly stop_hook_active?: boolean;
  readonly hook_event_name?: 'Stop';
  readonly [key: string]: unknown;
}

export type SessionContinuityStopOutput =
  | Readonly<{ decision: 'block'; reason: string }>
  | Readonly<{ decision?: never; reason?: never }>;

// ─── evaluator(纯函数,零副作用)─────────────────────────────────────────────

/** 冻结档位缺省:"跨 200k 档"(env `OMD_SESSION_BUCKET` 可覆盖)。 */
const DEFAULT_SESSION_BUCKET = 200_000;

/** 档位阈值:env 未设 → 缺省;设了但非正有限数 → null(fail-open:不拿坏配置造档位)。 */
function bucketThreshold(): number | null {
  const raw = process.env.OMD_SESSION_BUCKET;
  if (raw === undefined) return DEFAULT_SESSION_BUCKET;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function evaluateSessionContinuityStop(
  input: SessionContinuityStopInput,
  ledger: StopLedger,
): SessionContinuityStopOutput {
  // opt-in 事件门:只处理 Stop;SessionStart / PreCompact / SessionEnd 与缺省事件一律不决策。
  if (input.hook_event_name !== 'Stop') return {};
  // 守卫不是触发:CC loop guard 防递归、writer 双写排除 → 一律不决策。
  if (input.stop_hook_active === true) return {};
  if (input.writer_locked === true) return {};

  const threshold = bucketThreshold();
  if (threshold === null) return {}; // 阈值配置坏 → fail-open 不决策

  const last = ledger.entries[ledger.entries.length - 1];
  if (last === undefined) return {}; // 空 ledger → fail-open 不决策
  if (last.tokenBucket === null) return {}; // 最新条缺 token → 绝不伪造
  if (last.tokenBucket < threshold) return {}; // 未跨档

  // 跨档一次性:首条即 ≥ 档(无更早记录可比,fail-safe 方向),或前一条 < 档(含前一条缺 token)
  // → 本次跨档,block;前一条已 ≥ 档 = 同档延续,不重复触发。
  const prev = ledger.entries[ledger.entries.length - 2];
  if (prev !== undefined && prev.tokenBucket !== null && prev.tokenBucket >= threshold) {
    return {};
  }
  return {
    decision: 'block',
    reason: `跨档触发:第 ${last.ordinal} 轮 tokenBucket ${last.tokenBucket} ≥ 档位 ${threshold}(OMD_SESSION_BUCKET)`,
  };
}

// ─── hook 入口(标准 stdin JSON 接线:输入 + transcript → W3 → 决策;全 fail-open)──────────

if (import.meta.main) {
  void main();
}

async function main(): Promise<void> {
  let out: SessionContinuityStopOutput;
  try {
    const input = JSON.parse(await new Response(Bun.stdin).text()) as SessionContinuityStopInput;
    // 只处理 Stop;SessionStart / PreCompact / SessionEnd / 缺省 → opt-in 不决策。
    if (input.hook_event_name !== 'Stop') {
      out = {};
    } else {
      const parsed = parseStopLedger(await Bun.file(input.transcript_path).text());
      out = parsed.ok ? evaluateSessionContinuityStop(input, parsed.ledger) : {};
      if (parsed.ok) {
        // S1 接缝(SDD 契约 D-4):W2 → W1 writer 的 caller 链 —— serializer + ledger.jsonl append
        // (每轮记账)。任何失败 fail-open 跳过:不改变决策、不抛、不阻断 hook 链。
        const sessionId = typeof input.session_id === 'string' ? input.session_id : '';
        const cwd = typeof input.cwd === 'string' ? input.cwd : undefined;
        const appended = appendLedger({ ledger: parsed.ledger, sessionId, cwd });
        if (!appended.ok) console.error(`[session-continuity] ledger append skipped (fail-open): ${appended.error}`);
      }
    }
  } catch {
    out = {}; // 输入/transcript 不可读或畸形 → fail-open:不抛、不决策、零写入
  }
  process.stdout.write(JSON.stringify(out));
}
