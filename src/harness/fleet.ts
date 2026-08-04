/**
 * src/harness/fleet —— executor 并发 + 模型路由的显式配置 (契约 D72 §8, VAL-DAG-7/8)。
 *
 * the owner 锁: 并发**不埋 CPU 默认**, 模型路由**by task-kind 全可配**。这一层是 DAG-executor
 * 接缝 (D72) 的配置真理源 —— dispatcher 按 node 的 task-kind 解析执行模型 (resolveExecutorModel),
 * 按 provider 解析并发桶 cap (resolveProviderCap); 内层 fan-out 上限走 effectiveFanout。
 *
 * 限流是 per-API-账户 (独立桶) → 全局可并发 = Σ providerPools。加一个 provider = 加一桶吞吐。
 * 默认: DeepSeek 可靠+可扩 → 开大; MiMo flaky+RPM100 → 压小 (实测 headless 单发都会 hang)。
 */
import { availableParallelism } from 'node:os';
import { resolveMultimodalPool, resolveSeatModel } from '../model/role-models';

// ---------------------------------------------------------------------------
// 并发配置 (VAL-DAG-7)
// ---------------------------------------------------------------------------

export interface OmdConcurrencyConfig {
  /** 单 omd 内层 fan-out 上限 (parallel/pipeline)。省略 → env OMD_MAX_FANOUT → CPU fallback。 */
  maxFanout?: number;
  /** per-provider 并发池 cap (外层 DAG + 内层共用桶)。键 = pi-ai provider id。 */
  providerPools?: Record<string, number>;
}

/** CPU-derived fallback (旧默认, 现仅 command 档兜底): min(16, cores−2), 至少 1。 */
export const CPU_FALLBACK_FANOUT = Math.max(1, Math.min(16, availableParallelism() - 2));

/**
 * agent 档默认并发 (owner 裁决 2026-08-04, r2 实测驱动)。
 *
 * **为什么脱离 CPU 派生值**: 这道闸原本与 command 共用 `CPU_FALLBACK_FANOUT`, 理由是"agent leaf
 * 有本地足迹(起子进程抢 CPU·磁盘)"。r2 的时间轴推翻了这个画像 —— agent leaf 的 32–142s 里
 * 绝大部分是**等 API**, 不是烧 CPU。按核数派生等于用错了尺子量。command 档留在 CPU 派生值不动:
 * 那一档是真在跑本地 shell。
 *
 * ⚠ **别把这个数读成"墙钟会变快"**: r2 实测并发只到 ~4, 而当时的闸是 16 —— 闸从没被撞到。
 * 真正的串行化源头未查明(见图「引擎墙钟与 leaf 档位」r1 票)。这里放宽只是**移走一个将来会
 * 挡路的东西**, 不是修复。
 */
export const AGENT_DEFAULT_FANOUT = 36;

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
  // 2026-07-31 owner: **DeepSeek 不设并发上限** —— 官方并发 2500, 而我们一张图撑死几十个节点,
  // 这个 cap 在真实负载下**永远够不着它要防的那件事**, 只是在挡自己。
  //
  // 为什么这一格此前是 64: 2026-06-01 的 ramp probe 量到 ≤256 零 429、256 起排队, 于是取了个
  // "留 TPM 余量"的保守数。今天回看那个数保守错了对象 —— 排队不是失败, 而 429 在 2500 并发下
  // 根本没出现过。真正需要护的是**本机足迹**(agent leaf 起子进程 / command leaf 起 shell),
  // 那件事由 `ExecutorDagConfig.kindFanout` 的 per-kind 小闸管着, 与 provider 桶是两回事。
  // 把两件事压在一个数上, 结果就是为了保护本机而顺手把网络等待型的 inproc 扇出也钳到 64。
  deepseek: Number.MAX_SAFE_INTEGER,
  'xiaomi-token-plan-ams': 8, // probe: >8 即 429, 硬上限 = 8 (**这个是真硬顶, 别跟着放**)
};
/** 未列出 provider 的兜底 cap。 */
const FALLBACK_PROVIDER_CAP = 8;

/**
 * 内层 fan-out 实际上限。优先级: 显式 config.maxFanout > env OMD_MAX_FANOUT > **不设限**
 * (owner 2026-07-21: 删 CPU 兜底 — API 等待型并发与核数无关, 钳 6 纯冤枉; 本地足迹的保护
 * 迁至 per-kind 闸 ExecutorDagConfig.kindFanout, agent/command 各自小闸, inproc 放飞)。
 */
export function effectiveFanout(
  config: OmdConcurrencyConfig = {},
  env: Record<string, string | undefined> = process.env,
): number {
  if (config.maxFanout !== undefined && config.maxFanout > 0) return Math.floor(config.maxFanout);
  const envVal = env.OMD_MAX_FANOUT ? Number.parseInt(env.OMD_MAX_FANOUT, 10) : NaN;
  if (Number.isFinite(envVal) && envVal > 0) return envVal;
  return Number.MAX_SAFE_INTEGER;
}

/** 某 provider 的并发桶 cap。config > DEFAULT_PROVIDER_POOLS > FALLBACK。 */
export function resolveProviderCap(
  provider: string,
  config: OmdConcurrencyConfig = {},
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
export function defaultRouting(): Required<ModelRoutingConfig> {
  const multimodal = resolveMultimodalPool()[0];
  return {
    routes: {
      coding: resolveSeatModel('agent').model, // agentic 实装 = agent 座
      ...(multimodal ? { multimodal } : {}), // 多模态池首选 (config.multimodalPool)
      general: resolveSeatModel('leaf').model,
    },
    default: resolveSeatModel('leaf').model,
    // conductor = **分解器非设计者**: omd (主 agent, 可换 SOTA) 已做高海拔设计/SDD, conductor 只把
    // 已成形的 plan 忠实分解成有效 DAG (拓扑/原子叶/executor 路由)。这活要 **指令遵守 + 结构化输出保真 + 快**,
    // **不要 reasoning** —— 推理会: ① 加延迟 (gate 在 fan-out 前, 拖慢全局) ② 过度思考 (擅自"改进"/二次设计
    // 已定 plan) ③ reasoning 模型反而常少遵守结构化输出指令。
    conductor: resolveSeatModel('conductor').model,
  };
}

/** 'provider:modelId' → {provider, modelId} (split on first ':')。 */
export function parseModelRef(ref: string): ModelRef {
  const i = ref.indexOf(':');
  if (i === -1) throw new Error(`[omd/fleet] bad model ref (need 'provider:modelId'): ${ref}`);
  return { provider: ref.slice(0, i), modelId: ref.slice(i + 1) };
}

/** task-kind → 执行模型 ref。config.routes > config.default > DEFAULT_ROUTING。 */
export function resolveExecutorModel(
  kind: TaskKind,
  config: ModelRoutingConfig = {},
): ModelRef {
  const fallback = defaultRouting();
  const ref = config.routes?.[kind] ?? fallback.routes[kind] ?? config.default ?? fallback.default;
  return parseModelRef(ref);
}

/** conductor (规划) 模型 ref。 */
export function resolveConductorModel(config: ModelRoutingConfig = {}): ModelRef {
  return parseModelRef(config.conductor ?? defaultRouting().conductor);
}
