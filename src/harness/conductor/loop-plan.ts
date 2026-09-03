/**
 * src/harness/conductor/loop-plan —— 编排循环那张 plan 的**形状真源** (2026-09-04 从 goal/orchestrating-loop.ts 抽出)。
 *
 * 为什么单独一个文件: `decompose` 卡 (conductor/tools/decompose.ts) 编译出的就是一张嵌套的编排循环 plan
 * (conductor 坐 escalation 座, 深度 +1), 而 orchestrating-loop.ts 又 import 全部卡 —— 形状留在那里就是循环 import。
 * 这里只有纯数据 + 一个纯函数, 不依赖任何卡。
 */
import type { ConductorPlan } from '../conductor-plan';
import type { ConductorCtx } from './types';

export const ORCHESTRATING_LOOP_PLAN_NAME = 'goal-orchestrating-loop';
/** conductor 节点 id。`leafFace` 钩子只对它返回值; 回灌锚也只挂它。派发子图时会被加前缀 (`d<n>.conductor`)。 */
export const CONDUCTOR_NODE_ID = 'conductor';
/** 机械 oracle 节点 id —— run-goal 既有的 `exec.results.accept` 消费者零改动。 */
export const LOOP_ACCEPT_NODE_ID = 'accept';
/**
 * conductor 的只读哨兵写集 (与 `conductor/tools/explore.ts` 的 READONLY_SENTINEL 同一手法): 声明一条仓内不存在
 * 的路径使 `writeAllow.length > 0`, 写域闸真下发; conductor 面上没有 write/edit, 这条闸对它天然成立 (D-20),
 * bash 重定向写盘会被写集对账 (writeset/write-set.ts) 在收尾抓到。
 */
export const CONDUCTOR_READONLY_SENTINEL = '.omd/conductor-readonly-sentinel';
/** 嵌套编排循环的深度上限: decompose 只展开一层 (深度 1 的 conductor 不能再 decompose)。 */
export const LOOP_MAX_DEPTH = 1;

export interface OrchestratingLoopInput {
  goal: string;
  acceptance?: { command: string; expect_exit: number };
  ctx: ConductorCtx;
  /**
   * 编排节点的座位 (owner 2026-09-03): 它就是 conductor —— 编排 + 对话循环的那个角色, 该坐 conductor 座 (SOTA 档),
   * 不跟 worker 同座。给了 → 节点 `model` 显式钉死 (TPL-3 最高优先, 引擎 per-node 路由); 缺席 → 落回 agent 叶静态座
   * (agentLeafModel / leafModel, 即 worker 座)。decompose 派出的嵌套循环钉 escalation 座。
   */
  conductorModel?: string;
  /** 嵌套深度 (顶层缺席 = 0)。>0 时写进 plan 顶层 `loopDepth`, 派发方据此给子 run 装循环面并把深度传下去。 */
  depth?: number;
}

/**
 * 编排循环的 plan: `conductor` (agent, 只读哨兵写集) → `accept` (command, 冻结判据原文; 无判据时缺席)。
 * 只经 `executePlan(applyPlanFilters(…))` 执行 (D-5 / INV-3); 这里不调 parsePlan —— 它是格式闸, 编译产物
 * 恒过它 (测试钉这一点), 运行期再过一遍是冗余。
 */
export function compileOrchestratingLoop(input: OrchestratingLoopInput): ConductorPlan {
  const nodes: ConductorPlan['nodes'] = {
    [CONDUCTOR_NODE_ID]: {
      executor: 'agent',
      goal: input.goal,
      write_set: [CONDUCTOR_READONLY_SENTINEL],
      ...(input.conductorModel ? { model: input.conductorModel } : {}),
    },
  };
  if (input.acceptance) {
    nodes[LOOP_ACCEPT_NODE_ID] = {
      executor: 'command',
      command: input.acceptance.command,
      expect_exit: input.acceptance.expect_exit,
      depends_on: [CONDUCTOR_NODE_ID],
      goal: '冻结判据 (环外确定性闸)',
    };
  }
  return { name: ORCHESTRATING_LOOP_PLAN_NAME, nodes, ...(input.depth ? { loopDepth: input.depth } : {}) } as ConductorPlan;
}

/** plan 是不是一张编排循环 (含 decompose 派出的嵌套循环; 派发加前缀后 name 不变)。 */
export function isOrchestratingLoopPlan(plan: ConductorPlan): boolean {
  return plan.name === ORCHESTRATING_LOOP_PLAN_NAME;
}

/** 循环 plan 的嵌套深度 (顶层 0)。 */
export function loopDepthOf(plan: ConductorPlan): number {
  const d = (plan as { loopDepth?: unknown }).loopDepth;
  return typeof d === 'number' && d > 0 ? d : 0;
}

/** 循环 plan 里 conductor 节点的实际 id (派发加前缀后是 `d<n>.conductor`)。 */
export function conductorNodeIdOf(plan: ConductorPlan): string {
  return Object.keys(plan.nodes).find((id) => id === CONDUCTOR_NODE_ID || id.endsWith(`.${CONDUCTOR_NODE_ID}`)) ?? CONDUCTOR_NODE_ID;
}
