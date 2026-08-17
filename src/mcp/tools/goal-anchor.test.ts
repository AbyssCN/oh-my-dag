/**
 * #147 点火锚预检 + `cwd` 参数 —— `dag_goal` handler 接线网 (2026-08-17)。
 *
 * 它要杀死的失效形态 (B0 实测, runId f5984f2b): goal 文本写明别仓绝对路径, MCP solve 照常
 * 点火在 server 自己的 cwd —— worktree/验收命令/continuity 全落锚仓, 烧完 1.11M in 才看得见,
 * 且从点火到烧完**没有任何一处提示锚不匹配** (症状与"活没干成"同形)。
 *
 * 验收纪律 (issue #147): 构造一条 goal 文本含他仓路径的点火, 预检不红即闸虚。
 * 证伪方式: 把 handler 里 detectAnchorMismatch 那段删掉 → 第一条测直接绿着通过点火 (isError
 * 缺席), 断言红; 把 detached 分支的 --cwd 换回 deps.cwd → 跨仓 spawn 那条的参数断言红。
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGoalTool } from './goal';
import { RunRegistry } from '../run-registry';
import { CheckpointManager } from '../../harness/continuity/checkpoint-manager';
import type { RunGoalResult } from '../../harness/goal/run-goal';

function makeRepo(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `omd-ganchor-${name}-`));
  mkdirSync(join(dir, '.git'));
  return realpathSync(dir);
}

const okResult = (goal: string): RunGoalResult => ({
  goal, tier: 'simple', acceptance: { kind: 'executable', command: 'x', expectExit: 0 },
  stages: [], sources: [], repoContext: '', converged: true, rounds: 1, reusedNodes: [], outcome: 'success' as const,
});

const make = (anchor: string) => {
  const registry = new RunRegistry();
  const spawned: { cmd: string[]; cwd: string; logPath: string }[] = [];
  const tool = createGoalTool({
    runGoal: async (goal) => okResult(goal),
    runRegistry: registry,
    cwd: anchor,
    buildConfig: () => ({ conductorModel: 'c:m', leafModel: 'l:m' }),
    continuity: { manager: new CheckpointManager(anchor), repoRoot: anchor },
    spawnDetached: (cmd, o) => {
      spawned.push({ cmd, ...o });
      return 77;
    },
  });
  const call = (args: Record<string, unknown>) =>
    tool.handler(args as never, {} as never) as Promise<{ content: { text: string }[]; isError?: boolean }>;
  return { call, registry, spawned };
};

describe('#147 dag_goal 点火锚预检', () => {
  const repoA = makeRepo('a');
  const repoB = makeRepo('b');

  test('goal 文本提到别仓 → 拒, 不登记 run, 不 spawn (issue 验收: 预检不红即闸虚)', async () => {
    const { call, registry, spawned } = make(repoA);
    const out = await call({ goal: `在 ${repoB} 仓做一笔回流, 改 ${repoB}/packages/engine` });
    expect(out.isError).toBe(true);
    expect(out.content[0]!.text).toContain('点火锚预检拒绝');
    expect(out.content[0]!.text).toContain(repoB); // 两个锚都要点名, 不是一句"路径有问题"
    expect(out.content[0]!.text).toContain(repoA);
    expect(registry.listRuns()).toHaveLength(0);
    expect(spawned).toHaveLength(0);
  });

  test('显式 cwd=锚仓自己 → 确认锚, 同一条 goal 放行 (别仓路径只是引用的那条腿)', async () => {
    const { call } = make(repoA);
    const out = await call({ goal: `参考 ${repoB} 的实现, 在本仓写一份`, cwd: repoA });
    expect(out.isError).toBeUndefined();
  });

  test('显式 cwd=别仓 + 非 detached → 拒 (registry 烤死在本锚, 跨仓会写出半边状态)', async () => {
    const { call } = make(repoA);
    const out = await call({ goal: '干活', cwd: repoB });
    expect(out.isError).toBe(true);
    expect(out.content[0]!.text).toContain('detached');
  });

  test('显式 cwd=别仓 + detached → worker 以别仓为锚 (--cwd/日志/spawn cwd 三处一致), 回执念出锚仓', async () => {
    const { call, spawned } = make(repoA);
    const out = await call({ goal: '干活', cwd: repoB, detached: true });
    expect(out.isError).toBeUndefined();
    const { cmd, cwd, logPath } = spawned[0]!;
    expect(cmd[cmd.indexOf('--cwd') + 1]).toBe(repoB);
    expect(cwd).toBe(repoB);
    expect(logPath.startsWith(repoB)).toBe(true); // 日志随锚走, 不落发令仓
    expect(out.content[0]!.text).toContain(`锚仓: ${repoB}`); // 跨仓要念出来: 本 server 查不到它
  });

  test('cwd 指向不存在的路径 → 当场响亮拒绝', async () => {
    const { call } = make(repoA);
    const out = await call({ goal: '干活', cwd: '/no/such/dir' });
    expect(out.isError).toBe(true);
    expect(out.content[0]!.text).toContain('cwd 无效');
  });

  test('resume 不再过文本预检 (续跑不是点火; worker 面走 resume 语义, 其 --cwd 即首跑的锚决定)', async () => {
    const { call, spawned } = make(repoA);
    const out = await call({ goal: `在 ${repoB} 收尾`, resume: 'run-x', detached: true });
    expect(out.isError).toBeUndefined();
    expect(spawned).toHaveLength(1);
  });
});
