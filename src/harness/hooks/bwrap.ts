/**
 * bwrap —— bubblewrap 隔离的**绑定组装**共享助手 (2026-07-23, eval worktree 真隔离)。
 *
 * 治终局根因 (记忆 dag-engine-write-reliability): eval leaf 在同一文件系统命名空间跑, 会 `cd /主repo`
 * 出 worktree、`git show <commit>:file > file` 从共享 .git 捞被清空的实现写回主树 (oracle 作弊 + 污染)。
 * pi 暴露多条命令通道 (bash + 模型幻觉的 shell + 未来工具), 逐工具沙箱是打地鼠 → 用 bwrap 把**整个 leaf
 * 进程**关进只见 worktree 的文件系统视图 (subprocess-per-leaf, 见 sandboxed-leaf.ts)。
 *
 * 绑定策略 (已隔离单元验证): `--bind <root> <root>` 同路径挂 worktree (rw); 中间目录 (含主 repo 前缀)
 * 被 bwrap 建成**空目录** → `cd /主repo && ls src` 见空、`git show` 无 .git → 逃逸与 oracle 作弊双断。
 * ro-bind node_modules (自 root 向上找最近的) + bunDir → bun/tsc 可跑且解析依赖。系统只读 + /tmp + /proc + /dev。
 * **不 --clearenv**: 继承父进程 env (provider API key 等要流进 worker); 只 --setenv HOME/PATH。
 */
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/**
 * DNS 解析所需的额外绑定 (WSL2: /etc/resolv.conf 是指向 /mnt/wsl/resolv.conf 的符号链接, ro-bind /etc 时
 * 链接目标不在 jail 内 → 无 DNS → leaf 连不上 model API)。把真身按**自己的绝对路径**绑进去, /etc 里的
 * 符号链接自然解析。真身在 /etc 内 (常规文件) → 已被 /etc 覆盖, 返 []。
 */
function dnsBinds(): string[] {
  try {
    const real = realpathSync('/etc/resolv.conf');
    return real.startsWith('/etc/') ? [] : [real];
  } catch {
    return [];
  }
}

/** 自 start 向上找最近含 node_modules 的祖先目录, 返 node_modules 绝对路径 (无则 null)。 */
export function findNodeModules(start: string): string | null {
  let dir = resolve(start);
  for (;;) {
    const nm = join(dir, 'node_modules');
    if (existsSync(nm)) return nm;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** leaf 隔离默认只读绑定: bun 可执行目录 + root 向上最近的 node_modules (供 bun/tsc 解析依赖)。 */
export function defaultRoBinds(root: string): string[] {
  const bunDir = dirname(process.execPath);
  const nm = findNodeModules(root);
  return [bunDir, ...(nm ? [nm] : [])];
}

/**
 * 组 bwrap argv (不含末尾要跑的程序)。root 同路径 rw 挂载; roBinds 只读; 系统只读; 只挂真存在的目录。
 * chdir 到 root → 子进程 process.cwd() = worktree, 主 repo 物理不可见。
 */
export function bwrapArgs(root: string, roBinds: string[]): string[] {
  const args: string[] = [
    '--unshare-user',
    '--unshare-pid',
    '--die-with-parent',
    '--proc',
    '/proc',
    '--dev',
    '/dev',
    '--tmpfs',
    '/tmp',
  ];
  for (const p of ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc']) {
    if (existsSync(p)) args.push('--ro-bind', p, p);
  }
  // DNS (WSL2 resolv.conf 符号链接真身) + 调用方 roBinds (node_modules/bunDir), 去重、只挂存在的。
  for (const p of [...new Set([...dnsBinds(), ...roBinds])]) {
    if (p && existsSync(p)) args.push('--ro-bind', p, p);
  }
  args.push('--bind', root, root);
  args.push('--chdir', root);
  // 模型注册表映入 jail HOME (2026-07-25 实证): HOME=/tmp 后 worker 读 /tmp/.pi/agent/models.json
  // → 注册制 provider (mimo-platform/opencode-go/…) 全消失 → leaf 模型解析不到, leafTokens=0 全军
  // 覆没。真 ~/.pi/agent 只读映到 jail HOME 下 — 凭证本就经继承 env 流入 jail, 同信任域, ro 无升权。
  const piAgent = join(homedir(), '.pi', 'agent');
  if (existsSync(piAgent)) args.push('--ro-bind', piAgent, '/tmp/.pi/agent');
  args.push('--setenv', 'HOME', '/tmp');
  // TMPDIR 必须洗 (2026-07-25 实证): 宿主 shell 的 TMPDIR (如 ~/.cache/tmp) 泄进 jail 后,
  // pi bash 工具往 os.tmpdir() 写日志 → 未挂载路径 ENOENT → worker 停摆 → 超时 SIGKILL 137。
  // jail 内 tmp 一律指向 tmpfs /tmp (hermetic, 不 bind 宿主 cache)。
  for (const k of ['TMPDIR', 'TEMP', 'TMP']) args.push('--setenv', k, '/tmp');
  args.push('--setenv', 'PATH', `${dirname(process.execPath)}:/usr/bin:/bin`);
  return args;
}
