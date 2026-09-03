/**
 * D-7/D-3 接线集成测试 (S2 verification-gap 修复)。从 tmp cwd 的**真实** `.omd/mcp.json`、
 * plan 节点 `mcp`、模板卡 frontmatter `mcp` 出发, 走**生产链** —— 测试侧零合并逻辑复刻:
 *   loadMcpClientConfig/knownMcpServerNames (注册表) → loadAgentTemplates (模板加载) →
 *   runExecutorDag (conductor parsePlan 必传 knownServers + executePlan agent-run 调用点
 *   mergeMcpAllow) → createAgentLeafRunner (createMcpClientTools + ALS per-call policy) →
 *   SDK 桥 (真 ListTools/CallTool 回路) → InMemory 外部 server + ':memory:' ledger。
 * 共用真源: engine 与本测试同调 conductor-plan.mergeMcpAllow; leaf 装配与本测试同调 agent-leaf.leafMcpPolicy。
 *
 * 反向自检 (哪条接线被拆, 哪条断言红):
 *  - 删 engine.ts agent-run 调用点的 mcpAllow 条件 spread, 或 mergeMcpAllow 只并一边 →
 *    测试 A 红 (seenMcpAllow 不再是去重并集; pokeA/pokeB 各只在一侧声明, 缺一边即被拒);
 *  - 把 leaf 缺省 policy 从 'deny' 改回 'allow' (leafMcpPolicy) → 测试 B 红 (未声明也放行,
 *    server.calls 非空, ledger 无 rejected-policy 行);
 *  - engine 两处 parsePlan 调用点不传 knownServers (或注册表不取自该 run 的 cwd) → 测试 C 红
 *    (ghost plan 被接受; 或注册 ghost 后仍被拒)。
 */
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { runExecutorDag } from '../../test/helpers/legacy-plan-entry';
import type { ExecutorDagConfig, GenerateFn } from './dag/types';
import { createAgentLeafRunner, leafMcpPolicy } from './agent-leaf';
import type { AgentLeafRunner } from './leaf-runners';
import { mergeMcpAllow, parsePlan } from './conductor-plan';
import { loadAgentTemplates } from './agent-templates';
import { knownMcpServerNames } from '../mcp/client/config';
import { openMcpCallLedger, type McpCallLedger } from '../mcp/client/call-ledger';
import { CheckpointManager } from './continuity/checkpoint-manager';

const MODEL = 'claude-code:claude-sonnet-5';

// ── SDK 消息假件 (照 agent-leaf-sdk.test.ts 形状) ─────────────────────────────
const asst = (text: string): SDKMessage =>
  ({
    type: 'assistant',
    session_id: 's',
    message: {
      content: [{ type: 'text', text }],
      usage: { input_tokens: 20, output_tokens: 9, cache_read_input_tokens: 5, cache_creation_input_tokens: 4 },
      stop_reason: 'end_turn',
    },
  }) as unknown as SDKMessage;
const success = (): SDKMessage =>
  ({ type: 'result', subtype: 'success', result: 'done', session_id: 's', usage: {} }) as unknown as SDKMessage;

const textOf = (r: unknown): string =>
  ((r as { content: Array<{ type: string; text?: string }> }).content ?? []).map((c) => c.text ?? '').join('\n');

/** 进程内外部 server 't': pokeA/pokeB 皆**无 readOnlyHint** (副作用类, C-5 判据)。calls = 真到 server 的调用。 */
function makeSideEffectServer(): { calls: string[]; connectTo: () => Promise<import('@modelcontextprotocol/sdk/shared/transport.js').Transport> } {
  const calls: string[] = [];
  const srv = new McpServer({ name: 't', version: '0' }, { capabilities: { tools: {} } });
  srv.server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: ['pokeA', 'pokeB'].map((name) => ({
      name,
      description: `side-effect ${name} (无 readOnlyHint)`,
      inputSchema: { type: 'object', properties: { msg: { type: 'string' } } },
    })),
  }));
  srv.server.setRequestHandler(CallToolRequestSchema, async (req) => {
    calls.push(req.params.name);
    return { content: [{ type: 'text' as const, text: `${req.params.name}:${(req.params.arguments as { msg?: string })?.msg}` }] };
  });
  return {
    calls,
    connectTo: async () => {
      const [clientT, serverT] = InMemoryTransport.createLinkedPair();
      await srv.connect(serverT);
      return clientT;
    },
  };
}

/** tmp cwd + 真实 .omd/mcp.json (server 't') + 模板卡 frontmatter mcp (与节点声明**不相交**的部分 pokeB)。 */
function makeTmpCwd(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'omd-mcp-wiring-'));
  mkdirSync(join(cwd, '.omd', 'agents'), { recursive: true });
  writeFileSync(join(cwd, '.omd', 'mcp.json'), JSON.stringify({ mcpServers: { t: { command: 'unused-by-inmemory' } } }));
  writeFileSync(
    join(cwd, '.omd', 'agents', 'wirer.md'),
    ['---', 'name: wirer', 'description: 接线测试卡', 'mcp:', "  - 't'", "  - 't:pokeB'", '---', '正文: 方法论。', ''].join('\n'),
  );
  return cwd;
}

/**
 * fake sdkQueryFn: 拿到 runner 装配的 options (含 omd 桥 instance), 开真 Client 经
 * InMemory linked pair 驱动 mcp_find/mcp_call —— 工具面/C-4/C-5 全走 runner 闭包里的真件。
 */
function driveBridge(
  opts: Options,
  script: (client: Client) => Promise<void>,
): AsyncIterable<SDKMessage> {
  return (async function* () {
    const inst = (opts.mcpServers as unknown as Record<string, { instance: McpServer }>).omd!.instance;
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'wiring', version: '0' });
    await Promise.all([inst.server.connect(a), client.connect(b)]);
    await script(client);
    await client.close();
    yield asst('改完了');
    yield success();
  })();
}

function makeConfig(cwd: string, generate: GenerateFn, extra: Partial<ExecutorDagConfig> = {}): ExecutorDagConfig {
  return {
    conductorModel: 'test:conductor',
    leafModel: 'test:leaf',
    agentLeafModel: MODEL,
    generate,
    continuity: { manager: new CheckpointManager(cwd), runId: 'wiring', repoRoot: cwd },
    ...extra,
  };
}

describe('D-7 并集接线 (生产链: parsePlan → 模板加载 → engine mergeMcpAllow → leaf policy.allow)', () => {
  test('A: node.mcp ∪ 模板卡 mcp 去重并集 → leaf policy.allow; 两个副作用工具经 InMemory 真实放行', async () => {
    const cwd = makeTmpCwd();
    // ── 生产解析/模板加载层 (真 .omd/mcp.json + 真 frontmatter) ──
    const knownServers = knownMcpServerNames(cwd);
    expect([...knownServers]).toEqual(['t']); // 注册表真从该 cwd 的 .omd/mcp.json 来
    const templates = loadAgentTemplates({ root: cwd });
    const tpl = templates.get('wirer');
    expect(tpl?.mcp).toEqual(['t', 't:pokeB']); // frontmatter 合法 mcp 进卡片 (详见 agent-templates.test.ts)
    const planJson = JSON.stringify({
      name: 'p',
      nodes: { a: { goal: '接线', executor: 'agent', template: 'wirer', mcp: ['t', 't:pokeA'] } },
    });
    const parsed = parsePlan(planJson, { knownTemplates: new Set(templates.keys()), knownServers });
    expect(parsed.ok).toBe(true);
    // ── 并集真源 (engine agent-run 调用点同调此函数): 不相交两半 + 重叠 't' 去重 ──
    const node = parsed.ok ? parsed.plan.nodes.a! : (() => { throw new Error('unreachable'); })();
    const merged = mergeMcpAllow(node, tpl);
    expect(merged).toEqual(['t', 't:pokeA', 't:pokeB']); // pokeA 仅节点侧, pokeB 仅卡片侧, 't' 两侧 → 一次
    expect(leafMcpPolicy(merged)).toEqual({ sideEffects: { allow: merged } }); // leaf 装配同一真源

    // ── 执行层: 同一份 planJson 作 conductor 回复, 走 runExecutorDag 生产入口 ──
    const server = makeSideEffectServer();
    const ledger: McpCallLedger = openMcpCallLedger({ db: new Database(':memory:') });
    const callResults: string[] = [];
    const leaf = createAgentLeafRunner({
      cwd,
      sdkQueryFn: (props) =>
        driveBridge(props.options, async (client) => {
          await client.callTool({ name: 'mcp_find', arguments: { query: 't:pokeA' } }); // C-4 教学闸
          await client.callTool({ name: 'mcp_find', arguments: { query: 't:pokeB' } });
          callResults.push(
            textOf(await client.callTool({ name: 'mcp_call', arguments: { tool: 't:pokeA', args: { msg: 'a' } } })),
            textOf(await client.callTool({ name: 'mcp_call', arguments: { tool: 't:pokeB', args: { msg: 'b' } } })),
          );
        }),
      mcpDeps: { poolDeps: { transportFactory: () => server.connectTo() }, ledger },
    });
    let seenMcpAllow: string[] | undefined;
    const agentRunner: AgentLeafRunner = async (input) => {
      seenMcpAllow = input.mcpAllow; // 引擎算好并**真传给 leaf** 的授权清单 (= leaf policy.allow 的输入)
      return leaf(input);
    };
    const conductor: GenerateFn = async () => ({ text: planJson, usage: { in: 1, out: 1 } });
    const r = await runExecutorDag('接线任务', makeConfig(cwd, conductor, { agentRunner }));

    expect(r.results.a!.status).toBe('done');
    // 并集断言 (证伪①: engine 删掉 mcpAllow spread → undefined; mergeMcpAllow 只并一边 → 缺 't:pokeA' 或 't:pokeB')。
    expect(seenMcpAllow).toEqual(['t', 't:pokeA', 't:pokeB']);
    // 两个无 readOnlyHint 的副作用工具**真实放行** (缺任一半并集 → 对应调用被拒 → 红)。
    expect(callResults).toEqual(['pokeA:a', 'pokeB:b']);
    expect(server.calls).toEqual(['pokeA', 'pokeB']);
    expect(ledger.rows().map((x) => x.status)).toEqual(['ok', 'ok']);
    ledger.close();
  });

  test('B: 未声明节点 → 副作用工具被拒, server 零调用, :memory: ledger 精确一行 rejected-policy', async () => {
    const cwd = makeTmpCwd();
    const server = makeSideEffectServer();
    const ledger: McpCallLedger = openMcpCallLedger({ db: new Database(':memory:') });
    const rejected: string[] = [];
    const leaf = createAgentLeafRunner({
      cwd,
      sdkQueryFn: (props) =>
        driveBridge(props.options, async (client) => {
          await client.callTool({ name: 'mcp_find', arguments: { query: 't:pokeA' } });
          rejected.push(textOf(await client.callTool({ name: 'mcp_call', arguments: { tool: 't:pokeA', args: { msg: 'x' } } })));
        }),
      mcpDeps: { poolDeps: { transportFactory: () => server.connectTo() }, ledger },
    });
    let seenMcpAllow: string[] | undefined;
    const agentRunner: AgentLeafRunner = async (input) => {
      seenMcpAllow = input.mcpAllow;
      return leaf(input);
    };
    // 节点不声明 mcp、不用模板 → 并集为空 → engine 不传 mcpAllow → leaf 回落 deny。
    const planJson = JSON.stringify({ name: 'p', nodes: { a: { goal: '不声明', executor: 'agent' } } });
    const conductor: GenerateFn = async () => ({ text: planJson, usage: { in: 1, out: 1 } });
    const r = await runExecutorDag('未声明任务', makeConfig(cwd, conductor, { agentRunner }));

    expect(r.results.a!.status).toBe('done'); // 节点本身跑完, 只是外部工具被闸
    expect(seenMcpAllow).toBeUndefined(); // 空并集 → 不传字段 (engine 条件 spread)
    expect(rejected[0]).toContain('拒绝'); // C-5 确定性拒绝
    expect(server.calls).toEqual([]); // 没发往 server
    const rows = ledger.rows();
    expect(rows).toHaveLength(1); // 精确一行 (C-4 find 不入账)
    expect(rows[0]!.status).toBe('rejected-policy');
    ledger.close();
    // 证伪②: leafMcpPolicy 缺省改 'allow' → 上面 server.calls 变 ['pokeA']、rows[0].status 变 'ok' → 红。
  });
});

describe('D-3 knownServers 生产接线 (惰性闸修复: 必传 + 来自该 run 的 cwd)', () => {
  test('C: 生产入口 runExecutorDag 拒未注册声明 (错误含 server 名); 同一 cwd 注册后即放行', async () => {
    const cwd = makeTmpCwd(); // 注册表只有 't'
    const planJson = JSON.stringify({ name: 'p', nodes: { a: { goal: '叶', mcp: ['ghost'] } } });
    const conductor: GenerateFn = async () => ({ text: planJson, usage: { in: 1, out: 1 } });
    // 负半: 未注册 'ghost' → conductor 规划层拒 → maxPlanRetries:0 → 引擎抛, 错误含 server 名。
    // (证伪③: engine parsePlan 调用点不传 knownServers → plan 被接受 → 不抛 → 红。)
    await expect(runExecutorDag('ghost 任务', makeConfig(cwd, conductor))).rejects.toThrow(/ghost/);
    // 正半: 把 'ghost' 写进**同一个 cwd** 的 .omd/mcp.json → 同一 plan 即被接受并执行。
    // 这证明生产调用点的注册表确实读自该 run 的 cwd (不是空 Set, 不是手传) —— 空 Set 会让这半也拒。
    writeFileSync(
      join(cwd, '.omd', 'mcp.json'),
      JSON.stringify({ mcpServers: { t: { command: 'unused' }, ghost: { command: 'unused' } } }),
    );
    let calls = 0;
    const conductorThenLeaf: GenerateFn = async () => {
      calls += 1;
      return calls === 1 ? { text: planJson, usage: { in: 1, out: 1 } } : { text: 'leaf done', usage: { in: 1, out: 1 } };
    };
    const r = await runExecutorDag('ghost 任务', makeConfig(cwd, conductorThenLeaf));
    expect(r.results.a!.status).toBe('done');
  });
});
