/**
 * src/harness/learning/dream-pump.ts — DreamPump impl (Phase 0, L2-only drift consolidation).
 *
 * Incremental pump: watermark → fetch events → DreamModel.consolidate →
 * filter L2 → OmdMemory.writeFact → advance watermark.
 *
 * LRN-1: call DreamModel.consolidate directly (not DreamEngine.run).
 * LRN-2: L2-only filter.
 * LRN-3: writeFact via OmdMemory (validateFactWrite + tentative confidence).
 * LRN-4: watermark advances only on success (pump throw → no advance).
 * LRN-5: ≤ batchLimit per pump call.
 *
 * 闸门 I 情感门 (研究稿 omd-compounding-self-learning-v2 §闸门 I):
 *   负面情感强度 > 阈值的事件标记 BLOCKED_EMOTIONAL, 不进 consolidate。失稳模式: 用户在气头上的
 *   反馈反映情绪不反映"该怎么做", 学进去会让 omd 把一次性情绪当持久行为约束。被挡的事件仍算
 *   "已消费" (watermark 推进) —— 我们已经看过并决定不学, 重处理只会再挡一次。
 */
import type { DreamModel, ConsolidationInput, DreamEvent } from '../../dream/model';
import type { EventStore, DreamPump, PumpResult, RuntimeEventRow } from './types';
import type { WriteFactResult } from '../memory/types';

const DEFAULT_BATCH_LIMIT = 50;

/** 情感门默认阈值: payload.negativeIntensity ∈ [0,1], 严格大于此值即挡。0.8 = 强负面。 */
const DEFAULT_NEGATIVE_INTENSITY_THRESHOLD = 0.8;

/** 情感门读取的 payload 字段 (生产者契约: user_correction / user_feedback 信号源填 0..1)。 */
const NEGATIVE_INTENSITY_KEY = 'negativeIntensity';

/** 闸门 I 情感门: true = 该事件因强负面情感被挡, 不进 consolidate。 */
function isEmotionallyBlocked(row: RuntimeEventRow, threshold: number): boolean {
  const raw = (row.payload as Record<string, unknown> | undefined)?.[NEGATIVE_INTENSITY_KEY];
  const intensity = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(intensity) && intensity > threshold;
}

// Namespace steering (关键): 反复卡住的教训要落 omd.pattern (可行动 + 能跨 session 升 confident 驱动行为),
// 不要落 omd.limit —— omd.limit 是 safe-namespace 永不自动升 (硬边界只人验), 落它=学到的教训永远 inert。
// 一条"假 limit"(误判我不能做 X) 会让 agent 自我设限不再尝试, 比"假 pattern"危险得多, 故 limit 留人验门控。
const BASE_CONSOLIDATION_PROMPT =
  'You are a consolidation engine. Extract durable L2 facts about agent behavior from these runtime events. ' +
  'Output only candidate facts with layer="L2", a source_event_id, and confidence="tentative". ' +
  'Namespace choice (critical): ' +
  'PREFER omd.pattern {situation, approach, outcome} for a RECURRING lesson — i.e. "when stuck on X, try Y". ' +
  'It is actionable and, once confirmed across sessions, is allowed to drive future behavior. ' +
  'Use omd.capability {area, level} for demonstrated competence. ' +
  'RESERVE omd.limit {kind, statement} ONLY for a genuine HARD boundary the agent must treat as a fixed constraint; ' +
  'these are human-gated and will NOT auto-drive behavior, so use sparingly — a recurring failure is almost always a ' +
  '"try a different approach" pattern, not a true capability limit.';

export interface DreamPumpOptions {
  store: EventStore;
  dream: DreamModel;
  memory: { writeFact(input: unknown, opts?: { scanSecrets?: boolean }): Promise<WriteFactResult> };
  agentId: string;
  batchLimit?: number;
  promptOverlay?: string;
  /** 情感门阈值 (默认 0.8)。payload.negativeIntensity 严格大于此值的事件不进 consolidate。 */
  negativeIntensityThreshold?: number;
}

export function createDreamPump(opts: DreamPumpOptions): DreamPump {
  const {
    store,
    dream,
    memory,
    agentId,
    batchLimit = DEFAULT_BATCH_LIMIT,
    promptOverlay,
    negativeIntensityThreshold = DEFAULT_NEGATIVE_INTENSITY_THRESHOLD,
  } = opts;

  const prompt = promptOverlay
    ? `${BASE_CONSOLIDATION_PROMPT}\n${promptOverlay}`
    : BASE_CONSOLIDATION_PROMPT;

  return {
    async pump(): Promise<PumpResult> {
      const watermark = store.getWatermark();
      const rows = store.sinceWatermark(watermark, batchLimit);

      // No new events → skip model call (LRN-5: 0 events → no call).
      if (rows.length === 0) {
        return { eventsConsumed: 0, factsWritten: 0, factsRejected: 0, newWatermark: watermark };
      }

      // 闸门 I 情感门: 挡掉强负面情感事件, 不进 consolidate (但仍消费 → watermark 推进)。
      const admitted = rows.filter((r) => !isEmotionallyBlocked(r, negativeIntensityThreshold));

      // 全部被情感门挡 (或本批无可学事件) → 跳过模型调用, 但推进 watermark 消费这批 (LRN-4)。
      if (admitted.length === 0) {
        const blockedMax = rows[rows.length - 1]!.eventId;
        store.setWatermark(blockedMax);
        return { eventsConsumed: rows.length, factsWritten: 0, factsRejected: 0, newWatermark: blockedMax };
      }

      const events: DreamEvent[] = admitted.map((r) => ({
        event_id: r.eventId,
        type: r.type,
        payload: r.payload,
      }));

      const input: ConsolidationInput = { agent_id: agentId, events, prompt };

      // LRN-1: call DreamModel.consolidate directly.
      // INV-1 from LiveDreamModel: throw propagates → watermark not advanced.
      const candidates = await dream.consolidate(input);

      // LRN-2: L2-only filter. Write each L2 candidate to OmdMemory.
      let factsWritten = 0;
      let factsRejected = 0;

      for (const c of candidates) {
        if (c.layer !== 'L2') continue;

        // LRN-3: ensure source_event_id + agent_tentative confidence before write.
        const sourceEventId = String(c.source_event_ids[0] ?? events[0]?.event_id ?? 0);
        const fact = {
          ...c.fact,
          source_event_id: sourceEventId,
          // Types.ts comment uses shorthand 'tentative'; actual schema requires full Confidence object.
          confidence: {
            level: 'agent_tentative' as const,
            // 注入至少一个源 event (LRN-3 源锚底线); model 输出可能已带 confidence, 此处覆盖确保 tentative。
            source_event_ids: [sourceEventId],
            created_at: new Date(),
          },
        };

        // writeFact internally runs validateFactWrite (REJECT-by-default).
        // scanSecrets:true —— 这是**自动学习路径**, 偶遇的密钥不该被当事实持久化 (显式 remember 不开此闸)。
        const result = await memory.writeFact(fact, { scanSecrets: true });
        if (result.status === 'written') {
          factsWritten++;
        } else {
          factsRejected++;
        }
      }

      // LRN-4: all writes completed → advance watermark.
      const maxEventId = rows[rows.length - 1]!.eventId;
      store.setWatermark(maxEventId);

      return {
        eventsConsumed: rows.length,
        factsWritten,
        factsRejected,
        newWatermark: maxEventId,
      };
    },
  };
}
