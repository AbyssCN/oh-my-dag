/**
 * #178 produce-by 软推 —— 纯谓词两侧钉死。
 *
 * 背景 (账本读数 2026-08-18, n=66): M3 agent 叶最大失败类 = 勘探耗尽空手终止 (16 例全部
 * filesTouched=0 · 只读工具连发 · output 空), grind 三档的 stall 轴抓不到它 (它不 idle, 忙着读)。
 * 本谓词是与 grind 正交的第二根轴: 读"从未写过"而不是"停止增长"。
 *
 * 证伪方式 (当场验过): 把 shouldFireProduceBy 里 `s.filesTouchedCount === 0` 改成 `>= 0`
 * → 「已写过文件不触发」一条红; 把 `!s.expectsArtifact` 短路删掉 → 「非产物叶恒不触发」红。
 */
import { describe, expect, test } from 'bun:test';
import { PRODUCE_BY_WALL_MS, produceByInstruction, shouldFireProduceBy } from './agent-leaf';

const base = {
  expectsArtifact: true,
  startedAtMs: 0,
  nowMs: PRODUCE_BY_WALL_MS + 1,
  filesTouchedCount: 0,
  produceByFiredAt: null as number | null,
};

describe('shouldFireProduceBy (#178): 产物叶勘探超预算零写 → 触发一次', () => {
  test('四条件齐备 → 触发', () => {
    expect(shouldFireProduceBy(base)).toBe(true);
  });

  test('非产物叶恒不触发 (#178 硬约束: 非 produces-files 节点零行为变化)', () => {
    expect(shouldFireProduceBy({ ...base, expectsArtifact: false })).toBe(false);
  });

  test('已写过文件不触发 (它在产出, 不是空手勘探)', () => {
    expect(shouldFireProduceBy({ ...base, filesTouchedCount: 1 })).toBe(false);
  });

  test('墙钟未到阈值不触发 (给正常勘探留空间); 恰好等于阈值也不触发 (严格大于)', () => {
    expect(shouldFireProduceBy({ ...base, nowMs: PRODUCE_BY_WALL_MS - 1 })).toBe(false);
    expect(shouldFireProduceBy({ ...base, nowMs: PRODUCE_BY_WALL_MS })).toBe(false);
  });

  test('已触发过不再触发 (每叶至多 1 次, firedAt 非空短路)', () => {
    expect(shouldFireProduceBy({ ...base, produceByFiredAt: 100 })).toBe(false);
  });

  test('催产指令含目标路径与后果 (弱模型要看到"不写就作废")', () => {
    const msg = produceByInstruction('src/x/y.ts');
    expect(msg).toContain('src/x/y.ts');
    expect(msg).toContain('empty-artifact');
    expect(msg).toContain('现在就写');
  });
});
