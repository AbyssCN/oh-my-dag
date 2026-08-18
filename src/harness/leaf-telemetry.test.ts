/**
 * #175 S1 — LeafTelemetry 单一真源 + pickLeafTelemetry 纯投影闸。
 *
 * 穷尽性本体在类型层 (leaf-runners.ts 的 _KeysEq 双向 extends: 往 LeafTelemetry 加键
 * 而不进 LEAF_TELEMETRY_KEYS → tsc 红, 反之亦然) —— 那道闸不需要运行时测试。
 * 这里钉的是投影器的**语义**:
 *
 * 证伪方式 (当场验过): 给 pickLeafTelemetry 恢复 M3 首版的「spin 缺席补 {0,0,[]}」默认值
 * → 「缺席保缺席」两条红; 恢复纯投影后绿。
 */
import { describe, expect, test } from 'bun:test';
import { LEAF_TELEMETRY_KEYS, pickLeafTelemetry } from './leaf-runners';

describe('pickLeafTelemetry (#175 S1): 纯投影, 缺席保缺席', () => {
  test('全 7 键在场 → 逐键原值透传', () => {
    const full = {
      watchdog: { stalled: false, timedOut: false, touchTimelineMs: [1], toolTimelineMs: [2] },
      spin: { spinEvents: 1, maxSameCount: 3, stuckSigs: ['x'] },
      writeEffects: [],
      toolSteps: [{ tool: 'read' }],
      toolStepsDropped: 2,
      shellRuns: [{ command: 'ls', ok: true }],
      parseNudges: 1,
    };
    const out = pickLeafTelemetry(full);
    for (const k of LEAF_TELEMETRY_KEYS) expect(out[k]).toEqual(full[k] as never);
  });

  test('缺席保缺席: 空入参 → 零键输出, 不给 spin/writeEffects 编 {0,0,[]} (NULL≠0 仓纪律)', () => {
    const out = pickLeafTelemetry({});
    expect(Object.keys(out)).toEqual([]);
    // 「没量」与「量了为 0」必须可分辨 —— in 检查比 undefined 检查更严 (键根本不该在)。
    expect('spin' in out).toBe(false);
    expect('writeEffects' in out).toBe(false);
  });

  test('部分在场 → 只透传在场键 (checkpoint spread 语义: 缺席键不进 JSON)', () => {
    const out = pickLeafTelemetry({ parseNudges: 0, toolStepsDropped: undefined });
    expect(Object.keys(out)).toEqual(['parseNudges']);
    expect(out.parseNudges).toBe(0); // 显式 0 是合法读数, 与缺席分开
  });

  test('非遥测键不透传 (投影而非拷贝)', () => {
    const out = pickLeafTelemetry({ parseNudges: 1, output: 'x', exitCode: 0 } as never);
    expect(Object.keys(out)).toEqual(['parseNudges']);
  });
});
