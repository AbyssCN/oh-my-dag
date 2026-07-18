/**
 * src/harness/mcp/output-sandbox-extension —— 轴 B 接进 TUI (Contract D74)。
 *
 * ① tool_result hook (MR-INV-7 确定性拦截): 任意工具输出 > 阈值 → 存 output-store + 把 content
 *    换成指针 (大数据不进 context)。pi tool_result "Can modify result" + 链式 patch。
 * ② ctx_execute: 子进程跑代码只回 stdout。 ③ ctx_search: 拉沙箱里的大输出相关块。
 */
import { Type, type Static } from 'typebox';
import {
  defineTool,
  type ExtensionContext,
  type ExtensionFactory,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import type { OutputStore } from './output-store';
import { ctxExecute, type ExecLang, type ExecRunner } from './sandbox';
import { logger } from '../../logger';

/** 不拦截的工具 (检索结果/小输出必须可见, 否则模型拿不到)。 */
const DEFAULT_SKIP = new Set(['ctx_search', 'mcp_search', 'mcp_describe']);

type ResultContent = string | Array<{ type: string; text?: string }>;

export interface ToolResultLike {
  toolName: string;
  toolCallId: string;
  content: ResultContent;
  isError?: boolean;
}

export function contentText(content: ResultContent): string {
  if (typeof content === 'string') return content;
  return content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n');
}

/** 纯逻辑: 大输出 → 存库 + 返指针 patch; 否则 null (不改)。可测。 */
export function offloadBigOutput(
  event: ToolResultLike,
  opts: { store: OutputStore; threshold: number; skip?: Set<string> },
): { content: { type: 'text'; text: string }[] } | null {
  if (event.isError) return null;
  if ((opts.skip ?? DEFAULT_SKIP).has(event.toolName)) return null;
  const text = contentText(event.content);
  if (text.length <= opts.threshold) return null;
  const source = `${event.toolName}#${event.toolCallId}`;
  const { chunks, bytes } = opts.store.index(source, text);
  const kb = (bytes / 1024).toFixed(1);
  return {
    content: [
      {
        type: 'text',
        text: `[大输出 ${kb}KB 已存沙箱, 未进 context。source="${source}" (${chunks} 块)。用 ctx_search(query, source) 取相关块。]`,
      },
    ],
  };
}

const EXEC = Type.Object({
  code: Type.String({ description: '要在子进程跑的代码; 用 console.log/print 输出 (只 stdout 回来)。' }),
  lang: Type.Optional(Type.Union([Type.Literal('ts'), Type.Literal('js'), Type.Literal('py')], { description: '默认 ts (bun)。' })),
});
const SEARCH = Type.Object({
  query: Type.String({ description: '要在沙箱大输出里找什么。' }),
  source: Type.Optional(Type.String({ description: '限定某次输出的 source id (指针里给的)。' })),
  k: Type.Optional(Type.Number({ description: '返回块数, 默认 5。' })),
});
type ExecParams = Static<typeof EXEC>;
type SearchParams = Static<typeof SEARCH>;

function textResult(text: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: 'text' as const, text }], details };
}

export interface OutputSandboxOpts {
  store: OutputStore;
  /** 超过这字节数的工具输出转沙箱。默认 8000。 */
  threshold?: number;
  runner?: ExecRunner;
  skip?: Set<string>;
}

export function createOutputSandboxExtension(opts: OutputSandboxOpts): ExtensionFactory {
  const threshold = opts.threshold ?? 8000;
  const skip = opts.skip ?? DEFAULT_SKIP;

  return (pi) => {
    pi.on('tool_result', (event) => {
      try {
        const patch = offloadBigOutput(event as ToolResultLike, { store: opts.store, threshold, skip });
        if (patch) {
          logger.debug({ tool: event.toolName }, '[omd/mcp] big output offloaded to sandbox');
          return patch;
        }
      } catch (e) {
        logger.warn({ err: (e as Error).message }, '[omd/mcp] offload failed, 原样返回');
      }
      return {};
    });

    pi.registerTool(
      defineTool({
        name: 'ctx_execute',
        label: 'ctx execute',
        description: '在隔离子进程里跑代码处理大数据 (只 stdout 回 context)。处理沙箱大输出/重计算时用。',
        promptSnippet: 'ctx_execute(code, lang?) — 子进程跑代码, 只回 stdout。',
        parameters: EXEC,
        executionMode: 'sequential',
        async execute(_id: string, p: ExecParams, signal?: AbortSignal) {
          const out = await ctxExecute(p.code, (p.lang ?? 'ts') as ExecLang, { runner: opts.runner, signal });
          return textResult(out, { lang: p.lang ?? 'ts' });
        },
      }) as unknown as ToolDefinition,
    );

    pi.registerTool(
      defineTool({
        name: 'ctx_search',
        label: 'ctx search',
        description: '检索沙箱里存的大输出 (被 offload 的工具结果) 的相关块。',
        promptSnippet: 'ctx_search(query, source?) — 拉沙箱大输出相关块。',
        parameters: SEARCH,
        executionMode: 'parallel',
        async execute(_id: string, p: SearchParams, _signal, _onUpdate, _ctx: ExtensionContext) {
          const hits = opts.store.search(p.query, { source: p.source, k: p.k ?? 5 });
          if (hits.length === 0) return textResult('沙箱无匹配块。', { hits: 0 });
          const text = hits.map((h) => `### ${h.heading || h.source}\n${h.text}`).join('\n\n---\n\n');
          return textResult(text, { hits: hits.length });
        },
      }) as unknown as ToolDefinition,
    );
  };
}
