/**
 * W2 Stop hook 冻结测试切片 (session-continuity · Open-5 `RESOLVED—FROZEN`)。
 *
 * 契约面 (冻结, 逐字节不变):
 * - W2 hook 文件 `scripts/session-continuity.ts` (唯一生产 root), 只导出冻结 API:
 *   `SessionContinuityStopInput` / `SessionContinuityStopOutput` / `evaluateSessionContinuityStop(input, ledger)`。
 * - ledger 只经 W3 `parseStopLedger(source)` 产生 (结构化 W3 输出; 决策绝不 grep transcript 文本)。
 * - 决策 = token bucket 唯一主触发 (Open-3): 跨档才 block; 无 HEAD bonus、无 transcript grep、
 *   无 shell 搜索、无 raw-text regex 替代; `lastUserAsk` 与 `assistantText` 对 W2 决策不透明 (classifier 只属 W3,
 *   skill preamble 保持 OPEN, 本切片不得隐式解决)。
 * - 守卫不是触发: `stop_hook_active: true` (CC loop guard) / `writer_locked: true` (双写排除)
 *   → 一律不决策; SessionStart / PreCompact / SessionEnd 事件与缺省事件 → 不决策 (opt-in)。
 * - fail-open: 空 ledger / 缺 token / transcript 不可读 → 不伪造 token、不抛、零写入
 *   (W4 no-op: 无 sink / SQLite / checkpoint 旁路; markdown 仍是真理源)。
 * - token 档阈值 = `OMD_SESSION_BUCKET`, 缺省 200_000 (冻结 Markdown 断言 "跨 200k 档")。
 *
 * ledger 源格式 (合成 fixture 内联, 不建 fixture 文件): 与 W3 切片
 * `tests/harness/session/stop-ledger.test.ts` 同源 —— 一行一条 assistant 记录
 * (`type:'assistant'` + `message.content` + `usage` 四键), `tokenBucket` =
 * input + cache_read + cache_creation (冻结公式, E-P1; output 不计), 无 usage → null。
 * 本切片只喂良构源; 畸形行 typed error (GWT-3) / 损坏行 fail-open (GWT-6) 属 W3 切片职责。
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseStopLedger, type StopLedger } from '../../src/harness/session/stop-ledger';
import {
  evaluateSessionContinuityStop,
  type SessionContinuityStopInput,
  type SessionContinuityStopOutput,
} from '../../docs/examples/claude-code/hooks/session-continuity';

const DEFAULT_BUCKET = 200_000;

const tmpRoot = mkdtempSync(join(tmpdir(), 'omd-w2-slice-'));
let txSeq = 0;

function writeTranscript(content: string): string {
  txSeq += 1;
  const p = join(tmpRoot, `transcript-${txSeq}.jsonl`);
  writeFileSync(p, content);
  return p;
}

/** 冻结 usage 四键形状 (E-P1): tokenBucket = input + cache_read + cache_creation, output 不计。 */
function usageTokens(sum: number): Record<string, number> {
  return { input_tokens: 1, cache_read_input_tokens: sum - 4, cache_creation_input_tokens: 3, output_tokens: 7 };
}

/** 与 W3 切片同源的合成 fixture: 一行一条 assistant 记录 (usage 四键 → tokenBucket)。 */
function assistantLine(text: string, usage?: Record<string, number>): string {
  return JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] }, usage });
}

/** 无内容轮 (assistantText → null), 与 W3 切片 `assistant(null, usage)` 用例同形。 */
function assistantNoText(usage: Record<string, number>): string {
  return JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: null }, usage });
}

/** 合成 W3 输入: user 记录 (lastUserAsk candidate 源; 不产生 entries), 与 W3 切片 `tests/harness/session/stop-ledger.test.ts` 同形。 */
function userLine(text: string): string {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });
}
function userRaw(text: string): string {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: text } });
}
function userToolResult(): string {
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_r1', content: 'ok' }] },
  });
}

/** 合成 W3 输入: 冻结 ledger 源 (assistant 记录 JSONL) → parseStopLedger (W3 消费)。 */
function ledgerFrom(...lines: string[]): StopLedger {
  const res = parseStopLedger(lines.join('\n'));
  if (!res.ok)
    throw new Error(`synthetic ledger 解析失败 (line ${res.error.line}): ${res.error.message}`);
  return res.ledger;
}

function stopInput(over: Partial<SessionContinuityStopInput> = {}): SessionContinuityStopInput {
  return { transcript_path: join(tmpRoot, 'transcript.jsonl'), hook_event_name: 'Stop', stop_hook_active: false, ...over };
}

function expectNoDecision(out: SessionContinuityStopOutput): void {
  expect('decision' in out).toBe(false);
  expect('reason' in out).toBe(false);
}

function expectBlock(out: SessionContinuityStopOutput): void {
  expect(out.decision).toBe('block');
  expect(typeof out.reason).toBe('string');
  expect((out.reason as string).length).toBeGreaterThan(0);
}

const savedBucket = process.env.OMD_SESSION_BUCKET;
beforeEach(() => {
  process.env.OMD_SESSION_BUCKET = String(DEFAULT_BUCKET);
});
afterEach(() => {
  if (savedBucket === undefined) delete process.env.OMD_SESSION_BUCKET;
  else process.env.OMD_SESSION_BUCKET = savedBucket;
});

describe('opt-in 事件门 (SessionStart · Stop · PreCompact · SessionEnd)', () => {
  test('非 Stop 事件一律不决策 (四个 hook 全 opt-in; 本文件只处理 Stop 事件)', () => {
    for (const ev of ['SessionStart', 'PreCompact', 'SessionEnd'] as const) {
      const out = evaluateSessionContinuityStop(
        stopInput({ hook_event_name: ev as unknown as 'Stop' }),
        ledgerFrom(assistantLine('轮1', usageTokens(250000))),
      );
      expectNoDecision(out);
    }
  });

  test('缺省 hook_event_name 不决策 (无显式 Stop 事件不触发)', () => {
    const out = evaluateSessionContinuityStop(
      stopInput({ hook_event_name: undefined }),
      ledgerFrom(assistantLine('轮1', usageTokens(150000)), assistantLine('轮2', usageTokens(210000))),
    );
    expectNoDecision(out);
  });

  test('Stop 事件 + 跨档 → block (唯一可激活路径)', () => {
    const out = evaluateSessionContinuityStop(
      stopInput(),
      ledgerFrom(assistantLine('轮1', usageTokens(150000)), assistantLine('轮2', usageTokens(210000))),
    );
    expectBlock(out);
  });
});

describe('loop guard 与 writer-lock 排除 (守卫不是触发)', () => {
  test('stop_hook_active: true → 不决策, 即使跨档 (CC loop guard 防递归)', () => {
    const out = evaluateSessionContinuityStop(
      stopInput({ stop_hook_active: true }),
      ledgerFrom(assistantLine('轮1', usageTokens(150000)), assistantLine('轮2', usageTokens(210000))),
    );
    expectNoDecision(out);
  });

  test('writer_locked: true → 不决策, 即使跨档 (writer 双写排除, 不叠写 checkpoint)', () => {
    const out = evaluateSessionContinuityStop(
      stopInput({ writer_locked: true }),
      ledgerFrom(assistantLine('轮1', usageTokens(150000)), assistantLine('轮2', usageTokens(210000))),
    );
    expectNoDecision(out);
  });

  test('stop_hook_active: false 且 writer_locked 缺省 → 正常评估 (跨档 block)', () => {
    const out = evaluateSessionContinuityStop(
      stopInput(),
      ledgerFrom(assistantLine('轮1', usageTokens(150000)), assistantLine('轮2', usageTokens(210000))),
    );
    expectBlock(out);
  });
});

describe('token bucket 唯一主触发 (Open-3)', () => {
  test('全部低于档位 → 不决策', () => {
    const out = evaluateSessionContinuityStop(
      stopInput(),
      ledgerFrom(assistantLine('轮1', usageTokens(100000)), assistantLine('轮2', usageTokens(150000))),
    );
    expectNoDecision(out);
  });

  test('跨档 (前条低于档、最新 ≥ 档) → block', () => {
    const out = evaluateSessionContinuityStop(
      stopInput(),
      ledgerFrom(assistantLine('轮1', usageTokens(150000)), assistantLine('轮2', usageTokens(210000))),
    );
    expectBlock(out);
  });

  test('首条记录已 ≥ 档 → block (无更早记录可比, 按跨档处理; fail-safe 方向)', () => {
    const out = evaluateSessionContinuityStop(stopInput(), ledgerFrom(assistantLine('轮1', usageTokens(250000))));
    expectBlock(out);
  });

  test('同档延续 (前条已 ≥ 档) → 不重复触发 (跨档一次性)', () => {
    const out = evaluateSessionContinuityStop(
      stopInput(),
      ledgerFrom(
        assistantLine('轮1', usageTokens(150000)),
        assistantLine('轮2', usageTokens(210000)),
        assistantLine('轮3', usageTokens(230000)),
      ),
    );
    expectNoDecision(out);
  });

  test('最新条目无 usage → tokenBucket null → 不决策 (绝不伪造 token)', () => {
    const out = evaluateSessionContinuityStop(
      stopInput(),
      ledgerFrom(assistantLine('轮1', usageTokens(150000)), assistantLine('轮2')),
    );
    expectNoDecision(out);
  });

  test('空 ledger → 不决策 (ledger 缺失 fail-open, 不阻断)', () => {
    const empty = ledgerFrom();
    expect(empty.entries).toHaveLength(0);
    const out = evaluateSessionContinuityStop(stopInput(), empty);
    expectNoDecision(out);
  });

  test('OMD_SESSION_BUCKET 降到 150000 后, 160000 跨档', () => {
    process.env.OMD_SESSION_BUCKET = '150000';
    const out = evaluateSessionContinuityStop(
      stopInput(),
      ledgerFrom(assistantLine('轮1', usageTokens(100000)), assistantLine('轮2', usageTokens(160000))),
    );
    expectBlock(out);
  });

  test('OMD_SESSION_BUCKET 升到 250000 后, 210000 不跨档', () => {
    process.env.OMD_SESSION_BUCKET = '250000';
    const out = evaluateSessionContinuityStop(
      stopInput(),
      ledgerFrom(assistantLine('轮1', usageTokens(100000)), assistantLine('轮2', usageTokens(210000))),
    );
    expectNoDecision(out);
  });

  test('OMD_SESSION_BUCKET 未设时默认 200k 档 (冻结断言 "跨 200k 档")', () => {
    delete process.env.OMD_SESSION_BUCKET;
    const out = evaluateSessionContinuityStop(
      stopInput(),
      ledgerFrom(assistantLine('轮1', usageTokens(150000)), assistantLine('轮2', usageTokens(210000))),
    );
    expectBlock(out);
  });
});

describe('W3 消费 · 无 transcript grep · 无 HEAD bonus (Open-3)', () => {
  test('transcript 含 commit 字面量 + 巨型 token + ledger 形 JSONL, 但 ledger 未跨档 → 不决策 (grep/commit bonus 已禁用)', () => {
    const tx = writeTranscript([
      '{"type":"assistant","message":{"content":[{"type":"tool_result","content":"git commit -m done"}]}}',
      '{"ctxTokens": 999999}',
      'git commit 226451',
    ].join('\n'));
    const out = evaluateSessionContinuityStop(
      stopInput({ transcript_path: tx }),
      ledgerFrom(assistantLine('轮1', usageTokens(100000)), assistantLine('轮2', usageTokens(150000))),
    );
    expectNoDecision(out);
  });

  test('跨档 ledger + 与 commit 无关的 transcript → block (token 触发不依赖任何 commit/HEAD 信号)', () => {
    const tx = writeTranscript('{"type":"user","message":{"content":"普通对话"}}\n');
    const out = evaluateSessionContinuityStop(
      stopInput({ transcript_path: tx }),
      ledgerFrom(assistantLine('轮1', usageTokens(150000)), assistantLine('轮2', usageTokens(210000))),
    );
    expectBlock(out);
  });

  test('transcript_path 不存在 → 不抛, 决策只来自结构化 W3 输出 (纯求值不读文件, fail-open)', () => {
    const missing = join(tmpRoot, 'no-such-transcript.jsonl');
    const crossed = ledgerFrom(assistantLine('轮1', usageTokens(150000)), assistantLine('轮2', usageTokens(210000)));
    expect(() => evaluateSessionContinuityStop(stopInput({ transcript_path: missing }), crossed)).not.toThrow();
    expectBlock(evaluateSessionContinuityStop(stopInput({ transcript_path: missing }), crossed));
  });

  test('评估不触碰 transcript 文件内容 (hook 只消费结构化 ledger, 不 grep 原文)', () => {
    const tx = writeTranscript('{"ctxTokens": 42}\n');
    const before = readFileSync(tx, 'utf-8');
    evaluateSessionContinuityStop(
      stopInput({ transcript_path: tx }),
      ledgerFrom(assistantLine('轮1', usageTokens(150000)), assistantLine('轮2', usageTokens(210000))),
    );
    expect(readFileSync(tx, 'utf-8')).toBe(before);
  });
});

describe('assistantText 对 W2 决策不透明 (无 skill-preamble 扩展 · classifier 只属 W3)', () => {
  test('跨档时 assistantText 内容 (null / <system-reminder / <task-notification / /skill 前导) 不改变决策', () => {
    const secondLine = [
      assistantLine('普通文本', usageTokens(210000)),
      assistantNoText(usageTokens(210000)),
      assistantLine('<system-reminder>reminder</system-reminder>', usageTokens(210000)),
      assistantLine('<task-notification>notify</task-notification>', usageTokens(210000)),
      assistantLine('/memory 存一条结论', usageTokens(210000)),
    ];
    for (const line of secondLine) {
      const out = evaluateSessionContinuityStop(
        stopInput(),
        ledgerFrom(assistantLine('轮1', usageTokens(150000)), line),
      );
      expectBlock(out);
    }
  });

  test('未跨档时同样与 assistantText 无关 (skill preamble 不产生触发, 也不被宽泛过滤)', () => {
    const out = evaluateSessionContinuityStop(
      stopInput(),
      ledgerFrom(assistantLine('/memory 存一条结论', usageTokens(100000))),
    );
    expectNoDecision(out);
  });
});

describe('lastUserAsk 对 W2 决策不透明 (D-5 · 唯一触发仍是 token bucket)', () => {
  test('跨档时 lastUserAsk 三态 (found / empty / blocked) 在相同 token entries 下输出逐字相同 (均 block)', () => {
    const crossed = [assistantLine('轮1', usageTokens(150000)), assistantLine('轮2', usageTokens(210000))];
    const ledgers = [
      ledgerFrom(...crossed, userRaw('git commit 226451 — 最后真实 ask')), // found (D-1 string candidate)
      ledgerFrom(...crossed, userToolResult()), // empty (tool_result 无 candidate, D-1)
      ledgerFrom(...crossed, userLine('Base directory for this skill: /home/nick/skills/foo')), // blocked (D-2)
    ];
    // user 记录不产生 entries → 三份 ledger entries 逐字相同, 差异只在 lastUserAsk。
    expect(ledgers[1]!.entries).toEqual(ledgers[0]!.entries);
    expect(ledgers[2]!.entries).toEqual(ledgers[0]!.entries);
    // 三态必须真实不同, 否则对等输出断言是空转。
    expect(ledgers[0]!.lastUserAsk.status).toBe('found');
    expect(ledgers[1]!.lastUserAsk.status).toBe('empty');
    expect(ledgers[2]!.lastUserAsk.status).toBe('blocked-skill-preamble');
    const outs = ledgers.map((l) => evaluateSessionContinuityStop(stopInput(), l));
    for (const out of outs) expectBlock(out);
    expect(outs[1]).toEqual(outs[0]);
    expect(outs[2]).toEqual(outs[0]);
  });

  test('未跨档时 lastUserAsk 三态同样不改变决策 (均 {}; HEAD/Git/grep 仍不参与)', () => {
    const idle = [assistantLine('轮1', usageTokens(100000)), assistantLine('轮2', usageTokens(150000))];
    const ledgers = [
      ledgerFrom(...idle, userRaw('HEAD 指向 226451 · git log 最新')),
      ledgerFrom(...idle, userToolResult()),
      ledgerFrom(...idle, userLine('Base directory for this skill: /home/nick/skills/bar')),
    ];
    expect(ledgers[0]!.lastUserAsk.status).toBe('found');
    expect(ledgers[1]!.lastUserAsk.status).toBe('empty');
    expect(ledgers[2]!.lastUserAsk.status).toBe('blocked-skill-preamble');
    const outs = ledgers.map((l) => evaluateSessionContinuityStop(stopInput(), l));
    for (const out of outs) expectNoDecision(out);
    expect(outs[1]).toEqual(outs[0]);
    expect(outs[2]).toEqual(outs[0]);
  });
});
