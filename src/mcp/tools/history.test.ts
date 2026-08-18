/**
 * history MCP tool contract tests.
 *
 * Red gates: remove compaction id validation -> missing-id tests fail; call any
 * store write port -> read-only test fails; drop offset/seq fields -> paging/search
 * assertions fail. Recall functions are injected here because S1 is a separate slice.
 */
import { describe, expect, test } from 'bun:test';
import type { OmdSession, OmdSessionStore } from '../../harness/chat/session-store';
import {
  createHistoryTools,
  HistoryCompactionNotFoundError,
  type BranchEntries,
  type HistoryRecall,
} from './history';
import type { OmdMcpTool } from '../server';

const entries = [] as unknown as BranchEntries;

const recall: HistoryRecall = {
  listShadowedSpans: () => [{ compactionEntryId: 'c-1', startSeq: 2, endSeq: 3, count: 2 }],
  renderShadowedTranscript: (_entries, id, opts) => ({
    text: `rendered ${id} offset=${opts?.offset ?? 0}`,
    nextOffset: opts?.offset === 2 ? undefined : 2,
  }),
  searchShadowedSpans: (_entries, query, opts) => ({
    snippets: [{ compactionEntryId: opts?.compactionEntryId ?? 'c-1', seq: 3, snippet: `${query} hit` }],
    scanned: 1,
    matched: 1,
    truncated: false,
  }),
};

const session = {
  entries: async () => entries,
} as unknown as OmdSession;

const makeStore = (onOpen?: () => void): OmdSessionStore =>
  ({
    open: async () => {
      onOpen?.();
      return session;
    },
  }) as unknown as OmdSessionStore;

const call = async (tool: OmdMcpTool, args: Record<string, unknown>) =>
  (await (tool.handler as (a: unknown, e: unknown) => unknown)(args, {})) as {
    content: { text?: string }[];
    isError?: boolean;
  };

const tools = (store = makeStore()) => createHistoryTools({ store, sessionId: 'sid-1', recall });

describe('history tools', () => {
  test('schema exposes exactly two read-only tools and frozen arguments', () => {
    const [readTool, searchTool] = tools();
    expect([readTool.name, searchTool.name]).toEqual(['history_read', 'history_search']);
    expect(Object.keys(readTool.inputSchema)).toEqual(['compactionEntryId', 'offset']);
    expect(Object.keys(searchTool.inputSchema)).toEqual(['query', 'compactionEntryId', 'limit']);
    expect(readTool.description).toContain('Read');
    expect(searchTool.description).toContain('Search');
  });

  test('tools only open and read entries; no write port is called', async () => {
    let opened = 0;
    const [readTool, searchTool] = tools(makeStore(() => opened++));
    await call(readTool, { compactionEntryId: 'c-1' });
    await call(searchTool, { query: 'needle' });
    expect(opened).toBe(2);
  });

  test('missing compaction id is typed error and message names id for both tools', async () => {
    const missing = 'c-does-not-exist';
    const absentRecall: HistoryRecall = {
      ...recall,
      listShadowedSpans: () => [],
    };
    const [readTool, searchTool] = createHistoryTools({ store: makeStore(), sessionId: 'sid-1', recall: absentRecall });
    const assertMissing = async (tool: OmdMcpTool, args: Record<string, unknown>): Promise<void> => {
      let thrown: unknown;
      try {
        await call(tool, args);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(HistoryCompactionNotFoundError);
      expect(String(thrown)).toContain(missing);
    };
    await assertMissing(readTool, { compactionEntryId: missing });
    await assertMissing(searchTool, { query: 'x', compactionEntryId: missing });
  });

  test('history_read forwards offset and returns nextOffset page marker', async () => {
    const [readTool] = tools();
    const result = await call(readTool, { compactionEntryId: 'c-1', offset: 2 });
    const body = JSON.parse(result.content[0]!.text!);
    expect(body).toEqual({ compactionEntryId: 'c-1', text: 'rendered c-1 offset=2' });
  });

  test('history_search returns compactionEntryId and seq with hit', async () => {
    const [, searchTool] = tools();
    const result = await call(searchTool, { query: 'needle', compactionEntryId: 'c-1', limit: 5 });
    const body = JSON.parse(result.content[0]!.text!);
    expect(body.snippets).toEqual([{ compactionEntryId: 'c-1', seq: 3, snippet: 'needle hit' }]);
    expect(body.matched).toBe(1);
  });
});
