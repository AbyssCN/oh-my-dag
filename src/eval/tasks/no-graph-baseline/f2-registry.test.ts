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

  // 分项读数 (2026-08-04): 官方分不变, 两维分开报。加它的理由是实测 —— 总分在 n=3 上全在
  // 噪声里 (同对同配置两跑 8/8 vs 5/8), 而出处分项给出 0/8 → 24/24 的定向变化。
  // 两维捆成一个数会把能看见的信号淹掉。
  test('分项: 出处对而关键词错 → 官方 0 分, 但 srcHit 记 1 (信号不被淹)', () => {
    const r = scoreF2({ q1: '初始分写错了, 见 co-scientist-2502.18864' });
    expect(r.hit).toBe(0);        // 官方判据没松
    expect(r.srcHit).toBe(1);     // 出处这一维确实中了
    expect(r.kwHit).toBe(0);
  });

  test('分项: 关键词对而出处错 → 反过来', () => {
    const r = scoreF2({ q1: '初始 Elo 是 1200, 见 sgh-2604.11378' });
    expect(r.hit).toBe(0);
    expect(r.srcHit).toBe(0);
    expect(r.kwHit).toBe(1);
  });

  test('分项与总分的关系: hit ≤ min(kwHit, srcHit) (两维都中才计分)', () => {
    const r = scoreF2({
      q1: '初始 Elo 是 1200, 见 co-scientist-2502.18864',
      q2: '裁决靠 evidence, 见 sgh-2604.11378',   // 关键词中, 出处错
    });
    expect(r.hit).toBe(1);
    expect(r.kwHit).toBe(2);
    expect(r.srcHit).toBe(1);
    expect(r.hit).toBeLessThanOrEqual(Math.min(r.kwHit, r.srcHit));
  });
});
