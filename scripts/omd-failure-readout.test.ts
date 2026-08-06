import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { failureReadout } from './omd-failure-readout';

/** 造一棵合成 continuity 树: root/<runId>/ 下 checkpoint + 归档 + 内环 journal。 */
function makeTree(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'omd-failure-readout-'));
  const runA = join(root, 'run-a');
  const runB = join(root, 'run-b');
  mkdirSync(runA, { recursive: true });
  mkdirSync(runB, { recursive: true });
  const cp = (status: string, failureKind?: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ nodeId: 'n', status, failureKind, outputPaths: [], ...extra });
  writeFileSync(join(runA, 'node_ok.json'), cp('done'));
  writeFileSync(join(runA, 'node_fail.json'), cp('failed', 'infra-error', { failurePaths: ['a.txt'] }));
  writeFileSync(join(runA, 'node_exhaust.json'), cp('failed', 'rounds-exhausted'));
  // 归档 (`__r<N>.json`) 与原名是同一类 checkpoint, 必须同样进格 —— 这正是它存在的意义
  writeFileSync(join(runA, 'node_fail.__r1.json'), cp('failed', 'empty-artifact', { inputPaths: ['in.txt'] }));
  // gate-rejected / dep-skip 不进 ① 分母 (命令未执行 / 级联跳过, 结构上带不出 failurePaths)
  writeFileSync(join(runA, 'node_gate.json'), cp('failed', 'gate-rejected', { failurePaths: ['g.txt'] }));
  writeFileSync(join(runA, 'node_skip.json'), cp('skipped', 'dep-skip'));
  writeFileSync(
    join(runA, '_loop-node.json'),
    JSON.stringify({
      runId: 'run-a',
      nodeId: 'node',
      completedRounds: 2,
      verdicts: [
        { round: 1, criterion: 'red', judge: 'converged' },
        { round: 2, criterion: 'red', judge: 'rejected' },
        { round: 3, criterion: 'green', judge: 'converged' },
      ],
    }),
  );
  writeFileSync(join(runA, 'broken.json'), '{ not json');
  writeFileSync(join(runB, 'node_fail.json'), cp('failed', 'empty-artifact'));
  // verdicts 缺席 (老记录) → 不是 0 条, 是没记 —— 不算进 ③
  writeFileSync(join(runB, '_loop-other.json'), JSON.stringify({ runId: 'run-b', nodeId: 'x', completedRounds: 1 }));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe('failureReadout', () => {
  test('四格读数 + 归档进格 + fail-open', () => {
    const { root, cleanup } = makeTree();
    try {
      const r = failureReadout([root]);
      expect(r.runDirs).toBe(2);
      expect(r.unreadable).toBe(1); // broken.json 解析失败 → 跳过不计入任何一格
      // ① 分母 = failed ∧ ∉ {dep-skip, gate-rejected}: run-a 3 (infra-error, rounds-exhausted, 归档 __r1 那份 empty-artifact) + run-b 1
      expect(r.failurePaths.denominator).toBe(4);
      expect(r.failurePaths.withPaths).toBe(1); // gate-rejected 那份即使带 paths 也不进分子
      expect(r.failurePaths.rate).toBeCloseTo(1 / 4);
      // ② 归档那份 inputPaths 非空; run-b 那份 inputPaths 缺席
      expect(r.emptyArtifact).toEqual({ total: 2, withInputPaths: 1 });
      // ③ 只有 (round1, red, converged) 一条
      expect(r.redConverged).toBe(1);
      // ④ 两格各自计数
      expect(r.infraError).toBe(1);
      expect(r.roundsExhausted).toBe(1);
    } finally {
      cleanup();
    }
  });

  test('没有失败 checkpoint → 占比 null (算不出 ≠ 0%), 不编 0', () => {
    const root = mkdtempSync(join(tmpdir(), 'omd-failure-readout-'));
    try {
      mkdirSync(join(root, 'run-empty'), { recursive: true });
      writeFileSync(join(root, 'run-empty', 'node_ok.json'), JSON.stringify({ status: 'done' }));
      const r = failureReadout([root]);
      expect(r.failurePaths.denominator).toBe(0);
      expect(r.failurePaths.rate).toBeNull();
      expect(r.emptyArtifact.total).toBe(0);
      expect(r.redConverged).toBe(0);
      expect(r.infraError).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('空 roots / 不存在的 root → 零读数, 不抛', () => {
    expect(failureReadout([])).toEqual({
      runDirs: 0,
      unreadable: 0,
      failurePaths: { denominator: 0, withPaths: 0, rate: null },
      emptyArtifact: { total: 0, withInputPaths: 0 },
      redConverged: 0,
      infraError: 0,
      roundsExhausted: 0,
    });
    const r = failureReadout([join(tmpdir(), 'omd-failure-readout-不存在')]);
    expect(r.runDirs).toBe(0);
    expect(r.unreadable).toBe(0);
  });

  test('多 root 输入 → 各 root 的读数合并进同一份结果 (不互相覆盖)', () => {
    // 两个独立 root, 各含一个 run 目录 —— 合并后每一项都是两棵树的加总
    const rootA = mkdtempSync(join(tmpdir(), 'omd-failure-readout-a-'));
    const rootB = mkdtempSync(join(tmpdir(), 'omd-failure-readout-b-'));
    try {
      mkdirSync(join(rootA, 'run-1'), { recursive: true });
      mkdirSync(join(rootB, 'run-2'), { recursive: true });
      const cp = (failureKind: string, extra: Record<string, unknown> = {}) =>
        JSON.stringify({ nodeId: 'n', status: 'failed', failureKind, outputPaths: [], ...extra });
      writeFileSync(join(rootA, 'run-1', 'node_a.json'), cp('infra-error', { failurePaths: ['a.txt'] }));
      writeFileSync(join(rootB, 'run-2', 'node_b.json'), cp('empty-artifact', { inputPaths: ['in.txt'] }));
      writeFileSync(
        join(rootB, 'run-2', '_loop-node.json'),
        JSON.stringify({
          runId: 'run-2',
          nodeId: 'node',
          completedRounds: 1,
          verdicts: [{ round: 1, criterion: 'red', judge: 'converged' }],
        }),
      );
      const r = failureReadout([rootA, rootB]);
      expect(r.runDirs).toBe(2);
      // ① rootA 的 infra-error 带 paths; rootB 的 empty-artifact 不带 —— 分母跨 root 相加
      expect(r.failurePaths).toEqual({ denominator: 2, withPaths: 1, rate: 0.5 });
      // ② / ③ / ④ 各 root 的贡献都进同一份合计
      expect(r.emptyArtifact).toEqual({ total: 1, withInputPaths: 1 });
      expect(r.redConverged).toBe(1);
      expect(r.infraError).toBe(1);
      expect(r.roundsExhausted).toBe(0);
      expect(r.unreadable).toBe(0);
    } finally {
      rmSync(rootA, { recursive: true, force: true });
      rmSync(rootB, { recursive: true, force: true });
    }
  });
});
