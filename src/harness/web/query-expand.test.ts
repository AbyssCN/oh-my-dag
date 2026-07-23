/**
 * web/query-expand 测试 —— 检索 query 扩展 (Task B, 解析 + 改写器 + 安全降级)。
 * 注入 fake _callModel → 永不真调模型。
 */
import { describe, expect, test } from 'bun:test';
import type { ModelResponse } from '../../model/gateway';
import { createModelQueryExpander, expandQueries, parseRewrites } from './query-expand';

/** 吐 canned text 的 fake send (只填 expander 用到的 text, 其余占位)。 */
function fakeSend(text: string): (req: unknown) => Promise<ModelResponse> {
  return async () => ({ text, usage: { in: 0, out: 0 }, raw: {}, model: 'fake', attempts: 1 });
}

describe('parseRewrites', () => {
  test('逐行解析, 去项目符号/编号, 丢原文, 去重', () => {
    const raw = [
      '- LLM 推理加速',
      '1. large language model inference speedup',
      'LLM 推理加速', // 与首行重复 → 去
      '大语言模型 推理加速',
      '原问题', // = original → 丢
    ].join('\n');
    expect(parseRewrites(raw, '原问题')).toEqual([
      'LLM 推理加速',
      'large language model inference speedup',
      '大语言模型 推理加速',
    ]);
  });

  test('JSON 数组格式也吃', () => {
    expect(parseRewrites('["a variant","b variant"]', 'orig')).toEqual(['a variant', 'b variant']);
  });

  test('空输出 → 空数组 (无改写非错误)', () => {
    expect(parseRewrites('   \n  \n', 'orig')).toEqual([]);
  });
});

describe('createModelQueryExpander', () => {
  test('一次调用 → 解析出改写 (不含原文)', async () => {
    const expander = createModelQueryExpander({
      _callModel: fakeSend('kubernetes 自动扩缩容\nk8s autoscaling best practices') as never,
    });
    const rewrites = await expander('k8s 自动扩缩容怎么配');
    expect(rewrites).toEqual(['kubernetes 自动扩缩容', 'k8s autoscaling best practices']);
  });
});

describe('expandQueries 安全降级', () => {
  test('有 expander → [原 query, ...改写]', async () => {
    const expander = async () => ['r1', 'r2'];
    expect(await expandQueries('q0', expander)).toEqual(['q0', 'r1', 'r2']);
  });

  test('无 expander → 仅原 query (现有行为)', async () => {
    expect(await expandQueries('q0', undefined)).toEqual(['q0']);
  });

  test('expander 抛错 → 退回单 query + warn, 不断链', async () => {
    let warned = '';
    const boom = async () => {
      throw new Error('flash 挂了');
    };
    const out = await expandQueries('q0', boom, { onWarn: (m) => (warned = m) });
    expect(out).toEqual(['q0']);
    expect(warned).toContain('flash 挂了');
  });
});
