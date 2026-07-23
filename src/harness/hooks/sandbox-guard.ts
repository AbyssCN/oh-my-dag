/**
 * sandbox-guard —— tool_call fail-closed 写沙箱: 拒绝把文件写到 sandboxRoot 子树之外。
 *
 * 治 eval worktree 隔离漏 (2026-07-23 实测): leaf 用**绝对路径**调 `write` 写穿 worktree、
 * 污染主树真源码 (pi write 的 resolveToCwd 对绝对路径原样放行, 见 paths.js:63)。此前只有
 * executor-dag 的 F1 **事后** git-status 闸能抓 (跑完才发现, 不阻止、不还原); 本 hook 是**事前**阻断。
 *
 * 守的是结构化写工具: write / edit / multiedit (顶层 path/file_path) + hashline_edit (路径嵌 patch 的
 * `¶PATH#TAG` 头, 解析出来一并校)。命中越界 → 返 ToolCallEventResult.block + reason (模型收到拒绝原因,
 * 可改用 root 内相对路径重试, 不杀 session)。
 *
 * ⚠ 不守 bash 写逃逸 (`cat > /abs`, `sed -i` 等) —— 那需容器/chroot 级隔离, 非 tool_call 层能拦;
 *   由 tool-gate 的 dangerous-cmd 闸 + executor-dag F1 事后闸兜底 (defense in depth)。
 */
import { isAbsolute, relative, resolve } from 'node:path';
import type { ExtensionFactory, ToolCallEvent } from '@earendil-works/pi-coding-agent';
import { logger } from '../../logger';
import { hashlinePatchPaths } from '../hashline';

/** 顶层 path 参数的结构化写工具。 */
const PATH_ARG_WRITE_TOOLS = new Set(['write', 'edit', 'multiedit', 'apply_patch']);

/** 从 tool_call event 抽出所有目标写路径 (原始串, 未解析)。非写工具 → []。 */
function writePathsOf(event: ToolCallEvent): string[] {
  const input = event.input as Record<string, unknown> | undefined;
  if (!input) return [];
  if (PATH_ARG_WRITE_TOOLS.has(event.toolName)) {
    const p = input.path ?? input.file_path;
    return typeof p === 'string' && p.trim() ? [p] : [];
  }
  // hashline_edit: 路径嵌在 patch 的 `¶PATH#TAG` 头 (可多 section) —— 共用 hashline 的解析器 (单一真源)。
  if (event.toolName === 'hashline_edit') {
    return typeof input.patch === 'string' ? hashlinePatchPaths(input.patch) : [];
  }
  return [];
}

/** resolved 是否逃出 root 子树 (root 自身也算越界: 不该把根当文件写)。 */
function escapesRoot(raw: string, root: string): boolean {
  const resolved = isAbsolute(raw) ? resolve(raw) : resolve(root, raw);
  const rel = relative(root, resolved);
  return rel === '' || rel.startsWith('..') || isAbsolute(rel);
}

/**
 * 造写沙箱 extension。任一目标写路径解析到 sandboxRoot 子树外 → block。
 * 纯配置闭包, 无外部状态; 跨 leaf 复用同一 factory 安全。
 */
export function createSandboxGuardHook(config: { root: string }): ExtensionFactory {
  const root = resolve(config.root);
  return (pi) => {
    pi.on('tool_call', (event) => {
      for (const raw of writePathsOf(event)) {
        if (escapesRoot(raw, root)) {
          const reason =
            `[sandbox] 拒绝写沙箱外路径: "${raw}" (根 ${root})。` +
            `只允许写根子树内的**相对路径**, 不要用绝对路径。`;
          logger.warn({ tool: event.toolName, path: raw, root }, '[omd/sandbox] write blocked: escapes root');
          return { block: true, reason };
        }
      }
      return {};
    });
  };
}
