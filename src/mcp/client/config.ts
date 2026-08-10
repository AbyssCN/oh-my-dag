/**
 * src/mcp/client/config —— 外部 MCP server 注册表读取面(开放生态 SDD S1 / D-3)。
 * SDD: docs/plan/2026-08-10-omd-open-ecosystem-sdd.md
 *
 * 真源 = `<cwd>/.omd/mcp.json`,格式用生态标准 `mcpServers`(别人从 Claude Code / Mini-Agent
 * 迁入零改动)。可选只读兼容工程根 `.mcp.json`:默认关,`importClaudeConfig: true` 显式开;
 * **I-4:对 `.mcp.json` 只读** —— 全仓「绝不写入」承诺(config-tools.ts:13)在这里同样成立。
 *
 * 坏配置不静默:JSON 解析失败 → `loadError` 带原文返回,不是空表。空表意味着 meta-tool
 * 不挂载(I-2),用户会把"配置写错了"读成"机制不存在" —— 那是 S-3 族静默失效。
 * loadError 存在时 meta-tool 照挂,把错误暴露在工具返回值里(fail-open 不吞证据)。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../../logger';

export type McpTransportKind = 'stdio' | 'sse' | 'http';

export interface McpServerConfig {
  name: string;
  kind: McpTransportKind;
  /** stdio 传输。 */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** sse / http 传输。 */
  url?: string;
  headers?: Record<string, string>;
  /** O-3:缺省抄 Mini-Agent 实测值(10s/60s),待实测校准。 */
  connectTimeoutMs: number;
  callTimeoutMs: number;
}

export interface McpClientConfig {
  servers: McpServerConfig[];
  /** 配置文件存在但读不出来时的错误原文;undefined = 没出错(含文件不存在)。 */
  loadError?: string;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_CALL_TIMEOUT_MS = 60_000;

interface RawServerEntry {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  type?: string;
  disabled?: boolean;
  connectTimeoutMs?: number;
  callTimeoutMs?: number;
}

/** 传输判定:显式 `type` 优先;否则 url → http(streamable),command → stdio(与生态惯例一致)。 */
function inferKind(name: string, raw: RawServerEntry): McpTransportKind | null {
  const t = raw.type?.toLowerCase();
  if (t === 'stdio') return 'stdio';
  if (t === 'sse') return 'sse';
  if (t === 'http' || t === 'streamable-http' || t === 'streamable_http') return 'http';
  if (t) {
    logger.warn({ server: name, type: raw.type }, '[omd/mcp-client] 未知 transport type —— 该 server 跳过');
    return null;
  }
  if (raw.url) return 'http';
  if (raw.command) return 'stdio';
  logger.warn({ server: name }, '[omd/mcp-client] 既无 command 也无 url —— 该 server 跳过');
  return null;
}

function parseServers(mcpServers: Record<string, RawServerEntry>): McpServerConfig[] {
  const out: McpServerConfig[] = [];
  for (const [name, raw] of Object.entries(mcpServers)) {
    if (raw.disabled) continue;
    const kind = inferKind(name, raw);
    if (!kind) continue;
    if (kind === 'stdio' && !raw.command) {
      logger.warn({ server: name }, '[omd/mcp-client] stdio server 缺 command —— 跳过');
      continue;
    }
    if (kind !== 'stdio' && !raw.url) {
      logger.warn({ server: name, kind }, '[omd/mcp-client] 远程 server 缺 url —— 跳过');
      continue;
    }
    out.push({
      name,
      kind,
      ...(raw.command ? { command: raw.command } : {}),
      ...(raw.args ? { args: raw.args } : {}),
      ...(raw.env ? { env: raw.env } : {}),
      ...(raw.url ? { url: raw.url } : {}),
      ...(raw.headers ? { headers: raw.headers } : {}),
      connectTimeoutMs: raw.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
      callTimeoutMs: raw.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
    });
  }
  return out;
}

function readMcpServersFile(path: string): Record<string, RawServerEntry> | null {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return null; // 文件不存在 = 没注册,不是错误。
  }
  const parsed = JSON.parse(text) as { mcpServers?: Record<string, RawServerEntry> };
  return parsed.mcpServers ?? {};
}

/**
 * 读注册表。文件不存在 → 空表(meta-tool 不挂,I-2);文件坏 → 空表 + loadError(meta-tool
 * 照挂并暴露错误)。`.omd/mcp.json` 同名条目**覆盖** `.mcp.json` 的(本仓配置优先)。
 */
export function loadMcpClientConfig(cwd: string): McpClientConfig {
  const ownPath = join(cwd, '.omd', 'mcp.json');
  try {
    const own = readMcpServersFile(ownPath);
    if (own === null) return { servers: [] };
    const raw = readFileSync(ownPath, 'utf8');
    const flags = JSON.parse(raw) as { importClaudeConfig?: boolean };
    let merged = own;
    if (flags.importClaudeConfig === true) {
      try {
        const claude = readMcpServersFile(join(cwd, '.mcp.json')); // 只读(I-4)
        if (claude) merged = { ...claude, ...own };
      } catch (e) {
        // `.mcp.json` 坏不拖垮自家配置 —— warn 留痕,继续用 .omd 的。
        logger.warn({ err: (e as Error).message }, '[omd/mcp-client] .mcp.json 读取失败 (importClaudeConfig) —— 忽略该文件');
      }
    }
    return { servers: parseServers(merged) };
  } catch (e) {
    const msg = (e as Error).message;
    logger.warn({ err: msg, path: ownPath }, '[omd/mcp-client] .omd/mcp.json 读取失败 —— servers 空 + loadError 暴露');
    return { servers: [], loadError: `${ownPath}: ${msg}` };
  }
}
