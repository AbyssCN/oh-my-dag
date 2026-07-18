/**
 * core/primitive-router —— Rule Router(确定性,SDD 0013 S1 · D61-4 默认路由器)。
 *
 * 给一组任务信号,按 registry 顺序找**首个** `when(signals)` 命中的原语。无匹配返 null →
 * 调用方降级 LLM Planner(约束选)→ 再降级自由 node-graph(SEL-5 三级兜底,不 crash)。
 *
 * 确定性纯函数(0 模型 0 IO):同 signals → 同决策 → 完整可单测、weak-fleet 复算一致。
 * 控制流归属(SEL-3):Router 只**选** primitive id,params 由调用方/LLM 填、经 registry schema 校。
 */
import { PRIMITIVE_TEMPLATES, type PrimitiveId, type TaskSignals } from './primitive-registry';

export interface RouteResult {
  /** 命中的原语;null = 无规则匹配(降级信号)。 */
  primitive: PrimitiveId | null;
  /** 一行人读理由(审计 + 测试断言)。 */
  reason: string;
}

/**
 * Rule Router:遍历 registry(顺序即优先级),返回首个 `when` 命中的原语。
 * 无匹配 → { primitive: null }(SEL-5:调用方降级 LLM/自由图)。
 */
export function routePrimitive(signals: TaskSignals): RouteResult {
  for (const tmpl of PRIMITIVE_TEMPLATES) {
    if (tmpl.when(signals)) return { primitive: tmpl.id, reason: `Rule Router: 命中 '${tmpl.id}' 的 when 谓词` };
  }
  return { primitive: null, reason: 'Rule Router: 无原语匹配 → 降级 LLM Planner / 自由 node-graph' };
}
