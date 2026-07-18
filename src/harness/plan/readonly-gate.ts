/**
 * plan/readonly-gate —— plan mode 只读不变量的**代码级**判定 (纯函数, 可单测)。
 *
 * plan mode = 只读审议座舱: 写工具 + 写命令一律拦 (返 reason, 教模型先讨论)。**不藏工具**
 * (模型仍看得见 write/edit) —— 经 tool_call 闸拦执行 + 给理由, 培养弱模型"先对齐再动手"纪律。
 *
 * 与 hooks/dangerous-cmd 正交: 那个拦"不可逆破坏" (任何 mode), 这个拦"任何写" (仅 plan mode, 更严)。
 */

import { resolve as resolvePath, sep } from 'node:path';

/** 定义为"写"的 pi 工具名 (改盘工具)。read / bash(只读) / lsp / cg / audit / sast 不在内。 */
const WRITE_TOOLS: ReadonlySet<string> = new Set(['write', 'edit', 'hashline_edit']);

/** 该工具名是否为写工具 (plan mode 下拦)。 */
export function isWriteTool(toolName: string): boolean {
  return WRITE_TOOLS.has(toolName);
}

/**
 * plan mode 写 carve-out 允许目录 (相对工作根)。
 * 语义: plan mode 可落**审议产物** (SDD / 纪要 / 台账) 但仍碰不了**实装代码** (src/**)。
 * `.omd` = omd 运行期产物区; `docs/plan` = canonical plan 文档区。
 */
export const DEFAULT_DOC_WRITE_DIRS: readonly string[] = ['.omd', 'docs/plan'];

/** 从写工具的 input 取目标路径 (write/edit/hashline_edit 用 `path`; 兜 file_path/filePath)。 */
export function writeTargetPath(input: unknown): string | undefined {
  const o = input as Record<string, unknown> | undefined;
  const p = o?.path ?? o?.file_path ?? o?.filePath;
  return typeof p === 'string' && p.length > 0 ? p : undefined;
}

/**
 * 目标路径是否落在允许写的文档区 (plan mode carve-out)。
 *
 * 相对 cwd 解析成绝对路径后比对 (resolvePath 折叠 `..` → 自动挡 traversal 逃逸:
 * `docs/plan/../../src/x` resolve 后落 src/, 不在白名单 → false)。
 * target 缺失 (无路径的写) → false (保守 block, fail-closed)。
 */
export function isDocWritePath(
  target: string | undefined,
  opts: { cwd: string; allowDirs?: readonly string[] },
): boolean {
  if (!target) return false;
  const abs = resolvePath(opts.cwd, target);
  const dirs = opts.allowDirs ?? DEFAULT_DOC_WRITE_DIRS;
  return dirs.some((d) => {
    const absDir = resolvePath(opts.cwd, d);
    return abs === absDir || abs.startsWith(absDir + sep);
  });
}

/** 改盘/改仓的命令动词 (plan mode 下 bash 命中即拦)。 */
const BASH_MUTATION_PATTERNS: readonly RegExp[] = [
  /\b(rm|mv|cp|mkdir|rmdir|touch|ln|chmod|chown|truncate|dd|rsync)\b/,
  /\bsed\b[^|]*\s-i\b/, // sed -i 原地改
  /\btee\b/,
  /\bgit\s+(add|commit|push|reset|checkout|switch|merge|rebase|stash|apply|clean|rm|mv|tag|cherry-pick|revert)\b/,
  /\b(npm|bun|pnpm|yarn|pip|pip3|cargo|go)\s+(install|add|i|remove|rm|uninstall|update|upgrade|link)\b/,
  /\bpsql\b/, // DB 写风险, plan mode 保守拦
];

/** 重定向写文件? (含 >|/>>; 排除 /dev/null 与 fd dup 如 2>&1) */
function hasFileRedirect(command: string): boolean {
  const segs = command.match(/>\|?>?\s*[^\s&|;]+/g);
  if (!segs) return false;
  return segs.some((seg) => {
    const target = seg.replace(/^>\|?>?\s*/, '');
    return target !== '/dev/null' && !target.startsWith('&');
  });
}

/**
 * bash 命令是否改盘/改仓 (plan mode 下要拦)。
 *
 * ⚠ 诚实边界: 这是**黑名单启发式 (defense-in-depth), 非沙箱**。plan mode 的**硬保证** = 写工具
 * (write/edit/hashline_edit) 全拦 (isWriteTool, 弱模型写代码的主路径全堵)。bash 黑名单只兜常见
 * 写命令 (rm/git commit/重定向/包安装…); 异域写向量 (如 `python -c "open(...,'w')"`) 黑名单不全覆 →
 * 对未知 bash 写**fail-open**。威胁模型 = 纪律化**协作**弱模型 (劝其先讨论再动手), 非对抗逃逸,
 * 故黑名单足够; 真要硬只读沙箱是 P3+ 的事 (allowlist + cgroup), 不在 P1 脊柱 scope。
 * 只读 bash (grep/ugrep/ls/cat/find/bfs/git log|diff|status|show/wc/head/tail) 放行。
 */
export function isBashMutation(command: string): boolean {
  return BASH_MUTATION_PATTERNS.some((re) => re.test(command)) || hasFileRedirect(command);
}
