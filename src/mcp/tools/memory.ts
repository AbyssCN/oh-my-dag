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
import { annotateStaleness, stalenessLabel } from '../../harness/memory/staleness';

/** Fact payload for memory_remember (namespace + arbitrary fields). */
const FactInput = z.record(z.string(), z.unknown());

/**
 * 一次 recall 的总字符上限 (2026-08-28)。
 *
 * 实测本仓库:`omd.pattern` 均长 1161 字符、最长 4518,`k` 默认 10 ⇒ 最坏一次 recall
 * 吐 45k 字符 ≈ 11k token,而它**过去没有任何上界**。这不是理论风险 —— 89 条 live fact 里
 * 64 条超过 400 字符。
 *
 * 超预算时**按名次截断列表**并把丢掉的条数说出来,不做无声的逐条压缩:
 * 「第 7–10 条没给你」是可以处理的信息,「每条都被砍了一半」不是。
 */
const RECALL_TOTAL_CHARS = 8000;
/** 单条上限。超了给头部 + id,全文走 `memory_fact`(L0/L2 分层的那一刀)。 */
const RECALL_PER_FACT_CHARS = 1500;

/** Dependencies injected into tool handlers. */
export interface MemoryToolDeps {
  memory: OmdMemory;
  /**
   * 仓根 —— 代码锚(`evidence[].path`)是仓相对的,判陈旧要在这里拼绝对路径。
   * 省略 ⇒ `process.cwd()`。给错了的后果是全体 `anchored-missing`(不是 stale),
   * 方向是安全的那边:读侧只会少一个提醒,不会多一个假告警。
   */
  root?: string;
}

/**
 * Build memory_recall + memory_fact + memory_remember tool definitions.
 * Each handler is a pure fn closed over {memory}.
 */
export function createMemoryTools(deps: MemoryToolDeps): OmdMcpTool[] {
  return [makeRecall(deps), makeFact(deps), makeRemember(deps)];
}

// ---------------------------------------------------------------------------
// memory_recall — hybrid (FTS5 ⊕ vector) retrieval, top-k facts.
// ---------------------------------------------------------------------------

function makeRecall({ memory, root }: MemoryToolDeps): OmdMcpTool {
  return {
    name: 'memory_recall',
    // ⚠ ≤120 字符 (D-11 tools/list 闸)。长说明留给 chat 面那份, 不塞在这里。
    description:
      'Recall facts from omd self-memory (hybrid search). Ranked hits with confidence, source, anchor staleness.',
    inputSchema: {
      query: z.string().describe('Natural-language search query'),
      k: z.number().int().min(1).max(50).default(10).describe('Max results to return (default 10)'),
    },
    handler: async ({ query, k }) => {
      const raw: MemoryHit[] = await memory.retrieve(query as string, k as number);
      if (raw.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No matching facts found.' }] };
      }
      // 陈旧闸:零 LLM、零 token 的 sha 比对,顺带按降权重排(见 harness/memory/staleness.ts)。
      const hits = annotateStaleness(raw, root ?? process.cwd());

      const lines: string[] = [];
      let used = 0;
      let dropped = 0;
      for (const [i, h] of hits.entries()) {
        const f = h.fact;
        const conf = f.confidence?.level ?? 'unknown';
        const src = f.source_event_id ?? f.source_doc_id ?? '—';
        const cut = h.text.length > RECALL_PER_FACT_CHARS;
        const body = cut
          ? `${h.text.slice(0, RECALL_PER_FACT_CHARS)}…\n   [截断 ${h.text.length} 字符 → memory_fact("${h.id}") 取全文]`
          : h.text;
        const line = `${i + 1}. [${f.namespace}] conf=${conf} src=${src} rrf=${h.rrf.toFixed(4)}${stalenessLabel(h.staleness)} id=${h.id}\n   ${body}`;
        // 预算耗尽 → 停止列举, 但把丢掉的条数说出来 (仓规坑②: fail-open 不许吞证据)。
        if (used + line.length > RECALL_TOTAL_CHARS && lines.length > 0) {
          dropped = hits.length - i;
          break;
        }
        lines.push(line);
        used += line.length;
      }
      if (dropped > 0) {
        lines.push(`… 另有 ${dropped} 条命中因总预算 (${RECALL_TOTAL_CHARS} 字符) 未列出 — 收窄 query 或调小 k。`);
      }
      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    },
  };
}

// ---------------------------------------------------------------------------
// memory_fact — 按 id 取一条 fact 全文 (recall 截断后的 L2 出口)。
// ---------------------------------------------------------------------------

/**
 * 没有这个工具,`memory_recall` 的截断就是**内容永久不可达** —— 那正是自动注入路径上
 * `maxCharsPerFact=400` 今天在干的事(实测 64/89 条被砍,`approach` 字段整段看不见)。
 * 截断只有在配一个取全文的出口时才是分层,否则它就是丢失。
 */
function makeFact({ memory, root }: MemoryToolDeps): OmdMcpTool {
  return {
    name: 'memory_fact',
    description: 'Fetch one fact in full by id (from a memory_recall hit), with its code-anchor staleness detail.',
    inputSchema: {
      id: z.string().describe('Fact id from a memory_recall hit'),
    },
    handler: async ({ id }) => {
      const stored = memory.get(id as string);
      if (!stored) {
        // "不存在"与"已被 tombstone"在读侧都表现为拿不到 —— 但墓志铭分得开, 所以说出来。
        const ep = memory.epitaph(id as string);
        const why = ep
          ? `已 tombstone (reason=${ep.reason ?? 'NULL — 本次升级之前就死了, 死因无记录'}${ep.supersededBy ? `, 继任者=${ep.supersededBy}` : ''})`
          : '不存在';
        return { content: [{ type: 'text' as const, text: `No such live fact: ${id} — ${why}` }], isError: true };
      }
      const [ann] = annotateStaleness(
        [{ id: stored.id, fact: stored.fact, text: stored.text, rrf: 0 } as MemoryHit],
        root ?? process.cwd(),
      );
      const checks = ann!.checks.map(
        (c) => `   - ${c.path} ${c.verdict} (记的 ${c.expected} / 现在 ${c.actual ?? `NULL — ${c.why ?? '原因未记'}`})`,
      );
      return {
        content: [
          {
            type: 'text' as const,
            text:
              `[${stored.fact.namespace}] id=${stored.id} identity=${stored.identityKey}${stalenessLabel(ann!.staleness)}\n` +
              `${stored.text}\n` +
              (checks.length > 0 ? `代码锚:\n${checks.join('\n')}` : '代码锚: 无 (unanchored)'),
          },
        ],
      };
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
