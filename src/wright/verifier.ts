/**
 * src/wright/verifier —— wright executor-DAG 的**跨模型校验器** (model-agnostic skeptic)。
 *
 * 落地页角色卡 "Verifier" 的实装: 一个**不绑任何 CLI** 的怀疑者, 职责是**攻击结果而非盖章放行**。
 * DAG 跑完 → 把原任务 + 计划 + 各 leaf 输出交给 verifier → 它逐条对照任务的明确要求, 渲染
 * pass/fail + reason。fail 且配了可用升级模型 → executor-dag 用更强 conductor 重规划重跑 (静默升级)。
 *
 * 为什么 cross-model 而非同模型自审: 同模型自审会**复用同一盲点** (它造的坏计划自己看不出坏)。
 * 默认 verifier 模型走 resolveRoleModel('verifier') = deepseek (≠ 默认 mimo conductor/leaf), 形成
 * 真正的跨模型对抗。env XIHE_VERIFIER_MODEL / .wright/config.json 可换。
 *
 * 经济学 (见 [[project-wright-dag-executor-seam]] + conductor 模型校准): conductor 每 task 只跑一次,
 * 坏计划让一整轮 leaf 白干 (风险不对称) → verifier 兜底让弱 conductor 可安全降级: 弱模型造图 +
 * verifier 校验 + 失败才升级强模型。**没配 SOTA 升级模型 (provider 未注册) → 维持弱模型** (executor-dag
 * 内的 provider gate 自动判定, 见 escalationProviderReady)。
 *
 * Invariants:
 *  VER-1 verifier 永不阻断: 抛错由调用方 (executor-dag) 兜; 未结构化输出 → 保守判 fail (不静默放行)。
 *  VER-2 全 leaf 失败 → 不调模型直接 fail (省一次调用, 显然无产出)。
 *  VER-3 信 verifier 的 pass 布尔 (任务要求逐条对照已进 prompt); reason 必带 (fail 时点名缺啥)。
 */
import { z } from 'zod';
import { callModel, listProviders, assertModelResolvable } from '../model';
import { resolveRoleModel } from '../model/role-models';
import { logger } from '../logger';
import type { ModelUsage } from '../model/types';
import type { ConductorPlan } from './conductor-plan';
import type { LeafResult } from './executor-dag';

export interface VerifierVerdict {
  /** 结果是否满足任务的全部明确要求 (true = 放行)。 */
  pass: boolean;
  /** fail 时点名缺哪条要求 / 哪里捏造 + 该怎么改 (机制级)。pass 时可空。 */
  reason: string;
  /** 校验调用的 token 用量 (fast-path 时 {in:0,out:0})。 */
  usage: ModelUsage;
}

/** 校验器: 看 (原任务 + 计划 + leaf 结果) → 渲染裁决。注入式 (executor-dag 的 config.verifier)。 */
export type VerifierFn = (req: {
  task: string;
  plan: ConductorPlan;
  results: Record<string, LeafResult>;
}) => Promise<VerifierVerdict>;

/** verifier / escalation 的配置片段 (wiring 层经 resolveVerification 产, spread 进 dag config)。 */
export interface VerificationConfig {
  verifier?: VerifierFn;
  conductorEscalationModel?: string;
  maxEscalations?: number;
}

export const VERIFIER_VERDICT_SCHEMA = z.object({
  pass: z.coerce.boolean(),
  reason: z.coerce.string(),
});

/** 把 DAG 结果汇成给 verifier 看的一段 (失败节点标注, 每节点截断防爆 prompt)。 */
export function summarizeResults(
  plan: ConductorPlan,
  results: Record<string, LeafResult>,
  maxPerNode = 1200,
): string {
  const lines: string[] = [`plan: ${plan.name} · ${Object.keys(results).length} nodes`];
  for (const [id, leaf] of Object.entries(results)) {
    const goal = plan.nodes[id]?.goal;
    const head = `### ${id} [${leaf.status}]${goal ? ` — ${goal}` : ''}`;
    const body = leaf.status === 'failed' ? '(failed)' : (leaf.output ?? '').slice(0, maxPerNode);
    lines.push(`${head}\n${body}`);
  }
  return lines.join('\n\n');
}

function verifierPrompt(task: string, summary: string): string {
  return `你是一个**跨模型校验者**, 审一个多步任务的执行结果是否真正满足任务。你的职责是**攻击结果、找出它没满足任务的地方**, 而不是盖章放行 —— 默认怀疑, 证据不足时判不通过。

判定**必须先做一步**: 从原始任务里抽出所有**明确要求** —— 步数、字数/篇幅、必须覆盖的子部分、必须标注的东西、格式、约束、应产出的体裁 (设计/分析/清单, 而非假装执行)。**逐条**对照结果。

不通过 (pass=false) 的判据 (任一命中即不过):
1. 任一明确要求未满足 (即使整体看起来不错) —— reason 点名缺了哪条。
2. **高风险接缝** (契约边界 / 状态机 / 法定数字 / 安全) 即使"看起来对"也要质疑其正确性; 无法确证正确 → 不过。
3. 结果是**捏造的数据 / 假执行确认** (凭空编输入、"已发送/已录入" 这类没真做却声称做了的) → 不过。
4. 计划有节点失败导致结果不完整 → 不过。

原始任务:
---
${task}
---

执行结果:
---
${summary}
---

输出 JSON 两字段:
- pass (bool): 结果是否满足任务全部明确要求且无捏造。这是裁决。
- reason (string): pass=false 时**必填** —— 缺哪条要求 / 哪里捏造或不可信 + 重新规划时该怎么修 (机制级, 不是"不够好")。pass=true 时一句话说明已覆盖。`;
}

export interface DefaultVerifierOpts {
  /** 校验模型 'provider:modelId'。falsy → 调用时抛 (fail-closed 配置错, 不静默)。 */
  verifierModel: string | undefined;
  /** 校验推理档 (默认 high — 对抗式审查值得推理)。 */
  thinkingLevel?: 'off' | 'low' | 'medium' | 'high' | 'xhigh';
  /** 注入式 callModel (测试)。默认真 callModel。 */
  callModelFn?: typeof callModel;
}

/** 造默认跨模型校验器。全 leaf 失败 → 不调模型直接 fail (VER-2); 否则 callModel → 信其 pass 布尔。 */
export function createDefaultVerifier(opts: DefaultVerifierOpts): VerifierFn {
  const call = opts.callModelFn ?? callModel;
  return async ({ task, plan, results }): Promise<VerifierVerdict> => {
    if (!opts.verifierModel) {
      throw new Error('verifier: verifierModel 必填 (无硬默认, 形如 provider:modelId)');
    }
    const leaves = Object.values(results);
    // VER-2: 全失败 → 显然无产出, 省一次调用。
    if (leaves.length > 0 && leaves.every((l) => l.status === 'failed')) {
      return { pass: false, reason: '所有 leaf 执行失败 — 计划无产出', usage: { in: 0, out: 0 } };
    }
    const summary = summarizeResults(plan, results);
    const r = await call({
      model: opts.verifierModel,
      messages: [{ role: 'user', content: verifierPrompt(task, summary) }],
      temperature: 0.2,
      maxTokens: 700,
      thinkingLevel: opts.thinkingLevel ?? 'high',
      responseSchema: VERIFIER_VERDICT_SCHEMA,
    });
    const v = r.parsed as { pass: boolean; reason: string } | undefined;
    // VER-1: 未结构化输出 → 保守 fail (不静默放行)。
    if (!v) return { pass: false, reason: 'verifier 未结构化输出 → 保守判不通过', usage: r.usage };
    const pass = v.pass === true;
    return { pass, reason: pass ? v.reason ?? '已覆盖任务要求' : v.reason ?? '未满足任务要求', usage: r.usage };
  };
}

export interface ResolveVerificationOpts {
  /** 关掉校验 (返空 config = 无 verifier, executor-dag 退回无校验老行为)。默认开。 */
  enabled?: boolean;
  /** 校验模型坐标。省略 = resolveRoleModel('verifier') (默认 deepseek, 跨 mimo conductor)。 */
  verifierModel?: string;
  /**
   * conductor 升级模型坐标 (verifier fail 时重规划用)。省略 = env XIHE_CONDUCTOR_ESCALATION_MODEL。
   * **provider 未注册 (没配 API key) → executor-dag 自动不升级, 维持弱模型** (the owner 指令)。
   */
  escalationModel?: string;
  /** verifier-fail → 升级重规划的最大次数 (默认 executor-dag 的 1)。 */
  maxEscalations?: number;
  thinkingLevel?: 'off' | 'low' | 'medium' | 'high' | 'xhigh';
  callModelFn?: typeof callModel;
  env?: Record<string, string | undefined>;
}

/**
 * wiring 层助手: 据 role-models + env 产 {verifier, conductorEscalationModel}, spread 进 dag config。
 * executor-dag 保持纯净 (不读 env / role-models, 设计锁); 这层负责"默认走哪个模型 + 升级模型从哪来"。
 */
export function resolveVerification(opts: ResolveVerificationOpts = {}): VerificationConfig {
  if (opts.enabled === false) return {};
  const env = opts.env ?? process.env;
  const verifierModel = opts.verifierModel ?? resolveRoleModel('verifier', env);
  // verifier 是**可选增强** (cross-model skeptic), 不是致命依赖。坐标解析不了 (provider 没配 key /
  // 没 defaultModel 等) → **优雅降级到"验证禁用" + warn, 绝不崩 boot** (对齐"没配 SOTA 维持弱"哲学)。
  // 仍在 boot 早 detect (非等 leaves 跑完才在 verify 处崩, 那才是 footgun) — 只是从 throw 改成 disable。
  try {
    assertModelResolvable(verifierModel, 'verifier');
  } catch (err) {
    logger.warn(
      { verifierModel, err: (err as Error).message },
      '[wright/verifier] verifier 模型无法解析 → 验证已禁用 (设 XIHE_VERIFIER_MODEL 为完整 provider:model, 或 XIHE_VERIFY=0 显式关)',
    );
    return {};
  }
  const verifier = createDefaultVerifier({
    verifierModel,
    thinkingLevel: opts.thinkingLevel,
    callModelFn: opts.callModelFn,
  });
  const escalationModel = (opts.escalationModel ?? env.XIHE_CONDUCTOR_ESCALATION_MODEL)?.trim();
  return {
    verifier,
    conductorEscalationModel: escalationModel || undefined,
    maxEscalations: opts.maxEscalations,
  };
}

/** escalation 模型的 provider 是否已注册 (= 是否配了对应 API key)。未配 → 不升级, 维持弱模型。 */
export function escalationProviderReady(coord: string | undefined): coord is string {
  if (!coord) return false;
  const provider = coord.split(':')[0];
  return !!provider && listProviders().includes(provider);
}
