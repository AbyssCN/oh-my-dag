/**
 * chat 一轮的用量与上下文压力(2026-08-07)。
 *
 * 补的是一个**核出来的真缺口**:`emitModelUsage` 只在 `callModel` 出口被调,
 * 而 `runChatTurn` 走 pi 的 `runAgentLoop` —— TUI 每一轮的 token 与花费此前
 * **一个字都没进过账本**。所以这里第一条判据就是"它真的进账了"。
 */
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { observeModelUsage } from '../../model/accounting';
import { runChatTurn } from './agent';
import { createOmdSessionStore } from './session-store';
import { analyzeContextPressure, sumUsage, turnUsages } from './usage';

const MODEL = 'deepseek:deepseek-v4-flash';
const u = (input: number, output: number, cacheRead = 0) => ({ input, output, cacheRead, cacheWrite: 0, totalTokens: 0 });
const assistant = (text: string, usage?: ReturnType<typeof u>, stopReason: string = 'stop'): AgentMessage =>
  ({ role: 'assistant', content: [{ type: 'text', text }], timestamp: 1, stopReason, ...(usage ? { usage } : {}) }) as unknown as AgentMessage;
const user = (t: string): AgentMessage => ({ role: 'user', content: t, timestamp: 1 }) as AgentMessage;

describe('turnUsages', () => {
  test('★ 逐条不汇总 —— 每条 assistant 是一次独立的 provider 调用', () => {
    // 汇总成一笔会让账本的 `calls` 少算, 而 calls 是"这一轮打了几次模型"的唯一读数。
    expect(turnUsages([assistant('a', u(10, 2)), assistant('b', u(20, 3))])).toHaveLength(2);
  });

  test('★ 全零的不记 —— "provider 没报用量"与"这次没花钱"是两件事', () => {
    expect(turnUsages([assistant('a', u(0, 0))])).toEqual([]);
    expect(turnUsages([assistant('没有 usage 字段')])).toEqual([]);
  });

  test('user / toolResult 不算', () => {
    expect(turnUsages([user('q'), assistant('a', u(5, 1))])).toHaveLength(1);
  });

  test('cacheRead 补回 in(沿用 mapSessionUsage 的口径)', () => {
    const [got] = turnUsages([assistant('a', u(10, 2, 90))]);
    expect(got).toEqual({ in: 100, out: 2, cacheHit: 90 });
  });
});

describe('sumUsage', () => {
  test('合计给 UI 显示', () => {
    expect(sumUsage([{ in: 10, out: 1 }, { in: 20, out: 2, cacheHit: 5 }])).toEqual({ in: 30, out: 3, cacheHit: 5 });
  });

  test('没有缓存命中时不写 cacheHit 字段(0 与"没有"分得开)', () => {
    expect(sumUsage([{ in: 1, out: 1 }])).toEqual({ in: 1, out: 1 });
  });
});

describe('analyzeContextPressure', () => {
  test('分项相加等于合计', () => {
    const p = analyzeContextPressure({
      systemPrompt: 'x'.repeat(4000),
      contextFiles: [{ content: 'y'.repeat(2000) }],
      messages: [user('z'.repeat(1000))],
      windowTokens: 100_000,
    });
    expect(p.usedTokens).toBe(p.systemTokens + p.historyTokens);
    expect(p.harnessTokens).toBeGreaterThan(0);
    expect(p.harnessTokens).toBeLessThan(p.systemTokens); // harness 是 system 的一部分
  });

  test('★ 窗口未知 → ratio 是 null 不是 0(否则 UI 会画一条永远空的进度条)', () => {
    const p = analyzeContextPressure({ systemPrompt: 'x', messages: [], windowTokens: 0 });
    expect(p.ratio).toBeNull();
    expect(p.windowTokens).toBe(0);
  });

  test('窗口已知 → ratio 在 0..1', () => {
    const p = analyzeContextPressure({ systemPrompt: 'x'.repeat(400), messages: [], windowTokens: 1000 });
    expect(p.ratio).toBeGreaterThan(0);
    expect(p.ratio).toBeLessThanOrEqual(1);
  });

  test('没有 harness 文件 → harnessTokens 是 0(真值, 不是缺数据)', () => {
    expect(analyzeContextPressure({ systemPrompt: 'x', messages: [], windowTokens: 10 }).harnessTokens).toBe(0);
  });

  // 契约第 3 笔(RED, 只改测试, 不改 usage.ts —— 此刻必须红):
  // context 压力优先用 provider 真实 usage(`getLastAssistantUsage` + `calculateContextTokens`),
  // 取不到才回落现有 `estimateTokens` 估算, 并把走的哪条路如实记进新增字段 `source`。

  test('★ 有合法 assistant usage → usedTokens 取真实值, source 标 "usage"(证伪: 注释掉真实值分支只留估算, 此断言会因 usedTokens 变成估算数值而红)', () => {
    const p = analyzeContextPressure({
      systemPrompt: 'x'.repeat(4000),
      messages: [assistant('答', u(500, 100, 50))], // calculateContextTokens = 500+100+50+0 = 650
      windowTokens: 100_000,
    });
    expect(p.usedTokens).toBe(650);
    expect((p as unknown as { source: string }).source).toBe('usage');
  });

  test('★ 没有 usage 字段 → 回落估算, source 标 "estimate"(证伪: 若误把"无 usage"当真实值 0, usedTokens 会变 0 而不是估算的正数)', () => {
    const p = analyzeContextPressure({
      systemPrompt: 'x'.repeat(400),
      messages: [assistant('答')],
      windowTokens: 1000,
    });
    expect((p as unknown as { source: string }).source).toBe('estimate');
    expect(p.usedTokens).toBe(p.systemTokens + p.historyTokens);
  });

  test('★ stopReason 为 aborted/error → 即便带 usage 也回落估算(证伪: 若不查 stopReason, usedTokens 会取到那条 usage 的真实值 999 而不是估算数)', () => {
    const pAborted = analyzeContextPressure({
      systemPrompt: 'x'.repeat(400),
      messages: [assistant('答', u(900, 99), 'aborted')],
      windowTokens: 1000,
    });
    const pError = analyzeContextPressure({
      systemPrompt: 'x'.repeat(400),
      messages: [assistant('答', u(900, 99), 'error')],
      windowTokens: 1000,
    });
    for (const p of [pAborted, pError]) {
      expect((p as unknown as { source: string }).source).toBe('estimate');
      expect(p.usedTokens).toBe(p.systemTokens + p.historyTokens);
      expect(p.usedTokens).not.toBe(999);
    }
  });

  test('★ totalTokens 与四项和皆非正 → 回落估算(证伪: 若把 calculateContextTokens 的 0 误当真实值直接采用, usedTokens 会是 0 而不是估算的正数)', () => {
    const p = analyzeContextPressure({
      systemPrompt: 'x'.repeat(400),
      messages: [assistant('答', u(0, 0, 0))], // input+output+cacheRead+cacheWrite=0, totalTokens=0
      windowTokens: 1000,
    });
    expect((p as unknown as { source: string }).source).toBe('estimate');
    expect(p.usedTokens).toBe(p.systemTokens + p.historyTokens);
    expect(p.usedTokens).toBeGreaterThan(0);
  });

  test('★ windowTokens=0 时即便取到真实 usage, ratio 仍是 null(证伪: 若把 ratio 判定误绑到 source 而非 windowTokens, 这里会拿到一个非 null 的数)', () => {
    const p = analyzeContextPressure({
      systemPrompt: 'x',
      messages: [assistant('答', u(500, 100, 50))],
      windowTokens: 0,
    });
    expect((p as unknown as { source: string }).source).toBe('usage');
    expect(p.ratio).toBeNull();
    expect(p.windowTokens).toBe(0);
  });
});

describe('★ 接进账本了 —— 这是这一片补的缺口', () => {
  // 反向自检 (2026-08-07 实跑): 把 agent.ts 里那段 `for (const u of usages) emitModelUsage(...)`
  // 注释掉 → 「账本收到了」当场红。那正是这一片之前的状态: 一轮对话的钱一分都没上账。
  let root: string;
  afterEach(() => {
    root = '';
  });

  const fakeLoop = (msgs: AgentMessage[]) => (async (prompts: AgentMessage[]) => [...prompts, ...msgs]) as never;

  test('一轮对话的用量逐条进 emitModelUsage', async () => {
    root = mkdtempSync(join(tmpdir(), 'omd-chat-usage-'));
    const seen: { model: string; in: number }[] = [];
    const detach = observeModelUsage((usage, model) => seen.push({ model, in: usage.in }));
    try {
      const r = await runChatTurn({
        store: createOmdSessionStore(root), sessionId: 's', prompt: 'q', model: MODEL, cwd: root,
        loopFn: fakeLoop([assistant('答一', u(100, 10)), assistant('答二', u(200, 20))]),
      });
      expect(seen.map((s) => s.in)).toEqual([100, 200]); // 两次调用 = 账本两笔
      expect(seen.every((s) => s.model === MODEL)).toBe(true);
      expect(r.usage).toEqual({ in: 300, out: 30 }); // 合计给 UI
    } finally {
      detach();
    }
  });

  test('★ provider 没报用量 → 账本零笔(不灌水)', async () => {
    root = mkdtempSync(join(tmpdir(), 'omd-chat-usage2-'));
    const seen: unknown[] = [];
    const detach = observeModelUsage(() => seen.push(1));
    try {
      const r = await runChatTurn({
        store: createOmdSessionStore(root), sessionId: 's', prompt: 'q', model: MODEL, cwd: root,
        loopFn: fakeLoop([assistant('答')]),
      });
      expect(seen).toHaveLength(0);
      expect(r.usage).toEqual({ in: 0, out: 0 });
    } finally {
      detach();
    }
  });

  test('一轮跑完带回上下文压力(S9 算完就扔的那个数,现在返回给 UI)', async () => {
    root = mkdtempSync(join(tmpdir(), 'omd-chat-usage3-'));
    const r = await runChatTurn({
      store: createOmdSessionStore(root), sessionId: 's', prompt: 'q', model: MODEL, cwd: root,
      loopFn: fakeLoop([assistant('答', u(10, 1))]),
    });
    expect(r.pressure.usedTokens).toBeGreaterThan(0);
    expect(r.pressure.windowTokens).toBeGreaterThan(0); // deepseek-v4-flash 目录里有窗口
    expect(r.pressure.ratio).not.toBeNull();
    // ★ 集成接线回归: 真实运行时 (runChatTurn → agent.ts:332 的 analyzeContextPressure 装配点)
    // 必须真的走到 getLastAssistantUsage 消费链, 不是估算兜底 (证伪: 若 agent.ts 漏传 `messages: after`
    // 或漏传含真实 usage 的消息, source 会掉回 'estimate', 这条断言当场红)。
    expect((r.pressure as unknown as { source: string }).source).toBe('usage');
  });
});
