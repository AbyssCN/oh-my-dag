/**
 * **R2 接线闸** —— `dag_goal` 的 `branchStrategy` 真的把活挪到了那棵树上 (2026-07-31)。
 *
 * 单出 `run-worktree.ts` 是个空旋钮(件在、零调用方,与预算轴被七态词表抓出来那次同形),
 * 所以模块的网之外还要一条**装配层**的网。这里钉三件:
 *
 *   ① 缺省 = `head`,`runGoal` 拿到的 cwd **逐字等于** `deps.cwd` —— 零回归
 *   ② `branch` 档下 `runGoal` 拿到的是**那棵 worktree**,不是主树
 *   ③ 回话里念得出目录/分支/合回命令;**降级时念得出原因**
 *
 * 第 ③ 条不是文案洁癖:退回 head 而调用方不知道 = 它以为写在隔离树里、实际写的是主树,
 * 比不隔离坏得多。
 *
 * 本文件**不起真 worktree** —— 沙箱 `cwd` 不是 git 仓,于是 `branch` 档自然走降级那一路;
 * 「真建起来」那半由 `run-worktree.test.ts` 用注入的假 git 覆盖。两边合起来才是完整的。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGoalTool } from './goal';
import { RunRegistry } from '../run-registry';
import type { RunGoalResult } from '../../harness/goal/run-goal';

const emptyResult = (goal: string): RunGoalResult => ({
  goal,
  tier: 'simple',
  acceptance: { kind: 'executable', command: 'bun test', expectExit: 0 },
  stages: [],
  sources: [],
  repoContext: '',
  converged: true,
  rounds: 1,
  reusedNodes: [],
});

/** 造工具 + 回收 runGoal 实际拿到的 cwd(接线唯一说得清的观察面)。 */
const make = (opts: { fakeGitRepo?: boolean } = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'omd-branch-'));
  // `.git` 存在 = `prepareRunWorktree` 认它是工作树 → 会真去调 git。本文件只在**不建**的那条路上
  // 用它, 用来分开"没试"与"试了但失败"两种降级。
  if (opts.fakeGitRepo) mkdirSync(join(root, '.git'), { recursive: true });
  const cwds: string[] = [];
  const tool = createGoalTool({
    runGoal: async (goal, cfg) => {
      cwds.push(cfg.cwd);
      return emptyResult(goal);
    },
    runRegistry: new RunRegistry(),
    cwd: root,
    buildConfig: () => ({ conductorModel: 'c:m', leafModel: 'l:m' }),
  });
  return { tool, cwds, root };
};

const textOf = (r: { content: { text?: string }[] }): string => r.content.map((c) => c.text ?? '').join('\n');
/** 与既有 goal 工具测试同一个调法 (handler 的第二参是 MCP extra, 测试里给空壳)。 */
const call = (tool: ReturnType<typeof createGoalTool>, args: Record<string, unknown>) =>
  tool.handler(args as never, {} as never) as Promise<{ content: { text?: string }[] }>;
/** runGoal 是 fire-and-forget(handler 不等它), 让出一轮微任务再看。 */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

describe('① 缺省 head — 零回归', () => {
  test('不传 branchStrategy → runGoal 拿到的 cwd 逐字 = deps.cwd', async () => {
    const { tool, cwds, root } = make();
    await call(tool, { goal: '干点活' });
    await settle();
    expect(cwds).toEqual([root]);
  });

  test('显式 head 同上, 回话不该冒出分支相关的话', async () => {
    const { tool, cwds, root } = make();
    const r = await call(tool, { goal: '干点活', branchStrategy: 'head' });
    await settle();
    expect(cwds).toEqual([root]);
    const t = textOf(r);
    expect(t).toContain('当前工作树');
    expect(t).not.toContain('git merge');
  });
});

describe('② branch — 建不起来就退回 head, 但必须说出来', () => {
  test('cwd 不是 git 仓 → 降级到主树, 回话带原因', async () => {
    const { tool, cwds, root } = make();
    const r = await call(tool, { goal: '干点活', branchStrategy: 'branch' });
    await settle();
    // 活照跑(隔离是加固不是前置条件)……
    expect(cwds).toEqual([root]);
    // ……但调用方必须看得见它没被隔离。
    expect(textOf(r)).toContain('不是 git 工作树');
  });

  test('有 `.git` 但 git 命令必失败(空目录不是真仓)→ 同样降级 + 带原因', async () => {
    const { tool, cwds, root } = make({ fakeGitRepo: true });
    const r = await call(tool, { goal: '干点活', branchStrategy: 'branch' });
    await settle();
    expect(cwds).toEqual([root]);
    // 这一条与上一条的降级**成因不同**(没试 vs 试了失败), 文案也该不同 —— 两种"看不见"要分得开。
    expect(textOf(r)).toContain('建 worktree 失败');
  });
});

describe('③ 回话里的把手', () => {
  test('runId 与 status 仍在(R2 不许挤掉三段式的入口)', async () => {
    const { tool } = make();
    const r = await call(tool, { goal: '干点活', branchStrategy: 'branch' });
    const t = textOf(r);
    expect(t).toContain('runId:');
    expect(t).toContain('status: running');
  });

  test('schema 只认 head/branch —— merge-to-head 进不来', () => {
    const { tool } = make();
    // `.optional()` 包了一层 —— 先 unwrap 再取词表 (zod 4 的 enum 词表在 `options`)。
    const shape = tool.inputSchema as unknown as Record<string, { unwrap?: () => { options?: string[] } }>;
    const opts = shape.branchStrategy?.unwrap?.()?.options ?? [];
    expect([...opts].sort()).toEqual(['branch', 'head']);
  });
});
