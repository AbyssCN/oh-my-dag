// 证伪: 若 renderSeatLine 在 readSelfReport()===null 时返回 getServerSeatMemory() 坐标, 本文件 drift 用例第 1 子闸立即红。
import { describe, expect, test } from 'bun:test';
import type { SeatSelfReport } from '../seat-self-report';
import { renderSeatLine } from '../seat-self-report';

function selfReport(overrides: Partial<SeatSelfReport> = {}): SeatSelfReport {
  return {
    v: 1,
    schema: 'oh-my-dag.seat-self-report.v1',
    runId: '5382bd05',
    seatId: 'seat-minimax-cn-m3',
    actualModel: 'minimax-cn:M3',
    actualSeatLabel: null,
    reportedAt: '2026-08-18T00:00:00Z',
    source: 'worker-self',
    ...overrides,
  };
}

describe('renderSeatLine drift guard', () => {
  test('drift: server memory 漂移, 自报覆盖内存态', () => {
    const getServerSeatMemory = (): string => 'xiaomi mimo';

    // 子闸1: 无自报 → 必须落 UNCONFIRMED, 永不打印内存态坐标。
    {
      const readSelfReport = (): SeatSelfReport | null => null;
      const line = renderSeatLine({ readSelfReport, getServerSeatMemory });
      expect(line).not.toContain('xiaomi mimo');
      expect(line).toContain('UNCONFIRMED');
    }

    // 子闸2: 有自报 → 以 worker 自报为准, 内存态不得替换/污染。
    {
      const readSelfReport = (): SeatSelfReport | null =>
        selfReport({ actualModel: 'minimax-cn:M3' });
      const line = renderSeatLine({ readSelfReport, getServerSeatMemory });
      expect(line).not.toContain('xiaomi mimo');
      expect(line).toContain('minimax-cn:M3');
      expect(line).toContain('CONFIRMED worker自报');
    }
  });

  test('reverse: 无漂移, 内存态与自报一致', () => {
    const getServerSeatMemory = (): string => 'minimax-cn:M3';
    const readSelfReport = (): SeatSelfReport | null =>
      selfReport({ actualModel: 'minimax-cn:M3' });
    const line = renderSeatLine({ readSelfReport, getServerSeatMemory });

    expect(line).toContain('minimax-cn:M3');
    expect(line).toContain('CONFIRMED worker自报');
    expect(line).not.toContain('UNCONFIRMED');
  });
});