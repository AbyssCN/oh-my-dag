/**
 * src/harness/conductor/types —— conductor 工具面的冻结接口(P3 契约 D-2,2026-09-02)。
 *
 * 这里的声明是**契约正文的逐字实现**,不是又一份可以各自解读的转述:
 * `docs/plan/2026-09-02-p3-orchestrating-loop-contract.md` D-2 把这份接口写进决策正文,
 * 就是为了让并行 worker(S1/S5/S6b)不必各自发明一份不兼容的 `ConductorTool`。
 * 改这里 = 改契约,必须回流,不许静默漂移。
 *
 * `ConductorCtx` / `CompileResult` / `ConductorTool` 只钉**形状**;真正的七张卡在 `./tools/*`,
 * 唯一构造点 `createConductorTools` 在 `./tools/index.ts`,渲染函数 `renderManual` 在
 * `./render-manual.ts`。
 */
import type { z } from 'zod';
import type { ConductorPlan } from '../conductor-plan';

/** 七张卡的名字(D-2 冻结枚举;这条路模型没有第八种选择)。 */
export type ConductorToolName = 'work' | 'spawn' | 'map' | 'explore' | 'best_of' | 'research' | 'decompose';

// `CONDUCTOR_TOOL_NAMES`(运行期数组)与 `createConductorTools` 按契约切片表定在 `./tools/index.ts`
// (唯一构造点),这里只留类型 —— 两处各留一份会造出「改一处漏一处」的第二真源。

/**
 * compile() 拿到的执行上下文 —— 由装配层(S6b)按当次 run 填好后传入,
 * conductor 工具本身不解析环境、不重复真源(D-25:maxFanout 沿用 `effectiveFanout` 的结果)。
 */
export interface ConductorCtx {
  cwd: string;
  writeRoot: string;
  /** 本次 run 冻结的验收命令(缺席 = 这条 run 没有可执行判据,best_of 据此拒)。 */
  acceptance?: { command: string; expect_exit: number };
  /** allowlistForRoot(cwd) ∪ 真探测 —— compile 不重新计算,只透传。 */
  allowlist: readonly string[];
  maxFanout: number;
  seats: { worker: string; escalation: string; verify: string };
  /** 是否有搜索 provider —— research 工具据此拒(缺 provider 的调用会抓不到东西地失败)。 */
  researchAvailable: boolean;
}

/**
 * compile() 的产物:成功带过 `parsePlan` 的 plan;失败带拒因**与该卡完整 manual**
 * 一次给全(D-3:manual 只走 tool result,不进 system prompt)。
 */
export type CompileResult = { ok: true; plan: ConductorPlan } | { ok: false; error: string; manual: string };

/** 一张 conductor 卡。`schema` 必须 `.strict()`(D-4:调度字段不进 schema);`manual` 是 thunk(D-2 惰性求值)。 */
export interface ConductorTool<P = unknown> {
  name: ConductorToolName;
  /** ≤300 字符,常驻在工具列表里(D-3)。 */
  short: string;
  schema: z.ZodType<P>;
  /** thunk:惰性求值 = 机械保证 manual 不会被顺手拼进常驻 prompt(D-3)。 */
  manual: () => string;
  compile: (params: P, ctx: ConductorCtx) => CompileResult;
}
