/**
 * src/model/provider-health —— (channel, model) 粒度熔断 (circuit breaker, D-18/INV-5)。
 *
 * 原设计按 provider 裸名冷却 → 同 provider 不同 model 共享冷却窗 (深seek v4-flash 故障把 v4-pro 也拉黑)。
 * D-18 改为 (channel, model) 粒度: 同一 model 在不同 channel 独立冷却 —— allegretto:kimi-k3 故障不影响
 * lite:kimi-k3。role-fallback 只知 channel 不知 model → channelInCooldown(channel) 查该 channel 是否有
 * **任意** model 在冷却 (宽门); inCooldown(coord) 按 channel:model 精确查 (窄门, callModel 重试用)。
 *
 * 瞬时档纯内存 (进程级):「重启即清是对的」对它仍真。2026-08-09 座位事故 (kimi 403 计费
 * 周期耗尽横扫四图, NOTES 样本 A) 证明只对一半 —— 周期级下线是第二种态, 30s 退避对它是错的。
 * 分档 (S-B1): 402/403 走 PERIOD_COOLDOWN_MS 长窗 (6h; 真周期边界从 403 里读不出来,
 * 长窗 = 有界重试语义, 窗过重试一次失败再入窗, 每 6h 至多浪费一次瞬败调用)。
 *
 * 周期档跨进程持久化 (S-B2): `.omd/seat-health.json` (进程 cwd 锚, OMD_SEAT_HEALTH_PATH
 * 测试接缝) —— 每个 detached goal-worker 都是新 spawn 的进程 (goal.ts → goal-worker.ts),
 * 不持久化 = 每个新 worker 把已知死到周期边界的座位再撞一遍 (普查 §1.7)。只持久化周期档
 * (瞬时 30s 落盘只有陈旧害处); 存**到期时刻**不存布尔, 窗过即自愈, 过期行读写时过滤。
 * 写法 = 读-合-写 + 临时文件 rename (原子; 双进程同刻写最坏丢一条 → 该座多被撞一次瞬败,
 * 可接受)。读失败 fail-open 但留证据 (不吞)。载体自查: config.json 是用户意图面不收状态;
 * runs.db 在 mcp 层, model 层引它是层次倒挂; 独立小 json 与 tui-usage.jsonl 同类文件面。
 * 独立模块避免 index ↔ role-fallback import 环。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { logger } from '../logger';
import { CHANNEL_QUOTA_REGISTRY, validateQuotaRegistry, type ChannelQuotaEntry } from './channels';

/** 默认冷却窗 (ms): 一次 provider-fault 后该 (channel, model) 静默 30s。 */
const DEFAULT_COOLDOWN_MS = 30_000;

/** 周期级冷却窗 (ms): 402/403 = 配额/计费级下线, 30s 退避无意义 (样本 A)。 */
export const PERIOD_COOLDOWN_MS = 6 * 3_600_000;

/**
 * 按 HTTP 状态给冷却窗时长: 402/403 → 周期档, 其余 (429/5xx/transport=undefined) → 瞬时档。
 * 判据 = 状态语义本身: 402/403 是配额/计费/权限拒, 不随时间自愈到下一次重试的粒度;
 * 429 是限流, 短退避是对的 (真周期窗限流会反复触发, 每次只多付一次瞬败调用)。
 * 周期档先查配额窗登记表 (切片1/G-4): 命中可算边界 → 冷却到窗口边界 (剩余 ms);
 * 未登记 / 边界不可算 → 保守兜底 PERIOD_COOLDOWN_MS (6h, 与既有语义逐字节等价)。
 * `opts` 全可选: 现有调用点 (只传 httpStatus) 行为不变。
 */
export function cooldownMsFor(
  httpStatus: number | undefined,
  opts: { channel?: string; registry?: readonly ChannelQuotaEntry[]; now?: number; period?: boolean } = {},
): number {
  // `period` = 抛错方直说"这是配额档" (`ModelError.fault === 'quota'`)。此前只有 402/403 这一条
  // 状态码路径, 于是把业务码伪装成 402 才走得到周期档 —— 那正是 S-40 那格 (一格两义) 的病因。
  if (!opts.period && httpStatus !== 402 && httpStatus !== 403) return DEFAULT_COOLDOWN_MS;
  const { channel, registry = CHANNEL_QUOTA_REGISTRY, now = Date.now() } = opts;
  // INV-3 运行时闸: 配额路径用的登记表必须合法 (sourceUrl https + 原文引句非空),
  // 违规 → 抛错变红, 不静默兜底。空表合法 (fail-safe)。
  validateQuotaRegistry(registry);
  return quotaWindowRemainingMs(channel, registry, now) ?? PERIOD_COOLDOWN_MS;
}

/**
 * 查配额窗登记表 → 到窗口边界的剩余冷却 ms; 未命中 / 边界不可算 → undefined (调用方兜底)。
 * rolling: 剩余 = 整窗 (冷却从首次故障起算, 无历史可减);
 * billing-cycle: 剩余 = 到本月末 (UTC 下月 1 日 00:00);
 * calendar: 边界规则 (自由文本) 暂无计算实现 → 不可算 → undefined → 兜底 6h。
 */
function quotaWindowRemainingMs(
  channel: string | undefined,
  registry: readonly ChannelQuotaEntry[],
  now: number,
): number | undefined {
  if (channel === undefined) return undefined;
  const entry = registry.find((e) => e.channelId === channel);
  if (!entry) return undefined;
  for (const w of entry.windows) {
    if (w.windowKind === 'rolling' && w.windowMs !== undefined) return w.windowMs;
    if (w.windowKind === 'billing-cycle') return msToMonthBoundary(now);
    // calendar: 无实现 → 继续, 最后兜底
  }
  return undefined;
}

/** 到本月末 (UTC 下月 1 日 00:00) 的剩余 ms; 恒 > 0 (now 恰在边界上 → 算到下一月末)。 */
function msToMonthBoundary(now: number): number {
  const d = new Date(now);
  const nextMonthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1, 0, 0, 0, 0);
  return nextMonthStart - now;
}

/**
 * dispatch 存活闸 (样本 B/C: plan 级座位 pin 无视存活): pin 在冷却窗内 → 返 undefined
 * (调用方按「pin 缺席」落回既有解析链 —— 链的后段 role-fallback 本来就避开冷却 channel)。
 */
export function livePin(coord: string | undefined, now = Date.now()): string | undefined {
  if (coord === undefined) return undefined;
  return inCooldown(coord, now) ? undefined : coord;
}

/** "channel:model" → 冷却截止 epoch ms。 */
const cooldownUntil = new Map<string, number>();

// ── S-B2: 周期档跨进程持久化 ─────────────────────────────────────────────────
interface PersistedCooldown {
  key: string;
  /** 到期 epoch ms —— 存到期时刻不存布尔, 窗过即自愈。 */
  until: number;
  since: number;
  httpStatus?: number;
}

function seatHealthPath(): string {
  return process.env.OMD_SEAT_HEALTH_PATH || join(process.cwd(), '.omd', 'seat-health.json');
}

/** 读盘上周期档条目 (过期行过滤; 坏文件 fail-open 留证据)。 */
function readPersisted(now: number): PersistedCooldown[] {
  const path = seatHealthPath();
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { cooldowns?: PersistedCooldown[] };
    return (raw.cooldowns ?? []).filter(
      (c) => typeof c.key === 'string' && typeof c.until === 'number' && c.until > now,
    );
  } catch (err) {
    logger.warn({ err: (err as Error).message, path }, '[omd/provider-health] seat-health 读取失败 → 按空处理 (fail-open, 证据在此)');
    return [];
  }
}

/** 周期档落盘: 读-合-写 + rename 原子。失败 fail-open 留证据。 */
function persistPeriodCooldown(key: string, until: number, now: number): void {
  const path = seatHealthPath();
  try {
    const rest = readPersisted(now).filter((c) => c.key !== key);
    rest.push({ key, until, since: now });
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp.${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify({ cooldowns: rest }, null, 1)}\n`);
    renameSync(tmp, path);
  } catch (err) {
    logger.warn({ err: (err as Error).message, path }, '[omd/provider-health] seat-health 写入失败 (该周期档只在本进程内存)');
  }
}

let hydrated = false;
/** 首次触碰时从盘上继承周期档 (spawn 的新 worker 由此不再撞已知死座)。每进程一次。 */
function hydrateOnce(now: number): void {
  if (hydrated) return;
  hydrated = true;
  for (const c of readPersisted(now)) {
    const prev = cooldownUntil.get(c.key);
    if (prev === undefined || prev < c.until) cooldownUntil.set(c.key, c.until);
  }
}

/** "channel:model" 坐标 → "channel:model" key。裸 channel 名 → "channel:" (全 channel 冷却, 内部不用)。 */
function keyOf(coord: string): string {
  return coord.includes(':') ? coord : `${coord}:`;
}

/** 从 "channel:model" 坐标提取 channel 名。 */
function channelOf(coord: string): string {
  const i = coord.indexOf(':');
  return i === -1 ? coord : coord.slice(0, i);
}

/**
 * 上报一次 channel:model 故障 → 冷却该组合。幂等: 重复上报刷新截止时间。
 * @param coord "channel:model" 坐标 (如 "allegretto:kimi-k3") 或裸 channel 名 (冷却该 channel 所有 model)。
 */
export function reportProviderFailure(coord: string, cooldownMs = DEFAULT_COOLDOWN_MS): void {
  if (!coord) return;
  const now = Date.now();
  const until = now + Math.max(0, cooldownMs);
  cooldownUntil.set(keyOf(coord), until);
  // 周期档 (窗长达周期级) 才落盘 —— 瞬时 30s 落盘只有陈旧害处 (S-B2)。
  if (cooldownMs >= PERIOD_COOLDOWN_MS) persistPeriodCooldown(keyOf(coord), until, now);
}

/**
 * 坐标是否在冷却窗内 (精确 channel:model)。窗已过 → 清条目返 false (自愈)。
 * `now` 可注入供测试。
 */
export function inCooldown(coord: string, now = Date.now()): boolean {
  hydrateOnce(now);
  const k = keyOf(coord);
  const until = cooldownUntil.get(k);
  if (until === undefined) return false;
  if (until <= now) {
    cooldownUntil.delete(k);
    return false;
  }
  return true;
}

/**
 * 该 channel 是否有**任意** model 在冷却 (= channel 级宽门)。
 * role-fallback 只知 channel 不知 model, 用此判断是否顺延到下一个 channel。
 */
export function channelInCooldown(channel: string, now = Date.now()): boolean {
  hydrateOnce(now);
  const prefix = `${channel}:`;
  for (const [k, until] of cooldownUntil) {
    if (k.startsWith(prefix)) {
      if (until > now) return true;
      cooldownUntil.delete(k); // 窗过自愈
    }
  }
  return false;
}

/** 清全部冷却态 —— 测试钩子 (跨用例不串味)。含 S-B2 hydrate 标记 (不动盘上文件)。 */
export function resetProviderCooldowns(): void {
  cooldownUntil.clear();
  hydrated = false;
}