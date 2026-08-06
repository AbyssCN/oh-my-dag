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

/**
 * 失败留痕加厚的**可达性**闸 (2026-08-06)。
 *
 * 上面那三条证的是"失败节点有 checkpoint";这三条证的是**那份 checkpoint 里有没有东西可查** ——
 * 改动前盘上 150 份非绿 checkpoint 带全文的 **0** 份, 而"机制在、盘上零产出"正是本仓反复在治的形态。
 * 所以这里不测纯函数 (那在 `src/harness/failure-trace.test.ts`), 只测**真跑一遍之后盘上有没有那一位**。
 *
 * ⚠ 反向自检: 把 `executor-dag` 里 `saveNodeFailureOutput` / `blamePathCandidates` 两行删掉,
 *   第一、二条立刻红 (它们就是改动前的状态)。
 */
describe('失败留痕加厚 —— 盘上真有那一位吗 (2026-08-06)', () => {
  const failCmdPlan = JSON.stringify({
    name: 's',
    nodes: { n1: { goal: '跑验收', executor: 'command', command: 'bun test src/x.test.ts' } },
  });

  const runWithFailingCommand = async (text: string, root: string, manager: CheckpointManager, runId: string) =>
    runExecutorDag('t', {
      conductorModel: CONDUCTOR,
      leafModel: LEAF,
      generate: gen(failCmdPlan),
      commandRunner: async () => ({ text, exitCode: 1, usage: { in: 0, out: 0 } }),
      continuity: { manager, runId, repoRoot: root, resume: false },
    });

  test('失败全文落盘且可读回 —— 不再只有 800 字的头', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dag-fail-full-'));
    const manager = new CheckpointManager(dir);
    // 盘上真实形状: 前面成功刷屏占满 800 字预算, 失败判词在**尾巴**上。
    const long = `bun run tsc --noEmit\n${'成功刷屏 '.repeat(400)}\nerror: 1 test failed`;
    await runWithFailingCommand(long, dir, manager, 'run-full');
    const cp = manager.loadCheckpoint('run-full', 'n1')!;
    expect(cp.status).toBe('failed');
    expect(cp.outputText).toBeTruthy(); // ← 改动前恒缺席
    expect(manager.loadNodeOutput(cp.outputText!)).toContain('1 test failed');
    // summary 是头+尾: 两头都在, 且比全文短
    expect(cp.summary).toContain('bun run tsc --noEmit');
    expect(cp.summary).toContain('1 test failed'); // ← 改动前被切掉的正是这句
    expect(cp.summary.length).toBeLessThan(long.length);
  });

  test('失败全文与成功全文不同名 —— 后一轮成功不许覆盖前一轮的失败证据', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dag-fail-name-'));
    const manager = new CheckpointManager(dir);
    await runWithFailingCommand('炸了 in nowhere', dir, manager, 'run-name');
    const cp = manager.loadCheckpoint('run-name', 'n1')!;
    expect(cp.outputText).toContain('fail-n1.txt');
    expect(cp.outputText).not.toContain('out-n1.txt');
  });

  test('失败输出点名的真文件进 failurePaths; 编的路径不进 (漏认不误认)', async () => {
    const root = process.cwd(); // 用真仓根, 这样 `src/harness/failure-trace.ts` 核得过
    const dir = mkdtempSync(join(tmpdir(), 'dag-fail-paths-'));
    const manager = new CheckpointManager(dir);
    const text = 'src/harness/failure-trace.ts(1,1): error TS9999\n还有 src/harness/绝无此文件.ts';
    await runExecutorDag('t', {
      conductorModel: CONDUCTOR,
      leafModel: LEAF,
      generate: gen(failCmdPlan),
      commandRunner: async () => ({ text, exitCode: 1, usage: { in: 0, out: 0 } }),
      continuity: { manager, runId: 'run-paths', repoRoot: root, resume: false },
    });
    const cp = manager.loadCheckpoint('run-paths', 'n1')!;
    expect(cp.failurePaths).toEqual(['src/harness/failure-trace.ts']);
  });

  test('语义失败 (输出里没有文件) → failurePaths 缺席, 不硬凑一个', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dag-fail-nopath-'));
    const manager = new CheckpointManager(dir);
    // 盘上 assert-failed 的主流形状
    await runWithFailingCommand('[expect_exit 1, 实得 0]\n28 pass\n 0 fail', dir, manager, 'run-nopath');
    const cp = manager.loadCheckpoint('run-nopath', 'n1')!;
    expect(cp.failurePaths).toBeUndefined();
  });
});
