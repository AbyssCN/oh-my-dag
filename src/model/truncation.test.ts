/**
 * 截断可见性回归 (owner 2026-07-28)。
 *
 * 锁住的 bug: provider 报 finish_reason='length' 且正文非空时, 老路径原样返回半截答案,
 * `finishReason` 有生产者零消费者 → 静默失真 (综合被腰斩后当成品往下游传, 表现成"模型更差")。
 */
import { describe, expect, it } from 'bun:test';
import { onTruncation, reportTruncation } from './truncation';

describe('truncation 上报', () => {
  it('订阅者收到 model/out/cap/role', () => {
    const seen: unknown[] = [];
    const off = onTruncation((i) => seen.push(i));
    reportTruncation({ model: 'p:m', out: 8000, cap: 8000, role: 'fanout-leaf' });
    off();
    expect(seen).toEqual([{ model: 'p:m', out: 8000, cap: 8000, role: 'fanout-leaf' }]);
  });

  it('取消订阅后不再收到', () => {
    const seen: unknown[] = [];
    const off = onTruncation((i) => seen.push(i));
    off();
    reportTruncation({ model: 'p:m', out: 1, cap: 1 });
    expect(seen).toHaveLength(0);
  });

  it('订阅者抛错不下沉主流程 (fail-open)', () => {
    const seen: unknown[] = [];
    const offBad = onTruncation(() => {
      throw new Error('订阅者炸了');
    });
    const offGood = onTruncation((i) => seen.push(i));
    expect(() => reportTruncation({ model: 'p:m', out: 2 })).not.toThrow();
    expect(seen).toHaveLength(1); // 前一个抛错不挡后一个
    offBad();
    offGood();
  });

  it('无订阅者时兜底写 stderr —— 绝不静默', () => {
    const orig = process.stderr.write.bind(process.stderr);
    const lines: string[] = [];
    // @ts-expect-error 测试替身
    process.stderr.write = (s: string) => (lines.push(String(s)), true);
    try {
      reportTruncation({ model: 'opencode-go:deepseek-v4-pro', out: 8192, cap: 8192 });
    } finally {
      process.stderr.write = orig;
    }
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('[truncated]');
    expect(lines[0]).toContain('opencode-go:deepseek-v4-pro');
    expect(lines[0]).toContain('8192');
  });
});
