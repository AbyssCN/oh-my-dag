/**
 * src/valar/mcp —— MCP 路由层 (Contract D74)。
 * 轴 A (Phase 1): 所有 MCP 收敛一个路由, LLM 只见菜单 + 3 meta-tool, 加 MCP 不膨胀 context。
 * 轴 B (Phase 2, TODO): ctx_execute 子进程沙箱 + 大输出 FTS5 索引。
 */
export * from './types';
export { createToolIndex, ftsQuery, type ToolIndex, type MenuEntry } from './tool-index';
export { createMcpRouter, type McpRouter, type ServerState } from './router';
export { sdkClientFactory } from './sdk-client';
export { createMcpRouterExtension, menuBlock, defaultParseSpec, type McpRouterExtensionOpts } from './mcp-router-extension';
export { loadServerSpecs, createMcpStackFromConfig, type McpStack } from './config';
// 轴 B 输出沙箱
export { createOutputStore, chunkContent, type OutputStore, type Chunk } from './output-store';
export { ctxExecute, defaultExecRunner, type ExecLang, type ExecRunner, type ExecOutcome } from './sandbox';
export { createOutputSandboxExtension, offloadBigOutput, contentText, type OutputSandboxOpts, type ToolResultLike } from './output-sandbox-extension';
