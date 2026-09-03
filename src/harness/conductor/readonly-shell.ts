/**
 * src/harness/conductor/readonly-shell —— conductor 的 **只读 bash 闸** (P3 契约 D-20 的机械面, 2026-09-03)。
 *
 * 为什么要有它: smoke8-p3 (2026-09-03 08:43) 里 repo_understanding 那题, conductor 没派工, 用 bash heredoc 直接写了
 * 22 KB 的 analysis.json。D-20「conductor 不写文件」此前只靠 (a) conductor 面上没有 write/edit 与 (b) 收尾写集对账 ——
 * (b) 对 conductor 是哨兵写集, 对账对不到; bash 重定向就是那条没关的门。本仓的实测结论是「讲道理拦不住」,
 * 所以这里做成会拒的闸, 不是 prompt 里再讲一遍。
 *
 * 判据 (宁可多拒: conductor 想改文件的正确出口是派 work(), 被拒一次的代价是一次重试, 漏拒一次的代价是 D-20 失效):
 *   ① 任何写目标 (`writeset/shell-writes.ts` 的 shellWriteTargets: 重定向 / tee / sed -i / cp mv install / touch /
 *      脚本内 open('w') 等) —— 与产物闸同一个识别器, 不第二份;
 *   ② 认不出目标的重定向 (`> "$OUT"` 这类变量展开) —— 单独一条正则, 只放行 `>/dev/null` 与 `2>&1`;
 *   ③ 改盘动词首词 (每段各判: `rm rmdir mkdir touch chmod chown ln mv cp install tee truncate dd patch`);
 *   ④ 会改盘的子命令: `git {add commit checkout switch restore reset stash apply am merge rebase push clean rm mv}` ·
 *      `pip/pip3/uv install|uninstall` · `npm/pnpm/yarn/bun {install add remove i uninstall link}`。
 * 放行: 测试 / lint / grep / cat / ls / git 只读子命令 / python -c 只读脚本 —— conductor prompt §1 说的「read-only commands:
 * ls, grep, find, git log, test runs」全部过得去 (pytest 写 __pycache__ 不在 ①~④ 任何一条里, 这是有意的)。
 *
 * 证伪方式 (readonly-shell.test.ts): 把 ② 那条正则删掉 → `echo x > "$OUT"` 放行, 红; 把 ④ 的 git 表删掉 →
 * `git commit -am x` 放行, 红; 把 pytest 误拒 → 「测试命令放行」那条红。
 */
import type { AnyOmdTool } from '../agent-tools';
import { shellWriteTargets } from '../writeset/shell-writes';

const WRITE_VERBS: ReadonlySet<string> = new Set([
  'rm', 'rmdir', 'mkdir', 'touch', 'chmod', 'chown', 'ln', 'mv', 'cp', 'install', 'tee', 'truncate', 'dd', 'patch',
]);
const GIT_WRITE_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'add', 'commit', 'checkout', 'switch', 'restore', 'reset', 'stash', 'apply', 'am', 'merge', 'rebase', 'push', 'clean', 'rm', 'mv', 'cherry-pick', 'revert',
]);
const PKG_WRITE_SUBCOMMANDS: ReadonlySet<string> = new Set(['install', 'uninstall', 'add', 'remove', 'i', 'link', 'update', 'upgrade']);
const PKG_BINS: ReadonlySet<string> = new Set(['pip', 'pip3', 'uv', 'npm', 'pnpm', 'yarn', 'bun']);

/** 首词: 跳过 `FOO=bar` 环境赋值与 `sudo` / `env` / `command` / `nohup` 这类前缀。 */
function headTokens(seg: string): string[] {
  const toks = seg.trim().split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < toks.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[i]!) || toks[i] === 'sudo' || toks[i] === 'env' || toks[i] === 'command' || toks[i] === 'nohup' || toks[i] === 'time')) i++;
  return toks.slice(i);
}

/** 重定向且目标认不出 (变量 / 反引号 / 子 shell) —— 只放行 /dev/null 与 fd 复制 (`2>&1`)。 */
const OPAQUE_REDIRECT = /(?:^|\s)(?:[0-9]|&)?>{1,2}\s*(?!&[0-9]|\/dev\/null)\S/;

/**
 * 命令为什么不能在 conductor 的只读 bash 里跑; null = 放行。
 * 返回值是给 conductor 看的一句话 (它据此改派 work(), 不是改写命令绕过去)。
 */
export function readOnlyShellBlockReason(command: string): string | null {
  const cmd = command ?? '';
  const targets = shellWriteTargets(cmd);
  if (targets.length > 0) return `命令会写文件 (${targets.slice(0, 3).join(', ')})`;
  if (OPAQUE_REDIRECT.test(cmd)) return '命令含重定向 (目标认不出也一样拒)';
  for (const rawSeg of cmd.split(/\n|;|&&|\|\||\|/)) {
    const toks = headTokens(rawSeg);
    const bin = toks[0];
    if (!bin) continue;
    const base = bin.slice(bin.lastIndexOf('/') + 1);
    if (WRITE_VERBS.has(base)) return `\`${base}\` 会改盘`;
    if (base === 'git' && toks[1] && GIT_WRITE_SUBCOMMANDS.has(toks[1])) return `\`git ${toks[1]}\` 会改仓`;
    if (PKG_BINS.has(base) && toks[1] && PKG_WRITE_SUBCOMMANDS.has(toks[1])) return `\`${base} ${toks[1]}\` 会改环境`;
  }
  return null;
}

/** 拒绝回执的固定首行 —— conductor 与测试都靠它认「这是只读闸, 不是命令本身失败」。 */
export const READONLY_SHELL_BLOCKED_HEAD = '[BLOCKED · conductor 只读 bash]';

/**
 * 把一只 bash 工具包成只读: 拒的走 tool result (带原因 + 正确出口), 放行的原样透传。
 * 不改 schema, 不改 execute 的返回形状 —— 与交互 bash 的 BASH_SCHEMA 零改动 (契约 INV-13)。
 */
export function wrapReadOnlyShell(tool: AnyOmdTool, onBlocked?: () => void): AnyOmdTool {
  return {
    ...tool,
    description: `${tool.description} READ-ONLY for the conductor: commands that write files or mutate the repo are rejected; dispatch work() to change files.`,
    async execute(id: string, params: unknown, ...rest: unknown[]) {
      const command = params && typeof params === 'object' ? String((params as { command?: unknown }).command ?? '') : '';
      const reason = readOnlyShellBlockReason(command);
      if (reason) {
        onBlocked?.();
        return {
          content: [{ type: 'text', text: `${READONLY_SHELL_BLOCKED_HEAD} ${reason} —— conductor 不写文件 (D-20)。要改文件就派 work(); 要看结果用只读命令。` }],
          details: { blocked: reason },
        };
      }
      return (tool.execute as (id: string, params: unknown, ...rest: unknown[]) => Promise<unknown>)(id, params, ...rest);
    },
  } as AnyOmdTool;
}
