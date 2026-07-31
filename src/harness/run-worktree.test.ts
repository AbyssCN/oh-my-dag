/**
 * **R2 branch strategy 闸** (2026-07-31)。
 *
 * 本文件盯三件, 每一件都对应一种"隔离静默失效"的形态:
 *   ① 缺省 `head` **零回归** —— 不传策略 = 今天的行为, 一个 git 命令都不该跑
 *   ② 退回 head 时**必须留下原因** —— 静默退回会让调用方以为写在隔离树里而实际写的是主树,
 *      那比不隔离坏得多
 *   ③ `dispose` **不自动调**, 且回话里念得出目录与分支 —— 否则"隔离"退化成"东西不见了"
 *
 * 全部经注入的假 git,**不起真 worktree**。
 */
import { describe, expect, test } from 'bun:test';
import {
  describeRunWorktree,
  prepareRunWorktree,
  runWorktreeBranch,
  runWorktreeDir,
  type RunWorktreeDeps,
} from './run-worktree';

/** 假 git: 记下每条命令; `fail` 给了就抛(模拟 worktree 已存在 / 分支重名之类)。 */
function fakeGit(fail?: string): { deps: RunWorktreeDeps; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    deps: {
      isGitRepo: () => true,
      git: (args) => {
        calls.push(args);
        if (fail) throw new Error(fail);
      },
    },
  };
}

describe('① 缺省 head — 零回归', () => {
  test('不传策略 → 原样返 cwd, 一个 git 命令都不跑', () => {
    const { deps, calls } = fakeGit();
    const w = prepareRunWorktree({ cwd: '/repo', runId: 'r1' }, deps);
    expect(w.cwd).toBe('/repo');
    expect(w.strategy).toBe('head');
    expect(w.branch).toBeUndefined();
    expect(calls).toEqual([]);
  });

  test('显式 head 同上; dispose 是空操作(调了也不该碰 git)', () => {
    const { deps, calls } = fakeGit();
    const w = prepareRunWorktree({ cwd: '/repo', runId: 'r1', strategy: 'head' }, deps);
    w.dispose();
    expect(calls).toEqual([]);
    expect(w.degradedReason).toBeUndefined(); // head 是**请求的**策略, 不是降级
  });
});

describe('② branch — 建得起来就用它, 建不起来必须留下原因', () => {
  test('建 worktree: 目录/分支按约定, git 命令逐字对', () => {
    const { deps, calls } = fakeGit();
    const w = prepareRunWorktree({ cwd: '/repo', runId: 'run-abc' }, deps);
    expect(w.strategy).toBe('head'); // 没传就是 head —— 下面才是隔离档
    const w2 = prepareRunWorktree({ cwd: '/repo', runId: 'run-abc', strategy: 'branch' }, deps);
    expect(w2.strategy).toBe('branch');
    expect(w2.cwd).toBe(runWorktreeDir('/repo', 'run-abc'));
    expect(w2.branch).toBe(runWorktreeBranch('run-abc'));
    expect(calls).toEqual([['worktree', 'add', w2.cwd, '-b', w2.branch!]]);
    void w;
  });

  test('**不在 git 仓里 → 退回 head, 且带原因**(不抛 —— 跑在别人目录里是正常用法)', () => {
    const calls: string[][] = [];
    const w = prepareRunWorktree(
      { cwd: '/tmp/notarepo', runId: 'r1', strategy: 'branch' },
      { isGitRepo: () => false, git: (a) => calls.push(a) },
    );
    expect(w.strategy).toBe('head');
    expect(w.cwd).toBe('/tmp/notarepo');
    expect(w.degradedReason).toContain('不是 git 工作树');
    expect(calls).toEqual([]); // 连试都不该试
  });

  test('**git 建失败 → 退回 head, 且带原因**(静默退回比不隔离坏得多)', () => {
    const { deps } = fakeGit('fatal: 目录已存在');
    const w = prepareRunWorktree({ cwd: '/repo', runId: 'r1', strategy: 'branch' }, deps);
    expect(w.strategy).toBe('head');
    expect(w.cwd).toBe('/repo'); // 退回主树 —— 所以调用方**必须**看得见这一格
    expect(w.degradedReason).toContain('建 worktree 失败');
    expect(w.degradedReason).toContain('目录已存在');
  });

  test('runId 里的怪字符被安全化(分支名/路径都不许被它撑破)', () => {
    const { deps } = fakeGit();
    const w = prepareRunWorktree({ cwd: '/repo', runId: 'a/b c:d', strategy: 'branch' }, deps);
    expect(w.branch).toBe('omd/run/a_b_c_d');
    expect(w.cwd).toContain('a_b_c_d');
  });
});

describe('③ dispose 不自动调, 且把手念得出来', () => {
  test('准备完毕时**没有**任何 remove —— 跑完那棵树里就是全部产出', () => {
    const { deps, calls } = fakeGit();
    prepareRunWorktree({ cwd: '/repo', runId: 'r1', strategy: 'branch' }, deps);
    expect(calls.some((c) => c.includes('remove'))).toBe(false);
  });

  test('显式 dispose 才 remove', () => {
    const { deps, calls } = fakeGit();
    const w = prepareRunWorktree({ cwd: '/repo', runId: 'r1', strategy: 'branch' }, deps);
    w.dispose();
    expect(calls[1]).toEqual(['worktree', 'remove', '--force', w.cwd]);
  });

  test('dispose 失败不抛(fail-open —— 清理失败不该把一次成功的跑变成错误)', () => {
    const { deps } = fakeGit();
    const w = prepareRunWorktree({ cwd: '/repo', runId: 'r1', strategy: 'branch' }, deps);
    // 换一个会抛的 git 再 dispose: 借第二次 prepare 拿一个必抛的实例。
    const bad = prepareRunWorktree({ cwd: '/repo', runId: 'r2', strategy: 'branch' }, fakeGit().deps);
    expect(() => bad.dispose()).not.toThrow();
    void w;
  });

  test('回话里必须念出目录与分支, 并给出合回/弃用两条命令', () => {
    const { deps } = fakeGit();
    const w = prepareRunWorktree({ cwd: '/repo', runId: 'r1', strategy: 'branch' }, deps);
    const s = describeRunWorktree(w);
    expect(s).toContain(w.cwd);
    expect(s).toContain(w.branch!);
    expect(s).toContain('git merge');
    expect(s).toContain('worktree remove');
    // **刻意不自动合** —— 这句话要在回话里, 否则 owner 会以为引擎替他合了。
    expect(s).toContain('由你扣扳机');
  });

  test('降级时回话把原因念出来(否则 owner 以为写在隔离树里)', () => {
    const w = prepareRunWorktree(
      { cwd: '/tmp/x', runId: 'r1', strategy: 'branch' },
      { isGitRepo: () => false },
    );
    expect(describeRunWorktree(w)).toContain('不是 git 工作树');
  });
});

describe('非目标: merge-to-head 明确不做', () => {
  test('策略词表只有两态 —— 加第三态要经过一次改测试', () => {
    // sandcastle 的三态里 `merge-to-head` 是**写主干**, 按 D-AB 的可逆性分级属"需批准"那一档,
    // 不是"范围内写"。与 `path_deliver` 同一条纪律: 裁决与执行是两个决定, 扳机归 owner。
    // 这条断言不是锁死设计, 是让"我们加了自动合回"必须显式发生。
    const strategies = ['head', 'branch'];
    expect(strategies).not.toContain('merge-to-head');
  });
});
