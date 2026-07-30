/**
 * S2 后半 —— `dag_goal detached=true` 的接线 (2026-08-03)。
 *
 * 它要成立的那件事: MCP server 是 stdio + **客户端消失即自杀**, 所以在飞的 goal 随会话一起死,
 * 「无人值守」在那条路上物理上不成立。detached 把活交给一个子进程。
 *
 * 这条网盯三个失效形态, 每个都是沉默的:
 *  ① **母进程抢先登记 run** → 盘上那条的属主是母进程, 而母进程随时会走 → 下一个 session
 *     hydrate 就把一个**正在跑的** run 判成"被打断"。属主必须是 worker。
 *  ② **起不来却照样回 runId** → 调用方拿着一个永远不会出现的 id 等下去。要当场响亮失败。
 *  ③ **worker 脚本路径按 cwd 拼** → 在别的 repo 里必然 Script not found, 而错误只进日志文件,
 *     run 静默卡死。dispatch.ts 的 dag-research 踩过同一个坑。
 */
import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGoalTool } from './goal';
import { RunRegistry } from '../run-registry';
import { CheckpointManager } from '../../harness/continuity/checkpoint-manager';
import type { RunGoalResult } from '../../harness/goal/run-goal';

const neverRuns = async (): Promise<RunGoalResult> => {
  throw new Error('detached 路径不该在母进程里跑 runGoal');
};

const make = (spawnDetached?: (cmd: string[], o: { cwd: string; logPath: string }) => number | undefined) => {
  const root = mkdtempSync(join(tmpdir(), 'omd-det-'));
  const registry = new RunRegistry();
  const tool = createGoalTool({
    runGoal: neverRuns,
    runRegistry: registry,
    cwd: root,
    buildConfig: () => ({ conductorModel: 'c:m', leafModel: 'l:m' }),
    continuity: { manager: new CheckpointManager(root), repoRoot: root },
    ...(spawnDetached ? { spawnDetached } : {}),
  });
  return { tool, registry, root };
};

const call = (tool: ReturnType<typeof createGoalTool>, args: Record<string, unknown>) =>
  tool.handler(args as never, {} as never) as Promise<{ content: { text: string }[]; isError?: boolean }>;

describe('dag_goal detached', () => {
  test('起子进程并立刻回 runId, 命令行带齐 worker 要的四样', async () => {
    const seen: { cmd: string[]; cwd: string; logPath: string }[] = [];
    const { tool, root } = make((cmd, o) => {
      seen.push({ cmd, ...o });
      return 4242;
    });
    const out = await call(tool, { goal: '长活的活', tier: 'simple', maxRounds: 3, detached: true });
    const text = out.content[0]!.text;

    expect(out.isError).toBeUndefined();
    const runId = /runId: (\S+)/.exec(text)?.[1];
    expect(runId).toBeTruthy();
    expect(text).toContain('pid 4242');

    const { cmd, cwd } = seen[0]!;
    expect(cmd[0]).toBe('bun');
    // 脚本路径按**包安装位置**解析, 不是 cwd 相对 —— 换个 repo 也找得到。
    expect(cmd[2]).toContain('scripts/goal-worker.ts');
    expect(cmd[2]!.startsWith('/')).toBe(true);
    expect(existsSync(cmd[2]!)).toBe(true); // 真存在, 不是一个拼错的路径
    expect(cmd).toContain('--run-id');
    expect(cmd[cmd.indexOf('--run-id') + 1]).toBe(runId);
    expect(cmd[cmd.indexOf('--cwd') + 1]).toBe(root);
    expect(cmd[cmd.indexOf('--goal') + 1]).toBe('长活的活');
    expect(cmd[cmd.indexOf('--tier') + 1]).toBe('simple');
    expect(cmd[cmd.indexOf('--max-rounds') + 1]).toBe('3');
    expect(cwd).toBe(root);
  });

  test('**母进程不登记 run** —— 属主必须是 worker, 否则下个 session 会把在跑的判成被打断', async () => {
    const { tool, registry } = make(() => 1);
    const out = await call(tool, { goal: 'g', detached: true });
    const runId = /runId: (\S+)/.exec(out.content[0]!.text)![1]!;
    // 这正是"毫秒级窗口"的代价, 也是它换来的正确性: 盘上那条由 worker 写, 属主是 worker。
    expect(registry.getStatus(runId)).toBeNull();
  });

  test('起不来 → **当场响亮失败**, 不回一个永远不会出现的 runId', async () => {
    const { tool } = make(() => {
      throw new Error('bun 不在 PATH 上');
    });
    const out = await call(tool, { goal: 'g', detached: true });
    expect(out.isError).toBe(true);
    expect(out.content[0]!.text).toContain('bun 不在 PATH 上');
    expect(out.content[0]!.text).not.toContain('runId:');
  });

  test('不给 detached → 老路径 (母进程内跑), 一个子进程都不起', async () => {
    const seen: string[][] = [];
    const root = mkdtempSync(join(tmpdir(), 'omd-det-'));
    const tool = createGoalTool({
      runGoal: async (goal) => ({
        goal, tier: 'simple', acceptance: { kind: 'executable', command: 'x', expectExit: 0 },
        stages: [], sources: [], repoContext: '', converged: true, rounds: 1, reusedNodes: [],
      }),
      runRegistry: new RunRegistry(),
      cwd: root,
      buildConfig: () => ({ conductorModel: 'c:m', leafModel: 'l:m' }),
      continuity: { manager: new CheckpointManager(root), repoRoot: root },
      spawnDetached: (cmd: string[]) => {
        seen.push(cmd);
        return 1;
      },
    });
    const out = await call(tool, { goal: 'g' });
    await Bun.sleep(5);
    expect(seen).toHaveLength(0);
    expect(out.content[0]!.text).toContain('status: running');
  });
});
