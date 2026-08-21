/**
 * src/mcp/tools/memory — memory_recall + memory_remember MCP tools (D-54).
 *
 * Pure-fn factory: createMemoryTools({memory}) → OmdMcpTool[].
 * Handlers inject OmdMemory seam; recall = hybrid retrieve, remember = validateFactWrite gate → writeFact.
 * Explicit remember bypasses secret scan (user sovereignty — validator §scanSecrets).
 */
import { z } from 'zod';
import type { OmdMcpTool } from '../server';
import type { OmdMemory } from '../../harness/memory/store';
import type { MemoryHit } from '../../harness/memory/types';

/**
 * Fact payload for memory_remember (namespace + arbitrary fields)。
 *
 * ## 为什么要收 JSON 字符串(2026-08-21,实测拒写)
 *
 * 原实现只收对象。而 **MCP 客户端对"嵌套 object 参数"的序列化并不统一** —— 有的把整个
 * `fact` 当 JSON 字符串塞进来。实测(Claude Code 这条通道):四次 `memory_remember` 里三次
 * 服务端收到的是字符串,闸报 `Invalid input: expected object, received string` →
 * **这个工具在那种客户端上一条都写不进去**。
 *
 * 关键在于它的失败长得像**内容**问题而不是**传输**问题:判词说的是 schema 不合格,
 * 于是人会去反复改 fact 的字段(我就改了三轮),而字段从头到尾都是对的。
 *
 * 修法是 Postel:出口严、入口宽。字符串就 `JSON.parse` 一次,解析不出来才拒 ——
 * **收宽的只是编码,不是判据**:parse 出来的对象照样过 `validateFactWrite` 那道闸,
 * namespace / 密钥 / 越界一个都不放。
 */
const FactInput = z.union([
  z.record(z.string(), z.unknown()),
  z.string().transform((s, ctx) => {
    try {
      const parsed: unknown = JSON.parse(s);
      // 数组/标量 parse 得出来但不是 fact —— 明确拒,别让它带着错误形状往下走。
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        ctx.addIssue({ code: 'custom', message: 'fact 是 JSON 字符串但解析出来不是对象' });
        return z.NEVER;
      }
      return parsed as Record<string, unknown>;
    } catch {
      ctx.addIssue({ code: 'custom', message: 'fact 是字符串但不是合法 JSON' });
      return z.NEVER;
    }
  }),
]);

/** Dependencies injected into tool handlers. */
export interface MemoryToolDeps {
  memory: OmdMemory;
}

/**
 * Build memory_recall + memory_remember tool definitions.
 * Each handler is a pure fn closed over {memory}.
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
