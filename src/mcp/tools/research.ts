/**
 * src/mcp/tools/research —— dag_research 异步工具 (D-8 宽出)。
 * question → researchFanout 接缝 → 报告落盘 → {runId, reportPath, summary}。
 * 缺 question → MCP InvalidParams 错误。
 */
import { z } from 'zod';
import { withHeartbeat } from '../progress';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type { OmdMcpTool } from '../server.js';

/** researchFanout 接缝 —— 具体实现在 orchestration 层注入。 */
export interface ResearchFanout {
  (params: { question: string; council?: boolean; super?: boolean; k?: number; rounds?: number }): Promise<{
    runId: string;
    reportPath: string;
    summary: string;
  }>;
}

/** 构造 dag_research 工具定义, researchFanout 由调用方注入 (接缝)。 */
export function createDagResearchTool(researchFanout: ResearchFanout): OmdMcpTool {
  return {
    name: 'dag_research',
    description: 'Run async research fanout on question, store report to disk, return runId + path + summary.',
    inputSchema: {
      question: z.string().describe('Research question (required)'),
      council: z.boolean().optional().describe('Enable council deliberation'),
      super: z.boolean().optional().describe('Enable super-deep mode'),
      k: z.number().optional().describe('Top-k results to return'),
      rounds: z.number().int().min(1).max(4).optional().describe('Second-pass rounds cap (default 1; engine stops early when no new material)'),
    },
    // ⚠ 第二个参数 `extra` 以前没接 —— 那正是它被客户端判死的原因(见 src/mcp/progress.ts 头注)。
    handler: async (args, extra) => {
      const { question, council, super: superMode, k, rounds } = args as {
        question?: string;
        council?: boolean;
        super?: boolean;
        k?: number;
        rounds?: number;
      };
      if (!question) {
        throw new McpError(ErrorCode.InvalidParams, 'dag_research: missing required param "question"');
      }
      const result = await withHeartbeat(extra as never, 'dag_research', () =>
        researchFanout({ question, council, super: superMode, k, rounds }),
      );
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
      };
    },
  };
}
