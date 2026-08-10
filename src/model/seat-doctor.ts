/**
 * src/model/seat-doctor —— doctor 装配纯函数 (切片 2, docs/plan/2026-08-10-seats-doctor-report.md)。
 *
 * ## 它是什么
 * 只读观察者 (D-1): 把六源拼成行模型 —— 一行一座位 + 一行一已发现渠道 (INV-2)。
 * 零 IO、零状态: 六源全由调用方注入 (D-10, 读六源在 CLI 层接线), 本函数只拼, 不解析副本、不写盘。
 * 模型层不引 harness/tui 层 (层次纪律, 先例 provider-health.ts:20) —— 各源的注入类型在本地按
 * 「所需子集」声明, 生产侧真实类型结构兼容即可直传。
 *
 * ## O-3 实测: 周期用量真源 = .omd/tui-usage.jsonl (2026-08-10 复核, 各跑一条命令量两本账)
 *  · tui-usage.jsonl (387 条): 逐调用记录, token 级 (in/out/cacheHit), chat+engine 双源,
 *    订阅通道 costUsd 显式标记、unpriced 显式标记; 滚动窗语义 (5h 原生)。
 *    实测 5h 窗: 55 calls / 2.50M in / 0.064 USD; 7d 窗 = 全量 387 calls / 1.275 USD。
 *  · plan-ledger.db (60 plan_versions): 按 plan 版本聚合的 total_cost_usd (8.55 USD) ——
 *    无 token 列、无 run 级时间戳、无窗口语义、unpriced 计 0、只含 DAG plan run (chat 不可见)。
 * 结论: periodUsage 的 {count,tokens} 只可能来自 tui-usage.jsonl —— plan-ledger 既无 token 也无窗,
 *   USD 口径还与 tui-usage 差 ~6.7x (8.55 vs 1.28, 聚合粒度不同; 复核同值)。planLedger 源在本装配里的角色
 *   退化为「已发现渠道」的坐标并集 (DagRunNode.model 留痕面, dag-record.ts:50-58)。
 *
 * ## 三态纪律 (D-2)
 * 每格: 值 · NULL+原因列 · 不适用 (NULL + 「不适用: …」原因)。禁 0 填充 —— 窗口内无调用 ≠ 0 次
 * (tui-usage 是 omd 视角下界, 同订阅的其它客户端不可见, ledger.ts:19-22 原话); 无凭证 ≠ 'ok'。
 * 禁编 unknown 枚举: circuitState 只有 provider-health 真实存在的二元 (closed/open) ——
 * half-open 无生产语义, 不编。
 *
 * ## 熔断态口径 (G-2)
 * 座位行 = inCooldown(coord) 同口径: 只看 "channel:model" **精确键** (keyOf provider-health.ts:147,
 * inCooldown 判定 provider-health.ts:177; 与 inCooldown 判定一致由测试钉死; 渠道行 = channelInCooldown
 * 宽门 (provider-health.ts:193, 该渠道任一 model 冷却即开)。
 */
export type ConfigLayer = 'env' | 'config' | 'default' | 'derived';

/** 凭证态词表: 与 omd_config_status MCP 判定对齐; NULL = 未判定 (不是 'missing')。 */
export type CredentialState = 'ok' | 'missing' | 'expired' | 'invalid';

/** 熔断态: provider-health 是二元 (inCooldown), 无 half-open 生产语义 (D-2 不编)。 */
export type CircuitState = 'closed' | 'open';

 /** seat-health.json 单条冷却 (形状 = provider-health.ts:96 PersistedCooldown)。 */
export interface SeatHealthEntry {
  /** "channel:model" 或 "channel:" (provider-health keyOf 同形状)。 */
  key: string;
  /** 到期 epoch ms —— 存到期时刻不存布尔。 */
  until: number;
  since: number;
  httpStatus?: number;
}

 /** seat-health.json 文件形状 (OMD_SEAT_HEALTH_PATH 接缝, provider-health.ts:105)。 */
export interface SeatHealthFile {
  cooldowns?: SeatHealthEntry[];
}

/** tui-usage.jsonl 行的所需子集 (形状 = src/tui/usage/ledger.ts UsageRecord)。 */
export interface TuiUsageLog {
  ts: number;
  /** "provider:model" 坐标。 */
  model: string;
  in: number;
  out: number;
}

/** plan-ledger 账本注入行的所需子集 (O-3 主体: 不作周期用量源, 只供渠道发现)。 */
export interface DoctorDagRun {
  id: string;
  /** 节点实打坐标 (DagRunNode.model 同形状, dag-record.ts:50-58); 缺 = 该 run 没留痕。 */
  coords?: readonly string[];
}

/** config 全局状态中与 doctor 相关的截取 (坐标 + 凭证态)。 */
export interface DoctorConfigState {
  /** 每座位生效坐标 (CLI 层按执行期同解析序解析后注入; 装配不重解析)。 */
  models: Record<string, string>;
  /** 渠道 → 凭证态。缺席渠道 = NULL+原因 (切片 3 接 omd_config_status MCP, O-6)。 */
  credentials?: Record<string, CredentialState>;
}

/** 一行一座位或一渠道 (seatIndex=null 即渠道行)。任一可空格必有同名前缀的原因列 (G-1)。 */
export interface DoctorRow {
  /** 座位行 = 生效 "channel:model"; 渠道行 = 渠道名。无 → NULL + coordCause。 */
  coord: string | null;
  coordCause: string | null;
  /** 渠道标识 (coord 的 channel 段; 渠道行 = 渠道名)。 */
  channelId: string | null;
  /** 座位索引 (注入 seats 数组下标, 即 ALL_SEAT_IDS 序); null = 渠道行。 */
  seatIndex: number | null;
  /** 配置来源层 (词表与 pool-report.ts:26 一致); 渠道行无单一来源层 → NULL + 原因。 */
  configLayer: ConfigLayer | null;
  configLayerCause: string | null;
  /** 凭证态; NULL = 未判定 + credentialCause。 */
  credentialState: CredentialState | null;
  credentialCause: string | null;
  /** 熔断态; NULL = 不适用 (无坐标可查) + circuitCause。 */
  circuitState: CircuitState | null;
  circuitCause: string | null;
  /** 冷却剩余 ms (冷却中 = until-now); 不在冷却 → NULL + cooldownCause。 */
  cooldownRemaining: number | null;
  cooldownCause: string | null;
  /** 周期用量 (窗口内 count/tokens); NULL = 不可判定 + usageCause。禁 0 填充。 */
  periodUsage: { count: number; tokens: number } | null;
  usageCause: string | null;
}

/** 装配输入: 六源 + 两个可注入刻度 (G-2 的 now, 周期窗长)。 */
export interface AssembleDoctorInput {
  /** 座位 id 全集 (ALL_SEAT_IDS 派生视图注入, seats.ts:315)。 */
  seats: readonly string[];
  /** 座位 → 配置来源层 (pool-report 口径; CLI 层解析后注入)。 */
  configLayerBySeat: Map<string, ConfigLayer>;
  /** 熔断态 (seat-health.json 形状; OMD_SEAT_HEALTH_PATH 接缝的盘上内容)。 */
  seatHealth: SeatHealthFile;
  /** 用量 (tui-usage.jsonl 行; OMD_TUI_USAGE_DIR 接缝) —— 周期用量真源 (O-3)。 */
  usageEntries: readonly TuiUsageLog[];
  /** plan-ledger 账本 (O-3 主体: 只供已发现渠道的坐标并集)。 */
  planLedger: readonly DoctorDagRun[];
  /** config 全局状态截取 (生效坐标 + 凭证态)。 */
  configState: DoctorConfigState;
  /** 可注入时钟 (默认 Date.now; G-2 判定一致的前提)。 */
  now?: number;
  /** 周期窗长 ms (默认 tui-usage 账本原生 5h 滚动窗, ledger.ts FIVE_HOURS_MS)。 */
  windowMs?: number;
}

/** 周期用量默认窗: 5h —— tui-usage 账本原生滚动窗 (账本窗口语义的唯一真源)。 */
const DEFAULT_WINDOW_MS = 5 * 60 * 60 * 1000;

/** "channel:model" / "channel:" → 渠道名 (与 provider-health.channelOf 同规则)。 */
function channelOf(coord: string): string {
  const i = coord.indexOf(':');
  return i === -1 ? coord : coord.slice(0, i);
}

/**
 * 座位行熔断态: 只查 "channel:model" 精确键 —— 与 inCooldown(coord) 同口径 (窄门, G-2)。
 * 过期条目 = 自愈 (inCooldown 读时过滤同款)。
 */
function seatCircuit(
  coord: string,
  cooldowns: readonly SeatHealthEntry[],
  now: number,
): Pick<DoctorRow, 'circuitState' | 'circuitCause' | 'cooldownRemaining' | 'cooldownCause'> {
  const hit = cooldowns.find((e) => e.key === coord);
  if (hit === undefined) {
    return { circuitState: 'closed', circuitCause: null, cooldownRemaining: null, cooldownCause: '无冷却记录 (channel:model 精确键)' };
  }
  if (hit.until > now) {
    return { circuitState: 'open', circuitCause: null, cooldownRemaining: hit.until - now, cooldownCause: null };
  }
  return { circuitState: 'closed', circuitCause: null, cooldownRemaining: null, cooldownCause: '冷却窗已过, 已自愈' };
}

/**
 * 渠道行熔断态: 宽门 —— 该渠道任一 model 冷却即 open (与 channelInCooldown 同口径)。
 * 剩余时间 = 该渠道最晚到期 - now。
 */
function channelCircuit(
  channel: string,
  cooldowns: readonly SeatHealthEntry[],
  now: number,
): Pick<DoctorRow, 'circuitState' | 'circuitCause' | 'cooldownRemaining' | 'cooldownCause'> {
  const prefix = `${channel}:`;
  const hits = cooldowns.filter((e) => e.key.startsWith(prefix));
  if (hits.length === 0) {
    return { circuitState: 'closed', circuitCause: null, cooldownRemaining: null, cooldownCause: '无冷却记录 (渠道宽门)' };
  }
  const until = hits.reduce((m, e) => Math.max(m, e.until), 0);
  if (until > now) {
    return { circuitState: 'open', circuitCause: null, cooldownRemaining: until - now, cooldownCause: null };
  }
  return { circuitState: 'closed', circuitCause: null, cooldownRemaining: null, cooldownCause: '冷却窗已过, 已自愈' };
}

/**
 * 周期用量: 窗口 [now-windowMs, now] 内按 match 归集 count/tokens (in+out; cacheHit ⊆ in,
 * types.ts:88, 不重复计)。窗口内账本无记录 / 该坐标无调用 → NULL + 原因 (禁 0 填充, D-2)。
 */
function periodUsage(
  match: (u: TuiUsageLog) => boolean,
  entries: readonly TuiUsageLog[],
  since: number,
  now: number,
): Pick<DoctorRow, 'periodUsage' | 'usageCause'> {
  const inWindow = entries.filter((e) => e.ts >= since && e.ts <= now);
  if (inWindow.length === 0) {
    return { periodUsage: null, usageCause: '窗口内账本无记录 (无法判定 0)' };
  }
  const mine = inWindow.filter(match);
  if (mine.length === 0) {
    return { periodUsage: null, usageCause: '窗口内无该坐标调用 (omd 视角下界, 0 不是证明)' };
  }
  return {
    periodUsage: { count: mine.length, tokens: mine.reduce((s, e) => s + e.in + e.out, 0) },
    usageCause: null,
  };
}

/** 已发现渠道 = 六源坐标并集的 channel 段 (INV-2; 去重 + 稳定排序)。 */
function discoverChannels(input: AssembleDoctorInput): string[] {
  const set = new Set<string>();
  for (const c of Object.values(input.configState.models)) set.add(channelOf(c));
  for (const u of input.usageEntries) set.add(channelOf(u.model));
  for (const r of input.planLedger) for (const c of r.coords ?? []) set.add(channelOf(c));
  for (const e of input.seatHealth.cooldowns ?? []) set.add(channelOf(e.key));
  return [...set].sort();
}

/** 装配: 六源拼行模型。纯函数, 零 IO。 */
export function assembleDoctorRows(input: AssembleDoctorInput): DoctorRow[] {
  const now = input.now ?? Date.now();
  const windowMs = input.windowMs ?? DEFAULT_WINDOW_MS;
  const since = now - windowMs;
  const cooldowns = input.seatHealth.cooldowns ?? [];

  const rows: DoctorRow[] = [];

  // ── 座位行 (注入序 = ALL_SEAT_IDS 序) ──────────────────────────────────────
  input.seats.forEach((seatId, seatIndex) => {
    const coord = input.configState.models[seatId] ?? null;
    const channel = coord === null ? null : channelOf(coord);
    const circuit = coord === null
      ? { circuitState: null as CircuitState | null, circuitCause: '不适用: 无生效坐标可查熔断', cooldownRemaining: null, cooldownCause: '不适用: 无生效坐标' }
      : seatCircuit(coord, cooldowns, now);
    const usage = coord === null
      ? { periodUsage: null, usageCause: '不适用: 无生效坐标, 无从归集用量' }
      : periodUsage((u) => u.model === coord, input.usageEntries, since, now);
    rows.push({
      coord,
      coordCause: coord === null ? '无生效坐标 (configState.models 缺该座位)' : null,
      channelId: channel,
      seatIndex,
      configLayer: input.configLayerBySeat.get(seatId) ?? null,
      configLayerCause: input.configLayerBySeat.has(seatId) ? null : '配置层未注入 (pool-report 无该座位)',
      credentialState: channel === null ? null : input.configState.credentials?.[channel] ?? null,
      credentialCause:
        channel === null
          ? '不适用: 无渠道, 无从判定凭证'
          : input.configState.credentials?.[channel] === undefined
            ? '凭证态源未接 (omd_config_status MCP 属切片 3 接线)'
            : null,
      ...circuit,
      ...usage,
    });
  });

  // ── 渠道行 (INV-2: 全座位 + 已发现渠道) ────────────────────────────────────
  for (const ch of discoverChannels(input)) {
    const circuit = channelCircuit(ch, cooldowns, now);
    const usage = periodUsage((u) => u.model === ch || u.model.startsWith(`${ch}:`), input.usageEntries, since, now);
    rows.push({
      coord: ch,
      coordCause: null,
      channelId: ch,
      seatIndex: null,
      configLayer: null,
      configLayerCause: '渠道行为聚合行, 无单一配置来源层 (不适用)',
      credentialState: input.configState.credentials?.[ch] ?? null,
      credentialCause:
        input.configState.credentials?.[ch] === undefined
          ? '凭证态源未接 (omd_config_status MCP 属切片 3 接线)'
          : null,
      ...circuit,
      ...usage,
    });
  }

  return rows;
}
