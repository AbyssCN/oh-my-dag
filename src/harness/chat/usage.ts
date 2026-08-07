/**
 * src/harness/chat/usage —— **chat 一轮的用量与上下文压力**(2026-08-07)。
 *
 * ## 补的是一个真缺口,不是显示层的活
 *
 * 核过三条命令的事实:`emitModelUsage`(账本入口)**只在 `src/model/index.ts` 的 `callModel`
 * 出口被调**;而 `runChatTurn` 走的是 pi 的 `runAgentLoop`,**根本不经过 `callModel`**。
 * ⇒ **TUI 里每一轮对话的 token 与花费,此前一个字都没进过账本。**
 * (唯一进账的是 S9 那次压缩调用 —— 因为那一条是故意走 `callModel` 的。)
 *
 * 数据本身一直都在:每条 assistant 消息自带 `usage`(pi 的 `Usage`),
 * 换算函数 `mapSessionUsage` 也早就有 —— 只有 agent-leaf 那条路在用,chat 这条没接。
 *
 * ## 上下文压力:S9 已经在算,算完就扔
 *
 * 压缩判定每轮都要算「已用 / 窗口」,但那个数只进了一句日志。人在屏幕前**看不到快满了**,
 * 直到某一轮突然被压缩。这里把它变成一个可显示的结构。
 */
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { estimateTokens } from '@earendil-works/pi-agent-core';
import type { ModelUsage } from '../../model/types';
import { mapSessionUsage } from '../agent-leaf';

/** pi 的 `Usage` 里我们用得上的那几个字段(结构性依赖收窄到这里)。 */
interface PiUsageLike {
  input?: number;
  output?: number;
  cacheRead?: number;
}

/**
 * 把本轮返回消息里的用量**逐条**取出来。
 *
 * ⚠ **逐条不汇总**:`returned` 里可能有多条 assistant 消息(工具循环每轮一条),
 * 每条是**一次独立的 provider 调用**。汇总成一笔会让账本的 `calls` 少算 ——
 * 而 `calls` 正是"这一轮到底打了几次模型"的唯一读数。
 */
export function turnUsages(messages: readonly AgentMessage[]): ModelUsage[] {
  const out: ModelUsage[] = [];
  for (const m of messages) {
    const u = (m as { role?: string; usage?: PiUsageLike }).usage;
    if ((m as { role?: string }).role !== 'assistant' || !u) continue;
    const mapped = mapSessionUsage(u);
    // 全零的不记: provider 没报用量与"这次没花钱"是两件事, 记一笔零会把 calls 灌水。
    if (mapped.in === 0 && mapped.out === 0) continue;
    out.push(mapped);
  }
  return out;
}

/** 若干笔用量合成一笔(给 UI 显示"这一轮总共"用)。 */
export function sumUsage(list: readonly ModelUsage[]): ModelUsage {
  const total: ModelUsage = { in: 0, out: 0 };
  let cacheHit = 0;
  for (const u of list) {
    total.in += u.in;
    total.out += u.out;
    cacheHit += u.cacheHit ?? 0;
  }
  if (cacheHit > 0) total.cacheHit = cacheHit;
  return total;
}

export interface ContextPressure {
  /** 系统提示总量(含冻结前缀 + 工具 snippet + harness 文件)。 */
  systemTokens: number;
  /** 其中 harness 文件(CLAUDE.md / AGENTS.md)贡献的那部分。 */
  harnessTokens: number;
  /** 会话历史。 */
  historyTokens: number;
  /** 合计 = system + history。 */
  usedTokens: number;
  /** 模型窗口;`0` = 目录里查不到(**不是"窗口为 0"**,是不知道)。 */
  windowTokens: number;
  /** 占比 0..1;窗口未知时 `null` —— 不拿一个编出来的分母算百分比。 */
  ratio: number | null;
}

/**
 * 算一次上下文压力。**纯函数**,时钟/IO 都不碰。
 *
 * ⚠ `windowTokens === 0` 时 `ratio` 返回 `null` 而不是 0:
 * "占了 0%" 与 "不知道占多少" 是两件事,压成一个数之后 UI 就会画出一条永远空的进度条。
 */
export function analyzeContextPressure(opts: {
  systemPrompt: string;
  contextFiles?: readonly { content: string }[];
  messages: readonly AgentMessage[];
  windowTokens: number;
}): ContextPressure {
  const systemTokens = estimateTokens({ role: 'user', content: opts.systemPrompt, timestamp: 0 } as AgentMessage);
  const harnessTokens = (opts.contextFiles ?? []).reduce(
    (n, f) => n + estimateTokens({ role: 'user', content: f.content, timestamp: 0 } as AgentMessage),
    0,
  );
  const historyTokens = opts.messages.reduce((n, m) => n + estimateTokens(m), 0);
  const usedTokens = systemTokens + historyTokens;
  const windowTokens = Math.max(0, opts.windowTokens);
  return {
    systemTokens,
    harnessTokens,
    historyTokens,
    usedTokens,
    windowTokens,
    ratio: windowTokens > 0 ? usedTokens / windowTokens : null,
  };
}
