/**
 * #167 —— command 节点的绿 checkpoint「只当账不当闸」契约。
 *
 * 事故形状 (run 68cfb43f): accept (command) 红一攻绿一攻, 绿的那攻刻意不落 checkpoint →
 * base 文件只剩红那份, 验尸把一单成功读成「判据红」。修法 = 账诚实 (绿也落) + 闸不动
 * (shouldSkip 对 leafKind 'command' 恒 false, resume 照旧重跑 oracle)。
 * 两半各自可证伪: 删 engine 的 command saveDoneCheckpoint → ①红; 删 shouldSkip 的
 * leafKind 卡 → ③红 (当场验过, 恢复后绿)。
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CheckpointManager } from './checkpoint-manager';
import { runExecutorDagWithPlan } from '../dag/engine';
import type { ConductorPlan } from '../conductor-plan';
import type { ExecutorDagConfig } from '../dag/types';

const PLAN: ConductorPlan = {
  name: 'p167',
  nodes: { gate: { goal: 'run the oracle', executor: 'command', command: 'echo ok' } },
};

/** 一次性引擎配置: 假 command runner 计数真跑次数。 */
function cfg(root: string, runId: string, resume: boolean, spawns: { n: number }): ExecutorDagConfig {
  return {
    conductorModel: 'c:m',
    leafModel: 'l:m',
    agentTemplates: new Map(),
    commandRunner: async () => {
      spawns.n++;
      return { text: 'oracle ok', usage: { in: 0, out: 0 }, timedOut: false, signal: null, exitCode: 0 };
    },
    continuity: { manager: new CheckpointManager(root), runId, repoRoot: root, ...(resume ? { resume: true } : {}) },
  } as unknown as ExecutorDagConfig;
}

describe('#167 command 绿 checkpoint: 账诚实, 闸不跳', () => {
  test('① 账: command 节点 done 后 base 文件存在且 status=done (不再只可能 failed/skipped)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omd-167-'));
    const spawns = { n: 0 };
    await runExecutorDagWithPlan(PLAN, cfg(root, 'r1', false, spawns));
    const base = join(root, '.omd', 'continuity', 'r1', 'gate.json');
    expect(existsSync(base)).toBe(true);
    const cp = JSON.parse(readFileSync(base, 'utf8')) as { status: string; leafKind: string };
    expect(cp.status).toBe('done');
    expect(cp.leafKind).toBe('command');
  });

  test('② 闸: resume 同 runId, command 节点仍真跑 (oracle 不许被绿账跳过)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omd-167-'));
    const spawns = { n: 0 };
    await runExecutorDagWithPlan(PLAN, cfg(root, 'r1', false, spawns));
    expect(spawns.n).toBe(1);
    await runExecutorDagWithPlan(PLAN, cfg(root, 'r1', true, spawns));
    expect(spawns.n).toBe(2); // 绿 checkpoint 在盘上, 但 resume 没拿它跳过
  });

  test('③ shouldSkip 单点: command 绿恒 false; 无产物 inproc 绿为 true (对照, 证明尺子本身能跳)', () => {
    const root = mkdtempSync(join(tmpdir(), 'omd-167-'));
    const m = new CheckpointManager(root);
    const base = { outputPaths: [], artifactHashes: {}, tokenUsage: null, summary: 's', durationMs: 0, createdAt: new Date().toISOString(), schemaVersion: 1 as const };
    m.saveCheckpoint('r1', { nodeId: 'gate', leafKind: 'command', status: 'done', ...base });
    m.saveCheckpoint('r1', { nodeId: 'calc', leafKind: 'inproc', status: 'done', ...base });
    expect(m.shouldSkip('r1', 'gate')).toBe(false);
    expect(m.shouldSkip('r1', 'calc')).toBe(true);
  });
});
