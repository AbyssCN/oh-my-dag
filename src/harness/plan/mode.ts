/**
 * plan/mode —— 模式状态机 (单一真理源)。
 *
 * **PathfinderModeState** — shift+tab 切的模式 (pathfinder, 见 pathfinder-extension)。
 * 只跟踪 { status, activeSlug }: 是否在 pathfinder 模式 + 当前激活的地图 slug。
 * D-1: 原只读 plan mode 已移除, shift+tab 改绑 pathfinder; D-5: 开放 src, 无硬只读闸,
 * 故此状态机**不带** model/thinking 快照 (pathfinder 是工作台, 不切模型不上锁)。
 *
 * 2026-07-25 owner 裁决: plan-extension/PlanModeState 全撤 — TUI 审议命令捆与 Claude 侧
 * /omd-* skill 家族重复; 规划思考归 Claude, TUI 只留执行位 (pathfinder + /execute)。
 */

// ── PathfinderModeState (shift+tab 切这个) ────────────────────────────────────

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
