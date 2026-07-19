/**
 * src/mcp/tools/research —— dag_research 异步工具 (D-8 宽出)。
 * question → researchFanout 接缝 → 报告落盘 → {runId, reportPath, summary}。
 * 缺 question → MCP InvalidParams 错误。
 */
import { z } from 'zod';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type { OmdMcpTool } from '../server.js';

/** researchFanout 接缝 —— 具体实现在 orchestration 层注入。 */
export interface ResearchFanout {
  (params: { question: string; council?: boolean; super?: boolean; k?: number }): Promise<{
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
    },
    handler: async (args) => {
      const { question, council, super: superMode, k } = args as {
        question?: string;
        council?: boolean;
        super?: boolean;
        k?: number;
      };
      if (!question) {
        throw new McpError(ErrorCode.InvalidParams, 'dag_research: missing required param "question"');
      }
      const result = await researchFanout({ question, council, super: superMode, k });
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
      };
    },
  };
}
