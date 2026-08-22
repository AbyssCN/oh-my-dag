/**
 * **跑坏了回得去吗**(D1,2026-08-06)。
 *
 * ## 它填的是哪个洞
 *
 * D-AB 把自主度按可逆性分级,「范围内写」那一级可以放手的理由是**git 就是 rollback**。
 * R2 给的解法(独立 worktree + 分支)**默认关着、只挂在 `dag_goal` 一个入口上**,而
 * 2026-08-06 实测 `git branch --list 'omd/run/*'` **0 条 —— 从来没被用过一次**
 * (S-3「机制写好了但默认关着 / 只挂在一条路上」那一族,这次有读数)。
 *
 * 于是绝大多数跑直接写当前工作树。而在那一档上「git 就是 rollback」**不是恒假的,是有条件的**:
 * 条件就是**起跑时那棵树干不干净**。这一位此前没有任何一处记。
 *
 * ## 这套网的重心在**五态不许压平**
 *
 * 五态的下一步互不相同,而压平最容易发生在两个地方:
 *   ① 顺手把 `unknown`(查不了)当 `clean` —— 那会让 owner 以为有退路;
 *   ② 把 `dirty-untracked` 并进 `clean` —— 一个**跑之前就存在**的未跟踪文件会被
 *      `git clean -fd` 一起删掉,那种"回滚"是破坏不是还原。
 */
import { describe, expect, test } from 'bun:test';
import { captureRollbackAnchor, classifyRollbackAnchor, describeRollback } from '../../src/harness/writeset/rollback-anchor';

const cls = (statusOutput: string) => classifyRollbackAnchor({ head: 'abc1234', statusOutput });

describe('回滚锚 · 判据本身 (纯函数)', () => {
  test('★ 全干净 → clean, 且判词给得出**可直接敲的命令**', () => {
    const a = cls('');
    expect(a.kind).toBe('clean');
    expect(a.dirtyTracked).toBe(0);
    expect(a.untracked).toBe(0);
    expect(describeRollback(a)).toContain('git checkout -- . && git clean -fd');
  });

  test('★ 有已跟踪的未提交改动 → dirty-tracked = **没有回滚对象**', () => {
    const a = cls(' M src/a.ts\nM  src/b.ts\n');
    expect(a.kind).toBe('dirty-tracked');
    expect(a.dirtyTracked).toBe(2);
    // 判词必须说清为什么"没有": 两拨写混在同一片 diff 里, git 分不开
    expect(describeRollback(a)).toContain('分不开');
    expect(describeRollback(a)).toContain('branchStrategy');
  });

  test('★ 只有未跟踪文件 → dirty-untracked, **不许并进 clean**', () => {
    // 少了这条: 一个跑之前就存在的未跟踪文件(本仓那个 f2-checklist.ts 就是)会被
    // `git clean -fd` 一起删掉 —— 那种"回滚"是破坏不是还原。
    const a = cls('?? f2-checklist.ts\n');
    expect(a.kind).toBe('dirty-untracked');
    expect(a.untracked).toBe(1);
    expect(a.dirtyTracked).toBe(0);
    expect(describeRollback(a)).toContain('别直接 `git clean -fd`');
  });

  test('★ 两种脏同时有 → 已跟踪那一格**赢** (它更糟: 让 diff 混在一起)', () => {
    const a = cls(' M src/a.ts\n?? note.md\n');
    expect(a.kind).toBe('dirty-tracked');
    expect(a.dirtyTracked).toBe(1);
    expect(a.untracked).toBe(1); // 两个数都留着, 只是 kind 取更糟的那个
  });

  test('被 git 忽略的文件 (`!!`) 不算脏 —— 它本来就不进 git', () => {
    const a = cls('!! node_modules/\n');
    expect(a.kind).toBe('clean');
  });

  test('★ 五态的判词各不相同, 且每一态都说得出「跑坏了敲什么」', () => {
    // 这条钉的是 S-20 那条教训: 一个状态取某值时, 读的人要能反推出**唯一一个**下一步。
    const msgs = [
      describeRollback({ kind: 'clean', head: 'a' }),
      describeRollback({ kind: 'dirty-tracked', head: 'a', dirtyTracked: 1 }),
      describeRollback({ kind: 'dirty-untracked', head: 'a', untracked: 1 }),
      describeRollback({ kind: 'not-a-repo', why: '没有 .git' }),
      describeRollback({ kind: 'unknown', why: 'git 起不来' }),
    ];
    expect(new Set(msgs).size).toBe(5); // 五条判词互不相同
    expect(msgs[4]).toContain('不知道'); // unknown 明说是"不知道", 不是"没有"
    expect(msgs[4]).toContain('别据它下判断');
  });
});

describe('回滚锚 · 采集 (fail-open, 且**不吞证据**)', () => {
  test('★ git 起不来 → unknown, **不是 clean** (这是这段代码唯一致命的写法)', () => {
    const a = captureRollbackAnchor(
      { cwd: '/nowhere' },
      { git: () => { throw new Error('spawn git ENOENT'); } },
    );
    expect(a.kind).toBe('unknown');
    expect(a.kind).not.toBe('clean');
    expect(a.why).toContain('ENOENT'); // 原文留着 —— fail-open 可以吞异常, 不许吞证据
  });

  test('★ 不在 git 仓里 → not-a-repo, 与 unknown **分得开** (下一步不同)', () => {
    const a = captureRollbackAnchor(
      { cwd: '/tmp' },
      { git: () => { throw new Error('fatal: not a git repository (or any of the parent directories)'); } },
    );
    expect(a.kind).toBe('not-a-repo');
  });

  test('★ HEAD 取到了但 status 挂了 → unknown 且**保留 head**, 仍然不算干净', () => {
    let n = 0;
    const a = captureRollbackAnchor(
      { cwd: '/x' },
      { git: () => { if (n++ === 0) return 'deadbee\n'; throw new Error('index.lock 存在'); } },
    );
    expect(a.kind).toBe('unknown');
    expect(a.head).toBe('deadbee');
    expect(a.why).toContain('index.lock');
  });

  test('干净仓 → clean, head 取短 sha', () => {
    let n = 0;
    const a = captureRollbackAnchor({ cwd: '/x' }, { git: () => (n++ === 0 ? 'abc1234\n' : '') });
    expect(a).toMatchObject({ kind: 'clean', head: 'abc1234', dirtyTracked: 0, untracked: 0 });
  });
});
