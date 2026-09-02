/**
 * shape 进 checkpoint (2026-09-03) —— `dag_resume` 从 `_dag.json` 的 `plan` 重建图 (`mcp/tools/dag-tools.ts`
 * `loadDagMetadata` → `parsePlan`), 此前引擎写盘的 plan 只有 name/description/nodes, shape 在这一跳丢掉,
 * 续跑那一行的 `shape_id` 读成 null (账本把「没记」读成「没声明」)。
 *
 * 反向自检: 把 engine.ts writeDagMetadata 那行的 `...(plan.shape ? { shape } : {})` 删掉 → ★① 红。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runExecutorDagWithPlan } from './engine';
import { CheckpointManager } from '../continuity/checkpoint-manager';
import { parsePlan } from '../conductor-plan';
import type { ConductorPlan } from '../conductor-plan';
import type { ExecutorDagConfig, GenerateFn } from './types';

const generate: GenerateFn = async () => ({ text: 'ok', usage: { in: 1, out: 1 } });

async function runAndLoad(plan: ConductorPlan): Promise<{ stored: unknown; reparsedShape: string | undefined }> {
  const root = mkdtempSync(join(tmpdir(), 'omd-shape-cp-'));
  const manager = new CheckpointManager(root);
  const cfg: ExecutorDagConfig = {
    conductorModel: 'test:conductor',
    leafModel: 'test:leaf',
    generate,
    agentTemplates: new Map(),
    continuity: { manager, runId: 'run-s', repoRoot: root },
  };
  await runExecutorDagWithPlan(plan, cfg);
  const meta = manager.loadDagMetadata('run-s');
  const stored = meta?.plan;
  // 与 dag_resume 同一条路: 存下来的 plan 经 parsePlan 重建
  const reparsed = parsePlan(JSON.stringify(stored), { knownServers: new Set<string>() });
  return { stored, reparsedShape: reparsed.ok ? reparsed.plan.shape : undefined };
}

describe('shape 随 plan 进 checkpoint, resume 重建后仍在', () => {
  test('★① 声明了 shape 的 plan: _dag.json 的 plan.shape 在, parsePlan 重建后 shape 仍在', async () => {
    const plan: ConductorPlan = { name: 'p', shape: 'research-lens', nodes: { a: { goal: 'do a' } } };
    const { stored, reparsedShape } = await runAndLoad(plan);
    expect((stored as { shape?: string }).shape).toBe('research-lens');
    expect(reparsedShape).toBe('research-lens');
  });

  test('★② 没声明 shape 的 plan: 存的 plan 没有 shape 键 (缺席原样, 不编空串)', async () => {
    const plan: ConductorPlan = { name: 'p', nodes: { a: { goal: 'do a' } } };
    const { stored, reparsedShape } = await runAndLoad(plan);
    expect(Object.hasOwn(stored as object, 'shape')).toBe(false);
    expect(reparsedShape).toBeUndefined();
  });
});
