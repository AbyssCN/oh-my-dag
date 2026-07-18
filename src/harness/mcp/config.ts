/**
 * src/harness/mcp/config —— 从 .omd/mcp-servers.json 装配 MCP 路由栈。
 *
 * 配置格式: { "servers": [ {name, command, args} | {name, url} ] }。文件缺 → 空栈 (不报错)。
 * boot 时某 server 连不上 → 记 warn + 标 unavailable + 继续 (MR-INV-10), 不阻断整个起步。
 */
import { existsSync, readFileSync } from 'node:fs';
import { createMcpRouter, type McpRouter } from './router';
import { sdkClientFactory } from './sdk-client';
import { createMcpRouterExtension } from './mcp-router-extension';
import type { McpClientFactory, ServerSpec } from './types';
import type { ToolIndex } from './tool-index';
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { logger } from '../../logger';

const DEFAULT_CONFIG = '.omd/mcp-servers.json';

/** 读配置文件 → ServerSpec[]。缺/坏 → []。 */
export function loadServerSpecs(path = DEFAULT_CONFIG): ServerSpec[] {
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { servers?: ServerSpec[] } | ServerSpec[];
    const list = Array.isArray(raw) ? raw : (raw.servers ?? []);
    return list.filter((s): s is ServerSpec => !!s && typeof s.name === 'string');
  } catch (e) {
    logger.warn({ path, err: (e as Error).message }, '[omd/mcp] config parse failed → 空栈');
    return [];
  }
}

export interface McpStack {
  router: McpRouter;
  extension: ExtensionFactory;
}

/** 装配: 建 router + 连配置里所有 server (连不上跳过继续) + 产 extension。 */
export async function createMcpStackFromConfig(
  opts: { configPath?: string; factory?: McpClientFactory; index?: ToolIndex; specs?: ServerSpec[] } = {},
): Promise<McpStack> {
  const specs = opts.specs ?? loadServerSpecs(opts.configPath);
  const router = createMcpRouter({ factory: opts.factory ?? sdkClientFactory, index: opts.index });
  for (const spec of specs) {
    try {
      await router.add(spec);
    } catch (e) {
      // fail-closed 已在 add 内标 unavailable; boot 时继续装别的 (MR-INV-10)。
      logger.warn({ server: spec.name, err: (e as Error).message }, '[omd/mcp] boot connect failed → unavailable, 继续');
    }
  }
  return { router, extension: createMcpRouterExtension({ router }) };
}
