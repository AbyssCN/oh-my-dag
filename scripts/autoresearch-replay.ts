#!/usr/bin/env bun
/**
 * scripts/autoresearch-replay —— autoresearch 回放评估器 CLI (P1 前置件, 2026-09-01 契约 C-4)。
 *
 * ## 入口与选项
 *
 *   bun scripts/autoresearch-replay.ts <manifest-path> [options]
 *
 *   --variant <name>     conductor 提示面变体名 (默认 'baseline')。
 *                        stub 模式下, 不同 variant 通过 stableHash 分桶选 canned plan
 *                        (clean / fake-serial); 同一 variant 同输入 → 字节级同输出。
 *   --split <name>       评估语料切片: screen / main / heldout (默认 'main')。
 *                        heldout 必须配合 --allow-heldout 才放行 (C-2 闸)。
 *   --allow-heldout      放行 heldout split (闸钥匙, 默认锁)。
 *   --baseline           跑一次, 输出基线 JSON (C-4: 含语料 hash + 座位坐标)。
 *                        与 --stability 互斥; 默认行为 (两者都不传) 等价 --baseline。
 *   --stability <N>      同输入跑 N 次, 输出 per-dim 方差 (N ≥ 2)。
 *   --live               真联机调 LLM —— 经 defaultLiveProvider 走 src/model/gateway.send()。
 *                        **本契约测试零实际冒烟** (首夜点火前人工冒烟 1 题)。
 *                        默认 stub 座位, 零 LLM 调用, 确定性。
 *
 * ## 出口
 *
 *   stdout: JSON  {ok:true, manifestHash, seats, variant, split, ...}
 *   stderr: JSON  {ok:false, error}; 退出码 1。
 *
 * ## C-4 落点
 *
 *   - `--baseline` 输出含 manifest.totalHash + manifest.seats; stub 座位下同输入两跑逐字节同;
 *   - `--stability N` 输出 per-dim 方差 (各维独立, NaN/0/null 处理见 computeStability);
 *   - 真 LLM 调用 (`--live`) 路径走 defaultLiveProvider (send → gateway → 真联机),
 *     装配点接 conductorSystemPrompt + manifest.seats.conductor 解析;
 *     测试通过 opts.liveProvider 注入 fake, 不冒烟。
 *
 * ## 反向自检 (锁死判据力, 详见 autoresearch-replay.test.ts 的反向自检段)
 *
 *   - 把 stubVariantToRawText 的分桶改回 constant → REPLAY_STUB_JSON 真值键 (两跑字节同) 红;
 *   - 把 --baseline 输出中的 manifestHash 字段去掉 → C-4 闸红;
 *   - 把 computeStability 的方差改用 |a-b| → variance 不为 0 / 真值链失守 (REPLAY_STUB_JSON 闸红);
 *   - 把 defaultLiveProvider 改成返 stubVariantToRawText (不调 LLM) → live 路径仍跑通但 stub
 *     JSON byte-identical 跨 --live/无 --live, LIVE_FAKE_INJECTION 闸红。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  loadCorpus,
  stableHash,
  type LoadedCorpus,
  type SplitName,
  SPLIT_ORDER,
} from '../src/eval/replay/corpus';
import {
  aggregateFitness,
  computeFitness,
  type AggregatedFitness,
  type PlanFitness,
} from '../src/eval/replay/fitness';
import {
  conductorSystemPrompt,
  parsePlan,
  PLAN_BOUNDARY,
} from '../src/harness/conductor-plan';
import { bootstrapModelRuntime } from '../src/model/bootstrap';
import { send } from '../src/model/gateway';
import type { GatewayRequest, ModelResponse } from '../src/model/gateway';
import { tryResolveSeatModel } from '../src/model/role-models';

// ─── 选项解析 ─────────────────────────────────────────────────────────────

/** CLI 解析后的入参。供测试直接构造 (不必走 process.argv)。 */
export interface ReplayArgs {
  manifestPath: string;
  variant: string;
  split: SplitName;
  allowHeldout: boolean;
  /** `--baseline` 或 `--stability` 二选一;两者都不传 → 当作 baseline=1 跑一次。 */
  baseline: boolean;
  stability: number | null;
  live: boolean;
}

/** 解析 argv 为 ReplayArgs。throw 即错误 (调用方负责退出码)。 */
export function parseReplayArgs(argv: readonly string[]): ReplayArgs {
  const positional: string[] = [];
  let variant: string | null = null;
  let split: SplitName = 'main';
  let allowHeldout = false;
  let baseline = false;
  let stability: number | null = null;
  let live = false;
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    switch (a) {
      case '--variant':
        variant = next();
        break;
      case '--split': {
        const v = next();
        if (v !== 'screen' && v !== 'main' && v !== 'heldout') {
          throw new Error(`--split must be screen | main | heldout, got "${v}"`);
        }
        split = v;
        break;
      }
      case '--allow-heldout':
        allowHeldout = true;
        break;
      case '--baseline':
        baseline = true;
        break;
      case '--stability': {
        const v = next();
        const n = Number(v);
        if (!Number.isInteger(n) || n < 2) {
          throw new Error(`--stability needs integer >= 2, got "${v}"`);
        }
        stability = n;
        break;
      }
      case '--live':
        live = true;
        break;
      case '--help':
      case '-h':
        help = true;
        break;
      default:
        if (a.startsWith('--')) throw new Error(`unknown flag: ${a}`);
        positional.push(a);
        break;
    }
  }

  if (help) {
    // 让 main() 打印用法;这里返回的 args 不会被用到, 用空 manifestPath 标记。
    return {
      manifestPath: '',
      variant: variant ?? 'baseline',
      split,
      allowHeldout,
      baseline: false,
      stability: null,
      live,
    };
  }

  if (positional.length === 0) {
    throw new Error(
      'usage: bun scripts/autoresearch-replay.ts <manifest-path> [--variant V] [--split screen|main|heldout] [--allow-heldout] [--baseline|--stability N] [--live]',
    );
  }
  if (positional.length > 1) {
    throw new Error(
      `expected exactly one positional arg (manifest-path), got ${positional.length}`,
    );
  }
  if (split === 'heldout' && !allowHeldout) {
    throw new Error('--split heldout requires --allow-heldout (C-2 闸)');
  }
  if (baseline && stability !== null) {
    throw new Error('--baseline and --stability are mutually exclusive');
  }
  // 默认: 既不给 --baseline 也不给 --stability → 当作 --baseline
  if (!baseline && stability === null) baseline = true;

  return {
    manifestPath: positional[0]!,
    variant: variant ?? 'baseline',
    split,
    allowHeldout,
    baseline,
    stability,
    live,
  };
}

// ─── stub 座位 ─────────────────────────────────────────────────────────────

/**
 * Stub 座位: 不调 LLM, 给定 variant 选一个 canned rawText。**确定性**:
 * 同一 variant → 同一 rawText (字节级); 不同 variant 经 stableHash 分桶, 大概率不同。
 *
 * Canned = src/eval/replay/fixtures/ 下的两张真 plan JSON, 一张 clean 一张 fake-serial
 * (与 fitness.ts 的 fixture 同源, 不再造新文件)。
 *
 * 真 LLM 路径 (`--live`) 走 defaultLiveProvider, 见下。
 */
let CLEAN_RAW_CACHE: string | null = null;
let FAKE_SERIAL_RAW_CACHE: string | null = null;

function loadCannedRawText(variant: 'clean' | 'fake-serial'): string {
  const FIX_DIR = join(import.meta.dir, '..', 'src', 'eval', 'replay', 'fixtures');
  const file = variant === 'clean' ? 'plan-clean.json' : 'plan-fake-serial.json';
  return readFileSync(join(FIX_DIR, file), 'utf8');
}

function cleanRawText(): string {
  if (CLEAN_RAW_CACHE === null) CLEAN_RAW_CACHE = loadCannedRawText('clean');
  return CLEAN_RAW_CACHE;
}

function fakeSerialRawText(): string {
  if (FAKE_SERIAL_RAW_CACHE === null) FAKE_SERIAL_RAW_CACHE = loadCannedRawText('fake-serial');
  return FAKE_SERIAL_RAW_CACHE;
}

/** canned plan 的若干程序化变体; 分桶用。4 桶, 每桶覆盖不同 fitness 维度组合。 */
type CannedBucket = 0 | 1 | 2 | 3;

let SHAPED_CLEAN_RAW_CACHE: string | null = null;
let NO_BUDGET_FAKE_SERIAL_RAW_CACHE: string | null = null;

/** clean fixture + 注入顶层 `shape` → shapeDeclared=true。 */
function shapedCleanRawText(): string {
  if (SHAPED_CLEAN_RAW_CACHE === null) {
    const raw = cleanRawText();
    const obj = JSON.parse(raw) as Record<string, unknown>;
    obj['shape'] = `stub:${stableHash('shape', 0xface)}`;
    SHAPED_CLEAN_RAW_CACHE = JSON.stringify(obj);
  }
  return SHAPED_CLEAN_RAW_CACHE;
}

/** fake-serial fixture - 所有 budgetBasis → speedupTheoretical=null。 */
function noBudgetFakeSerialRawText(): string {
  if (NO_BUDGET_FAKE_SERIAL_RAW_CACHE === null) {
    const raw = fakeSerialRawText();
    const obj = JSON.parse(raw) as { nodes: Record<string, Record<string, unknown>> };
    for (const n of Object.values(obj.nodes)) delete n['budgetBasis'];
    NO_BUDGET_FAKE_SERIAL_RAW_CACHE = JSON.stringify(obj);
  }
  return NO_BUDGET_FAKE_SERIAL_RAW_CACHE;
}

/**
 * Stub rawText 提供器。给 variant 返 deterministic rawText。
 *
 * 4 桶, 各桶的 fitness 维度差异分布 (取样 1 题):
 *   - 0 (clean):                          fakeSerialPairs=0 · speedup=1   · shapeDeclared=false · planValidity=true
 *   - 1 (fake-serial):                    fakeSerialPairs=5 · speedup=4/3 · shapeDeclared=false · planValidity=true
 *   - 2 (fake-serial, 去掉 budgetBasis):  fakeSerialPairs=5 · speedup=null · shapeDeclared=false · planValidity=true
 *   - 3 (clean + shape 注入):              fakeSerialPairs=0 · speedup=1   · shapeDeclared=true  · planValidity=true
 *
 * 不同 variant 经 stableHash 分桶, 碰撞率 25%/pair, 但**每个 variant 自身 deterministic**:
 * 同 variant → 同 bucket → 同 rawText (字节级); evaluateSplit 不读时钟/全局 → 整输出字节级相同。
 *
 * 注: id / prompt 当前不参与分桶。**这是 stub 的故意简化** —— 真 LLM 路径下, 同 prompt
 * 不同 LLM 座位会产出不同 rawText, 那是 defaultLiveProvider 的责任, 不是 stub 的。
 */
export function stubVariantToRawText(variant: string): string {
  const bucket = (stableHash(variant, 0xabcdef) % 4) as CannedBucket;
  switch (bucket) {
    case 0:
      return cleanRawText();
    case 1:
      return fakeSerialRawText();
    case 2:
      return noBudgetFakeSerialRawText();
    case 3:
      return shapedCleanRawText();
  }
}

// ─── live 路径 ─────────────────────────────────────────────────────────────

/**
 * Live provider 上下文: 决定一次 `--live` 调用的目标座位 / variant / 元信息。
 * `seats` 来自 manifest.seats (冻结时的座位签名), 保证回放与冻结时刻的座位
 * 套对齐 (C-4: 基线可复算 —— 同 manifest 必同 seat)。
 */
export interface LiveProviderContext {
  /** manifest 冻结时刻的座位签名, 用于解析目标 coord。 */
  seats: Record<string, string>;
  /** 当前 variant 名; 用于日志 / trace, 不影响模型选型。 */
  variant: string;
  /** 语料条目 id; 用于 trace 关联。 */
  id: string;
}

/**
 * 真 LLM 联机调用契约: 给 (id, prompt, ctx) → rawText。
 * 实现 = defaultLiveProvider (bootstrap + send); 测试 = opts.liveProvider 注入 fake。
 *
 * 注入点的存在不是装饰 —— 它是 "本契约零实际冒烟" 与 "live 路径真存在" 这两件事
 * 能同时成立的那道闸: 默认实现烧真 token, 测试装假, 路径在两条线上都走。
 */
export type LiveProvider = (
  id: string,
  prompt: string,
  ctx: LiveProviderContext,
) => Promise<string>;

/**
 * 模拟 transport 的注入点 (与 LiveProvider 同层, 但低一档) —— 接 send(req) → ModelResponse
 * 的函数签名 (= src/model/gateway.ts:send 的同形)。让 defaultLiveProvider **不调真 send**
 * 但**完整跑 conductorSystemPrompt + PLAN_BOUNDARY + role 解析 + meta 拼装**这条
 * integration 路径, 把「live 路径真接入 conductor 装配」和「实际 HTTP 调用」两件事分开:
 *
 *   - opts.llmCaller 给 → 走 fake transport, 测试零发请求;
 *   - opts.llmCaller 不给 → 真 send() (烧 token, 仅人工冒烟用)。
 *
 * 同时也允许 opts.bootstrap 注入, 把 provider 注册这步也关上 (测试环境下不会触发
 * "[omd env] no providers" 这条 stderr 心跳 —— 测试不该污染 stderr)。
 */
export interface LiveProviderDeps {
  /** 替代 send() 的 transport 函数。默认 = gateway.send。 */
  llmCaller?: (req: GatewayRequest) => Promise<ModelResponse>;
  /** 替代 bootstrapModelRuntime 的引导函数。默认 = bootstrapModelRuntime。 */
  bootstrap?: () => string[];
}

/**
 * 默认 live provider —— 真联机 (boot model runtime + send through gateway)。
 *
 * 不冒烟: 本契约内无任何调用点会走这条, 测试全装 fake。首夜点火前人工冒烟 1 题
 * (上游 §未决), 配额/网络影响不进机械 verify。
 *
 * 装配点对齐 scripts/probes/repeat-plan-validity.ts:80-98 (generatePlan) 的同形:
 *   - 系统提示: conductorSystemPrompt({ profile: 'full' }) (与真 conductor 平面一致);
 *   - user 段: PLAN_BOUNDARY + prompt + 「禁 map/conductor」收口 (防 nested executor);
 *   - 推理深度: thinkingLevel: 'high' (与 conductor 档位一致);
 *   - maxTokens: 32_768 (与 role-models.ts:65 MAX_TOKENS_DEFAULT 一致);
 *   - 推理档 + meta.role='conductor' + sessionId/runLabel: 让回放调用进 seat-usage 同一通道,
 *     trace 与正常 conductor 发一致 (langfuse / 账本都能看到)。
 *
 * 第 4 个形参 `deps` 是 mock 注入点 (transport + bootstrap), 不进生产路径 (默认空对象)。
 * 测试时传 `{ llmCaller: fakeTransport, bootstrap: noopBootstrap }` → 完整跑装配链,
 * 但零实际 HTTP / 零 provider 注册副作用。
 */
export async function defaultLiveProvider(
  id: string,
  prompt: string,
  ctx: LiveProviderContext,
  deps: LiveProviderDeps = {},
): Promise<string> {
  // 每次进程起一次就够 —— send() 内部状态自洽; 重复调安全 (实测 repeat-plan-validity 复用同一进程)。
  const bootstrap = deps.bootstrap ?? bootstrapModelRuntime;
  const llmCaller = deps.llmCaller ?? send;
  bootstrap();
  const conductorCoord = ctx.seats['conductor'];
  if (!conductorCoord) {
    throw new Error(
      `[autoresearch-replay] manifest.seats.conductor 缺席 (id=${id}); 冻结时刻没记 conductor 座`,
    );
  }
  const seat = tryResolveSeatModel('conductor', { explicit: conductorCoord });
  const model = seat?.model ?? conductorCoord;
  const sys = conductorSystemPrompt({ profile: 'full' });
  const res = await llmCaller({
    model,
    messages: [
      { role: 'system', content: sys },
      {
        role: 'user',
        content:
          `${PLAN_BOUNDARY}${prompt}\n\n` +
          '注意: 本次分解出的节点**不得**再用 executor:"conductor" 或 executor:"map" —— ' +
          '你现在就是运行时展开, 已经知道清单了, 直接把步骤列出来即可。',
      },
    ],
    thinkingLevel: 'high',
    maxTokens: 32_768,
    meta: {
      role: 'conductor',
      sessionId: `autoresearch-replay:${id}`,
      runLabel: `replay/${ctx.variant}`,
    },
  });
  return res.text ?? '';
}

// ─── 单跑 ─────────────────────────────────────────────────────────────

/** 单条 (id, prompt) → ReplayItemResult。parsePlan 拒 → planValidity=false, 其他维走 0/null。 */
export interface ReplayItemResult {
  id: string;
  planValidity: boolean;
  fakeSerialPairs: number;
  speedupTheoretical: number | null;
  shapeDeclared: boolean;
  planningTokens: number;
}

/**
 * 同步/异步 rawText 提供器。stub 路径下返回 Promise.resolve (字面 sync),
 * live 路径下返回 defaultLiveProvider 的真 Promise。
 */
export type RawTextProvider = (id: string, prompt: string) => Promise<string>;

export interface EvaluateSplitInput {
  loaded: LoadedCorpus;
  split: SplitName;
  rawTextProvider: RawTextProvider;
}

export interface EvaluateSplitOutput {
  perItem: ReplayItemResult[];
  aggregate: AggregatedFitness;
}

export async function evaluateSplit(input: EvaluateSplitInput): Promise<EvaluateSplitOutput> {
  const { loaded, split, rawTextProvider } = input;
  const ids = loaded.splits[split] ?? [];
  if (ids.length === 0) {
    return { perItem: [], aggregate: aggregateFitness([]) };
  }
  const perItem: ReplayItemResult[] = [];
  const fitnesses: PlanFitness[] = [];
  for (const id of ids) {
    const prompt = loaded.prompts.get(id) ?? '';
    const raw = await rawTextProvider(id, prompt);
    const parsed = parsePlan(raw, {
      knownTemplates: new Set<string>(),
      knownServers: new Set<string>(),
    });
    if (!parsed.ok) {
      const tokens = Math.ceil(raw.length / 4);
      const failFit: PlanFitness = {
        planValidity: false,
        fakeSerialPairs: 0,
        speedupTheoretical: null,
        shapeDeclared: false,
        planningTokens: tokens,
      };
      perItem.push({
        id,
        planValidity: false,
        fakeSerialPairs: 0,
        speedupTheoretical: null,
        shapeDeclared: false,
        planningTokens: tokens,
      });
      fitnesses.push(failFit);
      continue;
    }
    const fit = computeFitness({ plan: parsed.plan, rawText: raw });
    perItem.push({
      id,
      planValidity: fit.planValidity,
      fakeSerialPairs: fit.fakeSerialPairs,
      speedupTheoretical: fit.speedupTheoretical,
      shapeDeclared: fit.shapeDeclared,
      planningTokens: fit.planningTokens,
    });
    fitnesses.push(fit);
  }
  return { perItem, aggregate: aggregateFitness(fitnesses) };
}

// ─── 顶层 ─────────────────────────────────────────────────────────────

/** `--baseline` 输出。C-4: 必须含语料 hash + 座位坐标。 */
export interface ReplayBaseline {
  ok: true;
  manifestHash: string;
  seats: Record<string, string>;
  variant: string;
  split: SplitName;
  n: number;
  aggregate: AggregatedFitness;
  perItem: ReplayItemResult[];
}

/** runBaseline / runStability / dispatch 的注入点。两层 mock 都在这:
 *  - `liveProvider`: 高层, 直接给 rawText, 不走 defaultLiveProvider (测试 plumbing);
 *  - `llmCaller`: 低层, 替换 send(), 让 defaultLiveProvider **完整跑**但 transport 是 fake
 *    (测试「live 装配链真接入 conductor」, 仍然零发请求)。 */
export interface DispatchOpts {
  /**
   * `--live` 时使用的 LLM 提供器。省略 → defaultLiveProvider (默认走真 send)。
   * 给则短路 defaultLiveProvider, 直接返 rawText (高阶 mock, 适合测 plumbing)。
   */
  liveProvider?: LiveProvider;
  /**
   * 替代 send() 的 transport 函数; 仅当未给 liveProvider 时生效。
   * 用于「defaultLiveProvider 真跑完整装配链, 但 transport 是 fake」这一档测试。
   */
  llmCaller?: (req: GatewayRequest) => Promise<ModelResponse>;
}

function resolveProvider(
  args: ReplayArgs,
  loaded: LoadedCorpus,
  opts: DispatchOpts | undefined,
): RawTextProvider {
  if (!args.live) {
    // stub 路径 —— deterministic, 同步返 Promise.resolve (与 live 同 shape, 评估侧无分支)。
    return (_id, _prompt) => Promise.resolve(stubVariantToRawText(args.variant));
  }
  // live 路径: 高阶 liveProvider 优先; 否则走 defaultLiveProvider, 透传 llmCaller。
  const ctx = { seats: loaded.manifest.seats, variant: args.variant };
  if (opts?.liveProvider) {
    const lp = opts.liveProvider;
    return (id, prompt) => lp(id, prompt, { ...ctx, id });
  }
  const llmCaller = opts?.llmCaller;
  return (id, prompt) => defaultLiveProvider(id, prompt, { ...ctx, id }, llmCaller ? { llmCaller } : {});
}

export async function runBaseline(
  args: ReplayArgs,
  loaded: LoadedCorpus,
  opts?: DispatchOpts,
): Promise<ReplayBaseline> {
  const { perItem, aggregate } = await evaluateSplit({
    loaded,
    split: args.split,
    rawTextProvider: resolveProvider(args, loaded, opts),
  });
  return {
    ok: true,
    manifestHash: loaded.manifest.totalHash,
    seats: { ...loaded.manifest.seats },
    variant: args.variant,
    split: args.split,
    n: perItem.length,
    aggregate,
    perItem,
  };
}

/** `--stability N` 各维方差。注: planValidityRate / shapeDeclarationRate 是聚合率; 单维 (如
 *  fakeSerialPairsTotal / planningTokensTotal) 才是有意义的方差; speedupTheoreticalMedian
 *  全 null → null。 */
export interface PerDimVariance {
  planValidityRate: number;
  fakeSerialPairsTotal: number;
  speedupTheoreticalMedian: number | null;
  shapeDeclarationRate: number;
  planningTokensTotal: number;
}

export function computeStability(aggregates: readonly AggregatedFitness[]): PerDimVariance {
  const n = aggregates.length;
  if (n < 2) {
    // 与 parseReplayArgs 的 --stability N>=2 闸对齐; 这里兜底返 0/null。
    return {
      planValidityRate: 0,
      fakeSerialPairsTotal: 0,
      speedupTheoreticalMedian: null,
      shapeDeclarationRate: 0,
      planningTokensTotal: 0,
    };
  }
  const varianceOf = (xs: readonly number[]): number => {
    const m = xs.reduce((s, x) => s + x, 0) / xs.length;
    return xs.reduce((s, x) => s + (x - m) ** 2, 0) / xs.length;
  };
  const speedups: number[] = [];
  for (const a of aggregates) {
    if (a.speedupTheoreticalMedian !== null) speedups.push(a.speedupTheoreticalMedian);
  }
  return {
    planValidityRate: varianceOf(aggregates.map((a) => a.planValidityRate)),
    fakeSerialPairsTotal: varianceOf(aggregates.map((a) => a.fakeSerialPairsTotal)),
    speedupTheoreticalMedian: speedups.length === 0 ? null : varianceOf(speedups),
    shapeDeclarationRate: varianceOf(aggregates.map((a) => a.shapeDeclarationRate)),
    planningTokensTotal: varianceOf(aggregates.map((a) => a.planningTokensTotal)),
  };
}

export interface ReplayStability {
  ok: true;
  manifestHash: string;
  seats: Record<string, string>;
  variant: string;
  split: SplitName;
  runs: number;
  perDimVariance: PerDimVariance;
  aggregates: AggregatedFitness[];
}

export async function runStability(
  args: ReplayArgs,
  loaded: LoadedCorpus,
  opts?: DispatchOpts,
): Promise<ReplayStability> {
  if (args.stability === null) throw new Error('runStability called without --stability');
  const provider = resolveProvider(args, loaded, opts);
  const aggregates: AggregatedFitness[] = [];
  for (let i = 0; i < args.stability; i++) {
    const { aggregate } = await evaluateSplit({
      loaded,
      split: args.split,
      rawTextProvider: provider,
    });
    aggregates.push(aggregate);
  }
  return {
    ok: true,
    manifestHash: loaded.manifest.totalHash,
    seats: { ...loaded.manifest.seats },
    variant: args.variant,
    split: args.split,
    runs: args.stability,
    perDimVariance: computeStability(aggregates),
    aggregates,
  };
}

// ─── 装载 + 调度 ─────────────────────────────────────────────────────────────

/** 从 disk 读 manifest 并装载, 应用 C-2 heldout 闸。 */
export function loadCorpusFromPath(
  manifestPath: string,
  allowHeldout: boolean,
): LoadedCorpus {
  const text = readFileSync(manifestPath, 'utf8');
  return loadCorpus(text, { allowHeldout, verifyHash: true });
}

const USAGE =
  'usage: bun scripts/autoresearch-replay.ts <manifest-path> ' +
  '[--variant V] [--split screen|main|heldout] [--allow-heldout] ' +
  '[--baseline|--stability N] [--live]';

export async function dispatch(args: ReplayArgs, opts?: DispatchOpts): Promise<unknown> {
  if (args.manifestPath === '') {
    // --help 触发
    return { ok: true, usage: USAGE };
  }
  const loaded = loadCorpusFromPath(args.manifestPath, args.allowHeldout);
  // split 是否真在 splits 里 (闸)
  const ids = loaded.splits[args.split];
  if (ids === undefined) {
    throw new Error(
      `split "${args.split}" not available in loaded corpus ` +
        `(loaded splits: ${SPLIT_ORDER.filter((s) => loaded.splits[s] !== undefined).join(', ')}; ` +
        `heldout locked? → ${args.allowHeldout ? 'no' : 'yes'})`,
    );
  }
  if (args.stability !== null) {
    return runStability(args, loaded, opts);
  }
  return runBaseline(args, loaded, opts);
}

// ─── CLI 入口 ─────────────────────────────────────────────────────────────

if (import.meta.main) {
  let args: ReplayArgs;
  try {
    args = parseReplayArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(JSON.stringify({ ok: false, error: (e as Error).message }) + '\n');
    process.stderr.write(USAGE + '\n');
    process.exit(1);
  }
  try {
    const out = await dispatch(args);
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    process.exit(0);
  } catch (e) {
    process.stderr.write(JSON.stringify({ ok: false, error: (e as Error).message }) + '\n');
    process.exit(1);
  }
}
