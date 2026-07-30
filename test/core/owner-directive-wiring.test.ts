/**
 * S3 的**引擎接线**: owner 指令真的逐字进了下一轮 conductor prompt 吗 (2026-07-31)。
 *
 * `owner-inbox.test.ts` 钉的是收件箱自己的语义;这一条钉**它被接上了**——本仓反复撞见的形态是
 * "实现写好了、没有调用方",而症状是沉默的:owner 裁了,环照旧跑错的那条路,读数上没有区别。
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runExecutorDagWithPlan } from '../../src/harness/executor-dag';
import { CheckpointManager } from '../../src/harness/continuity/checkpoint-manager';
import type { ConductorPlan } from '../../src/harness/conductor-plan';
import type { ExecutorDagConfig, GenerateFn } from '../../src/harness/executor-dag-types';

let root: string;
let manager: CheckpointManager;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'omd-owner-')); manager = new CheckpointManager(root); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

const leafId = (p: string): string => /\[omd leaf: ([^\]]+)\]/.exec(p)?.[1] ?? '';
const SUB = JSON.stringify({ name: 's', nodes: { w: { goal: '干活' } } });
const plan = (): ConductorPlan =>
  ({ name: 'outer', nodes: { C: { goal: '做完', executor: 'conductor', max_rounds: 3, judge_final: true } } }) as ConductorPlan;

/** 回收每一轮的展开 prompt。 */
const run = async (over: Partial<ExecutorDagConfig>) => {
  const expands: string[] = [];
  const generate: GenerateFn = async (req) => {
    const text = String(req.messages.find((m) => m.role === 'user')?.content ?? '');
    if (leafId(text)) return { text: 'ok', usage: { in: 1, out: 1 } };
    expands.push(text);
    return { text: SUB, usage: { in: 1, out: 1 } };
  };
  await runExecutorDagWithPlan(plan(), {
    conductorModel: 'c:m', leafModel: 'l:m', agentTemplates: new Map(),
    continuity: { manager, runId: 'owner-run', repoRoot: root },
    generate,
    judgeSend: (async () => {
      const v = { converged: false, score: 0, failureReason: '还不行', rejectedNodes: [] };
      return { text: JSON.stringify(v), parsed: v, usage: { in: 1, out: 1 } };
    }) as never,
    ...over,
  } as ExecutorDagConfig);
  return expands;
};

const RAW = '别用 zod v4 的 .loose(), 我们锁在 v3 —— 这是踩过的坑, 不要"顺手升级"。';

describe('S3 owner 指令的引擎接线', () => {
  test('**逐字**进 conductor prompt, 且是独立的块', async () => {
    const expands = await run({ ownerDirectives: (r) => (r === 2 ? `<owner 指令>\n${RAW}\n</owner 指令>\n` : '') });
    expect(expands.length).toBeGreaterThanOrEqual(2);
    expect(expands[0]).not.toContain(RAW);      // 第 1 轮还没有指令
    expect(expands[1]).toContain(RAW);          // 第 2 轮逐字出现
    expect(expands[1]).toContain('<owner 指令>'); // 与 <上一轮未通过> 分开的块 (D-S)
  });

  test('owner 指令排在**失败原因之前** —— 人的话优先级更高, 顺序上也该先看见', async () => {
    const expands = await run({ ownerDirectives: () => `<owner 指令>\n${RAW}\n</owner 指令>\n` });
    const p = expands[1]!;
    expect(p.indexOf('<owner 指令>')).toBeLessThan(p.indexOf('<上一轮未通过>'));
  });

  test('每轮各调一次, 轮号如实传入 (消费记账靠它)', async () => {
    const rounds: number[] = [];
    await run({ ownerDirectives: (r) => { rounds.push(r); return ''; } });
    expect(rounds).toEqual([1, 2, 3]);
  });

  test('不给通道 → prompt 里一个字都不多 (零回归)', async () => {
    const expands = await run({});
    expect(expands.every((p) => !p.includes('<owner 指令>'))).toBe(true);
  });
});
