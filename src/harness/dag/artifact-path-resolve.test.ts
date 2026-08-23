/**
 * `resolveArtifactPath` 单测 (SDD 2026-08-22 · S50 根治切片 1 · C-1/GWT/反向自检)。
 *
 * ⚠ **样本用运行时生成的临时目录**, 不要写死仓内路径 ——
 * 2026-08-22 名词闸那次的教训: 写死在仓里的样本会因为"在仓里"而改变语义
 * (例如 `${root}/${p}` 在 `/home/nick/repos/oh-my-dag` 下可能真存在)。
 *
 * 反向自检 (S-49 · 承重那一位) —— 把这条注释当作闸, 不要删:
 *   1. 把 INV-3 剥前缀拼 root 那段挪走 ⇒ GWT1 必红。
 *   2. INV-5 短路 ⇒ GWT2 (两边都 miss) 必红, 锚回把不存在也放行 = 闸判废。
 *   3. 既有的 `artifact-gate-anchor.test.ts` 一条不改也一条不红 (D-2 纯重构的证据)。
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveArtifactPath } from './engine';

/** 在临时根下建一棵 worktree 形状的树, 把指定相对路径全部写成非空文件。 */
function mkWorktreeWith(relPaths: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'omd-s50-'));
  for (const rel of relPaths) {
    const abs = join(root, rel);
    mkdirSync(abs.slice(0, abs.lastIndexOf('/')), { recursive: true });
    writeFileSync(abs, '/* s50 fixture */\n');
  }
  return root;
}

/** 清理临时树 (best-effort)。 */
function rmWorktree(root: string): void {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

describe('resolveArtifactPath —— 产物路径解析单源 (S50 切片 1)', () => {
  // ─────────── GWT1 · 锚回命中 · 承重 ───────────
  test('GWT1 · worktree 命中: 主干绝对前缀的路径, 文件只在 worktree ⇒ 返回 worktree 那条', () => {
    // 反向自检 (S-49 · 承重): 把 INV-3 剥前缀拼 root 那段挪走 ⇒ 本用例必红 (因为没有 anchor,
    //   原样 stat 主干绝对路径, 主干里没有这个文件 ⇒ 返回原样, worktree 那条就丢了)。
    //   若 GWT1 绿 ⇒ anchor 路径生效, INV-3 守门; 红 ⇒ anchor 没接上, 重写 helper。
    const wt = mkWorktreeWith(['src/x/foo.ts']);
    try {
      const mainRoot = '/repo/never/main-A';
      const p = `${mainRoot}/src/x/foo.ts`;
      const got = resolveArtifactPath(p, { root: wt, repoRoot: mainRoot });
      expect(got).toBe(`${wt}/src/x/foo.ts`);
    } finally {
      rmWorktree(wt);
    }
  });

  // ─────────── GWT2 · 两基准都 miss · INV-5 钉闸 ───────────
  test('GWT2 · 两基准都不存在 ⇒ 返回原样 (INV-5: 不冒充存在)', () => {
    // 反向自检: 若 helper 把 INV-5 短路成"也返回 anchored"⇒ 这条必红 (闸判废: 不存在冒充存在)。
    //   这条**修前修后都必须红** — 红是事实, 不是 bug; 绿就意味着闸坏了。
    const wt = mkWorktreeWith([]);
    try {
      const mainRoot = '/repo/never/main-B';
      const p = `${mainRoot}/src/y/ghost.ts`;
      const got = resolveArtifactPath(p, { root: wt, repoRoot: mainRoot });
      expect(got).toBe(p);
    } finally {
      rmWorktree(wt);
    }
  });

  // ─────────── GWT3 · INV-4 短路 ───────────
  test('GWT3 · root === repoRoot (非 branch) ⇒ 不锚回, 原样返回', () => {
    // 反向自检: 即便 root !== repoRoot 时会触发 INV-3, root === repoRoot 时**必须**短路,
    //   否则剥了再拼 = 恒等, 每个绝对路径白 stat 一次; `p.startsWith('')` 还恒真, 会把每条
    //   绝对路径都当锚回对象 (N7 副作用)。
    const wt = mkWorktreeWith(['src/z/file.ts']);
    try {
      const p = `${wt}/src/z/file.ts`;
      const got = resolveArtifactPath(p, { root: wt, repoRoot: wt });
      expect(got).toBe(p);
    } finally {
      rmWorktree(wt);
    }
  });

  // ─────────── GWT4 · 相对路径 (INV-1 钉闸) ───────────
  test('GWT4 · 相对路径 ⇒ `${root}/${p}` (INV-1)', () => {
    // 反向自检: 改成 `${p}` (不拼 root) ⇒ 本用例必红 (worktree 自己被拼成怪路径)。
    const wt = mkWorktreeWith(['src/rel/exists.ts']);
    try {
      const got = resolveArtifactPath('src/rel/exists.ts', {
        root: wt,
        repoRoot: '/never/main-D',
      });
      expect(got).toBe(`${wt}/src/rel/exists.ts`);
    } finally {
      rmWorktree(wt);
    }
  });

  // ─────────── INV-3 触发条件 (startsWith 是必要条件) ───────────
  test('INV-3 · 不以主干根开头的绝对路径 ⇒ 不剥前缀, INV-5 返回原样', () => {
    // 钉闸: `p.startsWith(repoRoot + '/')` 是 INV-3 的必要条件 —— 不能用 `p.startsWith('/')`
    //   当锚回触发 (否则每条绝对路径都白 stat 一次)。这里给一个跟 mainRoot 完全无关的绝对路径。
    const wt = mkWorktreeWith([]);
    try {
      const mainRoot = '/repo/main';
      const got = resolveArtifactPath('/elsewhere/foo.ts', { root: wt, repoRoot: mainRoot });
      expect(got).toBe('/elsewhere/foo.ts');
    } finally {
      rmWorktree(wt);
    }
  });

  // ─────────── INV-2 · 原样命中不白 stat anchor ───────────
  test('INV-2 · 绝对路径原样存在 ⇒ 直接返回, 不 stat anchor (onProbe 仅记 1 条)', () => {
    // 反向自检: 把 anchor 那段挪到 INV-2 之前 ⇒ onProbe 会记 2 条, 本用例必红 (length !== 1)。
    const wt = mkWorktreeWith([]);
    try {
      const mainRoot = '/repo/main-F';
      const p = `${wt}/on/wt.ts`;
      // 临时新建这个文件 ⇒ 原样命中 (INV-2)。
      mkdirSync(join(wt, 'on'), { recursive: true });
      writeFileSync(p, '/* on-wt */\n');
      const probed: string[] = [];
      const got = resolveArtifactPath(p, {
        root: wt,
        repoRoot: mainRoot,
        onProbe: (c) => probed.push(c),
      });
      expect(got).toBe(p);
      expect(probed).toEqual([p]);
    } finally {
      rmWorktree(wt);
    }
  });

  // ─────────── INV-4 · repoRoot 为空双保险 ───────────
  test('INV-4 · repoRoot === "" ⇒ 不锚回 (`p.startsWith("")` 恒真的副作用被挡住)', () => {
    // 反向自检: 把 `repoRoot.length > 0` 这条挪走 ⇒ 这条必红 (helper 会尝试 anchored 拼接)。
    const wt = mkWorktreeWith([]);
    try {
      const got = resolveArtifactPath('/some/abs/path.ts', {
        root: wt,
        repoRoot: '',
      });
      expect(got).toBe('/some/abs/path.ts');
    } finally {
      rmWorktree(wt);
    }
  });

  // ─────────── onProbe · anchor 命中时记 2 条 ───────────
  test('onProbe · anchor 命中 ⇒ 记 [原样, 锚回] 两条候选', () => {
    // 反向自检: 把 onProbe 在 anchored 那条挪走 ⇒ probed.length !== 2, 必红。
    const wt = mkWorktreeWith(['src/probe/anchor.ts']);
    try {
      const mainRoot = '/repo/main-G';
      const p = `${mainRoot}/src/probe/anchor.ts`;
      const probed: string[] = [];
      const got = resolveArtifactPath(p, {
        root: wt,
        repoRoot: mainRoot,
        onProbe: (c) => probed.push(c),
      });
      expect(got).toBe(`${wt}/src/probe/anchor.ts`);
      expect(probed).toEqual([p, `${wt}/src/probe/anchor.ts`]);
    } finally {
      rmWorktree(wt);
    }
  });

  // ─────────── 集成 · detector population 形态 (`:825`) ───────────
  test('集成 (INV-6): 主干绝对前缀的产物 ⇒ worktree 真文件, helper 解析正确', () => {
    // S50 收的"静默 null"那一格 —— 修前 `:825` 的 `hashArtifact(p.startsWith('/') ? p : join(root, p))`
    //   在主根前缀下走 `${root}/${abs}` 是损坏路径, hashArtifact 恒 null。
    //   修后走 helper ⇒ worktree 真文件被解析, hashArtifact 拿得到内容。
    const wt = mkWorktreeWith(['src/harness/foo.ts']);
    try {
      const mainRoot = '/repo/never/main-H';
      const p = `${mainRoot}/src/harness/foo.ts`;
      const abs = resolveArtifactPath(p, { root: wt, repoRoot: mainRoot });
      expect(abs).toBe(`${wt}/src/harness/foo.ts`);
      // (真实 hash 校验交给 hashArtifact 自身, 这里只验路径解析这一跳。)
    } finally {
      rmWorktree(wt);
    }
  });

  // ─────────── 集成 · checkpoint artifactHashes 形态 (`:1121`) ───────────
  test('集成 (INV-7): checkpoint 的 `rel()` 键与 stat 路径同源 (来自 helper 的 `abs`)', () => {
    // S50 收的"两套规则不一致"那一格 —— 修前 `rel(p)` 对非 `${root}/` 前缀的绝对路径
    //   保留原样, `${root}/${rp}` 是损坏路径。
    //   修后 `abs = resolveArtifactPath(p)`, `rp = rel(abs)` —— key 与 stat 同源。
    //
    // 场景: p 是 worktree 自己的绝对路径, root === wt ⇒ INV-4 短路, abs = p 原样, rp 剥前缀。
    const wt = mkWorktreeWith(['src/ckpt/x.ts']);
    try {
      const p = `${wt}/src/ckpt/x.ts`;
      const abs = resolveArtifactPath(p, { root: wt, repoRoot: wt });
      const rel = (s: string): string => (s.startsWith(`${wt}/`) ? s.slice(wt.length + 1) : s);
      const rp = rel(abs);
      expect(abs).toBe(p);
      expect(rp).toBe('src/ckpt/x.ts');
    } finally {
      rmWorktree(wt);
    }
  });

  // ─────────── 集成 · 主干绝对前缀解析到 worktree 后, `rel()` 也能剥回相对 ───────────
  test('集成 (INV-7 续): 主干绝对前缀 ⇒ helper 解析到 worktree ⇒ rel() 剥回相对', () => {
    // 往返: p 是主干前缀, 文件只在 worktree, helper 返回 worktree 绝对路径, rel() 应当把它
    //   剥成相对 key —— 这样 checkpoint 复用的 key 在 worktree 内外都是同一个串。
    const wt = mkWorktreeWith(['src/round-trip/y.ts']);
    try {
      const mainRoot = '/repo/main-I';
      const p = `${mainRoot}/src/round-trip/y.ts`;
      const abs = resolveArtifactPath(p, { root: wt, repoRoot: mainRoot });
      const rel = (s: string): string => (s.startsWith(`${wt}/`) ? s.slice(wt.length + 1) : s);
      const rp = rel(abs);
      expect(abs).toBe(`${wt}/src/round-trip/y.ts`);
      expect(rp).toBe('src/round-trip/y.ts');
    } finally {
      rmWorktree(wt);
    }
  });
});