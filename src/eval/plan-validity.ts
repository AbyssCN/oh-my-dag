/**
 * src/eval/plan-validity —— 「同段跑 n 次取分布」尺子的真实调用方 (SDD #159 切片 2)。
 *
 * 为什么单独成核: G6 那条 1/21 是 n=1 事件, 尺子问题与采样噪声分不开 (#97 缺口②)。
 * 这把尺子 (D-4) 把 plan 有效率从「一次性结果」抬到「n 次的分布 + 冻结区间」, 读数
 * 直接走 renderRepeatLine, 口径单点 (INV-3)。
 *
 * 判据 (INV-4): 「plan 有效」= `parsePlan(raw)` ok (import 自 src/harness/conductor-plan.ts,
 * 不新写第二个判定)。knownTemplates/knownServers 用空集 —— 沿用 G6 那次 1/21 的同源写法
 * (scripts/eval-detector-usage.ts:81), 让 "回的不是 plan" 与 "回了但不接受" 在这把尺下
 * 是**同一格** (都是 ok:false), 与 G6 当时撞见的 `Unrecognized token '错'` 同口径。
 *
 * 不变量:
 *   INV-2 (承自 repeat.ts): generate 抛错 = 该次记 error, 不算 invalid, 也不中断段;
 *     「模型没回话」与「回了但不是 plan」是**两格**, 混了就量不出格式守。
 *   INV-4: 仓内不出现第二个「plan 是否有效」判定 —— 想加新判据请去改 parsePlan。
 */
import { parsePlan } from '../harness/conductor-plan';
import {
  aggregateBool,
  renderRepeatLine,
  repeatSegment,
  type AggregateBool,
  type RepeatRecord,
} from './repeat';

/** 跑器输入: 一个 task = (id, text) —— 与 DETECTOR_GOAL_CASES 的最小形状一致, 不耦合源。 */
export interface PlanValidityTask {
  id: string;
  text: string;
}

/** 跑器输出: perTask 维度 + 跨 task 合并的 overall + 逐行口径行 (lines 全经 renderRepeatLine)。 */
export interface PlanValidityResult {
  perTask: Array<{ id: string; agg: AggregateBool }>;
  overall: AggregateBool;
  /** 逐 task + overall 的 renderRepeatLine 行, 顺序 = tasks 顺序 + overall 在末。 */
  lines: string[];
}

/** error 次的 value 形状 (承 repeatSegment 的 INV-2 写入磁盘形状) —— 测试用它做类型守卫。 */
type ErrorValue = { error: string };

function isError(v: unknown): v is ErrorValue {
  return typeof v === 'object' && v !== null && 'error' in v;
}

/**
 * 对一组 task 跑 n 次, 按 G6 同尺 (parsePlan) 判有效, 逐 task 聚合 + 跨 task 合并。
 *
 * generate 抛错 = 该次记 error, 不算 invalid (INV-2: 「模型没回话」与「回了不是 plan」分两格)。
 * 非 JSON / 坏形状 / 环 / 缺节点 = 返 false (invalid, 计入「无效」分母)。
 *
 * 不重复算: 聚合与口径行都从 repeat.ts import, 不在本文件再算 (INV-3)。
 */
export async function measurePlanValidity(opts: {
  tasks: readonly PlanValidityTask[];
  n: number;
  /** 一次 plan 生成, 返 raw text。注入: 测试给 stub, CLI 接生产 send。 */
  generate: (task: string) => Promise<string>;
  /** 透传给 repeatSegment (逐次写入磁盘); 缺省走 repeat.ts 默认 sink。 */
  sink?: (line: string) => void;
}): Promise<PlanValidityResult> {
  const recordsByTask = new Map<string, RepeatRecord<boolean | ErrorValue>[]>();
  const lines: string[] = [];
  let overallErrs = 0;

  for (const task of opts.tasks) {
    const id = `plan-validity/${task.id}`;
    const records = await repeatSegment<boolean>({
      id,
      n: opts.n,
      run: async () => {
        const raw = await opts.generate(task.text);
        // 沿用 G6 同源写法 (eval-detector-usage.ts:81): knownTemplates/knownServers 空集。
        // parsePlan 自己不抛 (ok|error 二选一), generate 抛错走 repeatSegment 的 try/catch。
        return parsePlan(raw, { knownTemplates: new Set(), knownServers: new Set() }).ok;
      },
      sink: opts.sink,
    });
    recordsByTask.set(task.id, records);
    const errs = records.filter((r) => isError(r.value)).length;
    overallErrs += errs;
    const validBools = records.filter((r): r is RepeatRecord<boolean> => !isError(r.value));
    const agg = aggregateBool(validBools.map((r) => r.value));
    lines.push(renderRepeatLine(id, agg, errs));
  }

  // 跨 task 合并: error 次**不**进分母, 但 errs 注记在 overall 行 (INV-2)。
  const allBools: boolean[] = [];
  for (const records of recordsByTask.values()) {
    for (const r of records) {
      if (!isError(r.value)) allBools.push(r.value);
    }
  }
  const overall = aggregateBool(allBools);
  lines.push(renderRepeatLine('plan-validity/_overall', overall, overallErrs));

  const perTask: Array<{ id: string; agg: AggregateBool }> = [];
  for (const task of opts.tasks) {
    const records = recordsByTask.get(task.id)!;
    const validBools = records.filter((r): r is RepeatRecord<boolean> => !isError(r.value));
    perTask.push({ id: task.id, agg: aggregateBool(validBools.map((r) => r.value)) });
  }

  return { perTask, overall, lines };
}
