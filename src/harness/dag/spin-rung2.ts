/**
 * src/harness/dag/spin-rung2 —— 空转档 2 的**纯函数核心**(SDD「自修环阶梯与空转路由」§4 片 S2 / 片 1)。
 *
 * ## 这条片买的是什么
 *
 * S2 的节点级自修阶梯 = 档 1 (S1 已实装的 `spin-route` 证据包注入) + 档 2 (本片提供选择与报告)。
 * 档 2 在节点重派入场处由 `runNode` (engine.ts:4334) 调用本片的具名判据, 决定下一次派发走
 * 升 leaf 座位 / 同座位 fresh-context; 判定函数、阈值、报告形状全部冻结, 不让下游各自另写同义结构。
 *
 * 与 spin-route.ts 同源的取舍:
 *   - 判据函数具名 —— prompt 改不到, 测试可名;
 *   - 常数具名 —— prompt 引用与测试断言共用同一份;
 *   - 阈值走依赖注入 —— SDD 待决 #a 的 owner 数值不在仓内宣称。
 *
 * ## 方向:档 2 是**重派**不是注入
 *
 * 档 1 是 leaf 原地注入一次证据包; 档 2 是 `runNode` 在下一次 `runNodeOnce` 调用前**派发新叶子**,
 * 派发面本身在 engine.ts (片 3); 本片只冻结形状与判据。本片零改既有文件, 故它是唯一可以与别片
 * 并行开跑的片 (写集天然不相交, 见总 SDD §分解)。
 *
 * ## 互斥与试尽 (INV-2, INV-3)
 *
 * 选择函数 `chooseSpinRung2Dimension` 返值域恰为 `seat-upgrade | fresh-context`, 不允许:
 *   · 普通 retry (province `causeNote` 走的同款路径);
 *   · 双标记或第三种返值;
 *   · 阈值等于时改归属 —— 该边界由测试固定, IMPL 期不得改动。
 *
 * `pickHigherTierSeat` 已在最高档 / 高一档池空 / 坐标不在任何池 → 一律 null (试尽), 绝不静默
 * 回退原模型并假装换脑 (INV-3 反向自检: "以原模型执行却记成功升级" 必判红)。
 *
 * ## 报告两档齐备 (INV-7)
 *
 * `SpinLadderReport.readings` 恰含两条 reading (档 1 + 档 2), 缺档或缺必填字段均判失败。每条
 * reading 的四个具名字段: `dimension` · `criterionDiff` · `blockerSignature` · `outcome` —— 不得
 * 拼成散文写进 run-board (Evidence ⑤ 那张 `BoardEntry` 表只有扁平字段, 把结构化读数降维成散文
 * = 自我欺骗)。
 */
import {
  judgeRungOutcome,
  type CriteriaDiff,
} from '../spin-route';

// ── 常数 ──────────────────────────────────────────────────────────────────

/** 档 2 = 换脑或 fresh-context 的节点级重派 (本片唯一新增档位, 与 `RUNG_1` 配对)。 */
export const RUNG_2 = 2;

/** 档 2 的尝试维度并集 —— 互斥二元, INV-2。顺序在仓内稳定以便测试断言。 */
export const SPIN_RUNG2_DIMENSIONS = ['seat-upgrade', 'fresh-context'] as const;
export type SpinRung2Dimension = (typeof SPIN_RUNG2_DIMENSIONS)[number];

/** 阶梯 reading 的 outcome 三态 (成 / 败 / 待定 —— "待定"只在本片内部, 报告出口前必归一成/败)。 */
export const SPIN_LADDER_OUTCOMES = ['success', 'fail', 'pending'] as const;
export type SpinLadderOutcome = (typeof SPIN_LADDER_OUTCOMES)[number];

/**
 * 档 1 失败的尝试维度字面量 (仅用于 SpinLadderReading.dimension 在档 1 的位置;
 * 档 2 用 `SpinRung2Dimension`)。与 `RUNG_1` 互不替代 —— RUNG_1 是数字档位, 这里是维度语义。
 */
export const SPIN_LADDER_RUNG1_DIMENSION = 'spin-route' as const;

// ── 坐标与池 (最小接口; 装配层全池在片 2 接入) ──────────────────────────────

/**
 * 装配层派生的座位池 (SEAT-1, 仓内真源 = `src/mcp/assemble.ts:546` 的 stampPools)。
 * S2 单节点选择器只需要 cheap/mid/strong 三层; multimodal 是能力硬约束, 不参与档 2 换脑。
 * 本片只冻结"给定实际 leaf 坐标返回高一档可用坐标"的最小入参形状, 装配层全量接入在片 2。
 */
export interface SpinRung2StampPools {
  readonly strong: readonly string[];
  readonly mid: readonly string[];
  readonly cheap: readonly string[];
}

// ── 档 2 决策形状 (D-3, INV-2) ─────────────────────────────────────────────

/**
 * 档 2 单次派发决策。互斥二分, 不允许普通 retry / 双标记 / 第三种返值。
 *
 * - `seat-upgrade`: `from` → `to` (高一档池首个可用坐标); `targetPoolExhausted: true` 时
 *                  `to` 缺席 (INV-3: 试尽如实, 不回退原模型伪装成功);
 * - `fresh-context`: `from` 保留 (`to` 字段省略, 因为同座位 + 丢消息历史, 不换模型)。
 *
 * `accumulatedUsageIn` = runNode 截至当前尝试的累积 input token (engine.ts:4365 累加点
 * 之上, 档 2 阈值选择的分母); `evidencePackHash` = 档 1 注入包的 sha256 (D-4: 档 2 必须继承)。
 */
export interface SpinRung2Decision {
  kind: SpinRung2Dimension;
  /** 派发前的 leaf 坐标 (从 runner 报告读)。 */
  from: string;
  /** 升 leaf 座位时的目标坐标; fresh-context 时省略 (同座位)。 */
  to?: string;
  /** 截至档 2 决策点的累积 input token (Decision 阈值选择的分母)。 */
  accumulatedUsageIn: number;
  /** 档 1 证据包 sha256 (D-4: 档 2 prompt 必含); 无档 1 史时缺席。 */
  evidencePackHash?: string;
  /** 升 leaf 座位但高一档池空时如实记 (INV-3: 试尽, 不静默回退)。 */
  targetPoolExhausted?: boolean;
}

// ── 阶梯读数形状 (INV-7, D-8) ──────────────────────────────────────────────

/**
 * 单档读数。**四个具名字段皆必填** (INV-7 GWT 字面点名)。
 * `readings` 数组中的位置 = 档位 (idx 0 = 档 1, idx 1 = 档 2),
 * 故本接口不复述 `rung` —— 位置即档位的契约由 `SpinLadderReport.readings` 长度保证。
 */
export interface SpinLadderReading {
  /** 尝试维度: 档 1 恒为 'spin-route'; 档 2 = `SpinRung2Dimension`。 */
  dimension: typeof SPIN_LADDER_RUNG1_DIMENSION | SpinRung2Dimension;
  /** 判据 diff, NULL ≠ 编造: 无 self_check 史时为 no-history 字面, 有史为 diff (added/removed)。 */
  criterionDiff: CriteriaDiff;
  /** 败因签名: 卡在哪个动作 (drift sig 原值 / grind action 原值)。 */
  blockerSignature: string;
  /** 单档 reading 的成 / 败 / 待定; 报告出口前必须归一为 success / fail。 */
  outcome: SpinLadderOutcome;
}

/**
 * 阶梯报告 = **恰两条** reading (INV-7 字面)。片 1 冻结该形状; 持久化与读取面在片 4,
 * 引擎接线在片 3, runner 接线在片 2。
 *
 * 用 `readonly [r1, r2]` 元组而非数组, 让缺档在编译期就报红 (而不是运行时数组长度不匹配)。
 */
export interface SpinLadderReport {
  readings: readonly [SpinLadderReading, SpinLadderReading];
}

// ── 纯函数:阈值二元选择 (INV-2 边界, 测试固定) ────────────────────────────

/**
 * 档 2 维度选择 (D-3, INV-2)。
 *
 *   accumUsageIn >  threshold → 'fresh-context'
 *   accumUsageIn <= threshold → 'seat-upgrade'
 *
 * "等于阈值"归属 = `seat-upgrade` —— 测试在此冻结, IMPL 期不得改动 (INV-2 字面: "等于阈值的
 * 归属由测试固定, IMPL 期不得改动")。阈值数值本身是 SDD 待决 #a, 仓内不宣称 owner; 本片接
 * 受任意 `number` (含 0 / 负数), 仅作分母 / 分子使用。
 */
export function chooseSpinRung2Dimension(input: {
  accumUsageIn: number;
  threshold: number;
}): SpinRung2Dimension {
  return input.accumUsageIn > input.threshold ? 'fresh-context' : 'seat-upgrade';
}

// ── 纯函数:坐标升级选择器 (INV-3, D-5) ─────────────────────────────────────

/**
 * 单节点座位升级: cheap → mid → strong 固定次序 (D-5 测试冻结), **一次只升一档**。
 *
 * 返回 `null` 的三种真情形 (INV-3 试尽如实):
 *   1. 当前坐标已在 `strong` (最高档, 没有高一档);
 *   2. 当前坐标的下一档池为空 (如 cheap 在 mid 空 / mid 在 strong 空);
 *   3. 当前坐标不在三档任何一个池内 (坐标池外, 不假装换脑)。
 *
 * 不写也不消耗"池内第二个坐标": 只取高一档池的**首个**可用坐标; 跨池切档是 owner 决策,
 * 不属本片。
 */
export function pickHigherTierSeat(input: {
  currentCoord: string;
  pools: SpinRung2StampPools;
}): string | null {
  const { currentCoord, pools } = input;
  const tierOf = (coord: string): 'cheap' | 'mid' | 'strong' | null => {
    if (pools.cheap.includes(coord)) return 'cheap';
    if (pools.mid.includes(coord)) return 'mid';
    if (pools.strong.includes(coord)) return 'strong';
    return null;
  };
  const tier = tierOf(currentCoord);
  if (tier === null) return null;
  if (tier === 'cheap') return pools.mid[0] ?? null;
  if (tier === 'mid') return pools.strong[0] ?? null;
  return null; // 'strong' = 已在最高档
}

// ── 纯函数:组 decision (D-3, INV-3, INV-4) ─────────────────────────────────

/**
 * 组装 `SpinRung2Decision`。fresh-context 同座位 (不写 `to`); seat-upgrade 走选择器并在
 * 池空时如实记 `targetPoolExhausted: true`。**绝不**回退原模型 (INV-3 反向自检条款)。
 */
export function buildSpinRung2Decision(input: {
  dimension: SpinRung2Dimension;
  currentCoord: string;
  pools: SpinRung2StampPools;
  accumulatedUsageIn: number;
  evidencePackHash?: string;
}): SpinRung2Decision {
  if (input.dimension === 'fresh-context') {
    return {
      kind: 'fresh-context',
      from: input.currentCoord,
      accumulatedUsageIn: input.accumulatedUsageIn,
      ...(input.evidencePackHash !== undefined
        ? { evidencePackHash: input.evidencePackHash }
        : {}),
    };
  }
  // seat-upgrade
  const target = pickHigherTierSeat({ currentCoord: input.currentCoord, pools: input.pools });
  if (target === null) {
    return {
      kind: 'seat-upgrade',
      from: input.currentCoord,
      accumulatedUsageIn: input.accumulatedUsageIn,
      targetPoolExhausted: true,
      ...(input.evidencePackHash !== undefined
        ? { evidencePackHash: input.evidencePackHash }
        : {}),
    };
  }
  return {
    kind: 'seat-upgrade',
    from: input.currentCoord,
    to: target,
    accumulatedUsageIn: input.accumulatedUsageIn,
    ...(input.evidencePackHash !== undefined
      ? { evidencePackHash: input.evidencePackHash }
      : {}),
  };
}

// ── 纯函数:组报告 (INV-7) ──────────────────────────────────────────────────

/**
 * 组装 `SpinLadderReport` (恰两条 reading)。**位置即档位**: idx 0 = 档 1, idx 1 = 档 2。
 * 缺档 / 多档在调用方就被 TS 元组类型拒住, 本函数不再防御。
 */
export function buildSpinLadderReport(input: {
  rung1: SpinLadderReading;
  rung2: SpinLadderReading;
}): SpinLadderReport {
  return { readings: [input.rung1, input.rung2] as const };
}

// ── 档 2 判定:复用 S1 的具名判据 (D-9, 不另写散文) ─────────────────────────

/**
 * 档 2 的 success / fail 口径与档 1 完全一致 (D-9):
 *   · success = touched 增长**或** failSet 严格缩小;
 *   · fail    = 两者皆无 (= 再次命中既有空转口径 → 试尽, 节点终止为 failed)。
 *
 * 直接再导出 S1 的 `judgeRungOutcome` 让档 2 不另写同义函数; SDD 关于 D-9 的要求是"具名纯
 * 函数, 不在 prompt 里写散文", 这就是。
 */
export const judgeRung2Outcome = judgeRungOutcome;
export type { CriteriaDiff, SpinJudgeOutcome } from '../spin-route';
