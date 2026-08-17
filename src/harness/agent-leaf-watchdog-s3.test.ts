/**
 * agent leaf S3 软看门狗 —— 反向自检 (2026-08-15)。
 *
 * ## 钉的是什么
 *
 * 把「叶子在原地打转」从**事后判**(等产物 / 等文本) 提到**活体判**(看 lastTouchGrowthAtMs
 * 是否还在被刷新)。但活体判据最容易写错的形状是「**纯墙钟**单条件」 —— 那会一刀切掉所有跑得久
 * 但**仍在动**的叶子。本文件用**合成**叶 + **注入时钟**, 反向钉四条, 全程不发真实模型请求:
 *
 *   ① 合成研磨叶: touched 恒零 + 注入时钟拨过 T+W → 必触发软介入, askAdvisor 恰好 1 次,
 *      advisorFiredAt 写入, advisorAdvice 非空;
 *   ② 合成高产长叶: touched 持续增 → 必不触发, advisorFiredAt===null;
 *   ③ 默认 grindAdvisorHardStop=false → 不截停, 不产生 kill/abort/stalled/timedOut 副作用,
 *      leaf 正常出文本;
 *   ④ 边界: 只满足单条件 (纯墙钟超 W 但 touched 刚刚增长) 不触发 —— 证明纯墙钟判据未被写进实现。
 *
 * 禁入判据 (本文件**不**引用): 父进程 CPU 占用 / 产物数量 / 文本字节 —— 都不是「还活着」信号。
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import {
  createAgentLeafRunner,
  GRIND_STALL_MS,
  GRIND_WALL_MS,
  shouldFireGrindAdvisor,
} from './agent-leaf';
import type { AgentLeafResult } from './agent-leaf';

const MODEL = 'claude-code:claude-sonnet-5';

let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'omd-grind-s3-'));
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

// ── 谓词层契约 (纯函数, 直接钉三条件 + 短路) ──────────────────────────
describe('shouldFireGrindAdvisor 谓词契约 (纯函数)', () => {
  it('常量 GRIND_WALL_MS=600_000 / GRIND_STALL_MS=300_000 (双条件常数, 改值会级联跑偏)', () => {
    expect(GRIND_WALL_MS).toBe(600_000);
    expect(GRIND_STALL_MS).toBe(300_000);
  });

  it('三条件齐备 (wall>W && stall>=T && advisorFiredAt===null) → true', () => {
    const t = 1_000_000;
    expect(
      shouldFireGrindAdvisor({
        startedAtMs: t,
        nowMs: t + GRIND_WALL_MS + GRIND_STALL_MS + 1,
        lastTouchGrowthAtMs: t, // 等于 startedAt = 0 增长
        advisorFiredAt: null,
      }),
    ).toBe(true);
  });

  it('★ 边界: 只满足单条件 (纯墙钟超 W 但 touched 刚刚增长) → false (钉: 纯墙钟判据未写进)', () => {
    const t = 1_000_000;
    // wall > W 已满足, 但 nowMs - lastTouchGrowthAtMs = 1ms < T → stall 不满足
    expect(
      shouldFireGrindAdvisor({
        startedAtMs: t,
        nowMs: t + GRIND_WALL_MS + 10,
        lastTouchGrowthAtMs: t + GRIND_WALL_MS + 9, // 1ms 前刚增
        advisorFiredAt: null,
      }),
    ).toBe(false);
  });

  it('★ 边界: 只满足单条件 (stall>=T 但 wall 未超 W) → false (双条件都不可缺一)', () => {
    const t = 1_000_000;
    expect(
      shouldFireGrindAdvisor({
        startedAtMs: t,
        nowMs: t + GRIND_WALL_MS - 1, // wall 未超
        lastTouchGrowthAtMs: t, // stall 已超 (W-1 >= T)
        advisorFiredAt: null,
      }),
    ).toBe(false);
  });

  it('advisorFiredAt!==null → 短路 false (每叶最多 1 次, 第二次触发被这一道闸吃下)', () => {
    expect(
      shouldFireGrindAdvisor({
        startedAtMs: 1_000_000,
        nowMs: 9_999_999,
        lastTouchGrowthAtMs: 1_000_000,
        advisorFiredAt: 1_700_000,
      }),
    ).toBe(false);
  });
});

// ── 跑圈层 (注入 deps.now + deps.askAdvisor, sdkQueryFn 替身 SDK) ──────────
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

describe('agent leaf S3 软看门狗 (注入时钟 + 假 advisor)', () => {
  it('★ ① 合成研磨叶: touched 恒零 + 时钟拨过 T+W → 必触发软介入, askAdvisor 恰好 1 次, advisorFiredAt/advisorAdvice 写入', async () => {
    const startedAtMs = 1_700_000_000_000;
    const fakeNowMs = startedAtMs + GRIND_WALL_MS + GRIND_STALL_MS + 1000;
    // 推进式注入钟: 第 1 次 now() 锁为初始 (供 runner 捕获 startedAt / 初始化 lastTouchGrowthAtMs),
    // 之后每次 now() 返回 T+W 之后 (让谓词双条件 wall>W ∧ stall>=T 都满足)。常数写法 here
    // 上一版让 nowMs===startedAtMs 恒真, 谓词墙钟不超阈, 是测试侧字面自相矛盾 —— 修在测试侧,
    // impl 不动钟语义。
    let clockMs = startedAtMs;
    const fakeNow = (): number => {
      const v = clockMs;
      clockMs = fakeNowMs;
      return v;
    };
    let askAdvisorCalls = 0;
    let recordedCtx: unknown = null;
    const fakeAdvice = 'STEP_BACK: 你已 T+W 没动过, 重新框问题。';

    const run = createAgentLeafRunner({
      cwd,
      sdkQueryFn: fakeQuery([asst('仍在原地'), success()]),
      deps: {
        now: fakeNow,
        askAdvisor: async (ctx) => {
          askAdvisorCalls++;
          recordedCtx = ctx;
          return fakeAdvice;
        },
      },
    });

    const r: AgentLeafResult = await run({ prompt: '改 a.ts 的 bug', model: MODEL });

    // 单触发: askAdvisor 整轮只被叫 1 次 (谓词短路 + advisorFiredAt!==null 闸共同保证)
    expect(askAdvisorCalls).toBe(1);
    expect(r.watchdog?.advisorFiredAt).toBe(fakeNowMs);
    expect(r.watchdog?.advisorAdvice).toBe(fakeAdvice);
    expect(r.watchdog?.advisorAdvice).not.toBe('');
    // askAdvisor 收到的 ctx 形状逐字段对得上
    expect(recordedCtx).toEqual({
      startedAtMs,
      nowMs: fakeNowMs,
      lastTouchGrowthAtMs: startedAtMs,
      cwd,
      goal: '改 a.ts 的 bug',
    });
  });

  it('★ ② 合成高产长叶: lastTouchGrowthAtMs 刚被刷新 → 必不触发, advisorFiredAt===null', () => {
    // 跑圈层 (SDK 替身无 tool 事件 → touched 增不上去) 与谓词层双向钉:
    // 谓词 false ⇒ runner 单点走 shouldFireGrindAdvisor ⇒ 不触发 ⇒ advisorFiredAt 保持 null。
    const t = 1_000_000;
    const nowMs = t + GRIND_WALL_MS + GRIND_STALL_MS + 1000; // 墙钟已超 T+W
    const lastTouchGrowthAtMs = nowMs - 100; // 100ms 前刚增 (仍在 stall 阈值内)
    expect(
      shouldFireGrindAdvisor({
        startedAtMs: t,
        nowMs,
        lastTouchGrowthAtMs,
        advisorFiredAt: null,
      }),
    ).toBe(false);
    // 反向: 即使 advisorFiredAt 还为 null (它就该为 null), 谓词不允许这次调用进 fire
    expect(
      shouldFireGrindAdvisor({
        startedAtMs: t,
        nowMs,
        lastTouchGrowthAtMs,
        advisorFiredAt: null,
      }),
    ).toBe(false);
  });

  it('★ ③ 默认 grindAdvisorHardStop=false → 软介入仍触发, 但不截停, leaf 正常出文本', async () => {
    const startedAtMs = 1_700_000_000_000;
    const fakeNowMs = startedAtMs + GRIND_WALL_MS + GRIND_STALL_MS + 1000;
    // 同 ①: 推进式注入钟, 第 1 次 = 初始 (供 startedAt), 之后 = T+W 之后 (谓词触发)
    let clockMs = startedAtMs;
    const fakeNow = (): number => {
      const v = clockMs;
      clockMs = fakeNowMs;
      return v;
    };
    let askAdvisorCalls = 0;
    let processKillCalls = 0;
    let abortControllerAborts = 0;
    // 监听 process.kill / AbortController.abort 是否被本次运行触发 (应在 false 路径上**零**)
    const origKill = process.kill;
    const origAbort = AbortController.prototype.abort;
    process.kill = (() => {
      processKillCalls++;
      return true;
    }) as typeof process.kill;
    AbortController.prototype.abort = function () {
      abortControllerAborts++;
      origAbort.call(this);
    };

    try {
      const run = createAgentLeafRunner({
        cwd,
        // 关键: 不传 grindAdvisorHardStop → 默认 false
        sdkQueryFn: fakeQuery([asst('还在磨'), success()]),
        deps: {
          now: fakeNow,
          askAdvisor: async () => {
            askAdvisorCalls++;
            return '建议: 重新框问题';
          },
        },
      });
      const r: AgentLeafResult = await run({ prompt: '磨底', model: MODEL });

      // 软介入**仍**触发 (grindAdvisorHardStop=false 不挡 askAdvisor)
      expect(askAdvisorCalls).toBe(1);
      expect(r.watchdog?.advisorFiredAt).toBe(fakeNowMs);
      // 但**不**截停:
      //  - S1 契约: stalled/timedOut 恒写 boolean (false = 量过了且没发生)
      expect(r.watchdog?.stalled).toBe(false);
      expect(r.watchdog?.timedOut).toBe(false);
      expect(r.stalled).toBeFalsy();
      //  - 进程级 kill / AbortController.abort 调用次数为 0
      expect(processKillCalls).toBe(0);
      expect(abortControllerAborts).toBe(0);
      // leaf 跑完, 正常出文本 (没被中途 kill)
      expect(r.text).toBe('还在磨');
    } finally {
      process.kill = origKill;
      AbortController.prototype.abort = origAbort;
    }
  });
});