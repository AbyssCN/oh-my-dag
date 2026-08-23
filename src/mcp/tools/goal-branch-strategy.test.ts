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
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
  outcome: 'success' as const,
  rounds: 1,
  reusedNodes: [],
});

/**
 * 造工具 + 回收**两个**观察面:
 *   `cwds`        —— runGoal 拿到的 cwd
 *   `buildCwds`   —— buildConfig 被传的 cwd(`undefined` = 没传)
 *
 * ⚠ 为什么必须有第二个: 2026-07-31 live 实测抓到 —— 第一版只钉了 `cwds`, 它绿着, 而**产物
 * 全落在主树**。leaf runner 的 cwd 是**装配期**烤死的, `runGoal` 的 `cwd` 参数只管 spec 存盘目录。
 * 也就是说那条网验的是"我改的那个旋钮", 不是"真正要紧的性质(文件落在哪)"。
 * `buildConfig(cwd)` 是重建 runner 的唯一入口, 所以它就是那条性质在装配层的代理。
 */
const make = (opts: { fakeGitRepo?: boolean; realGitRepo?: boolean } = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'omd-branch-'));
  // `.git` 是**空目录** = prepareRunWorktree 认它是工作树 → 真去调 git → 必失败。
  // 用来分开"没试"(不是仓)与"试了但失败"两种降级。
  if (opts.fakeGitRepo) mkdirSync(join(root, '.git'), { recursive: true });
  // 真 git 仓: 隔离档才真的建得起来 —— 那条路上才验得了"runner 有没有被重建"。
  if (opts.realGitRepo) {
    writeFileSync(join(root, 'seed.txt'), 'seed\n');
    for (const args of [['init', '-q'], ['add', '-A'], ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 's']]) {
      Bun.spawnSync(['git', ...args], { cwd: root, stdout: 'ignore', stderr: 'ignore' });
    }
  }
  const cwds: string[] = [];
  const buildCwds: (string | undefined)[] = [];
  const tool = createGoalTool({
    runGoal: async (goal, cfg) => {
      cwds.push(cfg.cwd);
      return emptyResult(goal);
    },
    runRegistry: new RunRegistry(),
    cwd: root,
    buildConfig: (cwd) => {
      buildCwds.push(cwd);
      return { conductorModel: 'c:m', leafModel: 'l:m' };
    },
  });
  return { tool, cwds, buildCwds, root };
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

describe('②b **真 git 仓里隔离档必须重建 leaf runner** ←第一版漏的就是这一步', () => {
  test('隔离建起来 → buildConfig 被**再调一次**且带 worktree 路径', async () => {
    const { tool, cwds, buildCwds, root } = make({ realGitRepo: true });
    const r = await call(tool, { goal: '干点活', branchStrategy: 'branch' });
    await settle();
    const t = textOf(r);
    expect(t).toContain('隔离 worktree'); // 真建起来了, 不是降级
    const wt = join(root, '.omd', 'runs');
    expect(cwds[0]).toContain(wt);
    // ★ 这条是本文件存在的理由: leaf runner 的 cwd 是装配期烤死的, 只有再过一次 buildConfig
    //   才换得掉。少了它, 上面那条 `cwds` 照样绿, 而产物落在主树。
    expect(buildCwds).toHaveLength(2); // ① 起跑自检(无参) ② 隔离重建(带路径)
    expect(buildCwds[0]).toBeUndefined();
    expect(buildCwds[1]).toContain(wt);
    // 清理: worktree + 分支都在临时目录里, 整棵删掉即可。
    rmSync(root, { recursive: true, force: true });
  });

  test('head 档 → buildConfig **只调一次**(零回归: 不白建一份 runner)', async () => {
    const { tool, buildCwds, root } = make({ realGitRepo: true });
    await call(tool, { goal: '干点活' });
    await settle();
    expect(buildCwds).toEqual([undefined]);
    rmSync(root, { recursive: true, force: true });
  });

  test('降级(建不起来)→ 也**只调一次** —— 不许拿一个没建成的路径去重建 runner', async () => {
    const { tool, buildCwds } = make({ fakeGitRepo: true });
    await call(tool, { goal: '干点活', branchStrategy: 'branch' });
    await settle();
    expect(buildCwds).toEqual([undefined]);
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
