/**
 * src/harness/hashline-extension —— hashline 的**交互-TUI 侧**接线 (pi `main()` 那条路)。
 *
 * 与工具本体 (`hashline.ts`) 分开成两个文件, 是因为**只有这一侧需要 `pi-coding-agent`**:
 * agent leaf 搬到 `pi-agent-core` 的低层循环之后, MCP 那条路径对 CLI 包应当是零引用 ——
 * 而"零引用"这件事只有在文件级别才验得动 (同一个文件里留一个 import, 整条路径就还挂着它)。
 */
import type { ExtensionFactory, ToolDefinition } from '@earendil-works/pi-coding-agent';
import {
  createHashlineCustomTools,
  HASHLINE_BLOCK_NATIVE_EDIT_REASON,
  type HashlineToolsOpts,
} from './hashline';

/**
 * 造 hashline 的**交互-TUI extension** —— 把 agent-leaf 的
 * `createAgentSession({ customTools: hashline, excludeTools: ['edit'] })` 等价搬到 pi `main()` 路径。
 *
 * 为什么经 extension: 交互 TUI 走 pi `main(args, { extensionFactories })`, **不暴露 customTools/
 * excludeTools** (那是 createAgentSession 才有的)。两侧各补一招:
 *   - 注入侧 → `pi.registerTool(hashline_read/hashline_edit)` (ExtensionAPI 原生支持)。
 *   - 排除侧 → `on('tool_call')` block 原生 `edit` (tool-gate 同款 fail-closed 形态)。
 *     `write` 不拦 (整文件覆写不易行错位, 新建文件还需它) —— 与 agent-leaf `excludeTools:['edit']` 一致。
 *
 * 默认只在驱动**弱 executor** 时挂 (tui.ts 的 resolveHashlineEdit 门控): 弱 MiMo 原生 edit 易错位,
 * hashline 行锚定治它; 强模型 (用户 --model 选 Opus) 原生 edit 够好, 拦它反添摩擦。此工厂只管"挂了即生效"。
 *
 * (plan readonly-gate 已退役 (D-5): 现在**没有**别的写闸拦 hashline_edit/write —— 此 handler 只拦
 * native edit, 是当前唯一的 edit 闸, 不要再假设上游还有一层。)
 */
export function createHashlineExtension(opts: HashlineToolsOpts = {}): ExtensionFactory {
  // 共享快照: 建一次, 整 session 复用 (hashline_read 写标签 → hashline_edit 校验同一 store)。
  const tools = createHashlineCustomTools(opts);
  return (pi) => {
    // OmdTool → pi `ToolDefinition`: 结构同形 (name/label/description/parameters/execute/executionMode),
    // 差的只是 CLI 侧那几个**可选**渲染钩子 (renderCall/renderResult) —— 不给就走默认渲染。
    for (const tool of tools) pi.registerTool(tool as unknown as ToolDefinition);
    pi.on('tool_call', (event) => {
      if (event.toolName === 'edit') {
        return { block: true, reason: HASHLINE_BLOCK_NATIVE_EDIT_REASON };
      }
      return {};
    });
  };
}
