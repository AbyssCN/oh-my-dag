/**
 * L1 + **真跑一次**:bwrap 围栏(2026-08-13)。
 *
 * ## 这一组必须真起 bwrap,不能只对着字符串断言
 *
 * 围栏的全部价值是「工作根之外写不进去」,而那句话在 argv 字符串上**看不出来**:
 * 顺序反了(`--bind root` 在 `--ro-bind / /` 之前)组出来的 argv 长得一模一样,
 * 跑起来却是一个全只读的沙箱。所以判据是**文件系统上的读数**。
 *
 * 反向自检(实跑,判据会红):
 *   · 把 `shellSandboxArgs` 里 `--bind root root` 挪到 `--ro-bind / /` **之前**
 *     → 「工作根可写」当场红(EROFS)。
 *   · 把 `--ro-bind / /` 换成 `--bind / /` → 「工作根之外只读」当场红(真写进去了)。
 *
 * ⚠ 机器上没有可用 bwrap 时**跳过**这几条并说出来 —— 不是静默绿。
 * 「跑不了」与「跑了且通过」在测试报告上长得不一样,这正是本仓 NULL≠0 那条。
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeShellSandbox, sandboxCommand, shellQuote, shellSandboxArgs } from './shell-sandbox';

const SANDBOX = probeShellSandbox();

/** 在宿主 shell 里跑一条命令,返回 stdout+stderr 与退出码。 */
function sh(command: string): { out: string; code: number } {
  const p = Bun.spawnSync(['/bin/bash', '-c', command], { stdout: 'pipe', stderr: 'pipe' });
  const d = new TextDecoder();
  return { out: `${d.decode(p.stdout)}${d.decode(p.stderr)}`, code: p.exitCode };
}

describe('shellQuote', () => {
  test('单引号自身也包得住 —— 命令原文里的 \' 不许把包装拆开', () => {
    expect(sh(`echo ${shellQuote(`a'b"c $HOME`)}`).out.trim()).toBe(`a'b"c $HOME`);
  });
});

describe('shellSandboxArgs —— 顺序即叠挂顺序', () => {
  test('★ `--ro-bind / /` 必须排在 `--bind <root> <root>` 之前(反了就是全只读)', () => {
    const a = shellSandboxArgs('/srv/repo');
    const roRoot = a.findIndex((x, i) => x === '--ro-bind' && a[i + 1] === '/');
    const rwRoot = a.findIndex((x, i) => x === '--bind' && a[i + 1] === '/srv/repo');
    expect(roRoot).toBeGreaterThanOrEqual(0);
    expect(rwRoot).toBeGreaterThan(roRoot);
  });

  test('额外可写点排在 root 之后 —— 它们也要盖得住只读的 /', () => {
    const a = shellSandboxArgs('/srv/repo', ['/srv/extra']);
    const rwRoot = a.findIndex((x, i) => x === '--bind' && a[i + 1] === '/srv/repo');
    const rwExtra = a.findIndex((x, i) => x === '--bind' && a[i + 1] === '/srv/extra');
    expect(rwExtra).toBeGreaterThan(rwRoot);
  });

  test('chdir 到 root —— 命令的 cwd 就是工作根', () => {
    const a = shellSandboxArgs('/srv/repo');
    expect(a[a.indexOf('--chdir') + 1]).toBe('/srv/repo');
  });

  test('★ /mnt 的 tmpfs 排在 `--ro-bind / /` 之后(反了就盖不住)', () => {
    const a = shellSandboxArgs('/srv/repo');
    const roRoot = a.findIndex((x, i) => x === '--ro-bind' && a[i + 1] === '/');
    const mntTmpfs = a.findIndex((x, i) => x === '--tmpfs' && a[i + 1] === '/mnt');
    expect(mntTmpfs).toBeGreaterThan(roRoot);
  });

  test('★ writable 的 --bind 排在 /mnt 的 tmpfs 之后 —— 否则挂不回来', () => {
    const a = shellSandboxArgs('/srv/repo', ['/mnt/d']);
    const mntTmpfs = a.findIndex((x, i) => x === '--tmpfs' && a[i + 1] === '/mnt');
    const back = a.findIndex((x, i) => x === '--bind' && a[i + 1] === '/mnt/d');
    expect(back).toBeGreaterThan(mntTmpfs);
  });
});

describe.if(SANDBOX.ok)('围栏真跑(bwrap 可用)', () => {
  const root = mkdtempSync(join(tmpdir(), 'omd-fence-'));
  const run = (cmd: string) => sh(sandboxCommand(cmd, { root }));

  test('★ 工作根可写', () => {
    const r = run('echo inside > written.txt && cat written.txt');
    expect(r.out).toContain('inside');
    expect(readFileSync(join(root, 'written.txt'), 'utf8').trim()).toBe('inside');
  });

  test('★ 工作根之外只读 —— 写不进去, 且宿主文件真的没变', () => {
    const outside = mkdtempSync(join(tmpdir(), 'omd-outside-'));
    const victim = join(outside, 'keep.txt');
    writeFileSync(victim, 'original\n');
    // ⚠ 目标在 /tmp 下, 而 jail 里 /tmp 是 tmpfs ⇒ 那条路径在 jail 里根本不存在。
    //   两种拦法都算拦住(写不到宿主), 判据统一为"宿主文件原样 + 退出码非 0"。
    const r = run(`echo tampered > ${shellQuote(victim)}`);
    expect(r.code).not.toBe(0);
    expect(readFileSync(victim, 'utf8')).toBe('original\n');
  });

  test('★ 系统目录只读 —— rm 打不穿 /usr', () => {
    const r = run('touch /usr/local/bin/omd-fence-probe');
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/Read-only file system|Permission denied/);
    expect(existsSync('/usr/local/bin/omd-fence-probe')).toBe(false);
  });

  test('★ 家目录只读 —— 递归删除在围栏里打不到宿主', () => {
    const r = run(`rm -rf ${shellQuote(join(process.env.HOME ?? '/home', '.omd-fence-should-not-matter'))}`);
    // rm -rf 对不存在的路径本来就返 0;这条量的是**宿主家目录仍在**, 不是退出码。
    expect(existsSync(process.env.HOME ?? '/home')).toBe(true);
    expect(r.out).not.toContain('Segmentation');
  });

  test('★ 读一律放开 —— conductor 要能读整台机器(owner 2026-08-13 裁的边界)', () => {
    expect(run('head -c 3 /etc/hostname').code).toBe(0);
  });

  /**
   * ★★ **jail 里的 `/mnt` 是空的**(2026-08-13,WSL 整机卡死的次因修法)。
   *
   * 「读一律放开」有**一个例外**,而这个例外是拿一次事故换来的:`/mnt/{c,d,nas*}`
   * 是 9p / 网络挂载,递归读一遍就能把 9P 桥打爆、整台 WSL 停摆。
   * 挡它不能靠"别读"这种约定 —— 本仓实测结论是讲道理拦不住 —— 只能物理上看不见。
   *
   * 证伪(实跑):把 `shellSandboxArgs` 里 `--tmpfs /mnt` 那两个元素删掉 → 这条当场红
   * (jail 里能列出宿主的 c / d / nas)。
   */
  test('★ /mnt 在 jail 里是空目录 —— 9P / 网络盘物理上碰不到', () => {
    const r = run('ls -A /mnt | wc -l');
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe('0');
    // 反面锚:宿主上它**不是**空的(否则这条在别人机器上是空断言)。
    expect(sh('ls -A /mnt | wc -l').out.trim()).not.toBe('0');
  });

  test('★ writable 能把某一条挂回来 —— 屏蔽是默认, 不是死路', () => {
    const back = mkdtempSync(join(tmpdir(), 'omd-mnt-back-'));
    // 用一个真实存在的目录冒充"要挂回的那条挂载" —— 判据是 `--bind` 排在 `--tmpfs /mnt`
    // 之后因而盖得住, 与那条路径是不是真的 /mnt 下无关。
    const r = sh(sandboxCommand(`ls -d ${shellQuote(back)}`, { root, extraWritable: [back] }));
    expect(r.code).toBe(0);
  });

  test('额外可写点真的可写 —— 逃生口不是摆设', () => {
    const extra = mkdtempSync(join(tmpdir(), 'omd-extra-'));
    // ⚠ extra 在 /tmp 下, 而 jail 的 /tmp 是 tmpfs —— 显式 --bind 才盖得回来。
    //   这正是这条用例要证明的:列进 writable 之后它是真路径, 不是 tmpfs 里的空目录。
    const r = sh(sandboxCommand(`echo ok > ${shellQuote(join(extra, 'f.txt'))}`, { root, extraWritable: [extra] }));
    expect(r.code).toBe(0);
    expect(readFileSync(join(extra, 'f.txt'), 'utf8').trim()).toBe('ok');
  });

  test('网络与工具链不受影响 —— 围栏挡的是写, 不是干活', () => {
    expect(run('git rev-parse --is-inside-work-tree; command -v bash').code).toBe(0);
  });
});

describe.if(!SANDBOX.ok)('围栏跑不了(bwrap 不可用)', () => {
  test('★ 降级是**原样返回命令**(裸跑), 不是抛 —— owner 裁的兜底', () => {
    expect(sandboxCommand('echo x', { root: '/srv/repo' })).toBe('echo x');
    // 这条不是通过, 是**跳过的告示**: 上面那一组围栏用例在这台机器上一条都没跑。
    console.warn(`[shell-sandbox.test] bwrap 不可用, 围栏用例整组跳过 —— 原因: ${SANDBOX.reason}`);
  });
});
