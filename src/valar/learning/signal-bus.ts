/**
 * src/valar/learning/signal-bus.ts — SignalBus impl: emit(signal) → event-store.record.
 *
 * 薄透传层 + 闸门 I 信号准入: 信号源 (drift-detector / future) → emit → 白名单 → EventStore.record。
 * FROZEN CONTRACT: src/valar/learning/types.ts (RuntimeSignal / EventStore / SignalBus)。
 *
 * 闸门 I (信号准入, 研究稿 valar-compounding-self-learning-v2 §闸门 I):
 *   只有白名单事件可进 dream 管线。系统故障类 (crash/timeout/db_error) 是噪声不是教训 —— 让它们
 *   进 consolidate 会让 valar "学到" 把自己的崩溃当行为模式 (anti-slop)。这些信号仍可走 drift-detector
 *   等别的通路, 只是不产生可学习的 dream 事件。
 */
import type { RuntimeSignal, EventStore, SignalBus } from './types';

/**
 * 闸门 I 白名单: 可进入 dream consolidation 管线的事件类型。
 *
 * - drift_stuck        : 同一动作反复无进展 (drift-detector onSpinning) ── WIRED
 * - tool_failure       : 工具调用契约层失败 (≠ 系统崩溃; 是"这么用工具不对"的教训; tool-failure-signal) ── WIRED
 * - recall_miss        : 召回未命中应有先例 (记忆覆盖缺口; recall-extension onMiss) ── WIRED
 * - user_correction    : 用户显式纠正 (最高价值; input 启发式 user-correction-signal, 精度优先) ── WIRED
 * - hard_problem       : 难题已解开 (卡住→打破循环推进; drift-detector onRecovered 复合信号) ── WIRED
 * - clean_completion   : 干净完成 (正向强化) ── DEFER 非目标: 每回合 fire = dream-pump 每轮跑模型 (成本陷阱);
 *                        其高价值版本 (卡住后完成) 已被 hard_problem (drift recovery) 覆盖。纯"每回合成功"不学。
 *
 * 刻意 EXCLUDE: crash / timeout / db_error / 任何基础设施故障 —— 噪声, 不是行为教训。
 */
export const DREAM_ALLOWED_EVENT_TYPES: ReadonlySet<string> = new Set([
  'drift_stuck',
  'user_correction',
  'tool_failure',
  'recall_miss',
  'clean_completion',
  'hard_problem',
]);

/** 未落库 sentinel。event_id 自增从 1 起, 0 永不是合法 id → 调用方据此知信号被闸丢弃。 */
export const SIGNAL_DROPPED = 0 as const;

/** 造信号总线。store 通常 = event-store.ts 的 in-memory / SQLite store。 */
export function createSignalBus(store: EventStore): SignalBus {
  return {
    emit(signal: RuntimeSignal): number {
      // 闸门 I: 非白名单事件不进 dream 管线 (返 SIGNAL_DROPPED, 不落库, 不污染 watermark 窗口)。
      if (!DREAM_ALLOWED_EVENT_TYPES.has(signal.type)) {
        return SIGNAL_DROPPED;
      }
      return store.record(signal);
    },
  };
}
