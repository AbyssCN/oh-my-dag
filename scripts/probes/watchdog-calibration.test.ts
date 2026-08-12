/**
 * 校准尺自己的闸 —— 这把尺子只有两处能静默错, 都在这里钉住。
 *
 * ## 为什么值得写
 *
 * 它要读的是**部分样本才有的字段**(`watchdog` 只在 S1 埋点 `5a2d905` 之后的叶子上)。
 * 这正是本仓坑 #1 的形状: 把「没记」抹成 0, 事后再也分不开。一旦 `maxIdleMin` 对
 * 老叶子返回 0, 双条件闸网格里那些老叶子会被算成「停滞 0 分钟」→ 永远不命中,
 * 于是 T/W 看起来"很安全", 而那安全是编出来的。
 *
 * ## 反向自检 (证伪方式写在每条断言旁, 三刀都当场验过)
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collect, maxGapMin } from './watchdog-calibration';

const MIN = 60_000;

function fixture(nodes: Record<string, unknown>[]): string {
  const root = mkdtempSync(join(tmpdir(), 'wd-calib-'));
  const run = join(root, 'run-aaaaaaaa');
  mkdirSync(run, { recursive: true });
  writeFileSync(join(run, 'spec.json'), '{}');
  writeFileSync(join(run, '_dag.json'), '{}');
  nodes.forEach((n, i) => writeFileSync(join(run, `n${i}.json`), JSON.stringify(n)));
  return root;
}

describe('停滞窗口: 缺席 ≠ 0', () => {
  test('★ 没有 watchdog 的老叶子 → maxIdleMin 缺席, 不是 0', () => {
    const root = fixture([
      { nodeId: 'old', leafKind: 'agent', status: 'done', durationMs: 30 * MIN, outputPaths: [] },
      { nodeId: 'new', leafKind: 'agent', status: 'done', durationMs: 30 * MIN, outputPaths: [], watchdog: { stalled: false, timedOut: false, touchTimelineMs: [1 * MIN] } },
    ]);
    try {
      const { leaves } = collect(root);
      const old = leaves.find((l) => l.nodeId === 'old')!;
      const fresh = leaves.find((l) => l.nodeId === 'new')!;
      // 怎么让它红: 把 collect 里的 `...(t ? {...} : {})` 改成 `maxIdleMin: maxGapMin(t ?? [], ...)`
      // (即缺席补 0) → 下面这条变成 0, 断言失败。
      expect(old.maxIdleMin).toBeUndefined();
      expect(fresh.maxIdleMin).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('★ 末段也算一段: 最后一次 touch 之后的静默不许被漏掉', () => {
    // 30min 的叶子, 只在第 1 分钟碰过一次文件 → 真正的研磨段是**末尾那 29 分钟**。
    // 怎么让它红: 把 maxGapMin 里的 `durationMs` 从 pts 去掉 → 返回 1, 断言失败。
    expect(maxGapMin([1 * MIN], 30 * MIN)).toBeCloseTo(29, 5);
    // 头段同理: 前 20 分钟一次没碰。
    expect(maxGapMin([20 * MIN, 21 * MIN], 22 * MIN)).toBeCloseTo(20, 5);
  });

  test('对照 (改法拿掉也该绿): 非 agent 叶不进样本, 分母不被污染', () => {
    const root = fixture([
      { nodeId: 'cmd', leafKind: 'command', status: 'done', durationMs: 99 * MIN, outputPaths: [] },
      { nodeId: 'a', leafKind: 'agent', status: 'done', durationMs: 1 * MIN, outputPaths: ['x'] },
    ]);
    try {
      const { leaves, nonAgent } = collect(root);
      expect(leaves.map((l) => l.nodeId)).toEqual(['a']);
      expect(nonAgent).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
