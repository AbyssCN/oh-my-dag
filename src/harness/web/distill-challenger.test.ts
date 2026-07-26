import { describe, expect, test } from 'bun:test';
import { CHALLENGER_SYSTEM, createChallengerDistiller } from './distill-challenger';
import { DISTILL_SYSTEM } from './distill-source';

// 温度对偶 (2026-07-26): expert 低温忠实抽取 / challenger 高温挖长尾。
// 承 xihe-distill 的双 lens 设计 —— omd 这边一直只有 expert 那一半。

const fake = (out: unknown) =>
  (async () => ({ text: JSON.stringify(out), parsed: out, usage: { in: 1, out: 1 } })) as never;

const INPUT = { question: 'q', title: 't', url: 'https://e.example', body: 'b' };

describe('challenger 档', () => {
  test('高温是机制不是调味 —— 默认 0.9, 与 expert 的 0.25 构成对偶', async () => {
    let seen: { temperature?: number; messages: { content: string }[] } | undefined;
    const d = createChallengerDistiller({
      _callModel: (async (req: typeof seen) => {
        seen = req;
        return { text: '{}', parsed: { relevance: 'r', extract: 'e' }, usage: { in: 1, out: 1 } };
      }) as never,
    });
    await d(INPUT);
    expect(seen!.temperature).toBe(0.9);
    expect(seen!.messages[0]!.content).toBe(CHALLENGER_SYSTEM);
  });

  test('两个 lens 的 system 是真不同的任务 (不是换个说法)', () => {
    expect(CHALLENGER_SYSTEM).not.toBe(DISTILL_SYSTEM);
    expect(DISTILL_SYSTEM).toContain('忠实');
    for (const k of ['未言明的前提', '与主流叙事的冲突', '跨域迁移', '二阶效应']) {
      expect(CHALLENGER_SYSTEM).toContain(k);
    }
  });

  test('第一条铁律是"不许脑补事实" —— 高温挖长尾最大的风险就是编事实', () => {
    const first = CHALLENGER_SYSTEM.slice(CHALLENGER_SYSTEM.indexOf('1.'), CHALLENGER_SYSTEM.indexOf('2.'));
    expect(first).toContain('不许脑补事实');
    expect(first).toContain('事实不许新造');
  });

  test('空 extract → 抛错 (上层退回全文, 绝不静默丢内容)', async () => {
    const d = createChallengerDistiller({ _callModel: fake({ relevance: 'r', extract: '   ' }) });
    await expect(d(INPUT)).rejects.toThrow(/空 extract/);
  });

  test('正常产出 → relevance + extract', async () => {
    const d = createChallengerDistiller({ _callModel: fake({ relevance: '值得挑战 X', extract: '洞察一' }) });
    const r = await d(INPUT);
    expect(r.relevance).toBe('值得挑战 X');
    expect(r.extract).toBe('洞察一');
  });
});
