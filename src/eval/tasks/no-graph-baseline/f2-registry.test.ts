/**
 * F2 语料规范表 + 答案存在性自检: 每题关键词必须在点名的 raw 原文里逐字出现 —— 清单不接地 = 实验作废。
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { F2_ITEMS, F2_SOURCE_DIR, scoreF2 } from './f2-checklist';

const ROOT = new URL('../../../..', import.meta.url).pathname;

describe('F2 语料规范表', () => {
  test('8 题 · 8 个不同来源 (跨来源, 单篇答不全)', () => {
    expect(F2_ITEMS).toHaveLength(8);
    expect(new Set(F2_ITEMS.map((i) => i.sourceFile)).size).toBe(8);
  });

  test('答案存在性自检: 每题至少一个关键词在点名原文里逐字出现', () => {
    for (const item of F2_ITEMS) {
      const raw = readFileSync(join(ROOT, F2_SOURCE_DIR, item.sourceFile), 'utf8').toLowerCase();
      const found = item.acceptKeywords.some((k) => raw.includes(k.toLowerCase()));
      expect(found ? '' : `${item.id} 关键词全不在 ${item.sourceFile}`).toBe('');
    }
  });

  test('评分器: 对答+错答判分正确', () => {
    const good = { q1: '初始 Elo 是 1200, 见 co-scientist-2502.18864' };
    expect(scoreF2(good).hit).toBe(1);
    const bad = { q1: '初始分 1500, 见 sgh-2604.11378' };
    expect(scoreF2(bad).hit).toBe(0);
  });
});
