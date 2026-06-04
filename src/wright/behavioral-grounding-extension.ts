/**
 * src/wright/behavioral-grounding-extension —— 行为级自我 grounding。
 *
 * 每轮 LLM call 前 (context 事件) 自动检索 wright 长期记忆中的相关事实,
 * 经置信路由隔离后注入上下文, 让模型拿到相关事实而非纯参数 recall。
 *
 * 机制:
 *   ① 从 context 提取查询 (最后一条 user 消息文本)。
 *   ② memory.retrieve 做混合检索。
 *   ③ 置信路由隔离: 仅 wright.* namespace, confidence >= minLevel, 排除 agent_tentative。
 *   ④ 格式化注入文本, push 到 event.messages。
 *   ⑤ 空查询或无命中时不注入。
 */
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import type { WrightMemory, MemoryHit } from './memory';

export interface BehavioralGroundingOpts {
  /** WrightMemory 实例 (必须)。*/
  memory: WrightMemory;
  /** 检索 top-k。默认 5。*/
  k?: number;
  /**
   * 最低置信等级序数。默认 'agent_confident' (接受 agent_confident + human_verified,
   * 排除 agent_tentative)。设 'human_verified' → 仅人验记忆。
   */
  minConfidence?: 'agent_tentative' | 'agent_confident' | 'human_verified';
  /**
   * 注入回调: 本轮真注入了哪些 fact 的 identity key (置信路由后)。熔断器 session 级归因用
   * (eventStore.recordGroundingApplied)。可选, 不传则纯注入不留痕。
   */
  onGrounded?: (factIdentities: string[]) => void;
}

// ---------------------------------------------------------------------------
// 内部: 置信序数 (数字越高越可信)
// ---------------------------------------------------------------------------

const LEVEL_ORDER: Record<string, number> = {
  human_verified: 3,
  agent_confident: 2,
  agent_tentative: 1,
};

// ---------------------------------------------------------------------------
// 内部: 查询提取 + 过滤 + 格式化
// ---------------------------------------------------------------------------

/** 从 messages 中提取最后一条 user 消息文本。无 user 消息 → ''。*/
function extractQuery(messages: unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string; content?: unknown[] | string };
    if (m.role !== 'user') continue;
    const content = m.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      const texts = content
        .filter((c: unknown): c is { type: string; text: string } =>
          typeof c === 'object' && c !== null && (c as Record<string, unknown>).type === 'text',
        )
        .map((c) => c.text)
        .join(' ');
      if (texts) return texts;
    }
  }
  return '';
}

/** 单条 hit → 人读行。*/
function formatHit(h: MemoryHit): string {
  const f = h.fact as unknown as Record<string, unknown>;
  const fields = Object.entries(f)
    .filter(
      ([k]) =>
        !['namespace', 'confidence', 'source_event_id', 'source_doc_id'].includes(k),
    )
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(', ');
  return `- ${f.namespace}: ${fields}`;
}

/** 命中集 → 可注入文本块。*/
function formatBlock(hits: MemoryHit[]): string {
  const lines = ['[wright/grounding] 行为级 grounding 记忆 (已置信过滤):'];
  for (const h of hits) lines.push(formatHit(h));
  return lines.join('\n');
}

/** 置信路由隔离: 仅 wright.* namespace, confidence >= minLevel。排除 agent_tentative 暗含。*/
function filterHits(hits: MemoryHit[], minLevel: number): MemoryHit[] {
  return hits.filter((h) => {
    if (!h.fact.namespace.startsWith('wright.')) return false;
    const order = LEVEL_ORDER[h.fact.confidence.level] ?? 0;
    return order >= minLevel;
  });
}

// ---------------------------------------------------------------------------
// 工厂
// ---------------------------------------------------------------------------

/**
 * 造行为级 grounding extension。`context` 事件上每轮从 memory 检索相关 wright.* 事实,
 * 置信过滤后注入。
 */
export function createBehavioralGroundingExtension(
  opts: BehavioralGroundingOpts,
): ExtensionFactory {
  const k = opts.k ?? 5;
  const minConfidence = opts.minConfidence ?? 'agent_confident';
  const minLevel = LEVEL_ORDER[minConfidence] ?? 2;

  return (pi) => {
    pi.on('context', async (event) => {
      const query = extractQuery(event.messages as unknown[]);
      if (!query.trim()) return;

      const hits = await opts.memory.retrieve(query, k);
      if (hits.length === 0) return;

      const filtered = filterHits(hits, minLevel);
      if (filtered.length === 0) return;

      const block = formatBlock(filtered);
      const msg = {
        role: 'user' as const,
        content: [{ type: 'text' as const, text: block }],
      };
      event.messages.push(msg as never);

      // 熔断器归因: 留痕本轮真注入的 confident fact identity (这些 fact 现在驱动了行为 →
      // 升级后 bad_rate 才能归因到它们)。
      if (opts.onGrounded) {
        const identities = filtered.map((h) => opts.memory.identityKeyOf(h.fact));
        opts.onGrounded(identities);
      }

      return { messages: event.messages };
    });
  };
}
