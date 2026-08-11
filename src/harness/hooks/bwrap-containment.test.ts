/**
 * **jail 容器性探针** (2026-07-31, R2 第二层)。
 *
 * ## 为什么这条不该用 live 去问
 *
 * 2026-07-31 live 第三跑抓到: 隔离档下一个 agent 的产物落在**沙箱主树**
 * (`/…/omd-smoke-goal-Kp197I/docs/from-faq.md`), 即隔离树之外。根因是 `sandboxRoot` 那层
 * (bwrap: 整个 leaf 进程只见这棵树) **生产从来没接** —— 机制早就有、eval oracle 一直在用。
 *
 * 接上之后"绝对路径还逃不逃得出去"是个**容器问题, 不是模型问题**: 拦得住拦不住由 bwrap 的
 * bind 决定, 与 agent 写了什么无关。所以它值一个确定性探针, 不值一次 live。
 * (这正是本轮反复在做的分工: 便宜的问题用便宜的办法问掉, live 只留给 live 才答得了的。)
 *
 * ## 判据
 *
 * 在与 `createSandboxedLeafRunner` **逐字相同**的 bwrap 参数下:
 *   ① jail 内写**树内**相对/绝对路径 → 成功 (否则隔离把正事也挡了)
 *   ② jail 内写**树外**绝对路径 → 失败 (那正是 live 逃逸的那条路)
 *
 * ⚠ 本机无 bwrap → 跳过并**响亮说明**, 不静默绿。"没测" 与 "测过且通过" 必须分得开 ——
 * 这是本轮第五次为同一条纪律付账。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, existsSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { bwrapArgs, defaultRoBinds, resolveGitBinds, type GitBinds } from './bwrap';

const HAS_BWRAP = Boolean(Bun.which('bwrap'));

/** 在 jail 里跑一条 sh 命令, 返退出码。cwd 由 bwrap `--chdir` 定在 root。 */
function inJail(root: string, shell: string): number {
  const argv = ['bwrap', ...bwrapArgs(root, defaultRoBinds(root)), 'sh', '-c', shell];
  const r = Bun.spawnSync(argv, { stdout: 'pipe', stderr: 'pipe' });
  return r.exitCode;
}

describe('bwrap 容器性 — 隔离档的"绝对路径也逃不出去"到底成不成立', () => {
  if (!HAS_BWRAP) {
    test('⚠ 本机没有 bwrap → 本组**未测**(不是通过)', () => {
      // 刻意让这条留在输出里: 静默跳过会让 CI 上一片绿被读成"隔离验过了"。
      expect(HAS_BWRAP).toBe(false);
    });
    return;
  }

  test('① 树内写得进去 (隔离不能把正事也挡了)', () => {
    const root = mkdtempSync(join(tmpdir(), 'omd-jail-in-'));
    expect(inJail(root, 'echo hi > inside.txt')).toBe(0);
    expect(existsSync(join(root, 'inside.txt'))).toBe(true);
    // 树内的**绝对**路径同样该通 —— 拦的是"树外", 不是"绝对"。
    expect(inJail(root, `echo hi > ${root}/inside-abs.txt`)).toBe(0);
    expect(existsSync(join(root, 'inside-abs.txt'))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  test('② **树外绝对路径写不进去** ←live 逃逸的正是这条', () => {
    const root = mkdtempSync(join(tmpdir(), 'omd-jail-out-'));
    const outside = mkdtempSync(join(tmpdir(), 'omd-jail-victim-'));
    const victim = join(outside, 'stolen.txt');

    const code = inJail(root, `echo pwned > ${victim}`);
    expect(code).not.toBe(0); // 写失败
    // 更要紧的是**受害文件真的没被创建** —— 退出码非 0 也可能是别的原因, 落点才是硬证据。
    expect(existsSync(victim)).toBe(false);

    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  test('③ 树外**已存在**的文件也改不动 (live 那次是往已存在的沙箱主树里写)', () => {
    const root = mkdtempSync(join(tmpdir(), 'omd-jail-out2-'));
    const outside = mkdtempSync(join(tmpdir(), 'omd-jail-victim2-'));
    const victim = join(outside, 'existing.txt');
    Bun.write(victim, 'original\n');

    inJail(root, `echo overwritten > ${victim}`);
    expect(Bun.spawnSync(['cat', victim], { stdout: 'pipe' }).stdout.toString()).toBe('original\n');

    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
});

/**
 * **git 元数据探针** (2026-08-11, run 7d50fda2 修)。
 *
 * 症状: branch 隔离档的 jail 里 git 全灭 —— worktree 的 `.git` 是指向主 repo 的指针文件,
 * 那个路径不在 jail 视图里 (`fatal: not a git repository: …/.git/worktrees/…`)。叶子反复
 * 试探 git 后放弃, 12 轮空转的真实摩擦面就是它。
 *
 * 这条同样是**容器问题不是模型问题**: 挂没挂上由 bind 决定。判据三条 ——
 *   ① 不给 gitBinds → jail 里仍无 git (eval 档要的正是这个, 别顺手给它改了)
 *   ② 给 gitBinds → 读侧 (log/show/status) 真跑得起来
 *   ③ 共享 .git 仍**写不进** (ro): 隔离让开的是"读历史", 不是"改主 repo"
 * 反向自检 (实跑过): 把 bwrapArgs 里 `opts.gitBinds` 那段删掉 → ② 当场红, ①③ 仍绿。
 */
describe('bwrap git 元数据 — 隔离档里 git 到底能不能用 (run 7d50fda2)', () => {
  if (!HAS_BWRAP) {
    test('⚠ 本机没有 bwrap → 本组**未测**(不是通过)', () => {
      expect(HAS_BWRAP).toBe(false);
    });
    return;
  }

  const git = (cwd: string, ...args: string[]): number =>
    Bun.spawnSync(['git', '-C', cwd, ...args], { stdout: 'pipe', stderr: 'pipe' }).exitCode;

  /** 造「主 repo + 一棵 worktree」—— 生产隔离档的真实形状 (run root = worktree)。 */
  const fixture = (): { repo: string; tree: string } => {
    const repo = mkdtempSync(join(tmpdir(), 'omd-jail-repo-'));
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.email', 'probe@omd');
    git(repo, 'config', 'user.name', 'probe');
    Bun.spawnSync(['sh', '-c', `echo hi > ${join(repo, 'a.txt')}`]);
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'seed');
    const tree = join(repo, '..', `${basename(repo)}-wt`);
    git(repo, 'worktree', 'add', '-q', '--detach', tree);
    return { repo, tree: realpathSync(tree) };
  };

  const inJailWithGit = (root: string, gitBinds: GitBinds | null, shell: string): number =>
    Bun.spawnSync(
      ['bwrap', ...bwrapArgs(root, defaultRoBinds(root), gitBinds ? { gitBinds } : {}), 'sh', '-c', shell],
      { stdout: 'pipe', stderr: 'pipe' },
    ).exitCode;

  test('resolveGitBinds: worktree → 指出树外的 gitDir + commonDir; 普通 repo → null (树内, 已被 --bind 覆盖)', () => {
    const { repo, tree } = fixture();
    const b = resolveGitBinds(tree)!;
    expect(b.commonDir).toBe(join(realpathSync(repo), '.git'));
    expect(b.gitDir.startsWith(join(realpathSync(repo), '.git', 'worktrees'))).toBe(true);
    expect(resolveGitBinds(repo)).toBeNull();
    expect(resolveGitBinds(mkdtempSync(join(tmpdir(), 'omd-not-a-repo-')))).toBeNull(); // 不是 git 树
    rmSync(repo, { recursive: true, force: true });
    rmSync(tree, { recursive: true, force: true });
  });

  test('① 不给 gitBinds → jail 里 git 仍然全灭 (eval 档的行为一个字没动)', () => {
    const { repo, tree } = fixture();
    expect(inJailWithGit(tree, null, 'git status --porcelain')).not.toBe(0);
    rmSync(repo, { recursive: true, force: true });
    rmSync(tree, { recursive: true, force: true });
  });

  test('② 给 gitBinds → status / log / show 都跑得起来', () => {
    const { repo, tree } = fixture();
    const b = resolveGitBinds(tree);
    for (const cmd of ['git status --porcelain', 'git log --oneline -1', 'git show --stat HEAD']) {
      expect(inJailWithGit(tree, b, cmd)).toBe(0);
    }
    rmSync(repo, { recursive: true, force: true });
    rmSync(tree, { recursive: true, force: true });
  });

  test('③ 共享 .git 是只读: jail 里写不了 ref / objects, 主 repo 上不留痕', () => {
    const { repo, tree } = fixture();
    const b = resolveGitBinds(tree)!;
    expect(inJailWithGit(tree, b, `touch ${b.commonDir}/JAIL-WROTE-THIS`)).not.toBe(0);
    expect(inJailWithGit(tree, b, 'git -c user.email=a@b -c user.name=a tag jail-should-fail')).not.toBe(0);
    expect(existsSync(join(b.commonDir, 'JAIL-WROTE-THIS'))).toBe(false);
    expect(existsSync(join(b.commonDir, 'refs', 'tags', 'jail-should-fail'))).toBe(false);
    rmSync(repo, { recursive: true, force: true });
    rmSync(tree, { recursive: true, force: true });
  });
});
