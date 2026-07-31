/**
 * src/model/gateway.ts — 模型网关适配层 (evolved DAG engine 的单一模型入口)。
 *
 * omd 内核 (executor-dag / verifier / fanout / plan) 只从这里 import 模型能力,
 * 不直接摸 callModel / providers / role-models —— 一个文件收拢全部模型接缝:
 *   - send(): callModel 之上的薄编排 (traceId + MiMo 预算闸 makeBudgetedCall + overflow 溢出)。
 *     上游 (bluebell gateway) 还有 middleware pipeline; 开源版内核不消费它 → 不搬 (YAGNI),
 *     行为 = "零 middleware 纯直通" (GWT-2), send ≡ budgetedCall(callModel)。
 *   - 其余 = omd model 层既有能力的 re-export (listProviders / role-models / cost / fallback)。
 */
import { randomUUID } from 'node:crypto';
import type { ModelRequest, ModelResponse } from './types';
import { callModel } from './index';
import { makeBudgetedCall } from './provider-budget';
import { recordGeneration } from './langfuse';

// ── 类型 re-export (内核统一从 gateway 取型) ─────────────────────────
export type {
  ContentPart,
  ModelMessage,
  ModelRequest,
  ModelResponse,
  ModelUsage,
} from './types';

// ── 模型层能力 re-export ─────────────────────────────────────────────
export { listProviders } from './providers';
export { assertModelResolvable, ModelError } from './index';
export { resolveRoleModel, listRoleModels } from './role-models';
export { withGoFallback, isGoModel, goFallbackModel } from './go-fallback';
export { makeBudgetedCall } from './provider-budget';
export { computeCost } from './cost-ledger';
export { flushLangfuse, langfuseStatus, resolveLangfuseConfig } from './langfuse';

// ── Gateway 元数据 (跨切面; 内核经 meta 传 overflow/session 归组) ────

/** 跨切面网关元数据。开源内核只消费 overflowModel (预算溢出) + sessionId (trace 归组)。 */
export interface GatewayMeta {
  /** 角色标签 (可观测; 如 'omd-leaf' / 'fanout-leaf')。 */
  role?: string;
  /**
   * MiMo 配额溢出模型 (provider-budget overflow 角色)。给则该 send 走 overflow 语义: mimo 满 cap 时不排队,
   * 改调此模型 (executor leaf 用 ds-flash 兜底)。省略 = priority 角色 (排队等 permit)。**预算下沉关键**:
   * executor-dag/fanout 经 send 复用 gateway 的单一 budgetedCall, 不再各自包 makeBudgetedCall (避免双重预算)。
   */
  overflowModel?: string;
  /** 同一次高层运行 (fanout/DAG) 的分组 id (把一波 leaf 调用归到一个 session)。 */
  sessionId?: string;
}

/** 带网关元数据的请求 (ModelRequest 超集; callModel 忽略多余字段)。 */
export interface GatewayRequest extends ModelRequest {
  /** 可观测 trace id。省略 → send() 生成。 */
  traceId?: string;
  /** 跨切面元数据。 */
  meta?: GatewayMeta;
  /** 自由 per-request bag (预留)。 */
  metadata?: Record<string, unknown>;
}

/** 生成一个 trace id。 */
export function generateTraceId(): string {
  return randomUUID();
}

/** 终端调用: callModel 包上 MiMo 速率感知预算闸 (并发 + RPM + 429 退避/溢出)。 */
const budgetedCall = makeBudgetedCall(callModel);

/**
 * send — 内核的单一模型调用入口。
 * meta.overflowModel 给则走 overflow 语义 (mimo 满 cap → 溢出该模型), 省略 = priority 排队。
 * 返回 = callModel 的 ModelResponse 原样 (单发, 无 tool loop)。
 */
export async function send(req: GatewayRequest): Promise<ModelResponse> {
  const reqWithTrace: GatewayRequest = req.traceId ? req : { ...req, traceId: generateTraceId() };
  // ── Langfuse 出口 (2026-07-31) ────────────────────────────────────────────────
  //
  // 放在这一层而不是 executor-dag 里: 这是**内核唯一的模型入口**, 挂这儿意味着 conductor /
  // leaf / judge / verifier / research 一个都漏不掉 —— 而"漏不掉"正是 prompt 可审查的前提
  // (漏掉的那类调用恰好是没人想起来的那类)。
  //
  // 未配 env → recordGeneration 直接 return, 主路径零成本。失败 → fail-open, 见 langfuse.ts。
  // 归组用 meta.sessionId: 一次 run 的全部调用落进同一条 trace; 没给就退回本次 traceId
  // (孤立调用也该看得见, 只是它自己一条)。
  const startTime = new Date();
  const traceId = reqWithTrace.meta?.sessionId ?? reqWithTrace.traceId!;
  const name = reqWithTrace.meta?.role ?? 'model-call';
  try {
    const res = await budgetedCall(reqWithTrace, reqWithTrace.meta?.overflowModel);
    recordGeneration({
      traceId,
      name,
      model: res.model ?? reqWithTrace.model ?? 'unknown',
      input: reqWithTrace.messages,
      output: res.text ?? '',
      ...(res.usage ? { usage: res.usage } : {}),
      startTime,
      endTime: new Date(),
    });
    return res;
  } catch (err) {
    // **失败的调用比成功的更值得看**: 429/超时/闸拒是 prompt 迭代时最需要的那一批样本,
    // 而它们恰恰是"只记成功"的观测面永远看不见的。记完原样抛, 不改变错误语义。
    recordGeneration({
      traceId,
      name,
      model: reqWithTrace.model ?? 'unknown',
      input: reqWithTrace.messages,
      output: '',
      startTime,
      endTime: new Date(),
      error: String(err),
    });
    throw err;
  }
}
