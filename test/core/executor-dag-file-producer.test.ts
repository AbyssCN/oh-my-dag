import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runExecutorDag, type GenerateFn } from '../../src/harness/executor-dag';
import type { AgentLeafInput } from '../../src/harness/leaf-runners';

// 产物校验闸 (2026-07-03): agent 写文件节点声称的 filesTouched 必须真实存在 → 测试用真 tmp 文件。
const TMP = mkdtempSync(join(tmpdir(), 'dag-artifact-'));
const realArtifact = (name: string): string => {
  const p = join(TMP, name);
  writeFileSync(p, '// artifact');
  return p;
};

// M3 conductor inproc-写文件 bug 修复: conductor (M3 非确定性) 把"写文件"节点标成 leaf →
// inproc 不能写文件 → exit 0 但无产物 (静默假成功)。guard: output_type:file/git ∨ output_path ∨
// goal 写文件信号 → 必须 agent (有 runner 则提升, 无 runner 则失败不静默 done)。

const CONDUCTOR = 'mimo:mimo-v2.5-pro';
const LEAF = 'deepseek:deepseek-v4-flash';

function gen(plan: string): GenerateFn {
  return async ({ model }) =>
    model === CONDUCTOR ? { text: plan, usage: { in: 1, out: 1 } } : { text: 'OUT', usage: { in: 1, out: 1 } };
}
const fileAgentRunner = (touched: string[], flag: { called: boolean }) => async (_i: AgentLeafInput) => {
  flag.called = true;
  return { text: 'wrote', usage: { in: 1, out: 1 }, filesTouched: touched };
};

describe('executor-dag 写文件节点 guard (M3 conductor bug)', () => {
  test('output_type:file + executor:leaf + agentRunner → 提升 agent', async () => {
    const plan = JSON.stringify({ name: 'b', nodes: { impl: { goal: '实现缓存', executor: 'leaf', output_type: 'file' } } });
    const flag = { called: false };
    const res = await runExecutorDag('t', {
      conductorModel: CONDUCTOR, leafModel: LEAF, generate: gen(plan), agentRunner: fileAgentRunner([realArtifact('x.ts')], flag),
    });
    expect(flag.called).toBe(true);
    expect(res.results['impl']!.kind).toBe('agent'); // 被提升, 非 inproc
    expect(res.results['impl']!.status).toBe('done');
  });

  test('output_type:file + 无 agentRunner → 失败 (拒绝 inproc 静默假成功)', async () => {
    const plan = JSON.stringify({ name: 'b', nodes: { impl: { goal: '实现缓存', executor: 'leaf', output_type: 'file' } } });
    const res = await runExecutorDag('t', { conductorModel: CONDUCTOR, leafModel: LEAF, generate: gen(plan) });
    expect(res.results['impl']!.status).toBe('failed'); // 关键: 不是 done
  });

  test('goal 启发式 (创建 src/lru.ts, 无 output_type) → 提升 agent', async () => {
    const plan = JSON.stringify({ name: 'h', nodes: { impl: { goal: '创建 src/lru.ts 实现 LRU 缓存', executor: 'leaf' } } });
    const flag = { called: false };
    const res = await runExecutorDag('t', {
      conductorModel: CONDUCTOR, leafModel: LEAF, generate: gen(plan), agentRunner: fileAgentRunner([realArtifact('lru.ts')], flag),
    });
    expect(flag.called).toBe(true);
    expect(res.results['impl']!.kind).toBe('agent');
  });

  test('产物校验闸: agent 写文件节点 filesTouched 空 → failed (拒绝 empty-done)', async () => {
    const plan = JSON.stringify({ name: 'e', nodes: { impl: { goal: '实现缓存', executor: 'agent', output_type: 'file' } } });
    const flag = { called: false };
    const res = await runExecutorDag('t', {
      conductorModel: CONDUCTOR, leafModel: LEAF, generate: gen(plan), agentRunner: fileAgentRunner([], flag),
    });
    expect(flag.called).toBe(true);
    expect(res.results['impl']!.status).toBe('failed'); // 2026-07-03 ultraspeed 实测: 3/4 节点 empty-done → 本闸拒
    expect(res.results['impl']!.output).toContain('产物校验失败');
  });

  test('产物校验闸: 声称的产物路径不存在 → failed', async () => {
    const plan = JSON.stringify({ name: 'g', nodes: { impl: { goal: '实现缓存', executor: 'agent', output_type: 'file' } } });
    const flag = { called: false };
    const res = await runExecutorDag('t', {
      conductorModel: CONDUCTOR, leafModel: LEAF, generate: gen(plan), agentRunner: fileAgentRunner(['/tmp/__no_such_artifact__.ts'], flag),
    });
    expect(res.results['impl']!.status).toBe('failed');
    expect(res.results['impl']!.output).toContain('不存在');
  });

  test('纯分析节点 (goal=分析, 无 output_type) → 仍 inproc (不误提升)', async () => {
    const plan = JSON.stringify({ name: 'a', nodes: { think: { goal: '分析 src/x.ts 的 LRU 逻辑给出建议', executor: 'leaf' } } });
    const flag = { called: false };
    const res = await runExecutorDag('t', {
      conductorModel: CONDUCTOR, leafModel: LEAF, generate: gen(plan), agentRunner: fileAgentRunner([], flag),
    });
    expect(res.results['think']!.kind).toBe('inproc'); // 分析不写文件 → 不误提升
    expect(flag.called).toBe(false);
  });
});
