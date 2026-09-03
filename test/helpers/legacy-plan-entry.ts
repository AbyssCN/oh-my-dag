/**
 * test/helpers/legacy-plan-entry —— **测试专用**: 「task → 模型出图 → 执行」入口的最小复刻。
 *
 * 2026-09-03 v1 规划式 conductor 退役后, 引擎只剩预置图入口 `runExecutorDagWithPlan`; 生产的任务入口是编排循环
 * (`goal/loop-run.ts`)。但一批引擎机制测试 (trust header / touch ledger / 写域闸 / 就绪集 / 失败分型 …) 此前
 * 都用「fake generate 返一段 plan JSON」来驱动引擎 —— 它们测的是执行机器, 不是规划器。这里把那一跳 (调一次
 * generate 拿 plan 文本 → parsePlan → 执行) 留在测试侧, 让那些测试的注入面一个字不改。
 *
 * 不在生产代码里: reachability / capability 闸都不认 test/helpers。
 */
import { loadAgentTemplates } from '../../src/harness/agent-templates';
import { parsePlan } from '../../src/harness/conductor-plan';

/** v1 出图请求的冻结前缀 (原 conductor-plan.ts PLAN_BOUNDARY, 2026-09-04 随 v1 prompt 删除); 一批 fake generate 靠它的首行认出规划请求。 */
export const PLAN_BOUNDARY = '\n\n===== TASK (dynamic, below the frozen boundary) =====\n\n';
import { runExecutorDagWithPlan } from '../../src/harness/dag/engine';
import type { ExecutorDagConfig, ExecutorDagResult, PriorExec } from '../../src/harness/dag/types';
import { knownMcpServerNames } from '../../src/mcp/client/config';

export async function runExecutorDag(task: string, config: ExecutorDagConfig, prior?: PriorExec): Promise<ExecutorDagResult> {
  if (!config.conductorModel) throw new Error('executor-dag: conductorModel 必填 (无硬默认, 形如 provider:modelId)');
  if (!config.leafModel) throw new Error('executor-dag: leafModel 必填 (无硬默认, 形如 provider:modelId)');
  if (!config.generate) throw new Error('legacy-plan-entry: 需要注入 generate (fake 出图)');
  const { text, usage } = await config.generate({
    model: config.conductorModel,
    messages: [
      // 系统段含 CONDUCTOR 字样: 一批 fake 靠它 (而不是 model / traceName) 认出规划请求。
      { role: 'system', content: '[legacy-plan-entry] CONDUCTOR: 把任务分解成一张 plan JSON' },
      // v1 出图请求的形状: 冻结前缀 + 任务 —— 一批 fake generate 靠 PLAN_BOUNDARY 的首行认出「这一发是规划请求」。
      { role: 'user', content: `${PLAN_BOUNDARY}${task}` },
    ],
    // v1 的取档顺序: config 显式 > 座位档 > 硬默认 high; 标签与 v1 同名, 按 traceName 分桶的 fake 才认得出这一发。
    thinkingLevel: config.seatThinking?.(config.conductorModel, 'conductor') ?? 'high',
    maxTokens: 32_768,
    traceName: 'conductor:plan',
  });
  const root = config.continuity?.repoRoot ?? process.cwd();
  const templates = config.agentTemplates ?? loadAgentTemplates({ root });
  const parsed = parsePlan(text, { knownTemplates: new Set(templates.keys()), knownServers: knownMcpServerNames(root) });
  if (!parsed.ok) throw new Error(`legacy-plan-entry: plan 不合法: ${parsed.error}`);
  const res = await runExecutorDagWithPlan(parsed.plan, config, prior);
  return {
    ...res,
    usage: { ...res.usage, conductor: { in: res.usage.conductor.in + usage.in, out: res.usage.conductor.out + usage.out, cacheHit: (res.usage.conductor.cacheHit ?? 0) + (usage.cacheHit ?? 0) } },
  };
}
