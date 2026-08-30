/**
 * write-wall.test —— 刀② (2026-08-30 闸门三角结) 写域闸撞墙信号上抛。
 *
 * 契约 verify: 同路径两次撞闸 → observation 必须出现且带路径; 不同路径各撞一次 → 不出
 * (阈值防噪)。链路三段: 工具面回调 (agent-tools) → 按调用计数 (agent-leaf ALS) →
 * 引擎 ≥2 判档上抛 (engine observe)。本文件钉两端 (回调面 + 引擎面), 中段是 5 行
 * 类型化透传, 由 tsc 与两端夹住。
 *
 * 反向自检 (手做过, 记录在此): 把 engine 的 `n >= 2` 改成 `n >= 1` → 「不同路径各撞一次」
 * 用例当场红 (噪声升级成 observation)。
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOmdAgentTools, type AnyOmdTool } from '../agent-tools';
import { runExecutorDagWithPlan } from '../dag/engine';
import type { AgentLeafRunner } from '../leaf-runners';
import type { ConductorPlan } from '../conductor-plan';
import type { ExecutorDagConfig, GenerateFn } from '../dag/types';

// ── 工具面: 写域闸拒时回调必须带被拒目标 ─────────────────────────────────────

describe('agent-tools onWriteDenied 回调', () => {
  test('★ 同路径两次拒 → 回调两次, 目标同一形状 (与判词一致)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omd-wall-'));
    try {
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(join(root, 'src/allowed.ts'), 'export {};\n');
      const denied: string[] = [];
      const tools: Record<string, AnyOmdTool> = Object.fromEntries(
        createOmdAgentTools({
          cwd: root,
          writeAllow: () => ['src/allowed.ts'],
          onWriteDenied: (t) => denied.push(t),
        }).map((t) => [t.name, t]),
      );
      const tryWrite = (): Promise<unknown> =>
        (tools.write!.execute('c1', { path: 'src/forbidden.ts', content: 'x' } as never, undefined, undefined) as Promise<unknown>).catch(() => null);
      await tryWrite();
      await tryWrite();
      expect(denied).toEqual(['src/forbidden.ts', 'src/forbidden.ts']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('回调抛错不影响判拒 (fail-open 只丢观察)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omd-wall-throw-'));
    try {
      const tools: Record<string, AnyOmdTool> = Object.fromEntries(
        createOmdAgentTools({
          cwd: root,
          writeAllow: () => [],
          onWriteDenied: () => {
            throw new Error('观察者炸了');
          },
        }).map((t) => [t.name, t]),
      );
      expect(
        tools.write!.execute('c1', { path: 'x.ts', content: 'x' } as never, undefined, undefined) as Promise<unknown>,
      ).rejects.toThrow(/写域越界/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ── 引擎面: writeDenials → write-wall observation (≥2 阈值) ──────────────────

async function runWithDenials(writeDenials: Record<string, number>): Promise<readonly { kind: string; nodes: string[]; message: string }[]> {
  const execTree = mkdtempSync(join(tmpdir(), 'omd-wall-eng-'));
  try {
    const agentRunner: AgentLeafRunner = async () => ({
      text: '试着写, 被闸拒了。',
      usage: { in: 1, out: 1 },
      filesTouched: [],
      cwd: execTree,
      writeDenials,
    });
    const plan: ConductorPlan = {
      name: 'wall',
      nodes: { W: { goal: '只读检查', executor: 'agent', output_type: 'none' } },
    };
    const generate: GenerateFn = async () => ({ text: 'unused', usage: { in: 1, out: 1 } });
    const cfg: ExecutorDagConfig = {
      conductorModel: 'test:conductor',
      leafModel: 'test:leaf',
      generate,
      agentTemplates: new Map(),
      agentRunner,
    };
    const r = await runExecutorDagWithPlan(plan, cfg);
    return (r.observations ?? []) as readonly { kind: string; nodes: string[]; message: string }[];
  } finally {
    rmSync(execTree, { recursive: true, force: true });
  }
}

describe('engine write-wall observation', () => {
  test('★ 同路径撞闸 2 次 → observation 出现且带路径与节点 id', async () => {
    const obs = await runWithDenials({ 'src/config.ts': 2 });
    const walls = obs.filter((o) => o.kind === 'write-wall');
    expect(walls).toHaveLength(1);
    expect(walls[0]!.nodes).toEqual(['W']);
    expect(walls[0]!.message).toContain('src/config.ts');
    expect(walls[0]!.message).toContain('写集疑似写漏');
  });

  test('★ 不同路径各撞一次 → 不出 (阈值防噪)', async () => {
    const obs = await runWithDenials({ 'a.ts': 1, 'b.ts': 1 });
    expect(obs.filter((o) => o.kind === 'write-wall')).toHaveLength(0);
  });
});
