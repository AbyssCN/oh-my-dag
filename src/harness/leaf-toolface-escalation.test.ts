/**
 * 首轮之后放开工具面(`withToolFaceEscalation`,owner 2026-08-18)。
 *
 * 为什么单测这一层:pi 循环只认**一个** `prepareNextTurn`,而这里同时要做两件事
 * (换工具面 + 压缩)。危险不在"换得对不对",在**两件事撞在同一轮**时压缩把刚换上的工具面
 * 又丢回去 —— 那种失效没有任何症状:模型照着新 prompt 调工具,而工具面是旧的,只表现为
 * "这一轮工具调用失败了"。所以第三条是这组里真正承重的。
 *
 * ⚠ 覆盖边界照实说:这里测的是钩子本身。它接进 pi 循环的那一行(`agent-leaf.ts` 的
 * `prepareNextTurn: withToolFaceEscalation(...)`)**没有测试** —— 本仓没有任何测试驱动
 * agent-leaf 的 pi 分支(全部经 `sdkQueryFn` 走订阅通道),而生产上的极简座位恰恰只走 pi。
 * 要补那一层得先有一个 pi 侧的循环接缝,那是另一件事。
 *
 * 反向自检(2026-08-18 真跑过):
 *  - 把 `escalated = true` 那行删掉 → 第二条红(每一轮都升级, `onEscalate` 被叫两次);
 *  - 把内层调用改成 `inner({ context })`(传原 ctx 而不是升级后的)→ 第三条红(压缩返回的
 *    context 里工具面退回旧的)。
 */
import { describe, expect, test } from 'bun:test';
import type { AgentContext } from '@earendil-works/pi-agent-core';
import { withToolFaceEscalation } from './agent-leaf';

const tool = (name: string) => ({ name, description: name, parameters: {}, handler: async () => ({ content: [] }) }) as never;
const ctx = (): AgentContext => ({ systemPrompt: '极简 prompt', messages: [{ role: 'user', content: 'x', timestamp: 0 }], tools: [tool('bash')] } as AgentContext);
const FULL = { tools: [tool('bash'), tool('grep'), tool('read')], systemPrompt: '全量 prompt' };

describe('withToolFaceEscalation', () => {
  test('★ 首轮结束 → 换上全工具面与配套 prompt', async () => {
    let fired = 0;
    const prep = withToolFaceEscalation({ ...FULL, onEscalate: () => fired++ });
    const out = await prep({ context: ctx() });
    expect(out?.context?.tools).toHaveLength(3);
    expect(out?.context?.systemPrompt).toBe('全量 prompt');
    expect(out?.context?.messages).toHaveLength(1); // 消息一条不动
    expect(fired).toBe(1);
  });

  test('★ 只升一次 —— 第二轮起不再换(每轮都换 = 每轮都换掉冻结前缀)', async () => {
    let fired = 0;
    const prep = withToolFaceEscalation({ ...FULL, onEscalate: () => fired++ });
    await prep({ context: ctx() });
    const second = await prep({ context: ctx() });
    expect(second).toBeUndefined();
    expect(fired).toBe(1);
  });

  test('★ 承重条:压缩与升级撞在同一轮时,压缩后的 context 仍带新工具面', async () => {
    const inner = async ({ context }: { context: AgentContext }) => ({
      context: { ...context, messages: [{ role: 'user' as const, content: '压缩后', timestamp: 0 }] } as AgentContext,
    });
    const prep = withToolFaceEscalation(FULL, inner);
    const out = await prep({ context: ctx() });
    expect(out?.context?.tools).toHaveLength(3); // ← 内层若拿到的是旧 ctx, 这里是 1
    expect(out?.context?.systemPrompt).toBe('全量 prompt');
    expect((out?.context?.messages?.[0] as { content?: string })?.content).toBe('压缩后');
  });

  test('★ face 为 null(非极简座位)→ 退化成内层本身,一个字节不改', async () => {
    const prep = withToolFaceEscalation(null, async () => undefined);
    expect(await prep({ context: ctx() })).toBeUndefined();
  });

  test('★ 内层压不动(返 undefined)时,升级那半照样交出去', async () => {
    const prep = withToolFaceEscalation(FULL, async () => undefined);
    const out = await prep({ context: ctx() });
    expect(out?.context?.tools).toHaveLength(3);
  });
});
