/**
 * shell-sandbox —— **对话位 bash 的 bwrap 围栏**(2026-08-13,owner 裁:TUI 默认 yolo)。
 *
 * ## 与 `bwrap.ts` 是两件事,不要合并
 *
 * `bwrap.ts` 那套是 **leaf jail**:root 之外**物理不可见**(空目录),为的是挡 oracle 作弊
 * (`git show <commit>:file` 从共享 .git 捞回被清空的实现)。那里"看不见"本身就是判据。
 *
 * 这里是**对话位的围栏**,判据完全不同:conductor 就是要能读整台机器(截图里第一件事就是
 * `ls /home/nick/repos`),它只是**不许写到工作根外面**。两套要求相反 ——
 * 合并成一个函数就必然要长出一个 `mode` 参数,而那正是"两处声明同一件事"的开头。
 *
 * ## 形状(2026-08-13 五条实测,不是推的)
 *
 * ```
 * bwrap --ro-bind / /  --dev /dev --proc /proc --tmpfs /tmp
 *       --bind <root> <root> --chdir <root>
 *       --die-with-parent --unshare-pid  /bin/bash -c '<command>'
 * ```
 *
 * | 探针 | 读数 |
 * |---|---|
 * | `pwd` / `echo` | OK,cwd = root |
 * | `touch <root>/x` | OK(工作根可写) |
 * | `rm -f ~/.bashrc` | `Read-only file system`,宿主文件原封不动 |
 * | `touch /usr/local/bin/evil` | `Read-only file system` |
 * | `git rev-parse` / `which bun` / DNS | 全通(网络与工具链不受影响) |
 *
 * `--ro-bind / /` 在前、`--bind root root` 在后:bwrap 按给定顺序叠挂,子路径要在父路径
 * **之后**才盖得住。顺序反了就是一个看起来装了、其实全只读的沙箱。
 *
 * ## 探测是**真跑一次**,不是 `which bwrap`
 *
 * 二进制在、内核不给 unprivileged user namespace(部分发行版 / 容器)是常见组合,
 * 而 `which` 在那种机器上照样返回 0。判据是成本:一次 `bwrap … true` 是毫秒级的,
 * 没有任何理由用推的(P-2)。结果缓存,不每条命令探一次。
 */
import { logger } from '../../logger';

/** 沙箱起不来的原因(UI 要画出来 —— 「降级裸跑」不许静默)。 */
export interface SandboxStatus {
  ok: boolean;
  /** `ok:false` 时的原因原文(bwrap stderr / spawn 错误)。`ok:true` 时不存在。 */
  reason?: string;
}

/** bwrap 可用性探测的缓存。`null` = 还没探过。 */
let probed: SandboxStatus | null = null;

/**
 * bwrap 在这台机器上到底能不能起。**真跑一次**(见文件头注),结果缓存。
 * `refresh: true` 重探 —— 只有测试用得上。
 */
export function probeShellSandbox(o: { refresh?: boolean } = {}): SandboxStatus {
  if (probed && !o.refresh) return probed;
  let status: SandboxStatus;
  try {
    const p = Bun.spawnSync(['bwrap', '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--die-with-parent', 'true'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    status =
      p.exitCode === 0
        ? { ok: true }
        : { ok: false, reason: new TextDecoder().decode(p.stderr).trim() || `bwrap exited ${p.exitCode}` };
  } catch (err) {
    status = { ok: false, reason: (err as Error).message };
  }
  if (!status.ok) {
    logger.warn({ reason: status.reason }, '[omd/sandbox] bwrap 起不来 → bash 降级裸跑 (黑名单仍在)');
  }
  probed = status;
  return status;
}

/**
 * 组 bwrap argv(不含末尾要跑的程序)。`root` 可写,`/tmp` 是 tmpfs,其余全只读。
 *
 * `extraWritable` 是**逃生口**(`.omd/config.json` 的 `tui.sandbox.writable`):
 * 默认空 —— owner 2026-08-13 裁的边界就是 `cwd + /tmp`,要写到工作根外面得显式列出来。
 */
export function shellSandboxArgs(root: string, extraWritable: readonly string[] = []): string[] {
  const args = [
    '--ro-bind',
    '/',
    '/',
    '--dev',
    '/dev',
    '--proc',
    '/proc',
    '--tmpfs',
    '/tmp',
    // ★ **/mnt 变成空 tmpfs**(2026-08-13,WSL 整机卡死的次因修法)。
    //
    // `--ro-bind / /` 让整台机器可读 —— 包括 `/mnt/c` `/mnt/d`(WSL 的 9p drvfs)与
    // `/mnt/nas*`(网络盘)。围栏挡**写**不挡**读**,而那次事故是**读**打爆的:
    // 一条递归遍历把 9P 桥打爆之后,WSL 里任何碰 Windows 文件的操作无限期挂起,
    // 连新开 shell 解析 PATH 都卡住(PATH 含 /mnt/c 下的路径)—— 终端全黑且不报错。
    //
    // 所以这里把整个 `/mnt` 换成空目录:jail 里的命令**物理上碰不到**那些挂载。
    // 真要访问某一条,经 `.omd/config.json` 的 `tui.sandbox.writable` 显式挂回
    // (下面 extraWritable 的 `--bind` 排在这之后,盖得住这层 tmpfs)。
    //
    // ⚠ 这一层只保护 bash。`grep`/`ls` 是**进程内** JS,不进围栏 ——
    // 那一侧的闸在 `agent-tools.ts` 的 `walkFiles`(读 `/proc/mounts` 按 fstype 剪枝)。
    // 两侧都要有:这次事故的**主因**恰恰是进程内那一侧。
    '--tmpfs',
    '/mnt',
    '--bind',
    root,
    root,
  ];
  // 顺序即叠挂顺序: 额外可写点在 `--ro-bind / /` 之后才盖得住(见文件头注)。
  for (const p of extraWritable) args.push('--bind', p, p);
  args.push('--chdir', root, '--die-with-parent', '--unshare-pid');
  return args;
}

/** POSIX 单引号包一层 —— 命令原文里的 `'` 拆成 `'\''`。 */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export interface ShellSandboxOpts {
  /** 工作根(唯一可写的地方,除 `/tmp` 与 `extraWritable`)。 */
  root: string;
  /** 额外可写路径(`tui.sandbox.writable`)。默认空。 */
  extraWritable?: readonly string[];
}

/**
 * 把一条命令包进沙箱。**沙箱起不来 → 原样返回**(降级裸跑,owner 2026-08-13 裁)——
 * 这条路上的告警由 `probeShellSandbox` 记日志、由 UI 顶栏画红字,不在这里静默。
 *
 * ⚠ 内层用 `/bin/bash -c`:pi 的 `NodeExecutionEnv.exec` 每次 spawn 一个**全新**的 shell
 * (实读 `harness/env/nodejs.js:316`),没有跨调用的 `cd` 状态可破坏 —— 所以逐条包是安全的。
 */
export function sandboxCommand(command: string, o: ShellSandboxOpts): string {
  if (!probeShellSandbox().ok) return command;
  const argv = ['bwrap', ...shellSandboxArgs(o.root, o.extraWritable ?? []), '/bin/bash', '-c', command];
  return argv.map(shellQuote).join(' ');
}
