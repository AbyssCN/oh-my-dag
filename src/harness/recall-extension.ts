/**
 * src/harness/recall-extension —— omd 自我记忆**检索工具**, 挂进交互 TUI。
 *
 * 注册 `recall` 工具: 对 ValalMemory 做混合检索 (RRF ⊕ vector ⊕ BM25), 返人读摘要。
 * 跟 `remember` 配对: 记 + 查, TUI 内透明记忆操作。
 */
import { Type, type Static } from 'typebox';
import {
  defineTool,
  type ExtensionFactory,
  type ExtensionContext,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import type { OmdMemory } from './memory';
import type { MemoryHit } from './memory/types';
import { m } from './i18n';

const RECALL_SCHEMA = Type.Object({
  query: Type.String({
    description: m({
      en: 'Search query (natural-language fragment, more words = more precise)',
      zh: '检索查询 (自然语言片段, 词越多越准)',
    }),
    minLength: 1,
  }),
  k: Type.Optional(
    Type.Integer({
      description: m({ en: 'How many to return (default 5, max 50)', zh: '返多少条 (默认 5, 上限 50)' }),
      minimum: 1,
      maximum: 50,
      default: 5,
    }),
  ),
});
type RecallParams = Static<typeof RECALL_SCHEMA>;

function textResult(text: string, details: Record<string, unknown> = {}): {
  content: { type: 'text'; text: string }[];
  details: Record<string, unknown>;
} {
  return { content: [{ type: 'text', text }], details };
}

/** 一条 hit 的人读单行。 */
function formatHit(h: MemoryHit, i: number): string {
  const ns = h.fact.namespace;
  const fields = Object.entries(h.fact as unknown as Record<string, unknown>)
    .filter(([k]) => !['namespace', 'confidence', 'source_event_id', 'source_doc_id'].includes(k))
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(', ');
  const sim = h.vecSim !== undefined ? ` sim=${h.vecSim.toFixed(3)}` : '';
  return `  [${i + 1}] ${ns}: ${fields} (rrf=${h.rrf.toFixed(2)}${sim})`;
}

export interface RecallExtensionOpts {
  memory: OmdMemory;
  /**
   * 零命中回调 (复利自学习 `recall_miss` 信号): 检索本应有先例却查空 = 记忆覆盖缺口, 值得学。
   * bus-agnostic —— tui 接 signalBus.emit recall_miss (镜像 grounding onGrounded 解耦)。
   */
  onMiss?: (query: string) => void;
}

export function createRecallExtension(opts: RecallExtensionOpts): ExtensionFactory {
  return (pi) => {
    pi.registerTool(
      defineTool({
        name: 'recall',
        label: 'Recall',
        description: m({
          en:
            'Retrieve relevant facts from omd long-term memory (SQLite, hybrid search). Good for known user preference / ' +
            'capability / pattern / goal / interest / limit.',
          zh:
            '从 omd 自身长期记忆 (SQLite, 混合检索) 检索相关事实。适合查已知 user preference / ' +
            'capability / pattern / goal / interest / limit。',
        }),
        promptSnippet: m({
          en: 'recall(query, k?) — hybrid-search omd memory, returns top-k fact summaries.',
          zh: 'recall(query, k?) — 混合检索 omd 记忆, 返 top-k 事实摘要。',
        }),
        parameters: RECALL_SCHEMA,
        executionMode: 'sequential',
        async execute(
          _id: string,
          params: RecallParams,
          _signal: AbortSignal | undefined,
          _onUpdate: unknown,
          _ctx: ExtensionContext,
        ) {
          const k = params.k ?? 5;
          const hits = await opts.memory.retrieve(params.query, k);

          if (hits.length === 0) {
            try { opts.onMiss?.(params.query); } catch { /* recall_miss 信号失败不阻断工具 */ }
            return textResult(m({ en: '(no matching memory)', zh: '(无匹配记忆)' }), { query: params.query, hits: [] });
          }

          const lines = [m({ en: `Memory search (${hits.length} hits):`, zh: `记忆检索 (${hits.length} 条):` })];
          for (const [i, hit] of hits.entries()) {
            lines.push(formatHit(hit, i));
          }

          return textResult(lines.join('\n'), {
            query: params.query,
            k,
            hits: hits.map((h) => ({
              id: h.id,
              namespace: h.fact.namespace,
              text: h.text,
              rrf: h.rrf,
              vecSim: h.vecSim,
            })),
          });
        },
      }) as unknown as ToolDefinition,
    );
  };
}
