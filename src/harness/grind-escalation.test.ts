/**
 * grind 三档阶梯 (D-1/D-2) —— nextGrindAction 纯谓词 + runOnce 三档接线 + watchdog 记账位。
 * 验收 GWT 1-3 (SDD 2026-08-17)。
 *
 * 形状同 agent-leaf-watchdog-s3.test.ts: 纯函数直钉 + 注入 deps.now + 假 advisor 的跑圈层。
 * 覆盖范围: 本文件**只**测二/三档 (wrapup / abort); advisor 单档的契约由 S3 测试守, 不动。
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import {
  createAgentLeafRunner,
  GRIND_ABORT_MS,
  GRIND_STALL_MS,
  GRIND_WALL_MS,
  GRIND_WRAPUP_MS,
  nextGrindAction,
  type GrindAdvisorSnapshot,
} from './agent-leaf';
import type { AgentLeafResult } from './agent-leaf';

const MODEL = 'claude-code:claude-sonnet-5';

let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'omd-grind-escalation-'));
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

// ── 谓词层契约 (纯函数) ──────────────────────────────────────────────
describe('nextGrindAction 谓词契约 (纯函数, 三档阶梯)', () => {
  it('常量 GRIND_WRAPUP_MS=300_000 / GRIND_ABORT_MS=600_000 (改值会级联跑偏)', () => {
    expect(GRIND_WRAPUP_MS).toBe(300_000);
    expect(GRIND_ABORT_MS).toBe(600_000);
  });

  it('★ GWT-1.a: 双条件齐备 (wall>W && stall>=T && advisorFiredAt===null) → advisor', () => {
    const t = 1_000_000;
    const s: GrindAdvisorSnapshot = {
      startedAtMs: t,
      nowMs: t + GRIND_WALL_MS + GRIND_STALL_MS + 1,
      lastTouchGrowthAtMs: t,
      advisorFiredAt: null,
    };
    expect(nextGrindAction(s)).toBe('advisor');
  });

  it('★ GWT-1.b: advisor 已触发 + 距 advisor ≥ GRIND_WRAPUP_MS + 仍停滞 → wrapup', () => {
    const t = 1_000_000;
    const advisorAt = t + GRIND_WALL_MS + GRIND_STALL_MS + 1;
    const s: GrindAdvisorSnapshot = {
      startedAtMs: t,
      nowMs: advisorAt + GRIND_WRAPUP_MS + 1,
      lastTouchGrowthAtMs: t, // 仍停滞 (stall > T)
      advisorFiredAt: advisorAt,
      wrapupFiredAt: null,
    };
    expect(nextGrindAction(s)).toBe('wrapup');
  });

  it('★ GWT-1.c: wrapup 已触发 + 距 wrapup ≥ GRIND_ABORT_MS + 仍停滞 → abort', () => {
    const t = 1_000_000;
    const advisorAt = t + GRIND_WALL_MS + GRIND_STALL_MS + 1;
    const wrapupAt = advisorAt + GRIND_WRAPUP_MS + 1;
    const s: GrindAdvisorSnapshot = {
      startedAtMs: t,
      nowMs: wrapupAt + GRIND_ABORT_MS + 1,
      lastTouchGrowthAtMs: t, // 仍停滞
      advisorFiredAt: advisorAt,
      wrapupFiredAt: wrapupAt,
    };
    expect(nextGrindAction(s)).toBe('abort');
  });

  it('★ GWT-2: wrap-up 注入后 touched 有新增 → abort 不触发 (stall 钟随 touch 重置)', () => {
    const t = 1_000_000;
    const advisorAt = t + GRIND_WALL_MS + GRIND_STALL_MS + 1;
    const wrapupAt = advisorAt + GRIND_WRAPUP_MS + 1;
    // 模型响应 wrap-up, 改了一个文件: lastTouchGrowthAtMs 推到「nowMs - GRIND_STALL_MS + 1」之内,
    // stall 落回阈值以下 → wrapup 已触发但 abort 不该触发 (收尾成功的叶正常 done)。
    const nowMs = wrapupAt + GRIND_ABORT_MS + 10; // 距 wrapup 远超阈值
    const s: GrindAdvisorSnapshot = {
      startedAtMs: t,
      nowMs,
      lastTouchGrowthAtMs: nowMs - GRIND_STALL_MS + 1,
      advisorFiredAt: advisorAt,
      wrapupFiredAt: wrapupAt,
    };
    expect(nextGrindAction(s)).toBe(null);
  });

  it('次序固定 advisor→wrapup→abort, 不跳档: advisor 已触发但距 advisor 不足 GRIND_WRAPUP_MS → null', () => {
    const t = 1_000_000;
    const advisorAt = t + GRIND_WALL_MS + GRIND_STALL_MS + 1;
    const s: GrindAdvisorSnapshot = {
      startedAtMs: t,
      nowMs: advisorAt + GRIND_WRAPUP_MS - 1,
      lastTouchGrowthAtMs: t,
      advisorFiredAt: advisorAt,
      wrapupFiredAt: null,
    };
    expect(nextGrindAction(s)).toBe(null);
  });

  it('wrapup 已触发但距 wrapup 不足 GRIND_ABORT_MS → null', () => {
    const t = 1_000_000;
    const advisorAt = t + GRIND_WALL_MS + GRIND_STALL_MS + 1;
    const wrapupAt = advisorAt + GRIND_WRAPUP_MS + 1;
    const s: GrindAdvisorSnapshot = {
      startedAtMs: t,
      nowMs: wrapupAt + GRIND_ABORT_MS - 1,
      lastTouchGrowthAtMs: t,
      advisorFiredAt: advisorAt,
      wrapupFiredAt: wrapupAt,
    };
    expect(nextGrindAction(s)).toBe(null);
  });

  it('INV-2 三档各至多一次: advisor/wrapup/abort 全部已触发 → 仅在 stall 仍 ≥ T 时才返 abort', () => {
    const t = 1_000_000;
    const advisorAt = t + GRIND_WALL_MS + GRIND_STALL_MS + 1;
    const wrapupAt = advisorAt + GRIND_WRAPUP_MS + 1;
    // stall 已落回阈值以下 (touched 新增) → 即便距 wrapup 远超阈值, 也不返 abort
    const nowMs = wrapupAt + GRIND_ABORT_MS + 10;
    const s: GrindAdvisorSnapshot = {
      startedAtMs: t,
      nowMs,
      lastTouchGrowthAtMs: nowMs - GRIND_STALL_MS + 1,
      advisorFiredAt: advisorAt,
      wrapupFiredAt: wrapupAt,
    };
    expect(nextGrindAction(s)).toBe(null);
  });
});

// ── 跑圈层 (注入 deps.now + deps.askAdvisor, sdkQueryFn 替身 SDK) ──────
const asst = (text: string): SDKMessage =>
  ({
    type: 'assistant',
    session_id: 's',
    message: { content: [{ type: 'text', text }], usage: {}, stop_reason: 'end_turn' },
  }) as unknown as SDKMessage;

const success = (): SDKMessage =>
  ({ type: 'result', subtype: 'success', result: 'done', session_id: 's', usage: {} }) as unknown as SDKMessage;

const fakeQuery = (script: SDKMessage[]) =>
  (_props: { prompt: string; options: Options }) =>
    (async function* () {
      for (const m of script) yield m;
    })();

describe('agent leaf grind 三档阶梯 (注入时钟 + 假 advisor, GWT-3 abort 路径)', () => {
  it('★ GWT-3: 三档全过仍停滞 → abort 触发, spin-fused 写三级时间线, filesTouched 保留', async () => {
    const startedAtMs = 1_700_000_000_000;
    const tAdvisor = startedAtMs + GRIND_WALL_MS + GRIND_STALL_MS + 1000;
    const tWrapup = tAdvisor + GRIND_WRAPUP_MS + 1000;
    const tAbort = tWrapup + GRIND_ABORT_MS + 1000;
    // 推进钟: 第 1 次 = startedAt (供 `const startedAt = now()`); 之后逐步拨到三档阈值。
    // 每个 script item = 一次 emit → 一次 noteProgress → 一次 maybeFireGrindEscalation.now()。
    // 第 1 个 asst → tAdvisor (advisor 触发); 第 2 个 asst → tWrapup (wrapup 触发);
    // 第 3 个 asst → tAbort (abort 触发 → controller.abort()); 第 4 个 success → tAbort (predicate
    // 仍 null, 因 sinceWrapup=0 < GRIND_ABORT_MS, 不重入)。后续 now() 兜底回 tAbort。
    const fakeNowSequence = [
      startedAtMs, // call 1: startedAt
      tAdvisor, // call 2: 1st event's escalation check
      tWrapup, // call 3: 2nd event
      tAbort, tAbort, tAbort, tAbort, tAbort, tAbort, tAbort, // calls 4-10: 3rd event + padding
    ];
    let n = 0;
    const fakeNow = (): number => fakeNowSequence[n++] ?? tAbort;
    let askAdvisorCalls = 0;
    const fakeAdvice = '建议: 重新框问题。';

    const run = createAgentLeafRunner({
      cwd,
      sdkQueryFn: fakeQuery([asst('第一轮'), asst('第二轮'), asst('第三轮 (被 abort)'), success()]),
      deps: {
        now: fakeNow,
        askAdvisor: async () => {
          askAdvisorCalls++;
          return fakeAdvice;
        },
      },
    });

    const r: AgentLeafResult = await run({ prompt: '改 a.ts 的 bug', model: MODEL });

    // advisor 档: 仅 1 次 (谓词短路 + state short-circuit 共同保证)
    expect(askAdvisorCalls).toBe(1);
    expect(r.watchdog?.advisorFiredAt).toBe(tAdvisor - startedAtMs);
    // wrapup + abort 档: 各触发 1 次, 时刻以「距 startedAt 的相对毫秒数」计 (INV-5)
    expect(r.watchdog?.wrapupFiredAt).toBe(tWrapup - startedAtMs);
    expect(r.watchdog?.abortedByGrind).toBe(true);
    // spin-fused 路径: spinFused 字段非空, 含三级时间线 (INV-3)
    expect(r.spinFused).toBeDefined();
    expect(r.spinFused).toContain('grind 三档阶梯命中 abort');
    expect(r.spinFused).toContain(`advisor=${tAdvisor - startedAtMs}ms`);
    expect(r.spinFused).toContain(`wrapup=${tWrapup - startedAtMs}ms`);
    expect(r.spinFused).toContain(`abort=${tAbort - startedAtMs}ms`);
    // INV-3: filesTouched 保留 (本 leaf 没真动文件, 但字段应可读, 类型 = string[])
    expect(Array.isArray(r.filesTouched)).toBe(true);
    // INV-3: stalled 是 idle watchdog 的事, grind abort 不该把它弄成 true
    expect(r.watchdog?.stalled).toBe(false);
  });
});