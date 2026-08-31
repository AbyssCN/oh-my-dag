/**
 * src/harness/dag/thinker.ts —— 重画前置批评步 (2026-08-31, 片 1)。
 *
 * 纯函数层: 档位选择 (INV-4) + prompt 构造 (INV-2 角色约束) + 输出解析 (INV-2 形状检测)
 * + fail-open 入口 (INV-3 / INV-5)。generate 经参数注入, 不自建座位; 零 IO = 片 2 接线
 * 时也不会引入隐藏副作用。
 *
 * 详见 docs/research/2026-08-30-conductor-无训练编排设计.md §3.4。
 */
import type { GenerateFn } from './types';
import type { ModelUsage } from '../../model/gateway';
import { SEAT_PREFERRED_COORD } from '../../model/seats';

/** 锚串 —— 判据自证, 本片测试文件逐字包含 (GWT-2)。 */
export const THINKER_CRITIQUE = 'THINKER_CRITIQUE';

/** 具名错误码: 批评步输出长成 plan 形状 → 拒注入 (INV-2 fail-open, escTask 零变化)。 */
export const THINKER_REJECTED_PLAN_SHAPED_OUTPUT = 'THINKER_REJECTED_PLAN_SHAPED_OUTPUT';

/** 具名错误码: generate 调用抛错/超时 → fail-open, 留证据行, escTask 零变化 (INV-3)。 */
export const THINKER_GENERATE_FAILED = 'THINKER_GENERATE_FAILED';

/** 档位 (升档走 verifier 家族席, 缺省走 conductor 同模型兼任, D-2/D-3)。 */
export type CritiqueTier = 'conductor' | 'escalation';

// ────────────────────────────────────────────────────────────────────────────
// 档位选择纯函数 (INV-4) — 输入两 bool, 输出 tier + reasons, 零 IO。
// ────────────────────────────────────────────────────────────────────────────

export interface PickTierInput {
  /**
   * 判词来自闸红短路合成的 deterministic oracle (engine.ts:6150 起, 引擎自产) = true。
   * 读这种判词不需要外视角 —— 闸红短路路径失败证据是引擎给的。
   */
  verdictSynthesized: boolean;
  /** 本轮归一化败因与上一轮相同 (复用 D-6 同因归一化, 见 engine.ts:6288-6294) = true。 */
  sameCauseRepeat: boolean;
}

export interface PickTierOutput {
  seat: CritiqueTier;
  /** 选档理由 (trace 用, 调试时一眼看出为什么升档/不升档)。 */
  reasons: string[];
}

/**
 * 档位选择纯函数 (GWT-4 表)。
 *   (synth,  非同因) → conductor
 *   (真 verifier, 非同因) → escalation
 *   (synth,  同因) → escalation
 *   (真 verifier, 同因) → escalation
 *
 * 升档的两条理由**不互斥** (真 verifier + 同因都触发时 reasons 有两条), trace 看一眼就懂。
 */
export function pickCritiqueTier(input: PickTierInput): PickTierOutput {
  const reasons: string[] = [];
  let seat: CritiqueTier = 'conductor';
  if (!input.verdictSynthesized) {
    seat = 'escalation';
    reasons.push('verdict from real verifier (cross-model suspicion path)');
  }
  if (input.sameCauseRepeat) {
    seat = 'escalation';
    reasons.push('same normalized cause as prior round (own blind-spot repeated)');
  }
  if (reasons.length === 0) {
    reasons.push('verdict from deterministic oracle + no repeat → conductor-same sufficient (D-2)');
  }
  return { seat, reasons };
}

// ────────────────────────────────────────────────────────────────────────────
// 模型坐标解析 (零 IO, 不查注册表 — 注册表是调用方的事)。
// ────────────────────────────────────────────────────────────────────────────

/**
 * verifier 家族座位 coord (D-3 复用登记, 不新增)。
 * 仓规实测「同模型自审复用同一盲点, 它造的坏计划自己看不出坏」(`.claude/CLAUDE.md` 验收阶梯第 2 层)。
 * 从座位链取 (seats.ts 的 verifier 座 preferredCoord), 不写字面坐标 ——
 * seat-coordinate 防回潮闸对 src 运行路径拒一切未豁免字面坐标; 换座只改登记表, 这里跟着走。
 * verifier 座在登记表里恒配 preferredCoord (seats.ts:345), `!` 断言与 seats.ts 自身同款。
 */
export const THINKER_VERIFIER_COORD: string = SEAT_PREFERRED_COORD['verifier']!;

export interface CritiqueModel {
  /** 模型坐标 (provider:modelId)。 */
  model: string;
  /** 推理档。 */
  thinkingLevel: 'off' | 'low' | 'medium' | 'high' | 'xhigh';
  /** 档位 (分账用)。 */
  tier: CritiqueTier;
}

/** 档位 → 模型坐标。conductor 档走调用方给的 conductorModel, 升档走 verifier 家族。 */
export function resolveCritiqueModel(opts: {
  tier: PickTierOutput;
  conductorModel: string;
  /** 升档坐标; 缺省 = 内置 THINKER_VERIFIER_COORD。 */
  verifierFamilyCoord?: string;
}): CritiqueModel {
  if (opts.tier.seat === 'escalation') {
    return {
      model: opts.verifierFamilyCoord ?? THINKER_VERIFIER_COORD,
      thinkingLevel: 'high',
      tier: 'escalation',
    };
  }
  return {
    model: opts.conductorModel,
    thinkingLevel: 'high',
    tier: 'conductor',
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Prompt 构造 (INV-2 角色约束写死: 只批评, 不画图)。
// ────────────────────────────────────────────────────────────────────────────

export interface CritiqueInput {
  /** 原始任务 (escTask 起点 = task 文本)。 */
  task: string;
  /** 上一轮 plan 大纲文本 (planOutline(exec.plan) 产物)。 */
  planOutline: string;
  /** 判词原文 (verdict.reason)。 */
  verdictReason: string;
  /** 写域闸撞墙 observation 行 (格式 `[写域闸撞墙] ${msg}`, 可空)。 */
  writeWallLines: readonly string[];
  /** 归一化败因表 (本轮, 可能与上一轮同形)。可空。 */
  normalizedCauses: readonly string[];
}

export interface CritiquePrompt {
  messages: { role: 'system' | 'user'; content: string }[];
  /** 注入 escTask 的观测名 (分账用, 形如 `thinker:critique`)。 */
  traceName: string;
}

const SYSTEM_PROMPT = [
  '你是重画前的批评者 (thinker)。',
  '',
  '## 角色约束 (硬)',
  '- 只批评上一张图, 不许画新图, 不许输出节点定义。',
  '- 输出 = 散文批评块 (三段):',
  '  (1) 上一轮的具体败因 (判词原文 + 写域闸撞墙行 + 归一化败因表);',
  '  (2) 下张图必须改什么 (写集该怎么改, 哪条边该删, 哪条该加);',
  '  (3) 哪些节点可以并行 (写集内零依赖的写集)。',
  '- 不许输出 JSON 节点定义、不许重写 plan 文本、不许假设输入之外的上下文。',
  '- 若你认为无话可说 → 写「无可批评」并停笔, 不要硬编。',
  '',
  '## 输入',
].join('\n');

export function buildCritiquePrompt(input: CritiqueInput): CritiquePrompt {
  const userLines = [
    '### 原始任务',
    input.task,
    '',
    '### 上一轮 plan 大纲',
    input.planOutline,
    '',
    '### 判词原文',
    input.verdictReason,
    '',
    '### 写域闸撞墙行 (可空)',
    ...(input.writeWallLines.length > 0 ? input.writeWallLines : ['(无)']),
    '### 归一化败因表 (本轮)',
    ...(input.normalizedCauses.length > 0 ? input.normalizedCauses.map((c) => `- ${c}`) : ['(空)']),
  ];

  return {
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userLines.join('\n') },
    ],
    traceName: 'thinker:critique',
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 输出解析 (INV-2 形状检测) — plan 形状 JSON 具名拒, 其余视为散文。
// ────────────────────────────────────────────────────────────────────────────

export type CritiqueParseResult =
  | { ok: true; block: string }
  | { ok: false; error: string };

/**
 * 平衡切片 (与 conductor-plan.extractPlanJson 同款: 不信闭合 fence, 自己数括号)。
 * 字符串里的引号/转义保持原样, 深度为 0 时切。
 */
function balancedSlice(text: string, start: number): string {
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (escape) {
      escape = false;
      continue;
    }
    if (inStr) {
      if (ch === '\\') {
        escape = true;
      } else if (ch === '"') {
        inStr = false;
      }
      continue;
    }
    if (ch === '"') {
      inStr = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return text.slice(start);
}

/**
 * 形状检测: 抽首个平衡 {...} 子串 → JSON.parse → 看 `nodes` 字段是否为对象。
 * 命中 → plan 形状 → 拒; 不命中 → 散文 / 噪声 → 放行。
 *
 * 不复用 `parsePlan`: 那是**端到端**plan 校验 (schema + template + mcp server 注册表),
 * 而本片要的是"是不是**形状上像** plan"—— 让 schema 漂移污染形状检测是反向耦合, 反向自检条目见测试。
 */
function lookLikePlanJson(text: string): boolean {
  const start = text.indexOf('{');
  if (start < 0) return false;
  const cand = balancedSlice(text, start);
  if (cand.length === 0) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(cand);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  const nodes = (parsed as { nodes?: unknown }).nodes;
  if (!nodes || typeof nodes !== 'object' || Array.isArray(nodes)) return false;
  return true;
}

export function parseCritiqueOutput(text: string): CritiqueParseResult {
  if (lookLikePlanJson(text)) {
    return { ok: false, error: THINKER_REJECTED_PLAN_SHAPED_OUTPUT };
  }
  return { ok: true, block: text.trim() };
}

// ────────────────────────────────────────────────────────────────────────────
// fail-open 入口 (INV-1 / INV-3 / INV-5) — generate 经调用方注入, 副作用 = 调用方累加 usage。
// ────────────────────────────────────────────────────────────────────────────

export interface RunCritiqueOpts {
  /** 开关; 缺省关 → 直接返回 null, generate 零调用 (INV-5)。 */
  enabled: boolean;
  /** 档位选择输入。 */
  pick: PickTierInput;
  /** 调用方 conductor model 坐标 (档位 = conductor 时用)。 */
  conductorModel: string;
  /** 升档坐标; 省略 = THINKER_VERIFIER_COORD。 */
  verifierFamilyCoord?: string;
  /** prompt 输入 (与 buildCritiquePrompt 同形)。 */
  input: CritiqueInput;
  /** generate 注入 (测试传 fake, 生产 = runExecutorDag 传进来的同一个)。 */
  generate: GenerateFn;
  /** 失败证据日志 —— 给一个 Core logger 接口即可, 函数必须留证据行。 */
  logEvidence: (msg: string, payload: Record<string, unknown>) => void;
}

export interface RunCritiqueOutput {
  /** 解析成功的批评块; null = 没注入 (开关关 / 抛错 / 拒注入)。 */
  block: string | null;
  /** 选档结果 (trace 用)。 */
  tier: PickTierOutput;
  /** 选用的模型坐标 (trace 用)。 */
  model: CritiqueModel;
  /** 拒注入的具名错误 (若发生)。 */
  rejectReason?: string;
  /** 调用方自记 usage 累加 (成功时透传, 失败时归零 — 失败那一发 LLM 没真烧出 token)。 */
  usage: ModelUsage;
}

/**
 * 批评步入口 —— INV-1 (独立调用) / INV-2 (只批评不画图) / INV-3 (fail-open 不吞证据) /
  INV-5 (缺省关零扰动) 一并起。
 *
 *   enabled=false     → block=null, generate 零调用
 *   generate 抛错/超时 → logEvidence 留证据, block=null, rejectReason=THINKER_GENERATE_FAILED
 *   输出 plan 形状     → logEvidence 留证据, block=null, rejectReason=THINKER_REJECTED_PLAN_SHAPED_OUTPUT
 *   其余 (散文)        → block = trimmed 散文
 */
export async function runCritiqueStep(opts: RunCritiqueOpts): Promise<RunCritiqueOutput> {
  const tier = pickCritiqueTier(opts.pick);
  const model = resolveCritiqueModel({
    tier,
    conductorModel: opts.conductorModel,
    ...(opts.verifierFamilyCoord !== undefined ? { verifierFamilyCoord: opts.verifierFamilyCoord } : {}),
  });
  const zeroUsage: ModelUsage = { in: 0, out: 0 };
  if (!opts.enabled) {
    return { block: null, tier, model, usage: zeroUsage };
  }
  const prompt = buildCritiquePrompt(opts.input);
  let text: string;
  let usage: ModelUsage;
  try {
    const out = await opts.generate({
      messages: prompt.messages,
      model: model.model,
      thinkingLevel: model.thinkingLevel,
      // 升档换标签 —— 归座表按标签归到烧钱的座 (seat-usage.ts TRACE_SEAT_RULES),
      // 一个标签配两种模型必有一半错归 (escalation 分标签同一课)。
      traceName: model.tier === 'escalation' ? 'thinker:critique-escalated' : prompt.traceName,
    });
    text = out.text;
    usage = out.usage;
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    opts.logEvidence('[thinker-critique] generate failed (fail-open, escTask unchanged)', {
      error: THINKER_GENERATE_FAILED,
      raw,
      tier: model.tier,
      model: model.model,
    });
    return { block: null, tier, model, rejectReason: THINKER_GENERATE_FAILED, usage: zeroUsage };
  }
  const parsed = parseCritiqueOutput(text);
  if (!parsed.ok) {
    opts.logEvidence('[thinker-critique] output rejected (fail-open, escTask unchanged)', {
      error: parsed.error,
      tier: model.tier,
      model: model.model,
      rawPreview: text.slice(0, 120),
    });
    return { block: null, tier, model, rejectReason: parsed.error, usage };
  }
  return { block: parsed.block, tier, model, usage };
}