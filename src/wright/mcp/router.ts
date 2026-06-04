/**
 * src/wright/mcp/router —— McpRouter: 连 N server / 索引工具 / 路由调用 / 健康重连。
 *
 * 纯逻辑 (client 经 factory 注入) → TDD 头号靶子。
 * MR-INV-2 后端经注入 client (默认 SDK)。MR-INV-10 故障隔离: 单 server 挂不污染其它。
 */
import {
  McpRouterError,
  type IndexedTool,
  type McpClient,
  type McpClientFactory,
  type ServerSpec,
  type ServerStatus,
} from './types';
import { createToolIndex, type MenuEntry, type ToolIndex } from './tool-index';

export interface ServerState {
  spec: ServerSpec;
  status: ServerStatus;
  enabled: boolean;
  tools: number;
}

export interface McpRouter {
  /** 装/连一个 server + 索引其工具。连不上 → 标 unavailable 并抛 (caller 决定继续与否)。 */
  add(spec: ServerSpec): Promise<ServerState>;
  remove(name: string): Promise<void>;
  toggle(name: string, enabled: boolean): void;
  /** BM25 检索 (只在 enabled 的 server)。 */
  search(need: string, k?: number): IndexedTool[];
  describe(id: string): IndexedTool | null;
  /** 路由执行; 连接错 → 标 unavailable + 有界重连重试一次。 */
  call(id: string, args: unknown): Promise<unknown>;
  menu(): MenuEntry[];
  status(): ServerState[];
  close(): Promise<void>;
}

interface Slot {
  spec: ServerSpec;
  client: McpClient | null;
  status: ServerStatus;
  enabled: boolean;
  tools: number;
}

export function createMcpRouter(opts: {
  factory: McpClientFactory;
  index?: ToolIndex;
  maxReconnect?: number;
}): McpRouter {
  const factory = opts.factory;
  const index = opts.index ?? createToolIndex();
  const maxReconnect = opts.maxReconnect ?? 1;
  const slots = new Map<string, Slot>();

  const toState = (s: Slot): ServerState => ({
    spec: s.spec,
    status: s.status,
    enabled: s.enabled,
    tools: s.tools,
  });

  async function connectAndIndex(spec: ServerSpec): Promise<number> {
    const client = await factory(spec);
    const raw = await client.listTools();
    const tools: IndexedTool[] = raw.map((t) => ({
      id: `${spec.name}/${t.name}`,
      server: spec.name,
      name: t.name,
      description: t.description ?? '',
      inputSchema: t.inputSchema ?? {},
    }));
    index.upsert(tools);
    const existing = slots.get(spec.name);
    if (existing) {
      // 原地改 (保 slot 引用稳定 → call() 重连后能看见新 client)
      if (existing.client && existing.client !== client) await existing.client.close().catch(() => {});
      existing.client = client;
      existing.status = 'connected';
      existing.tools = tools.length;
    } else {
      slots.set(spec.name, { spec, client, status: 'connected', enabled: true, tools: tools.length });
    }
    return tools.length;
  }

  /** 有界重连; 成功 → connected, 失败 → 保持 unavailable。 */
  async function reconnect(slot: Slot): Promise<void> {
    for (let i = 0; i < maxReconnect; i++) {
      try {
        await connectAndIndex(slot.spec);
        return;
      } catch {
        /* keep trying up to bound */
      }
    }
    slot.status = 'unavailable';
    slot.client = null;
  }

  return {
    async add(spec) {
      try {
        await connectAndIndex(spec);
        return toState(slots.get(spec.name)!);
      } catch (e) {
        // fail-closed: 标 unavailable 留槽 (boot 时 caller 可继续装别的)
        slots.set(spec.name, { spec, client: null, status: 'unavailable', enabled: true, tools: 0 });
        throw new McpRouterError(`connect "${spec.name}" failed: ${(e as Error).message}`, 'connect_failed');
      }
    },

    async remove(name) {
      const s = slots.get(name);
      if (s?.client) await s.client.close().catch(() => {});
      slots.delete(name);
      index.removeServer(name);
    },

    toggle(name, enabled) {
      const s = slots.get(name);
      if (!s) throw new McpRouterError(`unknown server "${name}"`, 'unknown_server');
      s.enabled = enabled;
    },

    search(need, k = 5) {
      return index.search(need, k).filter((t) => slots.get(t.server)?.enabled !== false);
    },

    describe(id) {
      return index.get(id);
    },

    async call(id, args) {
      const tool = index.get(id);
      if (!tool) throw new McpRouterError(`unknown tool "${id}"`, 'unknown_tool');
      const slot = slots.get(tool.server);
      if (!slot) throw new McpRouterError(`server "${tool.server}" not registered`, 'unknown_server');
      if (slot.enabled === false) throw new McpRouterError(`server "${tool.server}" disabled`, 'disabled');

      if (slot.status === 'unavailable' || !slot.client) await reconnect(slot);
      if (!slot.client) throw new McpRouterError(`server "${tool.server}" unavailable`, 'unavailable');

      try {
        return await slot.client.callTool(tool.name, args);
      } catch (e) {
        // 连接错 → 标 unavailable + 重连重试一次 (MR-INV-10); 仅影响本 server
        slot.status = 'unavailable';
        await reconnect(slot);
        if (!slot.client) throw new McpRouterError(`server "${tool.server}" unavailable: ${(e as Error).message}`, 'unavailable');
        return await slot.client.callTool(tool.name, args);
      }
    },

    menu() {
      const enabled = new Set([...slots.values()].filter((s) => s.enabled).map((s) => s.spec.name));
      return index.menu().filter((m) => enabled.has(m.server));
    },

    status() {
      return [...slots.values()].map(toState);
    },

    async close() {
      for (const s of slots.values()) if (s.client) await s.client.close().catch(() => {});
      index.close();
    },
  };
}
