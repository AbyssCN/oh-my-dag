/**
 * src/mcp/tools/history —— compaction 后被遮蔽会话原文的只读工具。
 *
 * S1 的 history-recall 只做纯 span 计算；这里负责把固定 sessionId 绑定到 MCP
 * handler。工具不写 session，也不把“当前会话”藏进全局取值器。
 */
import { z } from 'zod';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type { OmdMcpTool } from '../server';
import type { OmdSession, OmdSessionStore } from '../../harness/chat/session-store';

export type BranchEntries = Awaited<ReturnType<OmdSession['entries']>>;

export interface ShadowedSpan {
  compactionEntryId: string;
  startSeq: number;
  endSeq: number;
  count: number;
}

export interface HistoryRecall {
  listShadowedSpans(entries: BranchEntries): ShadowedSpan[];
  renderShadowedTranscript(
    entries: BranchEntries,
    compactionEntryId: string,
    opts?: { offset?: number; budgetChars?: number },
  ): { text: string; nextOffset?: number };
  searchShadowedSpans(
    entries: BranchEntries,
    query: string,
    opts?: { compactionEntryId?: string; limit?: number },
  ): {
    snippets: Array<{ compactionEntryId: string; seq: number; snippet: string }>;
    scanned: number;
    matched: number;
    truncated: boolean;
  };
}

/** Fixed session binding for one conductor turn. `sessionId` must stay a string. */
export interface HistoryToolDeps {
  store: OmdSessionStore;
  sessionId: string;
  /** Test seam; production lazily consumes S1's frozen module. */
  recall?: HistoryRecall;
}

export class HistoryCompactionNotFoundError extends McpError {
  readonly compactionEntryId: string;

  constructor(compactionEntryId: string, sessionId: string) {
    super(
      ErrorCode.InvalidParams,
      `history: compactionEntryId '${compactionEntryId}' not found in session '${sessionId}'`,
    );
    this.name = 'HistoryCompactionNotFoundError';
    this.compactionEntryId = compactionEntryId;
  }
}

class HistorySessionNotFoundError extends McpError {
  constructor(sessionId: string) {
    super(ErrorCode.InvalidParams, `history: session '${sessionId}' not found`);
    this.name = 'HistorySessionNotFoundError';
  }
}

/**
 * Build history_read + history_search. Each handler opens only its bound session
 * and reads branch entries; no handler calls create/append/delete or mutates store state.
 */
export function createHistoryTools(deps: HistoryToolDeps): [OmdMcpTool, OmdMcpTool] {
  return [makeHistoryRead(deps), makeHistorySearch(deps)];
}

async function loadEntries(deps: HistoryToolDeps, compactionEntryId?: string): Promise<BranchEntries> {
  const session = await deps.store.open(deps.sessionId);
  if (!session) {
    if (compactionEntryId) throw new HistoryCompactionNotFoundError(compactionEntryId, deps.sessionId);
    throw new HistorySessionNotFoundError(deps.sessionId);
  }
  return session.entries();
}

async function loadRecall(deps: HistoryToolDeps): Promise<HistoryRecall> {
  if (deps.recall) return deps.recall;
  // C-1 provider is a parallel slice. Keep this consumer on frozen signatures without
  // duplicating span logic; the import resolves once S1 lands. Test seam above proves
  // this gate red if a tool silently substitutes an empty result for missing provider.
  const module = (await import('../../harness/chat/history-recall')) as unknown as HistoryRecall;
  return module;
}

function requireCompaction(
  recall: HistoryRecall,
  entries: BranchEntries,
  compactionEntryId: string,
  sessionId: string,
): void {
  if (!recall.listShadowedSpans(entries).some((span) => span.compactionEntryId === compactionEntryId)) {
    throw new HistoryCompactionNotFoundError(compactionEntryId, sessionId);
  }
}

function makeHistoryRead(deps: HistoryToolDeps): OmdMcpTool {
  return {
    name: 'history_read',
    description: 'Read paged original messages hidden by one compaction entry.',
    inputSchema: {
      compactionEntryId: z.string().describe('Compaction entry id from the summary footer'),
      offset: z.number().int().min(0).optional().describe('Transcript character offset (default 0)'),
    },
    handler: async (args) => {
      const { compactionEntryId, offset } = args as { compactionEntryId?: string; offset?: number };
      if (!compactionEntryId) {
        throw new McpError(ErrorCode.InvalidParams, 'history_read: missing required param "compactionEntryId"');
      }
      const entries = await loadEntries(deps, compactionEntryId);
      const recall = await loadRecall(deps);
      requireCompaction(recall, entries, compactionEntryId, deps.sessionId);
      const rendered = recall.renderShadowedTranscript(entries, compactionEntryId, {
        ...(offset !== undefined ? { offset } : {}),
      });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ compactionEntryId, ...rendered }) }],
      };
    },
  };
}

function makeHistorySearch(deps: HistoryToolDeps): OmdMcpTool {
  return {
    name: 'history_search',
    description: 'Search original messages hidden by compaction entries in this session.',
    inputSchema: {
      query: z.string().describe('Literal text to find in hidden original messages'),
      compactionEntryId: z.string().optional().describe('Restrict search to one compaction entry'),
      limit: z.number().int().min(1).max(50).optional().describe('Maximum snippets to return'),
    },
    handler: async (args) => {
      const { query, compactionEntryId, limit } = args as {
        query?: string;
        compactionEntryId?: string;
        limit?: number;
      };
      if (!query) throw new McpError(ErrorCode.InvalidParams, 'history_search: missing required param "query"');
      const entries = await loadEntries(deps, compactionEntryId);
      const recall = await loadRecall(deps);
      if (compactionEntryId) requireCompaction(recall, entries, compactionEntryId, deps.sessionId);
      const result = recall.searchShadowedSpans(entries, query, {
        ...(compactionEntryId ? { compactionEntryId } : {}),
        ...(limit !== undefined ? { limit } : {}),
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    },
  };
}
