/**
 * S1 埋点: watchdog 采集落 checkpoint 的契约测试 (先红后建)。
 *
 * ## 这份网钉的是什么
 *
 * 双条件闸 (墙钟 T + 停滞窗口 W) 定不出 T/W, 因为盘上没有任何时间分布: 叶级活性
 * (stalled / timedOut / touchTimelineMs / toolTimelineMs) 此前**不进 checkpoint**。
 * 本文件钉住「采集 → 引擎透传 → checkpoint」这条链的三条断言, 全部经
 * `runExecutorDagWithPlan` (预构造 plan, 跳过 conductor) + 注入 runner —— 零真实 LLM。
 *
 * ## 缺席语义 (本仓铁律「NULL ≠ 0 ≠ 不适用」)
 *
 * `watchdog` 整体缺席 = 非 agent 叶 / 老记录; 存在则内部 `stalled` / `timedOut` **恒写
 * boolean** (false = 量过了且没发生, 不许用缺席表示)。三条断言都挂在「checkpoint 里
 * watchdog 字段存在」这一前提上 —— 实装前的今天, 该字段不存在, 三条全红。
 *
 * ## 反向自检 (本仓惯例: 一条永远绿的闸不是闸)
 *
 * 每条断言注释里写明证伪方式: 断开对应接缝 → 必须红。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { CheckpointManager } from './checkpoint-manager';
import { runExecutorDagWithPlan } from '../dag/engine';
import { createAgentLeafRunner } from '../agent-leaf';
import type { ConductorPlan } from '../conductor-plan';
import type { ExecutorDagConfig, GenerateFn } from '../dag/types';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const MODEL = 'claude-code:claude-sonnet-5';

const dirs: string[] = [];
const freshRoot = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'omd-wd-cp-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const asst = (text: string): SDKMessage =>
  ({
    type: 'assistant',
    session_id: 's',
    message: {
      content: [{ type: 'text', text }],
      usage: { input_tokens: 20, output_tokens: 9, cache_read_input_tokens: 5, cache_creation_input_tokens: 4 },
      stop_reason: 'end_turn',
    },
  }) as unknown as SDKMessage;

const success = (): SDKMessage =>
  ({ type: 'result', subtype: 'success', result: 'done', session_id: 's', usage: {} }) as unknown as SDKMessage;

/** SDK 订阅通道替身: 立即吐完一份正常对话 (agent-leaf-sdk.test.ts 同款)。 */
const okQuery = () => {
  return async function* () {
    yield asst('改完了');
    yield success();
  };
};

/**
 * 看门狗触发用替身: 第一条消息之后**静默 gapMs** —— 期间零循环事件 (onActivity 不叫),
 * 于是注入的小 idleTimeoutMs 必然把「没动静」判成停摆 (stalled)。gap 取 5 倍 idle 窗,
 * 时钟抖动吞不掉。
 */
const stallingQuery = (gapMs: number) => {
  return async function* () {
    yield asst('开头');
    await sleep(gapMs);
    yield asst('结尾');
    yield success();
  };
};

/** generate = 抛错哨兵: agent 路径任何意外模型调用 → 响亮失败, 不被 mock 吞掉 (INV-3/INV-6)。 */
function makeGenerate(): GenerateFn {
  return async () => {
    throw new Error('watchdog-checkpoint 测试: generate 被意外调用 (agent 节点不该走 inproc)');
  };
}

function makeConfig(generate: GenerateFn, extra: Partial<ExecutorDagConfig>): ExecutorDagConfig {
  return { conductorModel: 'test:conductor', leafModel: 'test:leaf', generate, agentTemplates: new Map(), ...extra };
}

const plan = (nodes: ConductorPlan['nodes']): ConductorPlan => ({ name: 'test-plan', nodes });

describe('watchdog 采集落 checkpoint (S1 埋点)', () => {
  test('★ agent leaf 正常跑完 → checkpoint.watchdog.stalled === false && timedOut === false', async () => {
    // 实装前的今天: watchdog 字段不存在 → cp.watchdog undefined → 本条红。
    // 证伪: 把 agent-leaf 的恒写 stalled=false/timedOut=false 改成「缺席」(该字段不存在,
    // 与 false 同形) → 本条必红 —— 缺席 ≠ false 的语义靠这一条钉住。
    const root = freshRoot();
    const cwd = join(root, 'w');
    const mgr = new CheckpointManager(root);
    const run = createAgentLeafRunner({ cwd, sdkQueryFn: okQuery() });
    const r = await runExecutorDagWithPlan(
      plan({ A: { goal: '正常干完的叶', executor: 'agent' } }),
      makeConfig(makeGenerate(), {
        agentLeafModel: MODEL,
        agentRunner: run,
        continuity: { manager: mgr, runId: 'r-wd-ok', repoRoot: root },
      }),
    );
    expect(r.results.A!.status).toBe('done');
    const cp = mgr.loadCheckpoint('r-wd-ok', 'A')!;
    expect(cp.leafKind).toBe('agent');
    // 整个 watchdog 存在 = 这条采集接了; 内部 stalled/timedOut 必须是 boolean (量过且没发生)。
    expect(cp.watchdog).toBeDefined();
    expect(cp.watchdog!.stalled).toBe(false);
    expect(cp.watchdog!.timedOut).toBe(false);
    // 两条时间线也恒带 (空数组 = 一次工具/一次写都没有, 不是缺席)。
    expect(cp.watchdog!.touchTimelineMs).toEqual([]);
    expect(cp.watchdog!.toolTimelineMs).toEqual([]);
  });

  test('★ 注入小 idleTimeoutMs 触发看门狗的假叶 → checkpoint.watchdog.stalled === true (failed checkpoint 也透传)', async () => {
    // 实装前的今天: failed checkpoint 存在 (settle 早就写) 但 watchdog 字段不存在 → 本条红。
    // 只注入 runner 参数 (idleTimeoutMs: 60 + 假 SDK 流), 默认阈值 (180_000) 一个字没改。
    // 证伪: 断开引擎对 **failed** checkpoint 的 watchdog 透传 (只透 done 的那条路 /
    // 按 node 暂存的 watchdogByNode 不落) → 本条必红 —— stalled=true 进不了 checkpoint 正是
    // 这份网要拦的洞 (看门狗判死的叶, 盘上只有 failureKind:'stall' 而读不到 watchdog 活性)。
    const root = freshRoot();
    const cwd = join(root, 'w');
    const mgr = new CheckpointManager(root);
    const run = createAgentLeafRunner({ cwd, idleTimeoutMs: 60, sdkQueryFn: stallingQuery(300) });
    const r = await runExecutorDagWithPlan(
      plan({ A: { goal: '会停摆的叶', executor: 'agent' } }),
      makeConfig(makeGenerate(), {
        agentLeafModel: MODEL,
        agentRunner: run,
        continuity: { manager: mgr, runId: 'r-wd-stall', repoRoot: root },
      }),
    );
    expect(r.results.A!.status).toBe('failed');
    expect(r.results.A!.failureKind).toBe('stall');
    const cp = mgr.loadCheckpoint('r-wd-stall', 'A')!;
    expect(cp.status).toBe('failed');
    expect(cp.watchdog).toBeDefined();
    expect(cp.watchdog!.stalled).toBe(true); // 真触发: stalled 来自 runner 的看门狗, 不是 fake 编的
    expect(cp.watchdog!.timedOut).toBe(false);
  });

  test('★ touchTimelineMs 单调不减且长度 = filesTouched 数量 (engine 透传保真)', async () => {
    // 实装前的今天: watchdog 不存在 → 本条红。
    // 证伪: ① 删掉 touchTimelineMs 采集/透传 → length 断言必红; ② 同一路径重复追加
    // (去重前就 push) → 长度 > filesTouched 数量, 必红; ③ 乱序 push → 单调断言必红。
    // 用 fake runner 直喂四字段: 钉的是引擎「结果 → checkpoint」透传这一段 (真 runner 的
    // 采集面在 agent-leaf 侧, 无工具事件时恒空, 量不出这个形状)。
    const root = freshRoot();
    const mgr = new CheckpointManager(root);
    const fakeRunner: NonNullable<ExecutorDagConfig['agentRunner']> = async () => ({
      text: '写完了',
      usage: { in: 1, out: 1 },
      filesTouched: ['a.ts', 'b.ts', 'c.ts'],
      stalled: false,
      timedOut: false,
      // 升序相对毫秒; 允许同毫秒相等 (同一时刻批量写) —— 断言只要求单调不减。
      touchTimelineMs: [3, 8, 8],
      toolTimelineMs: [1, 4, 7],
    });
    const r = await runExecutorDagWithPlan(
      plan({ A: { goal: '三文件叶', executor: 'agent' } }),
      makeConfig(makeGenerate(), {
        agentRunner: fakeRunner,
        continuity: { manager: mgr, runId: 'r-wd-tl', repoRoot: root },
      }),
    );
    expect(r.results.A!.status).toBe('done');
    const cp = mgr.loadCheckpoint('r-wd-tl', 'A')!;
    expect(cp.watchdog).toBeDefined();
    const tl = cp.watchdog!.touchTimelineMs;
    // outputPaths 即 filesTouched 的 checkpoint 投影 —— 长度必须相等 (每次新增路径恰好一条)。
    expect(tl.length).toBe(cp.outputPaths.length);
    expect(cp.outputPaths).toEqual(['a.ts', 'b.ts', 'c.ts']);
    for (let i = 1; i < tl.length; i++) {
      expect(tl[i]! >= tl[i - 1]!).toBe(true); // 单调不减 (升序, 同毫秒相等合法)
    }
    expect(cp.watchdog!.toolTimelineMs).toEqual([1, 4, 7]);
  });
});
