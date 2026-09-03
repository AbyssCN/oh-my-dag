/**
 * src/harness/conductor/tools/index —— 七张卡的唯一构造点(P3 契约 D-2 / S1)。
 *
 * `createConductorTools(ctx)` 是 headless(solve)与 TUI(conductor_chat)两处接线**共用**的
 * 那一个构造点(INV-1:两处 conductor 卡必须来自同一处,防「一处漏改」的装配期漂移)。
 * S1 只造这个模块本身,不接线进 run-goal / chat(接线是 S6b 的事)。
 *
 * `invokeConductorTool` / `formatRejection` 不是 D-2 冻结面的一部分 —— 它们是 S1 为了让
 * 「zod 拒绝 / help:true → 拒因 + 完整 manual」这条契约行为可测而加的分发胶水,
 * 后续接线层(S6b)直接复用即可,不必另起一份。
 */
import type { CompileResult, ConductorCtx, ConductorTool, ConductorToolName } from '../types';
import { bestOfTool } from './best-of';
import { decomposeTool } from './decompose';
import { exploreTool } from './explore';
import { mapTool } from './map';
import { researchTool } from './research';
import { spawnTool } from './spawn';
import { workTool } from './work';

export const CONDUCTOR_TOOL_NAMES: readonly ConductorToolName[] = [
  'work',
  'spawn',
  'map',
  'explore',
  'best_of',
  'research',
  'decompose',
] as const;

/**
 * 每张卡各自的 `compile` 是按自己的参数类型 `P` 强类型的(见各 `tools/*.ts`),
 * 放进一份异构注册表时必须类型擦除 —— `ConductorTool<P>` 在 `compile` 上对 `P` 逆变,
 * `ConductorTool<WorkParams>` 天然不是 `ConductorTool<unknown>` 的子类型(不同 P 互不兼容是应有的
 * 类型安全,不是 bug)。真正的类型安全在运行期:`invokeConductorTool` 总是先经 `tool.schema.safeParse`
 * 才调用 `tool.compile`,擦除只发生在“装进同一个数组”这一步,不影响调用期的参数校验。
 */
export function eraseConductorTool<P>(tool: ConductorTool<P>): ConductorTool {
  return tool as unknown as ConductorTool;
}

/** 七张卡,唯一构造点。ctx 目前不影响构造出的卡集合(七张卡恒在),留给未来按 run 条件裁剪。 */
export function createConductorTools(_ctx: ConductorCtx): readonly ConductorTool[] {
  // 逐个擦除(不用 `.map`):异构数组过 `.map` 会把回调的类型参数统一成一个,反而在
  // 元素之间互相不兼容的地方报错 —— 这不是逻辑错误,是 TS 推断顺序的产物,逐个调用绕开它。
  return [
    eraseConductorTool(workTool),
    eraseConductorTool(spawnTool),
    eraseConductorTool(mapTool),
    eraseConductorTool(exploreTool),
    eraseConductorTool(bestOfTool),
    eraseConductorTool(researchTool),
    eraseConductorTool(decomposeTool),
  ];
}

function isHelpRequest(raw: unknown): boolean {
  return !!raw && typeof raw === 'object' && (raw as Record<string, unknown>).help === true;
}

/**
 * 一次工具调用的完整分发:help:true → 只返 manual,不 compile;schema 拒绝 → 拒因 + manual;
 * schema 过 → 调 `tool.compile`(其 ok:false 分支自己带 manual,见各卡实现)。
 * 三条路径产物同形(`CompileResult`),调用方不需要区分「拒在哪一层」。
 */
export function invokeConductorTool<P>(tool: ConductorTool<P>, raw: unknown, ctx: ConductorCtx): CompileResult {
  if (isHelpRequest(raw)) {
    return { ok: false, error: 'help requested — manual only, no compile attempted', manual: tool.manual() };
  }
  const parsed = tool.schema.safeParse(raw);
  if (!parsed.success) {
    const reason = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    return { ok: false, error: reason, manual: tool.manual() };
  }
  return tool.compile(parsed.data, ctx);
}

/** 拒绝体的人读形态:manual 在前(首行即该卡 manual 首行),拒因附在后面。 */
export function formatRejection(result: { error: string; manual: string }): string {
  return `${result.manual}\n\n--- rejected ---\n${result.error}`;
}
