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
import { estimateTokens, type AgentMessage } from '@earendil-works/pi-agent-core';
import type { callModel } from '../model';
import {
  COMPACTION_RETAINED_TOLERANCE,
  MIN_TOOL_RESULT_BYTES,
  TOOL_RESULT_TRUNCATION_MARK,
  TRUNCATION_ONLY_SUMMARY,
  compactLeafContext,
  planLeafCompaction,
  truncateOversizedToolResults,
} from './agent-leaf';

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

/**
 * ★ 巨型工具结果**截断**(2026-08-09)—— 「压不动」的真解。
 *
 * 病根不在切点: 两边的合法切点都排除 toolResult (切在它上面 = 孤儿结果, provider 400),
 * 于是「一批并发结果」「单条结果比预算还大」这两种形状, **任何切法**都得整批保留。
 * 实测基线 (keep=20000, 见 `truncateOversizedToolResults` 注): 形状 A 20 条并发结果 120211 tok
 * → `planLeafCompaction` 返 null; 形状 B 每条 3× 预算 → 保留 60k tok = 3 倍预算。
 *
 * 反向自检 (实跑, 2026-08-09): 把 `compactLeafContext` 里的
 * `truncateOversizedToolResults(...) ?? retained` 换回 `retained`、并把 `cut === null`
 * 那条分支的截断结果写死成 null → **11 pass / 2 fail**: 红的正是下面前两条
 * (A 回到 null; B 回到 3 倍预算), 而「零截断」「纯对话」「下限」三条仍绿 ——
 * 一起才分得开"截断起作用了"与"截断把什么都截了"。
 */
describe('★ 保留段的巨型工具结果截断', () => {
  const KEEP = 20_000;
  const TAIL_MARK = '★结论: 全绿'; // 结论在**尾** —— 截断留尾不留头, 这句必须活下来
  const HEAD_MARK = '★开头: 这段该被丢掉';
  /**
   * 一条巨型结果: 头尾各埋一个哨兵, 中间是**多行**填料 —— 真工具输出是按行的,
   * 而 `truncateTail` 不返回半行。拿单条超长行当语料量到的是那个边界, 不是常态。
   */
  const bigResult = (id: string, chars: number): AgentMessage => {
    const lines = [HEAD_MARK];
    for (let i = 0; i < Math.ceil(chars / 80); i++) lines.push(`${String(i).padStart(6, '0')} ${'y'.repeat(72)}`);
    lines.push(TAIL_MARK);
    return {
      role: 'toolResult', toolCallId: id, toolName: 'bash',
      content: [{ type: 'text', text: lines.join('\n') }],
      isError: false, timestamp: 1,
    } as AgentMessage;
  };
  /** 一条 assistant 一次发 n 个 toolCall (并发批的形状)。 */
  const batchCall = (ids: string[]): AgentMessage =>
    ({
      role: 'assistant',
      content: [
        { type: 'text', text: 'x'.repeat(400) },
        ...ids.map((id) => ({ type: 'toolCall', id, name: 'bash', arguments: { cmd: `run ${id}` } })),
      ],
      api: 'openai-completions', provider: 'p', model: 'm',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'toolUse', timestamp: 1,
    }) as AgentMessage;

  let calls = 0;
  const fakeCallModel = (async () => {
    calls++;
    return { text: '【摘要】干到一半的记录。', usage: { in: 1, out: 1 }, raw: {}, model: 'fake:compactor', attempts: 1 };
  }) as unknown as typeof callModel;

  const tokens = (ms: AgentMessage[]): number => ms.reduce((n, m) => n + estimateTokens(m), 0);
  /** 形状 A: 契约 + 一条 assistant 发 20 个 toolCall + 20 条巨型结果 (单轮就撑爆)。 */
  const shapeA = (): AgentMessage[] => {
    const ids = Array.from({ length: 20 }, (_, i) => `b${i}`);
    return [user('契约: 把 X 做完'), batchCall(ids), ...ids.map((id) => bigResult(id, 24_000))];
  };
  /** 形状 B: 6 轮串行, 每条结果 ≈3× 预算 (最后一批单独就超预算好几倍)。 */
  const shapeB = (): AgentMessage[] => {
    const out: AgentMessage[] = [user('契约: 把 X 做完')];
    for (let i = 0; i < 6; i++) out.push(assistantCall(`c${i}`), bigResult(`c${i}`, 240_000));
    return out;
  };

  it('★ 单轮一批巨型并发结果 —— 此前 planLeafCompaction 返 null, 现在压得动且落在预算内', async () => {
    const msgs = shapeA();
    expect(planLeafCompaction(msgs, KEEP)).toBeNull(); // 基线: 切点确实修不了这个形状
    calls = 0;
    const r = (await compactLeafContext({ messages: msgs, model: 'x:y', keepRecentTokens: KEEP, callModelFn: fakeCallModel }))!;
    expect(r).not.toBeNull();
    expect(tokens(r.messages)).toBeLessThanOrEqual(KEEP * COMPACTION_RETAINED_TOLERANCE);
    // 没有历史可摘要 ⇒ 一次模型调用都不该发 (省下来的是截断带来的, 不是摘要带来的),
    // 而摘要位上要写清楚这一点 —— 否则落进会话的那条 compaction 读起来像"摘要器出了空"。
    expect(calls).toBe(0);
    expect(r.summary).toBe(TRUNCATION_ONLY_SUMMARY);
    const dump = JSON.stringify(r.retainedTail);
    expect(dump).toContain(TOOL_RESULT_TRUNCATION_MARK); // 带标记 —— 缺了开头必须留痕
    expect(dump).toContain(TAIL_MARK); // 尾部内容仍在
    expect(dump).not.toContain(HEAD_MARK); // 丢的是头
    expect((r.retainedTail[0] as { content: string }).content).toBe('契约: 把 X 做完'); // 契约逐字
  });

  it('★ 每条结果都比预算大 —— 保留段从 3 倍预算压回预算内, 且尾部结论还在', async () => {
    const msgs = shapeB();
    const cut = planLeafCompaction(msgs, KEEP)!;
    // 基线: 切点找得到, 但保留段 = 最后那一批, 远超预算 —— 切点无能为力的正是这一半。
    expect(tokens([msgs[0]!, ...msgs.slice(cut)])).toBeGreaterThan(KEEP * COMPACTION_RETAINED_TOLERANCE);
    calls = 0;
    const r = (await compactLeafContext({ messages: msgs, model: 'x:y', keepRecentTokens: KEEP, callModelFn: fakeCallModel }))!;
    expect(r).not.toBeNull();
    expect(calls).toBe(1); // 这条路照旧摘要一次 (有历史可摘)
    expect(tokens(r.messages)).toBeLessThanOrEqual(KEEP * COMPACTION_RETAINED_TOLERANCE);
    const dump = JSON.stringify(r.retainedTail);
    expect(dump).toContain(TOOL_RESULT_TRUNCATION_MARK);
    expect(dump).toContain(TAIL_MARK);
    expect(roleAt(r.retainedTail as AgentMessage[], 1)).toBe('assistant'); // 仍不切出孤儿
  });

  it('★ 保留段没超阈值 → 一个字不动 (零截断: 返 null, 不是返一份"看着一样"的拷贝)', () => {
    const msgs = transcript(30); // ≈6100 tok, 远在 20000×1.5 之下
    expect(truncateOversizedToolResults(msgs, KEEP)).toBeNull();
    // 刚好压线也不动: 触发条件是**严格大于**
    expect(truncateOversizedToolResults(msgs, tokens(msgs) / COMPACTION_RETAINED_TOLERANCE)).toBeNull();
  });

  it('★ 撑爆预算的不是工具结果 (纯对话) → 不截 (截了也省不下, 而对话正文不该被动)', () => {
    const msgs: AgentMessage[] = [];
    for (let i = 0; i < 40; i++) msgs.push(user(`第 ${i} 问 ${'补'.repeat(4_000)}`));
    expect(tokens(msgs)).toBeGreaterThan(KEEP * COMPACTION_RETAINED_TOLERANCE);
    expect(truncateOversizedToolResults(msgs, KEEP)).toBeNull();
  });

  it('单条结果就算再大, 截完也不低于下限 (几十字节的尾巴读不出结论)', () => {
    const msgs: AgentMessage[] = [user('契约'), ...Array.from({ length: 200 }, (_, i) => bigResult(`t${i}`, 24_000))];
    const out = truncateOversizedToolResults(msgs, KEEP)!;
    expect(out).not.toBeNull();
    const text = ((out[1] as { content: { text: string }[] }).content[0] as { text: string }).text;
    // 200 条均分预算 = 每条 400 字节, 被下限抬到 MIN_TOOL_RESULT_BYTES (整行取尾 ⇒ 略少于上限)
    expect(text.length).toBeGreaterThan(MIN_TOOL_RESULT_BYTES * 0.9);
    expect(text).toContain(TAIL_MARK);
    // 代价写明白: 下限 × 条数 会**超**预算 —— 宁可超一点也不留读不出结论的碎尾。
    expect(tokens(out)).toBeGreaterThan(KEEP);
  });
});
