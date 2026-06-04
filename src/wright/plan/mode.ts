/**
 * plan/mode —— plan mode 的状态机 (单一真理源)。
 *
 * 一个 PlanModeState 实例被 plan-extension 的所有 handler 共享 (闭包): shortcut 翻 status,
 * tool_call 读 status 决定 block, before_agent_start 读 status 决定是否注审议 overlay+ledger。
 * 进/出 plan mode 时快照/还原 model+thinking (plan 默认 deepseek-v4-pro xhigh, 独立于执行模型)。
 */
import type { ThinkingLevel } from '../../runtime/types';
import { PlanLedger } from './ledger';

export type PlanModeStatus = 'normal' | 'plan';

export interface PlanModeState {
  status: PlanModeStatus;
  /** 审议台账 (跨 turn 累积, 每轮重注入)。 */
  ledger: PlanLedger;
  /** 进 plan mode 前的 model 快照 (退出还原)。pi-ai Model 对象, unknown 因泛型。 */
  savedModel: unknown | null;
  /** 进 plan mode 前的 thinking 快照。 */
  savedThinking: ThinkingLevel | null;
  /** grill-with-docs 子模式 (C 子系统): 开则每轮额外注 GRILL_OVERLAY。complexity-gated offer, /grill 切。 */
  grilling: boolean;
}

/** 新建一个 normal 态的 plan 状态机 (ledger 可注入测试桩, 默认空台账)。 */
export function createPlanModeState(ledger: PlanLedger = new PlanLedger()): PlanModeState {
  return { status: 'normal', ledger, savedModel: null, savedThinking: null, grilling: false };
}
