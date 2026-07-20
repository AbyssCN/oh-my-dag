/**
 * src/mcp/server —— omd MCP server 纯组装 (SDD 2026-07-19 omd-mcp-server, D-1/D-9)。
 * Server + StdioServerTransport + 工具注册, 零逻辑: 工具处理器住 src/mcp/tools/*.ts
 * (纯函数 + 注入接缝, 由后续 task 装配), 此处只把工具面挂上 SDK server。
 * stdout 是 MCP 协议通道 —— 本模块不写 stdout; 入口 (tui.ts `omd mcp`) 负责静默 logger。
 */
import { McpServer, type ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Implementation } from '@modelcontextprotocol/sdk/types.js';
import type { ZodRawShapeCompat } from '@modelcontextprotocol/sdk/server/zod-compat.js';

/** 注册面工具定义。D-11: description 一行 ≤120 字符 (说明书住 SKILL/CLAUDE.md, 客户端每轮付 description 税)。 */
export interface OmdMcpTool {
  name: string;
  description: string;
  inputSchema: ZodRawShapeCompat;
  handler: ToolCallback<ZodRawShapeCompat>;
}

/** 组装 server + 注册工具面: 纯循环无分支。info 由调用方给 (测试传固定值, 入口传包版本)。 */
export function createOmdMcpServer(tools: readonly OmdMcpTool[], info: Implementation): McpServer {
  const server = new McpServer(info);
  for (const t of tools) {
    server.registerTool(t.name, { description: t.description, inputSchema: t.inputSchema }, t.handler);
  }
  // SDK 只在首次 registerTool 时才装 tools/list|tools/call 处理器 —— 空注册面 (骨架期) 下
  // tools/list 会吃 -32601。此处无条件初始化 (已装则 SDK 内部 early-return), 空面回 {tools: []}。
  (server as unknown as { setToolRequestHandlers(): void }).setToolRequestHandlers();
  return server;
}

/** stdio 入口 (D-1): 防御式读包版本 (同 tui banner 范式, 失败不阻断) + 挂 stdio 传输。常驻, 生命周期客户端管 (D-9)。
 * 退出双保险 (审核实测: 客户端消失后僵尸 100% CPU 忙转): SDK StdioServerTransport 只挂 stdin data/error,
 * 不听 end/close —— stdin EOF 时 onclose 永不触发, Bun flowing-mode stdin 对已关 fd 空轮询 → 忙转。
 * 此处事件驱动零轮询: stdin 'end'/'close' 或 transport onclose (SDK 正常关闭路径) 任一触发即干净收尾。 */
export async function runOmdMcpServer(tools: readonly OmdMcpTool[]): Promise<void> {
  let version = '0.0.0';
  try {
    const pkg = (await import('../../package.json')) as unknown as {
      version?: string;
      default?: { version?: string };
    };
    version = pkg.version ?? pkg.default?.version ?? version;
  } catch { /* 版本读不到 → 兜底版本号, server 照起 */ }
  const server = createOmdMcpServer(tools, { name: 'omd', version });
  await server.connect(new StdioServerTransport());
  // connect 在 transport start 后即 resolve —— 挂住直到客户端断开, 否则调用方继续执行 = server 被秒杀。
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      process.stdin.removeListener('end', finish);
      process.stdin.removeListener('close', finish);
      resolve();
    };
    process.stdin.once('end', finish);
    process.stdin.once('close', finish);
    server.server.onclose = finish;
    // EOF 竞态: connect 期间 stdin 已结束 → end/close 已发过, 直接收尾不等下一拍。
    if (process.stdin.readableEnded || process.stdin.destroyed) finish();
  });
  // 收尾断忙转源头: transport.close 摘 stdin data 监听 + pause; destroy 兜底已 EOF 的 fd。
  // server.close 会回触发 onclose → finish (已 settled, 幂等 no-op)。
  await server.close().catch(() => {});
  try { process.stdin.destroy(); } catch { /* 已销毁 */ }
}
