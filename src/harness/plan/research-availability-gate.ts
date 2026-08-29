/**
 * E-T2 (2026-08-28): research 不可用时 conductor 仍规划 executor:'research' 节点。
 *
 * 现场: bench 容器无 search key → researchRunner 缺席, 契约段照样画 research 节点 →
 * 执行期必败 (engine: missing-capability) 占位耗轮。workbuddy code80-m3 单批实测
 * 真失败 (`缺 researchRunner → failed`) 22 次 (2026-08-29 更正: 首版此处写 124,
 * 那是把装配期告知行「无 search provider」一并数进去了 —— 那行每 trial 恒 2 条, 量的是
 * 环境不是缺陷)。修后同规模批: 0 次。
 *
 * 三层修法 (本模块是纯函数半, 接线在 executor-dag):
 *   ① 教学 — conductorSystemPrompt({researchAvailable:false}) 注入不可用告知 (便宜, 但只是散文);
 *   ② 顶层闸 — 规划环 parsePlan 后确定性找出 research 节点, 有界拒回带 remediation,
 *      预算尽 fail-open 放行 + 响亮留证 (与 leaf-tier-gate 同形);
 *   ③ 兜底 — 执行期 missing-capability 硬闸照旧 (engine.ts executor:research 分支)。
 *
 * 证伪方式 (新闸当场证伪, 见 .test.ts): researchAvailable=true 时同一张图必须零命中 ——
 * 把下面的 early-return 删掉, 反向用例当场红。
 */
import type { ConductorPlan } from '../conductor-plan';

/** 找出「research 不可用」时计划里仍会走 research 管线的节点 id (含 map 模板半)。 */
export function researchNodesWithoutRunner(plan: ConductorPlan, researchAvailable: boolean): string[] {
  if (researchAvailable) return [];
  const hits: string[] = [];
  for (const [id, node] of Object.entries(plan.nodes)) {
    if (node.executor === 'research') hits.push(id);
    else if (
      node.executor === 'map' &&
      (node.map?.template as { executor?: string } | undefined)?.executor === 'research'
    ) hits.push(id);
  }
  return hits;
}

/** 拒回文案: 告诉 conductor 为什么被拒 + 合法的改法 + 明令禁止的假改法 (D-6: 别拿模型记忆冒充调研)。 */
export const researchUnavailableRemediation = (nodes: string[]): string =>
  `计划里有 research 节点 [${nodes.join(', ')}], 但本部署没有 search provider —— ` +
  `这些节点执行期必败 (missing-capability)。重画: 删掉 research 节点, 改用 agent/leaf 基于本地材料完成; ` +
  `信息真拿不到就在交付物里明说, 不要把 research 改名成 leaf 去"凭记忆调研"。`;
