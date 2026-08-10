/**
 * src/harness/chat/memory-inject —— **记忆自动注入**(goal §4 S16,A8)。
 *
 * ## 走 `transformContext`,不写进会话
 *
 * `transformContext` 只改**这一次请求**看到的消息,不写回 `context.messages`
 * (与 agent-leaf 的 drift 注入同一条路,`agent-leaf.ts:694` 的注释记的就是这个理由)。
 * 于是"召回 → 注一次"是天然的边沿行为,不会在 transcript 里堆成 N 份召回结果,
 * 也不会把召回内容当成用户说过的话落进 ChatStore。
 *
 * ## advisory:失败静默 no-op,**不阻断一轮**
 *
 * goal §4 明写这一条。记忆是**线索不是真理** —— 召回挂了(库锁了、embedding 服务不在)
 * 不该让用户这一句话发不出去。但 fail-open 的另一半照旧:**不许吞证据**,
 * 每次失败留一行(错误原文 + query),否则"记忆一直没生效"这件事永远查不出来。
 *
 * ## `human_verified` 在 headless 下 fail-closed
 *
 * goal §4 点名。写记忆这条路**不在这里** —— 这个文件只召回,不写。
 * 而"不写"正是 fail-closed 的兑现方式:`memory_remember` 刻意**不在** chat 位白名单里
 * (`serve/chat-tools.ts` 原话:「记忆只给 recall 不给 remember:召回是读,写记忆是有后果的动作,
 * 不放在对话位自主调」)。所以 TUI 里的 conductor **没有任何一条路**能自主写下
 * 一条 human_verified 事实。`memory-inject.test.ts` 有一条钉住这个不变量。
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { logger } from '../../logger';
import type { OmdMemory } from '../memory/store';

/** 注入块的定界符。**两端都要有** —— 只有开头的话,后面的正文会被读成召回内容的一部分。 */
export const RECALL_OPEN = '<omd-recall>';
export const RECALL_CLOSE = '</omd-recall>';

export interface MemoryInjectOpts {
  memory: OmdMemory;
  /** 召回条数上限。太多会把冻结前缀之后的窗口吃光。 */
  k?: number;
  /** 单条事实截断长度 —— 一条超长事实不该挤掉其它四条。 */
  maxCharsPerFact?: number;
  /** 时钟注入(TTL 回收要可测)。 */
  now?: () => Date;
  /**
   * 召回漏斗打点(C-9,S-F):**注入真发生**时 append 一行 `{ts, hits, queryChars}`。
   * 此前 INJECTED 无盘上痕迹(transformContext 刻意不进 transcript,logger 一行是唯一
   * 证据)。路径**显式注入**(调用方拼 `join(cwd,'.omd','recall-events.jsonl')`)——
   * 不吃进程 cwd(2026-08-10 一天三踩的锚陷阱)。省略 = 不打点(无行 = NULL,不是 0)。
   * ACTION CHANGED 刻意不记:无真值,只有代理指标(读侧另算,报表必须标「代理」)。
   */
  eventsPath?: string;
}

/**
 * 从消息尾部取出**最后一条用户消息**当召回 query。
 *
 * ⚠ 不用整段对话当 query:那样每一轮的 query 都几乎一样,召回结果也就几乎一样,
 * 注入就退化成一份恒定的噪声。用户刚说的那句话才是"现在想知道什么"。
 */
export function lastUserText(messages: readonly AgentMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string; content?: unknown };
    if (m.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) {
      const text = m.content
        .map((c) => (c as { type?: string; text?: string }).text ?? '')
        .filter(Boolean)
        .join('\n');
      if (text) return text;
    }
  }
  return null;
}

/** 召回结果 → 一条注入用的 user 消息正文。空结果返回 `null`(**不注入空块**)。 */
export function formatRecall(hits: { text: string }[], maxCharsPerFact: number): string | null {
  const lines = hits
    .map((h) => h.text.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .map((t) => `- ${t.length > maxCharsPerFact ? `${t.slice(0, maxCharsPerFact)}…` : t}`);
  if (lines.length === 0) return null;
  return (
    `${RECALL_OPEN}\n` +
    '以下是从 omd 自记忆里召回的既有事实。**召回是线索不是真理** —— ' +
    '低置信度的落到依据前先核真源;与当前证据冲突时以当前为准。\n' +
    `${lines.join('\n')}\n${RECALL_CLOSE}`
  );
}

/**
 * 造一个 `transformContext` 钩子。
 *
 * 顺带在每次调用前跑一次 TTL 回收(`prune`)—— 那是 `OmdMemory` 早就有、但**一直没有挂载点**
 * 的方法(goal §3 原话)。挂在这里的理由:这是记忆在 chat 路径上唯一被碰到的地方,
 * 不另起一个定时器(定时器要管生命周期,而 TUI 退出时没人 unref 它)。
 */
export function createMemoryTransform(opts: MemoryInjectOpts): (messages: AgentMessage[]) => Promise<AgentMessage[]> {
  const k = opts.k ?? 5;
  const maxChars = opts.maxCharsPerFact ?? 400;
  const now = opts.now ?? (() => new Date());

  return async (messages: AgentMessage[]): Promise<AgentMessage[]> => {
    try {
      // TTL 回收: 过期的 agent_tentative 事实先 tombstone, 免得被召回出来当真。
      const pruned = opts.memory.prune(now());
      if (pruned > 0) logger.info({ pruned }, '[omd/memory] TTL 回收 (过期事实已 tombstone)');

      const query = lastUserText(messages);
      if (!query) return messages;
      const hits = await opts.memory.retrieve(query, k);
      const block = formatRecall(hits, maxChars);
      if (!block) return messages;
      logger.info({ query: query.slice(0, 80), hits: hits.length }, '[omd/memory] 召回已注入 (advisory)');
      // C-9 漏斗打点: INJECTED 落一条可数记录 (advisory 同款纪律: 打点失败不阻断注入, 但留证据)。
      if (opts.eventsPath) {
        try {
          mkdirSync(dirname(opts.eventsPath), { recursive: true });
          appendFileSync(opts.eventsPath, `${JSON.stringify({ ts: now().getTime(), hits: hits.length, queryChars: query.length })}\n`);
        } catch (err) {
          logger.warn({ err: (err as Error).message, path: opts.eventsPath }, '[omd/memory] 召回打点写入失败 (注入照常, 该行缺席 = NULL 不是 0)');
        }
      }
      // 注在**末尾**: 冻结前缀在最前, 追加只失效一次并重建 (goal §6 纪律 2)。
      return [...messages, { role: 'user' as const, content: block, timestamp: Date.now() } as AgentMessage];
    } catch (err) {
      // advisory: 失败静默 no-op, 不阻断这一轮。但**不吞证据** —— 不留一行的话,
      // "记忆一直没生效"这件事永远查不出来 (本仓 S-12 那条的代价)。
      logger.warn({ err: (err as Error).message }, '[omd/memory] 召回失败 → 本轮不注入 (advisory, 不阻断)');
      return messages;
    }
  };
}
