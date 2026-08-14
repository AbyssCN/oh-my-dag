/**
 * src/model/seat-usage —— **per-seat 调用台账**(2026-08-14 排的薄片)。
 *
 * ## 为什么不是往 tui-usage.jsonl 上加两列
 *
 * `tui-usage.jsonl` 记在 `callModel` 出口(`emitModelUsage`),那一层**看不见角色**——
 * 它只知道坐标与 token。角色标签(`GenerateFn.traceName` → `GatewayMeta.role`)只活到
 * `gateway.send`,再往下就被剥掉了。于是「这一发是谁烧的」在既有账本里**结构上答不出来**,
 * 不是没记而是记不了。这本账挂在 `send` 上,补的正是那一列。
 *
 * 两本账各答各的,别互相当对方的校验:
 * - `tui-usage.jsonl` = 钱(计价/通道/5h 窗口),覆盖面 = 全部 `callModel`;
 * - `seat-usage.jsonl` = 归属(座位/角色/runId),覆盖面 = **只有经 `send` 的那些**。
 *
 * ## 覆盖面诚实(先写在这,免得有人拿它当全量)
 *
 * `send` **不是**模型调用的唯一物理出口:
 * - agent leaf 走 pi-agent-core 自己的循环(`agent-leaf.ts`),不经 `send` → 这本账里**没有**
 *   (与 2026-08-14 契约段读数里「agent leaf tokenUsage 未记」是同一个缺口);
 * - `dream/extract-*` 直调 `callModel`,同样不经 `send`。
 * 所以按座位求和出来的是**下界**。缺席 ≠ 0(本仓 §3 第 1 条),消费面别把它读成"这个座没花钱"。
 *
 * ## seat 这一列是**派生**的,traceName 才是原始观测
 *
 * 网关手上没有座位 id —— 座位在调用点就被解析成坐标了(`resolveSeatModel`),传到网关的只剩
 * 一个人可读的角色标签。所以 `seat` 由 {@link seatOfTrace} 从 `traceName` 反查,而
 * `traceName` **原样落盘**:映射表将来发现是错的,历史行还能重算。认不出的写 `null`,
 * 不编一个 `'unknown'` 座位(§3 第 1 条:`NULL` ≠ 0 ≠ 不适用,抹平了事后就分不开)。
 *
 * 同理,调用抛错时 `in`/`out` 落 `null` 而不是 0 —— 那是「没读到」不是「没烧」,靠 `error` 列分辨。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { logger } from '../logger';
import { omdRepoRoot } from '../harness/repo-root';

/** 账本文件名(相对 `.omd/`)。 */
export const SEAT_USAGE_FILE = 'seat-usage.jsonl';

export interface SeatUsageEntry {
  ts: number;
  /** 座位 id。`null` = 这个 traceName 反查不到座位(见 {@link seatOfTrace}),不是「没有座位」。 */
  seat: string | null;
  /** 网关看见的原始角色标签(`GatewayMeta.role`)。调用方没给则 `null`。 */
  traceName: string | null;
  /** provider:modelId —— 响应回报的坐标优先(溢出/回退后可能与请求的不是一个)。 */
  model: string;
  /** `null` = 这一发没读到 usage(抛错 / provider 不报),不是 0。 */
  in: number | null;
  out: number | null;
  /** `null` = provider 不报缓存命中,不是「零命中」。 */
  cacheHit: number | null;
  /** 归组键(engine 里 = `config.sessionId ?? continuity.runId`)。孤立调用为 `null`。 */
  runId: string | null;
  /** 只在调用抛错时有:错误原文(fail-open 不吞证据,§3 第 2 条)。 */
  error?: string;
}

/**
 * traceName → 座位 id。**这张表是派生视图,真源是各调用点解析的那个座**;
 * 每一条都是读代码核出来的(不是按名字猜的),核的位置写在行尾。
 *
 * ⚠ 反查不到就返 `null`。宁可缺一列,不许把两个座位的量并进一个编出来的桶。
 */
const TRACE_SEAT_RULES: readonly [RegExp, string][] = [
  [/^conductor:/, 'conductor'], // engine.ts:278/422/1161 → conductorModel
  [/^judge:/, 'judge'], // engine.ts:1014
  [/^leaf:/, 'leaf'], // engine.ts:2965 → config.leafModel
  [/^primitive-leaf:/, 'leaf'], // engine.ts:2327 → 同 leaf 档
  [/^map-lister:/, 'leaf'], // engine.ts:2204 → config.leafModel
  [/^fanin-summary:/, 'leaf'], // engine.ts:3135 → faninCfg.model ?? config.leafModel(显式覆盖时会错归, model 列可查)
  [/^halt-judge$/, 'gate'], // continuity/halt-judge.ts:233 → resolveSeatModel('gate')
  [/^omd-leaf$/, 'leaf'], // dag/defaults.ts:31 缺 traceName 时的兜底标签
  // research fanout 的分 stage 标签 (2026-08-14 加, 见 research/fanout.ts 的 CallFn.stage)。
  // **stage 才是原始观测**, 座位只是往上归一层 —— 想问「那 8M 花在哪」要看 byTrace 不是 bySeat。
  [/^fanout:gen$/, 'lens'], // lensModel / divergePool —— 池里换的是模型, 角色仍是 lens 座
  [/^fanout:reduce$/, 'reduce'], // resolveRoleModelConfigured('reduce')
  [/^fanout:judge$/, 'judge'], // resolveRoleModelConfigured('judge')
  [/^fanout:(gap|synth|fusion|graft)$/, 'reason'], // 四个都默认 cfg.reasonModel (可被 synthPool/fusionModel/graftModel 覆盖 → 那时 model 列可查)
];

/**
 * 明知归不了座的标签 —— 列在这里是为了把「还没核」与「核过, 归不了」分开
 * (前者该去核,后者不必再核)。
 */
export const KNOWN_UNATTRIBUTABLE: ReadonlySet<string> = new Set([
  // research fanout 的 gen/reduce/synth/judge/graft **五个阶段共用这一个标签**
  // (fanout.ts:315 是所有阶段的单一漏斗)。它同时也是契约段 90.8% 量的所在地
  // (2026-08-14 读数)—— 想按阶段分账得先在 fanout 侧分标签, 那是另一片的活。
  'fanout-leaf',
  'seed-author', // web-fanout.ts:186, 种子 query 作者; 模型由调用方传, 座位不确定
  'classify:acceptance', // goal/classify-acceptance.ts:264, 模型由 run-goal 注入
  'model-call', // gateway 的兜底标签(调用方没给 role)
]);

/** traceName 反查座位;认不出返 `null`(含 `undefined` 入参)。 */
export function seatOfTrace(traceName: string | undefined | null): string | null {
  if (!traceName) return null;
  if (KNOWN_UNATTRIBUTABLE.has(traceName)) return null;
  for (const [re, seat] of TRACE_SEAT_RULES) if (re.test(traceName)) return seat;
  return null;
}

/**
 * 这个 traceName **核过没有** —— 归得了座 ∨ 明知归不了。
 * 与 {@link seatOfTrace} 分开是因为两者的 `null` 不是一回事:新加一个标签没人管它,和
 * 核过确认归不了座,在 `seatOfTrace` 的返回值上长得一模一样。覆盖率闸判的是这一个。
 */
export function traceIsClassified(traceName: string): boolean {
  return KNOWN_UNATTRIBUTABLE.has(traceName) || seatOfTrace(traceName) !== null;
}

/** 账本路径。`OMD_SEAT_USAGE_PATH` 显式覆盖(测试/隔离档用),否则 `<omdRepoRoot>/.omd/`。 */
export function seatUsagePath(): string {
  return process.env.OMD_SEAT_USAGE_PATH || join(omdRepoRoot(), '.omd', SEAT_USAGE_FILE);
}

/**
 * 记一发。**fail-open**:账本写不进去绝不能把模型调用带塌 —— 但失败要留一行证据
 * (§3 第 2 条:可以吞异常,不许吞证据)。`OMD_SEAT_USAGE=off` 显式关。
 */
export function recordSeatUsage(entry: SeatUsageEntry): void {
  if (process.env.OMD_SEAT_USAGE === 'off') return;
  const path = seatUsagePath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(entry)}\n`);
  } catch (err) {
    logger.warn({ err: (err as Error).message, path }, '[omd/seat-usage] 台账写入失败 (调用本身不受影响)');
  }
}

/** 读回全本。坏行跳过(账本是读数不是闸);读不到返空数组。 */
export function readSeatUsage(path: string = seatUsagePath()): SeatUsageEntry[] {
  if (!existsSync(path)) return [];
  const out: SeatUsageEntry[] = [];
  try {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line) continue;
      try {
        const r = JSON.parse(line) as SeatUsageEntry;
        if (typeof r.ts === 'number' && typeof r.model === 'string') out.push(r);
      } catch {
        // 坏行跳过
      }
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message, path }, '[omd/seat-usage] 台账读回失败');
  }
  return out;
}

export interface SeatUsageBucket {
  calls: number;
  in: number;
  out: number;
  cacheHit: number;
  /** 有几发**没读到** token(抛错/provider 不报)—— 上面三个和是下界,差多少看这个数。 */
  unmeasured: number;
}

export interface SeatUsageSummary {
  /** 桶键 = 座位 id;归不了座的行进 `'(unattributed)'` 桶,与真座位分开摆。 */
  bySeat: Record<string, SeatUsageBucket>;
  /** 同一批行按原始 traceName 分。座位归不了的时候,这一层仍然分得开。 */
  byTrace: Record<string, SeatUsageBucket>;
  total: SeatUsageBucket;
}

/** 归不了座的桶键。刻意不叫 `unknown` —— 它是一类**已知**的行,只是没有座位。 */
export const UNATTRIBUTED = '(unattributed)';

const emptyBucket = (): SeatUsageBucket => ({ calls: 0, in: 0, out: 0, cacheHit: 0, unmeasured: 0 });

function addTo(buckets: Record<string, SeatUsageBucket>, key: string, e: SeatUsageEntry): void {
  const b = (buckets[key] ??= emptyBucket());
  b.calls += 1;
  if (e.in === null && e.out === null) b.unmeasured += 1;
  b.in += e.in ?? 0;
  b.out += e.out ?? 0;
  b.cacheHit += e.cacheHit ?? 0;
}

/** 按座位 / 按 traceName 聚合。`runId` 给则只算那一次 run 的行。 */
export function aggregateSeatUsage(entries: SeatUsageEntry[], runId?: string): SeatUsageSummary {
  const bySeat: Record<string, SeatUsageBucket> = {};
  const byTrace: Record<string, SeatUsageBucket> = {};
  const total = emptyBucket();
  for (const e of entries) {
    if (runId !== undefined && e.runId !== runId) continue;
    addTo(bySeat, e.seat ?? UNATTRIBUTED, e);
    addTo(byTrace, e.traceName ?? UNATTRIBUTED, e);
    addTo({ t: total }, 't', e);
  }
  return { bySeat, byTrace, total };
}
