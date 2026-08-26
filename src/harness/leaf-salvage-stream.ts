/**
 * src/harness/leaf-salvage-stream —— 把 {@link parseEmbeddedToolCalls} 接进 pi 的流式通道。
 *
 * pi 的 `runAgentLoop` 从 `done` 事件的 `message` 上读工具调用: `content` 里没有 `toolCall` 块
 * ⇒ 本轮没工具 ⇒ 循环收尾。所以抢救必须发生在**这个事件到达循环之前** —— 唯一的接缝是
 * `runAgentLoop` 的第 6 参 `streamFn`。本文件把真 `streamSimple` 包一层: 事件原样转发,
 * 只在 `done` 上把正文里的调用改写进 `message.content`。
 *
 * ## 三条不许越的线
 *
 * ① **已有原生 toolCall → 一个字不动。** 抢救只在"零工具调用"时上场。模型正常走 tool_calls
 *    的路径必须与包之前**逐字节相同**, 否则这一层就成了新的故障源。
 * ② **先剥 `<think>` 再解析。** M3 把推理内联在 `<think>…</think>` 里 (见 `src/model/strip-think.ts`
 *    的实测注)。think 段里的工具调用是**草稿** —— 模型自己可能在后半段推翻了它。不剥就抢救,
 *    等于替模型执行它已经放弃的那个决定。`<think>` 开了没闭 (被 maxTokens 砍断) → 整段不抢救。
 * ③ **工具名必须已注册。** `known` 由装配处从真工具面传进来。见 tool-call-salvage.ts 文件头。
 *
 * ## 为什么不是在 transformContext / getFollowUpMessages 上做
 *
 * 那两个钩子都在**循环已经决定收尾之后**才跑, 那时这一轮的工具调用机会已经过去了。挂在那里
 * 只能"下一轮提醒模型改用工具面", 多烧一整轮, 而且模型未必听。
 */
import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions, ToolCall } from '@earendil-works/pi-ai';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { randomUUID } from 'node:crypto';
import { stripThink } from '../model/strip-think';
import { logger } from '../logger';
import { parseEmbeddedToolCalls, stripSpans } from './tool-call-salvage';

/** pi 的 streamFn 形状 (与 `runAgentLoop` 第 6 参一致)。 */
export type LeafStreamFn = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) => ReturnType<typeof createAssistantMessageEventStream>;

/** 一次抢救的读数 (装配处落账用; 没触发就不会被调)。 */
export interface SalvageEvent {
  /** 抢救出的调用数 (≥ 1 才会发这个事件)。 */
  calls: number;
  /** 抢救到的工具名 (去重, 保序)。 */
  names: string[];
  /** 认出形状但工具名不认识 —— 这些**没有**被执行。 */
  unknownNames: string[];
  /** 正文里还有被砍断的调用尾块 —— 同样**没有**被执行。 */
  truncated: boolean;
}

export const SALVAGE_LOG = '[agent-leaf] 正文内嵌工具调用抢救 → 改写成原生 toolCall';
export const SALVAGE_SKIP_UNCLOSED_LOG = '[agent-leaf] 正文含未闭合 <think> (回复被砍断) → 不抢救';

/** `message.content` 里已经有原生工具调用? */
function hasNativeToolCall(msg: AssistantMessage): boolean {
  return msg.content.some((b) => b.type === 'toolCall');
}

/**
 * 纯函数: 一条 assistant 消息 → 抢救后的消息 (没抢救到就**返回同一个对象引用**, 调用方据此短路)。
 * 独立导出是为了脱开流与网络单测 —— 这一层的判据全在这里。
 */
export function salvageAssistantMessage(
  msg: AssistantMessage,
  known: ReadonlySet<string>,
  onEvent?: (e: SalvageEvent) => void,
): AssistantMessage {
  if (hasNativeToolCall(msg)) return msg;
  const textBlocks = msg.content.filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text');
  const raw = textBlocks.map((b) => b.text).join('');
  if (raw.length === 0) return msg;
  const think = stripThink(raw);
  if (think.unclosed) {
    // `<think>` 开了没闭 = 回复在思考中途被砍断, 正文根本没生成。此时"正文里的工具调用"
    // 只可能是草稿的一部分。**不抢救**, 但要留痕 —— 「被砍断」与「压根没调」是两件事。
    logger.warn({ bytes: raw.length }, SALVAGE_SKIP_UNCLOSED_LOG);
    return msg;
  }
  const body = think.body;
  const parsed = parseEmbeddedToolCalls(body, known);
  if (parsed.calls.length === 0) {
    // 认出了形状但一条都没抢救成 (工具名不认识 / 尾块被砍断) —— 这是要留证据的:
    // 它和"正文里根本没有工具调用"是两件事, 而后者才是正常收尾。
    if (parsed.unknownNames.length > 0 || parsed.truncated) {
      onEvent?.({ calls: 0, names: [], unknownNames: parsed.unknownNames, truncated: parsed.truncated });
      logger.warn(
        { unknown: parsed.unknownNames, truncated: parsed.truncated },
        '[agent-leaf] 正文里认出工具调用形状但无一可执行 (工具名未注册 / 尾块被砍断)',
      );
    }
    return msg;
  }
  const remaining = stripSpans(body, parsed.spans);
  const toolCalls: ToolCall[] = parsed.calls.map((c) => ({
    // id 前缀是刻意的: 事后翻 transcript 时, 一次抢救出来的调用必须一眼认得出不是模型自己发的。
    type: 'toolCall',
    id: `salvaged-${randomUUID()}`,
    name: c.name,
    arguments: c.arguments,
  }));
  const names: string[] = [];
  for (const c of parsed.calls) if (!names.includes(c.name)) names.push(c.name);
  onEvent?.({ calls: parsed.calls.length, names, unknownNames: parsed.unknownNames, truncated: parsed.truncated });
  logger.info(
    { calls: parsed.calls.length, names, unknown: parsed.unknownNames, truncated: parsed.truncated },
    SALVAGE_LOG,
  );
  // 非 text 块 (thinking 等) 原样保留在原位; text 块**整体**换成剥离后的一块
  // (逐块回填要重算跨块 span, 那是一整类越界 bug 的来源, 不值得为省一个块换)。
  const kept = msg.content.filter((b) => b.type !== 'text');
  const rebuilt: AssistantMessage['content'] = [
    ...kept,
    ...(remaining.length > 0 ? [{ type: 'text' as const, text: remaining }] : []),
    ...toolCalls,
  ];
  // stopReason 必须一起改: 循环两处都读得到它 (`done.reason` 与 `message.stopReason`),
  // 只改一处会出现"有工具调用但循环认为该停"的分裂状态。
  return { ...msg, content: rebuilt, stopReason: 'toolUse' };
}

/**
 * 包一层 streamFn。`known` 为空集时**直接返回 inner** —— 没有工具面就没有抢救可言,
 * 这条短路让"没配工具的座位"完全不经过本层 (零回归)。
 */
export function withToolCallSalvage(
  inner: LeafStreamFn,
  opts: { known: ReadonlySet<string>; onSalvage?: (e: SalvageEvent) => void },
): LeafStreamFn {
  if (opts.known.size === 0) return inner;
  return (model, context, options) => {
    const src = inner(model, context, options);
    const out = createAssistantMessageEventStream();
    void (async () => {
      try {
        for await (const ev of src) {
          if (ev.type === 'done') {
            const salvaged = salvageAssistantMessage(ev.message, opts.known, opts.onSalvage);
            if (salvaged === ev.message) out.push(ev);
            else out.push({ ...ev, reason: 'toolUse', message: salvaged });
            return; // push 一个 done 事件即 resolve 掉 result(), 后面不会再有事件
          }
          out.push(ev);
        }
        // 上游流没发 done/error 就结束了 —— 不是我们该修的事, 但也不许把消费者挂死。
        out.end();
      } catch (err) {
        // fail-open: 抢救层自己炸了不许拖垮整轮。但**不许吞证据** (本仓 §静默坑 2)。
        logger.error({ err: String(err) }, '[agent-leaf] 抢救层异常 → 本轮按无抢救收尾');
        out.end();
      }
    })();
    return out;
  };
}
