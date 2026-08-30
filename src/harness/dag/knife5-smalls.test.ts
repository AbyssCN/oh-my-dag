/**
 * knife5-smalls.test —— 刀⑤ (2026-08-30 闸门三角结) 两处零风险小改的钉子。
 *
 *   1. checkpoint shouldSkip 的 artifactHashes 判不跳过必留 {path, was, now} —— 「不跳过」
 *      = 重跑 = 花钱, 此前三条出口全静默, formatter 漂移一个字节的重算查不到原因。
 *   2. A5 (写文件节点无 agentRunner 判死) 谓词从宽 producesFiles 收窄为 A3 同款
 *      declaredArtifact —— goal 正则是路由判据, 拿它判死会冤杀「只读检查」类节点。
 *
 * 反向自检 (手做过): 把 shouldSkip 那行 logger.info 删掉 → 用例 1 红; 把 A5 谓词改回
 * producesFiles → 用例 3 红 (goal 正则节点又被判 missing-capability)。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CheckpointManager, hashArtifact } from '../continuity/checkpoint-manager';
import { runExecutorDagWithPlan } from './engine';
import { setCoreLogger } from '../logger';
import type { ConductorPlan } from '../conductor-plan';
import type { ExecutorDagConfig, GenerateFn } from './types';

interface Captured { msg: string; payload: Record<string, unknown> }

let root: string;
let captured: Captured[];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'omd-knife5-'));
  captured = [];
  const push = (obj: unknown, msg?: string): void => void captured.push({ msg: msg ?? '', payload: (obj ?? {}) as Record<string, unknown> });
  setCoreLogger({ debug: () => {}, info: push, warn: push, error: push });
});
afterEach(() => {
  setCoreLogger({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} });
  rmSync(root, { recursive: true, force: true });
});

describe('刀⑤-1 shouldSkip 漂移证据行', () => {
  test('★ 产物哈希与 checkpoint 不同 → 不跳过, 且日志带 {path, was, now}', () => {
    const mgr = new CheckpointManager(root);
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src/a.ts'), 'v1\n');
    const was = hashArtifact(join(root, 'src/a.ts'))!;
    mgr.saveCheckpoint('r1', {
      nodeId: 'W', leafKind: 'agent', status: 'done', outputPaths: ['src/a.ts'],
      artifactHashes: { 'src/a.ts': was }, tokenUsage: { in: 1, out: 1 }, summary: 's',
      durationMs: 1, createdAt: new Date().toISOString(), schemaVersion: 1,
    });
    writeFileSync(join(root, 'src/a.ts'), 'v1 \n'); // 一个空格的漂移
    expect(mgr.shouldSkip('r1', 'W')).toBe(false);
    const line = captured.find((l) => l.msg.includes('产物哈希与 checkpoint 不同'));
    expect(line).toBeDefined();
    expect(line!.payload.path).toBe('src/a.ts');
    expect(line!.payload.was).toBe(was);
    expect(typeof line!.payload.now).toBe('string');
    expect(line!.payload.now).not.toBe(was);
  });

  test('产物不在盘上 → 不跳过, 日志 now=null (「没了」与「变了」分开记)', () => {
    const mgr = new CheckpointManager(root);
    mgr.saveCheckpoint('r1', {
      nodeId: 'W', leafKind: 'agent', status: 'done', outputPaths: ['src/gone.ts'],
      artifactHashes: { 'src/gone.ts': 'deadbeefdeadbeef' }, tokenUsage: { in: 1, out: 1 }, summary: 's',
      durationMs: 1, createdAt: new Date().toISOString(), schemaVersion: 1,
    });
    expect(mgr.shouldSkip('r1', 'W')).toBe(false);
    const line = captured.find((l) => l.msg.includes('产物不在盘上'));
    expect(line).toBeDefined();
    expect(line!.payload.now).toBeNull();
  });
});

describe('刀⑤-2 A5 谓词收窄 (declaredArtifact, 不再吃 goal 正则)', () => {
  const cfgNoAgent = (): ExecutorDagConfig => {
    const generate: GenerateFn = async () => ({ text: '看了一眼, 检查通过。', usage: { in: 1, out: 1 } });
    return { conductorModel: 'test:conductor', leafModel: 'test:leaf', generate, agentTemplates: new Map() };
  };

  test('★ goal 正则命中「实现…\\.ts」但未声明产物 + 无 agentRunner → 走 inproc, 不再判 missing-capability', async () => {
    const plan: ConductorPlan = {
      name: 'a5-narrow',
      // goal 正则命中 producesFiles (「实现」+40 字内 .ts), 但没有 output_path/output_type ——
      // A3 实测里被冤杀的「只读检查实现文件」正是这形态。
      nodes: { V: { goal: '只读检查非测试实现文件 src/harness/x.ts 的注释一致性' } },
    };
    const r = await runExecutorDagWithPlan(plan, cfgNoAgent());
    expect(r.results.V!.status).toBe('done');
    expect(r.results.V!.failureKind).toBeUndefined();
  });

  test('显式声明产物 (output_path) + 无 agentRunner → 仍判 missing-capability (判死面没放松)', async () => {
    const plan: ConductorPlan = {
      name: 'a5-keep',
      nodes: { W: { goal: '写文件', output_path: 'src/a.ts' } },
    };
    const r = await runExecutorDagWithPlan(plan, cfgNoAgent());
    expect(r.results.W!.status).toBe('failed');
    expect(r.results.W!.failureKind).toBe('missing-capability');
  });
});
