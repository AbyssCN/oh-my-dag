/**
 * plan/mode —— 模式状态机 (单一真理源)。
 *
 * ## 两个状态机 (D-1 pathfinder 改绑后并存):
 *
 * 1. **PathfinderModeState** — shift+tab 现在切的模式 (pathfinder, 见 pathfinder-extension)。
 *    只跟踪 { status, activeSlug }: 是否在 pathfinder 模式 + 当前激活的地图 slug。
 *    D-1: 原只读 plan mode 已移除, shift+tab 改绑 pathfinder; D-5: 开放 src, 无硬只读闸,
 *    故此状态机**不带** model/thinking 快照 (pathfinder 是工作台, 不切模型不上锁)。
 *
 * 2. **PlanModeState** — 保留给 plan 技能 (ledger) + /execute 交接协议。skills 解绑为 slash 后
 *    (D-12), plan-extension 仍靠 ledger 累积审议台账; execute-extension 仍读 status/savedModel
 *    做交接退出 (P1 引擎接缝, 不在本 slice 动)。status 恒为 'normal' (无人再把它翻 'plan'),
 *    savedModel/savedThinking 保留为交接协议的形状占位。
 */
import type { ThinkingLevel } from '../../runtime/types';
import { PlanLedger } from './ledger';

// ── PathfinderModeState (shift+tab 现在切这个) ────────────────────────────────

/** pathfinder 模式开关状态: normal=普通聊天 / pathfinder=散雾式规划模式。 */
export type PathfinderModeStatus = 'normal' | 'pathfinder';

/** pathfinder 模式状态 (pathfinder-extension 的 handler 共享闭包)。 */
export interface PathfinderModeState {
  status: PathfinderModeStatus;
  /** 当前激活的地图 slug (docs/plan/pathfinder/<slug>.md); null = 未选/无图。 */
  activeSlug: string | null;
}

/** 新建一个 normal 态的 pathfinder 状态机。 */
export function createPathfinderModeState(): PathfinderModeState {
  return { status: 'normal', activeSlug: null };
}

// ── PlanModeState (保留: plan 技能 ledger + /execute 交接协议) ─────────────────

/** 保留枚举 (execute-extension 交接判定读 'plan'; skills 解绑后无人再置 'plan')。 */
export type PlanModeStatus = 'normal' | 'plan';

export interface PlanModeState {
  status: PlanModeStatus;
  /** 审议台账 (跨 turn 累积, 供 /note /ref /search /council 等 slash 技能写入)。 */
  ledger: PlanLedger;
  /** /execute 交接协议的 model 快照占位 (pi-ai Model 对象, unknown 因泛型)。 */
  savedModel: unknown | null;
  /** 交接协议的 thinking 快照占位。 */
  savedThinking: ThinkingLevel | null;
  /** grill-with-docs 子模式: 开则每轮额外注 GRILL_OVERLAY。/grill 切 (解绑后可在普通聊天用)。 */
  grilling: boolean;
}

/** 新建一个 normal 态的 plan 状态机 (ledger 可注入测试桩, 默认空台账)。 */
export function createPlanModeState(ledger: PlanLedger = new PlanLedger()): PlanModeState {
  return { status: 'normal', ledger, savedModel: null, savedThinking: null, grilling: false };
}
