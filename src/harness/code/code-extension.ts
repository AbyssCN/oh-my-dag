/**
 * src/harness/code/code-extension —— code mode 接进 TUI: `code` 工具。
 *
 * 模型在一回合内写 TS 串调多工具 + 循环/条件处理数据, 只回最终 stdout (省 token, 不来回灌 context)。
 * 对 executor 叶做数据密集活 (分页抓取 / 聚合搜索 / 过滤大 JSON) 尤其省 —— 中间态全在子进程内存, 不进 context。
 * 可用 globalThis.tools.<name>(args) (注入的编排工具) + Bun 原生 fetch/std 库。
 */
import { Type, type Static } from 'typebox';
import { defineTool, type ExtensionFactory, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { runCodeMode } from './run';
import type { ToolMap } from './bridge';
import { logger } from '../../logger';

const CODE = Type.Object({
  code: Type.String({
    description:
      '要在隔离子进程跑的 TS (Bun)。用 console.log 输出 (只 stdout 回 context)。可 await tools.<name>(args) 调编排工具 + 原生 fetch / Bun.file 等。',
  }),
});
type CodeParams = Static<typeof CODE>;

export interface CodeExtensionOpts {
  /** 暴露给模型代码的编排工具 (web_search/web_fetch/mcp_call …)。省略 = 仅原生 fetch/std。 */
  tools?: ToolMap;
  /** 默认超时 ms (无外部 signal 时)。默认 60000。 */
  timeoutMs?: number;
}

function textResult(text: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: 'text' as const, text }], details };
}

export function createCodeExtension(opts: CodeExtensionOpts = {}): ExtensionFactory {
  const tools = opts.tools ?? {};
  const names = Object.keys(tools);
  const timeoutMs = opts.timeoutMs ?? 60_000;

  const avail = names.length ? `tools.${names.join(' / tools.')}` : '(无编排工具, 仅原生 fetch/std 库)';

  return (pi) => {
    pi.registerTool(
      defineTool({
        name: 'code',
        label: 'Code mode',
        description: `一回合写代码串调多工具 + 循环/条件聚合数据, 只回最终 stdout (省 token)。**何时用**: ① 多次工具调用/分页/fan-out (折叠 N 次往返为 1 回合) ② 工具返大输出但只需其中一小块 (web 抓取/大文件/冗长 JSON → 代码里过滤完只回结论)。**不用于**: 单次小结果原样返回 / 纯推理判断 (那些走普通 tool_call)。可用: ${avail} + Bun 原生 fetch/file/std。`,
        promptSnippet: 'code(code) — 多工具/数据密集活: 写 TS 串调+聚合, 只回 stdout (省 token)。',
        parameters: CODE,
        executionMode: 'sequential',
        async execute(_id: string, p: CodeParams, signal?: AbortSignal) {
          // 外部 signal 与默认超时取并 (任一触发即中断, 防子进程挂死)。
          const sig = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
          try {
            const out = await runCodeMode(p.code, { tools, signal: sig });
            return textResult(out, { tools: names });
          } catch (e) {
            logger.warn({ err: (e as Error).message }, '[omd/code] code mode 执行失败');
            return textResult(`error: ${(e as Error).message}`, { ok: false });
          }
        },
      }) as unknown as ToolDefinition,
    );
  };
}
