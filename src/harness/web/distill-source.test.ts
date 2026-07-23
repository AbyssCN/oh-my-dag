/**
 * web/distill-source 测试 —— per-source expert 蒸馏器 (解析 parsed + 字数截断 + 空→抛)。
 * 注入 fake _callModel → 永不真调模型。
 */
import { describe, expect, test } from 'bun:test';
import type { ModelResponse } from '../../model/gateway';
import { createModelSourceDistiller, buildDistillPrompt } from './distill-source';

/** 吐 canned parsed 的 fake send (蒸馏器读 res.parsed 优先)。 */
function fakeSend(parsed: unknown, text = ''): (req: unknown) => Promise<ModelResponse> {
  return async () => ({ text, parsed, usage: { in: 0, out: 0 }, raw: {}, model: 'fake', attempts: 1 });
}

const INPUT = { body: '原文正文……', title: 'T', url: 'http://a.com/x', question: '研究问题' };

describe('createModelSourceDistiller', () => {
  test('一次调用 → 返回 parsed 的 {relevance, extract}', async () => {
    const distill = createModelSourceDistiller({
      _callModel: fakeSend({ relevance: '相关因为 X', extract: '机制要点 A/B/C' }) as never,
    });
    const r = await distill(INPUT);
    expect(r).toEqual({ relevance: '相关因为 X', extract: '机制要点 A/B/C' });
  });

  test('extract 截断到 maxChars', async () => {
    const distill = createModelSourceDistiller({
      maxChars: 10,
      _callModel: fakeSend({ relevance: 'r', extract: 'x'.repeat(50) }) as never,
    });
    const r = await distill(INPUT);
    expect(r.extract).toBe('x'.repeat(10));
  });

  test('空 extract → 抛 (上层退回全文, 绝不静默丢)', async () => {
    const distill = createModelSourceDistiller({
      _callModel: fakeSend({ relevance: 'r', extract: '   ' }) as never,
    });
    await expect(distill(INPUT)).rejects.toThrow('extract 为空');
  });

  test('relevance 缺失 → 占位, 不抛 (只要 extract 非空)', async () => {
    const distill = createModelSourceDistiller({
      _callModel: fakeSend({ extract: '要点' }) as never,
    });
    const r = await distill(INPUT);
    expect(r.extract).toBe('要点');
    expect(r.relevance).toBe('(未结构化)');
  });

  test('prompt 携带 url/标题/关注点 + 字数上限', () => {
    const p = buildDistillPrompt(INPUT, 2500);
    expect(p).toContain('http://a.com/x');
    expect(p).toContain('研究问题');
    expect(p).toContain('≤2500 字');
  });
});
