/**
 * src/valar/fleet —— executor 并发 + 模型路由的显式配置 (契约 D72 §8, VAL-DAG-7/8)。
 *
 * the owner 锁: 并发**不埋 CPU 默认**, 模型路由**by task-kind 全可配**。这一层是 DAG-executor
 * 接缝 (D72) 的配置真理源 —— dispatcher 按 node 的 task-kind 解析执行模型 (resolveExecutorModel),
 * 按 provider 解析并发桶 cap (resolveProviderCap); 内层 fan-out 上限走 effectiveFanout。
 *
 * 限流是 per-API-账户 (独立桶) → 全局可并发 = Σ providerPools。加一个 provider = 加一桶吞吐。
 * 默认: DeepSeek 可靠+可扩 → 开大; MiMo flaky+RPM100 → 压小 (实测 headless 单发都会 hang)。
 */
import { availableParallelism } from 'node:os';

// ---------------------------------------------------------------------------
// 并发配置 (VAL-DAG-7)
// ---------------------------------------------------------------------------

export interface ValarConcurrencyConfig {
  /** 单 valar 内层 fan-out 上限 (parallel/pipeline)。省略 → env VALAR_MAX_FANOUT → CPU fallback。 */
  maxFanout?: number;
  /** per-provider 并发池 cap (外层 DAG + 内层共用桶)。键 = pi-ai provider id。 */
  providerPools?: Record<string, number>;
}

/** CPU-derived fallback (旧默认, 现仅兜底): min(16, cores−2), 至少 1。 */
export const CPU_FALLBACK_FANOUT = Math.max(1, Math.min(16, availableParallelism() - 2));

/**
 * per-provider 默认 cap (the owner 锁: DeepSeek 开大, MiMo 压小)。
 * **ramp probe 实测校准 (spikes/concurrency-probe.ts, 2026-06-01)**:
 *   - MiMo: n≤8 全 ok, n=16 起 8/16 → 429, n=32 全 429。真上限 = 8 (硬顶)。
 *   - DeepSeek: n≤256 全 ok 零 429, ~300ms; 128 无延迟降级, 256 起排队 (p50 910ms)。
 *     原始 API 并发 >256, 远超 MiMo。
 * default 64 = 「开大」但留 TPM 余量 (probe 用 5-token 短 call; 真 agentic call 更长 →
 * TPM-限, 故 cap 取在 raw 并发上限之下)。短 call fan-out 可经 config 调到 128。
 */
export const DEFAULT_PROVIDER_POOLS: Record<string, number> = {
  deepseek: 64, // probe ≤256 零 429 (128 无降级); 64 留 TPM 余量, config 可调高
  'xiaomi-token-plan-ams': 8, // probe: >8 即 429, 硬上限 = 8
};
/** 未列出 provider 的兜底 cap。 */
const FALLBACK_PROVIDER_CAP = 8;

/**
 * 内层 fan-out 实际上限。优先级: 显式 config.maxFanout > env VALAR_MAX_FANOUT >
 * CPU fallback (min(16,cores−2))。这是「leaf 开大」的旋钮 —— 不再被 CPU 默认卡死。
 */
export function effectiveFanout(
  config: ValarConcurrencyConfig = {},
  env: Record<string, string | undefined> = process.env,
): number {
  if (config.maxFanout !== undefined && config.maxFanout > 0) return Math.floor(config.maxFanout);
  const envVal = env.VALAR_MAX_FANOUT ? Number.parseInt(env.VALAR_MAX_FANOUT, 10) : NaN;
  if (Number.isFinite(envVal) && envVal > 0) return envVal;
  return CPU_FALLBACK_FANOUT;
}

/** 某 provider 的并发桶 cap。config > DEFAULT_PROVIDER_POOLS > FALLBACK。 */
export function resolveProviderCap(
  provider: string,
  config: ValarConcurrencyConfig = {},
): number {
  return (
    config.providerPools?.[provider] ??
    DEFAULT_PROVIDER_POOLS[provider] ??
    FALLBACK_PROVIDER_CAP
  );
}

// ---------------------------------------------------------------------------
// 模型路由 (VAL-DAG-8) — by task-kind, 全可配
// ---------------------------------------------------------------------------

export type TaskKind = 'coding' | 'multimodal' | 'general';

/** 'provider:modelId' 引用。 */
export interface ModelRef {
  provider: string;
  modelId: string;
}

export interface ModelRoutingConfig {
  /** task-kind → 'provider:modelId'。 */
  routes?: Partial<Record<TaskKind, string>>;
  /** 兜底 (未匹配 kind / 未列出)。 */
  default?: string;
  /** conductor (DAG 编译/replan, 非节点 execution) 用模型。 */
  conductor?: string;
}

/**
 * the owner 锁的默认路由 (全可被 config 覆盖)。
 * 2026-06-01 probe 后修正: coding 是 agentic 多轮实装, MiMo 在工具循环里会 hang
 * (probe 证原始 API 不 hang, 故是 pi+MiMo 多轮的问题) → coding 也走可靠的 DeepSeek。
 * **只有多模态留 MiMo** (它是唯一带 vision 的)。
 */
export const DEFAULT_ROUTING: Required<ModelRoutingConfig> = {
  routes: {
    coding: 'deepseek:deepseek-v4-flash', // agentic 实装走可靠 DeepSeek (MiMo 工具循环 hang)
    multimodal: 'xiaomi-token-plan-ams:mimo-v2.5', // 唯一带 vision → MiMo v2.5 (⚠ 确认 id)
    general: 'deepseek:deepseek-v4-flash', // 其他 → deepseek v4-flash
  },
  default: 'deepseek:deepseek-v4-flash',
  // conductor = **分解器非设计者**: valar (主 agent, 可换 SOTA) 已做高海拔设计/SDD, conductor 只把
  // 已成形的 plan 忠实分解成有效 DAG (拓扑/原子叶/executor 路由)。这活要 **指令遵守 + 结构化输出保真 + 快**,
  // **不要 reasoning** —— 推理会: ① 加延迟 (gate 在 fan-out 前, 拖慢全局) ② 过度思考 (擅自"改进"/二次设计
  // 已定 plan) ③ reasoning 模型反而常少遵守结构化输出指令。flash 更遵守指令 = 正解。
  // (例外: 无 valar 上游设计的 headless 裸任务, 分解需理解 → 可经 config 升 pro; 默认 flash。)
  conductor: 'deepseek:deepseek-v4-flash',
};

/** 'provider:modelId' → {provider, modelId} (split on first ':')。 */
export function parseModelRef(ref: string): ModelRef {
  const i = ref.indexOf(':');
  if (i === -1) throw new Error(`[valar/fleet] bad model ref (need 'provider:modelId'): ${ref}`);
  return { provider: ref.slice(0, i), modelId: ref.slice(i + 1) };
}

/** task-kind → 执行模型 ref。config.routes > config.default > DEFAULT_ROUTING。 */
export function resolveExecutorModel(
  kind: TaskKind,
  config: ModelRoutingConfig = {},
): ModelRef {
  const ref =
    config.routes?.[kind] ??
    DEFAULT_ROUTING.routes[kind] ??
    config.default ??
    DEFAULT_ROUTING.default;
  return parseModelRef(ref);
}

/** conductor (规划) 模型 ref。 */
export function resolveConductorModel(config: ModelRoutingConfig = {}): ModelRef {
  return parseModelRef(config.conductor ?? DEFAULT_ROUTING.conductor);
}
