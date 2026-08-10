/**
 * test/core/mcp-research-tool.test.ts — dag_research 工具测试 (SDD task-tool-research 先红补票)。
 *
 * researchFanout 接缝注入 fake:
 *   缺 question → McpError(InvalidParams) 抛出, 非 crash, 接缝不被触及;
 *   happy path → 接缝收全参 (question + council/super/k 透传), 结果 JSON 回传。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { createDagResearchTool, type ResearchFanout } from '../../src/mcp/tools/research';
import { RunRegistry } from '../../src/mcp/run-registry';

// S2 进程化 (SDD 2026-08-10): dag_research 的进程内执行体只在 dag-exec 子进程跑 ——
// 设 OMD_DAG_EXEC_CHILD=1 让 handler 走执行体而非 spawn 真子进程。
beforeEach(() => { process.env.OMD_DAG_EXEC_CHILD = '1'; });
afterEach(() => { delete process.env.OMD_DAG_EXEC_CHILD; });

type HandlerArgs = Record<string, unknown>;

function call(tool: ReturnType<typeof createDagResearchTool>, args: HandlerArgs) {
  return (tool.handler as (args: HandlerArgs, extra?: unknown) => unknown)(args, {}) as Promise<{
    content: { type: string; text: string }[];
    isError?: boolean;
  }>;
}

describe('dag_research 工具', () => {
  test('缺 question → McpError(InvalidParams), 非 crash, researchFanout 接缝未被调用', async () => {
    let seamCalled = false;
    const fakeFanout: ResearchFanout = async () => {
      seamCalled = true;
      return { runId: 'r', reportPath: '/tmp/r.md', summary: 's' };
    };
    const tool = createDagResearchTool(fakeFanout, { runRegistry: new RunRegistry() });

    let err: unknown;
    try {
      await call(tool, {});
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).code).toBe(ErrorCode.InvalidParams);
    expect((err as Error).message).toContain('question');
    expect(seamCalled).toBe(false);
  });

  test('happy path: question + 可选旗标透传接缝, {runId, reportPath, summary} JSON 回传', async () => {
    const captured: { params?: Parameters<ResearchFanout>[0] } = {};
    const fakeFanout: ResearchFanout = async (params) => {
      captured.params = params;
      return { runId: 'r-1', reportPath: '/tmp/report.md', summary: '摘要' };
    };
    const tool = createDagResearchTool(fakeFanout, { runRegistry: new RunRegistry() });

    // resume 是 dag-exec 子进程的接手参数 (内部, 不进 schema): 指定 registry runId = 报告文件名同源。
    const res = await call(tool, { question: '如何做 X?', council: true, super: false, k: 2, resume: 'r-1' });
    expect(res.isError).toBeFalsy();
    // runId 透传进接缝 (报告与 registry 同源), 其余旗标原样。
    expect(captured.params).toEqual({ question: '如何做 X?', council: true, super: false, k: 2, runId: 'r-1' });
    expect(JSON.parse(res.content[0]!.text)).toEqual({
      runId: 'r-1',
      reportPath: '/tmp/report.md',
      summary: '摘要',
    });
  });
});
