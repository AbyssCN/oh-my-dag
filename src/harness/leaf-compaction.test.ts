/**
 * agent leaf 的上下文压缩 —— **切点**回归 (2026-08-01)。
 *
 * 只钉切点这一半, 因为会**静默**出错的是它: 摘要写得好不好人一眼看得出来, 而切错一刀的后果是
 * 保留段以一条**孤儿 toolResult** 开头 —— provider 直接 400, 而且是在压缩之后、活干到一半时才炸,
 * 排查起来看着像"模型突然不行了"。
 *
 * 叶子的 transcript 形状: `user(契约) → assistant(toolCall) → toolResult → assistant(toolCall) → …`
 * 里面**没有第二条 user 消息**, 所以"切在 user 上"这种通用对话的做法在这里根本不可用。
 */
import { describe, expect, it } from 'bun:test';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { planLeafCompaction } from './agent-leaf';

const user = (text: string): AgentMessage =>
  ({ role: 'user', content: text, timestamp: 1 }) as AgentMessage;
const assistantCall = (id: string, pad = 400): AgentMessage =>
  ({
    role: 'assistant',
    content: [
      { type: 'text', text: 'x'.repeat(pad) },
      { type: 'toolCall', id, name: 'read', arguments: { path: `f${id}.ts` } },
    ],
    api: 'openai-completions', provider: 'p', model: 'm',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'toolUse', timestamp: 1,
  }) as AgentMessage;
const toolResult = (id: string, pad = 400): AgentMessage =>
  ({
    role: 'toolResult', toolCallId: id, toolName: 'read',
    content: [{ type: 'text', text: 'y'.repeat(pad) }], isError: false, timestamp: 1,
  }) as AgentMessage;

/** 一段典型叶子记录: 契约 + n 轮 (assistant(toolCall) + toolResult)。 */
function transcript(rounds: number): AgentMessage[] {
  const out: AgentMessage[] = [user('契约: 把 X 做完')];
  for (let i = 0; i < rounds; i++) {
    out.push(assistantCall(`c${i}`), toolResult(`c${i}`));
  }
  return out;
}

const roleAt = (msgs: AgentMessage[], i: number): string => (msgs[i] as { role: string }).role;

describe('压缩切点', () => {
  it('★ 保留段必须以 assistant 开头 —— 否则是孤儿 toolResult, provider 直接拒', () => {
    const msgs = transcript(30);
    for (const keep of [500, 2_000, 5_000, 20_000]) {
      const cut = planLeafCompaction(msgs, keep);
      if (cut === null) continue;
      expect(roleAt(msgs, cut)).toBe('assistant');
    }
  });

  it('★ 契约 (第 0 条) 永远不进摘要段 —— 对叶子来说那不是开场白, 是它被要求做什么', () => {
    const msgs = transcript(30);
    const cut = planLeafCompaction(msgs, 2_000)!;
    expect(cut).toBeGreaterThan(1); // 摘要段 = slice(1, cut), 恒不含第 0 条
  });

  it('keep 预算越大, 保留段越长 (切点越靠前)', () => {
    const msgs = transcript(30); // ≈6100 token, 所以 keep 要留在这个量级之下才切得动
    const small = planLeafCompaction(msgs, 1_000)!;
    const large = planLeafCompaction(msgs, 5_000)!;
    expect(large).toBeLessThan(small);
  });

  it('短记录不压 (没什么可摘要的, 压了纯亏一次调用)', () => {
    expect(planLeafCompaction(transcript(0), 100)).toBeNull();
    expect(planLeafCompaction([user('a'), assistantCall('c0')], 100)).toBeNull();
  });

  it('预算大到装得下整段 → 不压 (cut 会落到 1 之前, 视作压不动)', () => {
    expect(planLeafCompaction(transcript(5), 10_000_000)).toBeNull();
  });

  it('★ 末尾拖一长串 toolResult (并发工具批) → 退回到那批的 assistant, 不切出孤儿', () => {
    const msgs: AgentMessage[] = [user('契约'), assistantCall('c0'), toolResult('c0'), assistantCall('c1')];
    for (let i = 0; i < 20; i++) msgs.push(toolResult(`t${i}`, 2_000));
    const cut = planLeafCompaction(msgs, 500)!;
    expect(roleAt(msgs, cut)).toBe('assistant');
    expect(cut).toBe(3); // 退回 c1 那条 assistant, 它的 20 条结果全在保留段里
  });

  it('★ 最后一条 toolResult 单独就超预算 → 仍然压得动 (往回找而不是往后找)', () => {
    // 这是实测撞出来的形态: 读一个大文件的结果比 keep 预算还大。往后找会一路推出末尾 →
    // 每轮都判"压不下去"然后优雅停, 活永远干不完。
    const msgs: AgentMessage[] = [user('契约')];
    for (let i = 0; i < 6; i++) msgs.push(assistantCall(`c${i}`), toolResult(`c${i}`, 20_000));
    const cut = planLeafCompaction(msgs, 1_000)!;
    expect(cut).not.toBeNull();
    expect(roleAt(msgs, cut)).toBe('assistant');
  });

  it('★ 第一轮就撞线 (契约之后只有一轮) → 不压: 唯一能退到的 assistant 就是那一轮, 摘要段会是空的', () => {
    const msgs: AgentMessage[] = [
      user('契约'), assistantCall('c0'), toolResult('c0', 50_000), toolResult('c0b', 50_000),
    ];
    expect(planLeafCompaction(msgs, 100)).toBeNull();
  });
});
