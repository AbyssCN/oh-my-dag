/**
 * 抢救层接进 pi 流通道 —— 判据全在 `salvageAssistantMessage`, 流包壳只验转发与短路。
 *
 * **反向自检**: 「已有原生 toolCall 就一个字不动」「`<think>` 里的草稿不许被执行」两条
 * 各配一个会红的用例 —— 去掉对应分支这两条立刻失败。
 */
import { describe, expect, test } from 'bun:test';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import type { AssistantMessage, AssistantMessageEvent } from '@earendil-works/pi-ai';
import { salvageAssistantMessage, withToolCallSalvage, type LeafStreamFn } from './leaf-salvage-stream';

const KNOWN = new Set(['write', 'read']);

function msg(content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason'] = 'stop'): AssistantMessage {
  return {
    role: 'assistant',
    content,
    api: 'openai-completions',
    provider: 'minimax-cn',
    model: 'MiniMax-M3',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    stopReason,
    timestamp: 0,
  } as AssistantMessage;
}

const CALL_TEXT = `<tool_call>{"name":"write","arguments":{"path":"a.ts","content":"x"}}</tool_call>`;

describe('salvageAssistantMessage', () => {
  test('正文里的调用 → 改写成原生 toolCall 且 stopReason 翻成 toolUse', () => {
    const out = salvageAssistantMessage(msg([{ type: 'text', text: `先写文件。\n${CALL_TEXT}` }]), KNOWN);
    const calls = out.content.filter((b) => b.type === 'toolCall');
    expect(calls).toHaveLength(1);
    expect((calls[0] as { name: string }).name).toBe('write');
    // id 前缀是事后翻 transcript 时"这不是模型自己发的"的唯一标记。
    expect((calls[0] as { id: string }).id.startsWith('salvaged-')).toBe(true);
    expect(out.stopReason).toBe('toolUse');
    // 剥离后的正文保留, 调用那段挖掉。
    expect(out.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text)).toEqual(['先写文件。']);
  });

  test('反向 —— 已有原生 toolCall 时**返回同一个对象引用** (零回归的判据)', () => {
    const m = msg([
      { type: 'text', text: CALL_TEXT },
      { type: 'toolCall', id: 'real-1', name: 'read', arguments: { path: 'a' } },
    ], 'toolUse');
    expect(salvageAssistantMessage(m, KNOWN)).toBe(m); // 引用相等, 不是内容相等
  });

  test('反向 —— <think> 里的调用是草稿, 剥掉之后不产出调用', () => {
    // M3 把推理内联在 <think> 里。think 段中的调用模型自己可能已经推翻了 ——
    // 抢救它等于替模型执行一个它放弃的决定。
    const m = msg([{ type: 'text', text: `<think>也许该 ${CALL_TEXT} ?</think>\n算了, 先读一下。` }]);
    expect(salvageAssistantMessage(m, KNOWN)).toBe(m);
  });

  test('<think> 外面的调用照常抢救 (证明上一条不是把整条路关死了)', () => {
    const m = msg([{ type: 'text', text: `<think>先想想</think>\n${CALL_TEXT}` }]);
    const out = salvageAssistantMessage(m, KNOWN);
    expect(out.content.some((b) => b.type === 'toolCall')).toBe(true);
  });

  test('<think> 开了没闭 (回复被砍断) → 整段不抢救', () => {
    const m = msg([{ type: 'text', text: `<think>正在想 ${CALL_TEXT}` }]);
    expect(salvageAssistantMessage(m, KNOWN)).toBe(m);
  });

  test('工具名未注册 → 不改写, 但发出 unknownNames 事件 (不许静默)', () => {
    const seen: unknown[] = [];
    const m = msg([{ type: 'text', text: `<tool_call>{"name":"rm_rf","arguments":{}}</tool_call>` }]);
    expect(salvageAssistantMessage(m, KNOWN, (e) => seen.push(e))).toBe(m);
    expect(seen).toEqual([{ calls: 0, names: [], unknownNames: ['rm_rf'], truncated: false }]);
  });

  test('thinking 块原样保留在原位', () => {
    const out = salvageAssistantMessage(
      msg([{ type: 'thinking', thinking: 'hmm', thinkingSignature: '' } as never, { type: 'text', text: CALL_TEXT }]),
      KNOWN,
    );
    expect(out.content[0]!.type).toBe('thinking');
  });
});

describe('withToolCallSalvage (流包壳)', () => {
  /** 造一个只发 start + done 的假上游流。 */
  function fakeStream(message: AssistantMessage): LeafStreamFn {
    return () => {
      const s = createAssistantMessageEventStream();
      queueMicrotask(() => {
        s.push({ type: 'start', partial: message } as AssistantMessageEvent);
        s.push({ type: 'done', reason: message.stopReason as 'stop', message } as AssistantMessageEvent);
      });
      return s;
    };
  }

  test('done 事件上的 message 被换成抢救后的版本, reason 一并翻', async () => {
    const wrapped = withToolCallSalvage(fakeStream(msg([{ type: 'text', text: CALL_TEXT }])), { known: KNOWN });
    const events: AssistantMessageEvent[] = [];
    const stream = wrapped({} as never, {} as never);
    for await (const ev of stream) events.push(ev);
    const done = events.find((e) => e.type === 'done') as Extract<AssistantMessageEvent, { type: 'done' }>;
    expect(done.reason).toBe('toolUse');
    expect(done.message.content.some((b) => b.type === 'toolCall')).toBe(true);
    // result() 与事件面必须给出同一条消息 —— 循环两处都读得到, 分裂了就是静默失效。
    expect((await stream.result()).stopReason).toBe('toolUse');
  });

  test('start 等中途事件原样转发', async () => {
    const wrapped = withToolCallSalvage(fakeStream(msg([{ type: 'text', text: 'hi' }])), { known: KNOWN });
    const events: AssistantMessageEvent[] = [];
    for await (const ev of wrapped({} as never, {} as never)) events.push(ev);
    expect(events.map((e) => e.type)).toEqual(['start', 'done']);
  });

  test('known 为空 → **直接返回 inner 本身** (没工具面的座位零经过本层)', () => {
    const inner = fakeStream(msg([{ type: 'text', text: CALL_TEXT }]));
    expect(withToolCallSalvage(inner, { known: new Set() })).toBe(inner);
  });
});
