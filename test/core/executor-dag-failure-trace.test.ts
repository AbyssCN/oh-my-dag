/**
 * executor-dag 失败留痕守卫 (issue #4 + #5)。
 * 证:
 *   - agent leaf 停摆 (心跳闸 stalled) → 节点 failed, 不当近零输出为 done (issue #5)
 *   - agent leaf 抛错 → 节点 failed 且**保留错误消息** (issue #4: 此前 .catch(()=>null) 丢败因)
 *   - 失败节点落 continuity checkpoint (status=failed + failureKind), resume 不当绿跳过
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runExecutorDag, type GenerateFn } from '../../src/harness/executor-dag';
import type { AgentLeafInput } from '../../src/harness/leaf-runners';
import { CheckpointManager } from '../../src/harness/continuity/checkpoint-manager';

const CONDUCTOR = 'mimo:mimo-v2.5-pro';
const LEAF = 'deepseek:deepseek-v4-flash';
const gen =
  (plan: string): GenerateFn =>
  async ({ model }) =>
    model === CONDUCTOR ? { text: plan, usage: { in: 1, out: 1 } } : { text: 'OUT', usage: { in: 1, out: 1 } };

const AGENT_PLAN = JSON.stringify({ name: 's', nodes: { n1: { goal: '干活 (纯 agent, 非写文件)', executor: 'agent' } } });

describe('executor-dag 失败留痕 (issue #4/#5)', () => {
  test('agent leaf 停摆 (stalled) → 节点 failed + 输出含停摆标记 (issue #5)', async () => {
    const stallRunner = async (_i: AgentLeafInput) => ({ text: 'x', usage: { in: 1, out: 1 }, filesTouched: [], stalled: true });
    const res = await runExecutorDag('t', { conductorModel: CONDUCTOR, leafModel: LEAF, generate: gen(AGENT_PLAN), agentRunner: stallRunner });
    expect(res.results['n1']!.status).toBe('failed'); // 关键: 不是 done (拒绝近零输出假成功)
    expect(res.results['n1']!.output).toContain('停摆');
  });

  test('agent leaf 抛错 → 节点 failed + 保留错误消息 (issue #4)', async () => {
    const throwRunner = async (_i: AgentLeafInput): Promise<never> => {
      throw new Error('provider 挂了');
    };
    const res = await runExecutorDag('t', { conductorModel: CONDUCTOR, leafModel: LEAF, generate: gen(AGENT_PLAN), agentRunner: throwRunner });
    expect(res.results['n1']!.status).toBe('failed');
    expect(res.results['n1']!.output).toContain('provider 挂了'); // 败因保留, 非静默 null
  });

  test('失败节点落 continuity checkpoint (status=failed + failureKind=stall)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dag-fail-trace-'));
    const manager = new CheckpointManager(dir);
    const runId = 'run-fail-1';
    const stallRunner = async (_i: AgentLeafInput) => ({ text: 'x', usage: { in: 1, out: 1 }, filesTouched: [], stalled: true });
    await runExecutorDag('t', {
      conductorModel: CONDUCTOR,
      leafModel: LEAF,
      generate: gen(AGENT_PLAN),
      agentRunner: stallRunner,
      continuity: { manager, runId, repoRoot: dir, resume: false },
    });
    const cp = manager.loadCheckpoint(runId, 'n1');
    expect(cp).not.toBeNull();
    expect(cp!.status).toBe('failed');
    expect(cp!.failureKind).toBe('stall');
    expect(cp!.summary).toContain('停摆'); // 败因消息留痕
    // resume 语义: 失败 checkpoint 不当绿 → loadAllGreen 不含它
    expect(manager.loadAllGreen(runId).some((c) => c.nodeId === 'n1')).toBe(false);
  });
});
