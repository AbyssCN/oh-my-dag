/**
 * src/mcp/tools/memory — memory_recall + memory_remember MCP tools (D-54).
 *
 * Pure-fn factory: createMemoryTools({memory, cwd}) → OmdMcpTool[].
 * Handlers inject OmdMemory seam; recall = hybrid retrieve, remember = validateFactWrite gate → writeFact.
 * Explicit remember bypasses secret scan (user sovereignty — validator §scanSecrets).
 */
import { z } from 'zod';
import type { OmdMcpTool } from '../server';
import type { OmdMemory } from '../../harness/memory/store';
import type { MemoryHit } from '../../harness/memory/types';

/** Fact payload for memory_remember (namespace + arbitrary fields). */
const FactInput = z.record(z.string(), z.unknown());

/** Dependencies injected into tool handlers. */
export interface MemoryToolDeps {
  memory: OmdMemory;
  cwd: string;
}

/**
 * Build memory_recall + memory_remember tool definitions.
 * Each handler is a pure fn closed over {memory, cwd}.
 */
export function createMemoryTools(deps: MemoryToolDeps): OmdMcpTool[] {
  return [makeRecall(deps), makeRemember(deps)];
}

// ---------------------------------------------------------------------------
// memory_recall — hybrid (FTS5 ⊕ vector) retrieval, top-k facts.
// ---------------------------------------------------------------------------

function makeRecall({ memory }: MemoryToolDeps): OmdMcpTool {
  return {
    name: 'memory_recall',
    description: 'Recall facts from omd self-memory by semantic + lexical hybrid search. Returns ranked hits with confidence and source.',
    inputSchema: {
      query: z.string().describe('Natural-language search query'),
      k: z.number().int().min(1).max(50).default(10).describe('Max results to return (default 10)'),
    },
    handler: async ({ query, k }) => {
      const hits: MemoryHit[] = await memory.retrieve(query as string, k as number);
      if (hits.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No matching facts found.' }] };
      }
      const lines = hits.map((h, i) => {
        const f = h.fact;
        const conf = f.confidence?.level ?? 'unknown';
        const src = f.source_event_id ?? f.source_doc_id ?? '—';
        return `${i + 1}. [${f.namespace}] conf=${conf} src=${src} rrf=${h.rrf.toFixed(4)}\n   ${h.text}`;
      });
      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    },
  };
}

// ---------------------------------------------------------------------------
// memory_remember — validate gate → writeFact (explicit: no secret scan).
// ---------------------------------------------------------------------------

function makeRemember({ memory }: MemoryToolDeps): OmdMcpTool {
  return {
    name: 'memory_remember',
    description: 'Store a fact in omd self-memory. Validated by safeguard gate; rejects secrets/banned/out-of-namespace.',
    inputSchema: {
      fact: FactInput.describe('Fact object — must include namespace, confidence, source_event_id|source_doc_id'),
    },
    handler: async ({ fact }) => {
      // Explicit remember: user sovereignty → scanSecrets=false (validator §scanSecrets).
      const result = await memory.writeFact(fact, { scanSecrets: false });
      if (result.status === 'rejected') {
        const ban = result.banned ? ' [BANNED]' : '';
        return {
          content: [{ type: 'text' as const, text: `REJECTED${ban}: ${result.reason}` }],
          isError: true,
        };
      }
      return {
        content: [{ type: 'text' as const, text: `OK id=${result.id} action=${result.action}` }],
      };
    },
  };
}
