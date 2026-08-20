/**
 * src/tui/render/tool-result —— **工具行右半句:结果**(2026-08-13,owner 点名)。
 *
 * ## 为什么值得单开一片(与 `tool-arg` 同一个理由的另一半)
 *
 * `tool-arg` 治的是「看得出它动了手,看不出它动了什么」。这一片治的是剩下那一半:
 * **看得出它搜了,看不出它搜到了什么**。屏上一行 `✓ grep thinking_delta in src/`
 * 之后什么都没有 —— 命中 0 处还是 300 处,读的人分不出来,而这两件事该做的下一步完全不同。
 *
 * ## 料来自 `details`,不是正文
 *
 * omd 的每个工具都返回**结构化 `details`**(`agent-tools.ts` 的 `OmdTool<T>` 那个类型参数):
 * `grep → {matches, files, walked, walkCapped, skippedMounts}`、`read → {lines, truncated}`、
 * `bash → {exitCode, truncated}` …… 拿它渲染而不是去解析正文,是因为正文是给**模型**看的、
 * 随时可能改措辞,而 `details` 是契约。解析正文那条路第一次改文案就会静默失效。
 *
 * ## H6 (#187, owner 2026-08-20 裁 A 案):投影搬走了,这里只剩查表
 *
 * 本文件原先是一段**按工具名字符串派发的 switch**(`if (tool === 'grep') …`),未命中落 `null`。
 * 两个后果:①加一个工具要改第二处;②**改名即静默失效** —— 名字对不上就落 `null`,
 * 屏上那半句无声消失,无报错无日志。
 *
 * 现在投影体在 `harness/tool-render.ts`,并由 `agent-tools.ts` 按工具自己的 `name`
 * 挂到 `OmdTool.render` 上 —— **同一份**。本文件退成一次查表:
 *
 *  - 手上有工具对象(回放 / eval / 任何拿得到 tool 的地方)→ 直接 `tool.render(details)`;
 *  - 只有事件流(TUI 这条路只收到 name + details)→ `summarizeToolResult(name, details)`
 *    从同一张 `HAND_TOOL_RENDERERS` 取。
 *
 * ⚠ 刻意**没有**把投影挪到后端去做:「后端只传数据,挑哪几格是排版归 UI」那条纪律
 * (`backend-embedded.ts` 的 `details` 透传注)**不必为 H6 让路** —— 单一真源 + 覆盖闸
 * 已经把「改名静默失效」这条治掉了,再去倒转依赖是多花的代价。
 */
import { HAND_TOOL_RENDERERS } from '../../harness/tool-render';

/**
 * 工具 `details` → 工具行右半句。挑不出 → `null`(调用方就不画右半句,**不编一个占位**)。
 *
 * 没有该工具的投影也返回 `null` —— 但这不再是**静默**的:`tool-render.test.ts` 的覆盖闸
 * 保证每个手工具都挂得上投影,少一个当场红。
 */
export function summarizeToolResult(tool: string, details: unknown): string | null {
  return HAND_TOOL_RENDERERS.get(tool)?.(details) ?? null;
}
