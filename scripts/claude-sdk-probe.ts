/**
 * scripts/claude-sdk-probe.ts —— S0 最小实验:Claude Agent SDK 订阅通道可行性探针。
 *
 * 【实验四要素 —— 动手前钉死,别改】
 * 单一变量:通道(Claude Agent SDK + 订阅 OAuth)。模型固定 claude-sonnet-5,任务固定
 *   「调一次 ping 工具并复述 nonce」,不与任何其它改动混跑。
 * 成败信号(预先声明):
 *   ✅ 成 = ① SDKResultSuccess 到达且退出码 0
 *          ② result.usage 的 input+output tokens > 0
 *          ③ ping handler 真被调用(flag)且回复里含 nonce(工具结果真进了上下文)
 *          ④ 本进程 env 无 ANTHROPIC_API_KEY(显式删除)→ 成功即证认证走的是
 *             CLI 登录态/订阅,不是 API key
 *   ❌ 塌 = 任一条不满足。塌了记:error subtype + stderr 原文(方向:auth / MCP 桥 / 权限)。
 * 对照基线:无需外部基线 —— 判据是二值可行性,不是性能对比。
 * 收数:成 → usage 数字 + total_cost_usd 值(订阅模式下它报什么本身就是账本设计的输入);
 *       塌 → 第一条 error 消息原文。
 *
 * 跑法:bun run scripts/claude-sdk-probe.ts
 */
import { query } from '@anthropic-ai/claude-agent-sdk';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'node:crypto';

const nonce = randomUUID().slice(0, 8);
let pingCalled = false;

// 低层 handler 直喂 JSON Schema —— 正式 adapter 桥 OmdTool(TypeBox=JSON Schema)走同一条路。
const server = new McpServer({ name: 'omd-probe', version: '0.0.1' }, { capabilities: { tools: {} } });
server.server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'ping',
      description: 'Returns a pong with a secret nonce. Call it exactly once.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
  ],
}));
server.server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name !== 'ping') throw new Error(`unknown tool ${req.params.name}`);
  pingCalled = true;
  return { content: [{ type: 'text', text: `pong nonce=${nonce}` }] };
});

// ④ 的前提:确保不是 API key 在兜底。
delete process.env.ANTHROPIC_API_KEY;

const q = query({
  prompt: `Call the ping tool once, then reply with exactly the nonce it returns and nothing else.`,
  options: {
    model: 'claude-sonnet-5',
    tools: [],
    mcpServers: { omd: { type: 'sdk', name: 'omd-probe', instance: server } },
    allowedTools: ['mcp__omd__ping'],
    maxTurns: 3,
    systemPrompt: 'You are a connectivity probe. Do exactly what the prompt says.',
  },
});

let resultSeen = false;
for await (const msg of q) {
  if (msg.type === 'result') {
    resultSeen = true;
    const ok = msg.subtype === 'success';
    const usage = 'usage' in msg ? msg.usage : undefined;
    const tokens = (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0);
    const reply = ok && 'result' in msg ? msg.result : '';
    const hasNonce = typeof reply === 'string' && reply.includes(nonce);
    console.log(
      JSON.stringify(
        {
          probe: 'claude-sdk-subscription',
          signals: {
            resultSuccess: ok,
            tokensPositive: tokens > 0,
            pingCalled,
            replyHasNonce: hasNonce,
            noApiKeyInEnv: !process.env.ANTHROPIC_API_KEY,
          },
          readings: {
            subtype: msg.subtype,
            tokens,
            usage,
            total_cost_usd: 'total_cost_usd' in msg ? msg.total_cost_usd : null,
            modelUsage: 'modelUsage' in msg ? (msg as { modelUsage?: unknown }).modelUsage : null,
            reply,
          },
        },
        null,
        2,
      ),
    );
    const pass = ok && tokens > 0 && pingCalled && hasNonce;
    process.exit(pass ? 0 : 1);
  }
}
console.error('[probe] 流结束但没收到 result 消息');
process.exit(resultSeen ? 1 : 2);
