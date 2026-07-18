/**
 * src/harness/learning/types.ts — Phase 0 复利自学习闭环 FROZEN CONTRACT (omd, 2026-06-03).
 *
 * 最小端到端闭环 (drift-only): runtime 信号 → 持久事件 → dream consolidate → omd.* fact → grounding 注入。
 * 研究稿: docs/knowledge/research/omd-compounding-self-learning-2026-06-03.md。
 *
 * impl 模块 (omd leaf 写, 全 import 本文件 → 编译即 compose):
 *   - learning/event-store.ts : EventStore   —— runtime_events SQLite (镜像 dag-record/session-store 模式)
 *   - learning/signal-bus.ts  : SignalBus    —— emit(signal) → event-store.record (薄)
 *   - learning/dream-pump.ts  : DreamPump    —— sinceWatermark → consolidate → L2 fact → ValalMemory.writeFact (核心)
 *   - (omd L2 接线): drift-detector onDrift → bus.emit; grounding loadBehavioralFacts → NUDGE
 *
 * ── 已核实的 dream/memory API (R6, 禁改/禁猜) ────────────────────────────────────
 *  - DreamEvent (src/dream/model.ts): { event_id: number; type: string; payload: Record<string,unknown> }
 *  - ConsolidationInput: { agent_id: string; events: DreamEvent[]; prompt: string }
 *  - CandidateFact: { layer: DreamLayer; fact: Record<string,unknown>; source_event_ids: number[] } —— L2 的 fact 必须 validateFactWrite-shaped
 *  - LiveDreamModel (src/dream/model-live.ts): new LiveDreamModel({ callModel?, model? ... }); .consolidate(input) → CandidateFact[]
 *  - ValalMemory.writeFact(fact: unknown) → WriteFactResult (内跑 validateFactWrite REJECT-by-default 闸)
 *  - omd.* fact 形状 (universal-namespaces): { namespace:'omd.limit'|'omd.pattern'|'omd.capability', category:string, value:string, confidence:'tentative'|..., source_event_id:number }
 *
 * 不变量 (impl 必守):
 *  - LRN-1 · MVP 直调 consolidate 不走 DreamEngine.run (engine.router 写 HostAdapter, 与 ValalMemory 阻抗不匹配)。
 *  - LRN-2 · L2-only: 只取 consolidate 返回里 layer==='L2' 的 CandidateFact 写 ValalMemory; 其它 layer MVP 忽略。
 *  - LRN-3 · 安全底线 = ValalMemory.writeFact 的 validateFactWrite (源锚 source_event_id + confidence 必填) + ephemeral confidence='tentative' (跨 session 复现才升级, 留后续 phase)。restraint/purify/EntropyGate 不在 MVP。
 *  - LRN-4 · watermark 单调推进: pump 成功后才存 newWatermark = max(event_id); 失败不推进 (重跑幂等)。
 *  - LRN-5 · 确定性 + 有界: event payload 可序列化; pump 一次取 ≤ batchLimit。
 */
/** 信号源发给 bus 的一条信号 (drift / 未来 user-correction / repeated-failure …)。 */
export interface RuntimeSignal {
  sessionId: string;
  /** 事件类型 (如 'drift_stuck')。consolidate prompt 据 type 抽不同 fact。 */
  type: string;
  payload: Record<string, unknown>;
}

/** runtime_events 表里一行 (event_id 映射 DreamEvent.event_id)。 */
export interface RuntimeEventRow {
  eventId: number;
  sessionId: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

/** runtime 事件持久层 (SQLite, 镜像 dag-record)。 */
export interface EventStore {
  /** 落一条, 返 event_id (自增)。 */
  record(signal: RuntimeSignal): number;
  /** 取 event_id > watermark 的事件 (升序, ≤ limit)。喂 pump 增量窗口。 */
  sinceWatermark(watermark: number, limit?: number): RuntimeEventRow[];
  /** 读 dream watermark (无则 0)。 */
  getWatermark(): number;
  /** 推进 watermark (LRN-4, 单调; 调用方在 pump 成功后调)。 */
  setWatermark(eventId: number): void;
}

/** 信号总线: detector → emit → event-store.record。薄。 */
export interface SignalBus {
  emit(signal: RuntimeSignal): number;
}

/** 一次 pump 的结果 (审计 + 测试断言)。 */
export interface PumpResult {
  eventsConsumed: number;
  factsWritten: number;
  factsRejected: number;
  newWatermark: number;
}

/** dream pump: 增量事件 → consolidate → L2 fact → ValalMemory。核心闭环驱动。 */
export interface DreamPump {
  /** 跑一轮 (会话边界/定时调)。无新事件 → eventsConsumed:0 不调模型 (省 call)。 */
  pump(): Promise<PumpResult>;
}
