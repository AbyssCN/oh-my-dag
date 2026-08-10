/**
 * src/model/provider-health —— (channel, model) 粒度熔断 (circuit breaker, D-18/INV-5)。
 *
 * 原设计按 provider 裸名冷却 → 同 provider 不同 model 共享冷却窗 (深seek v4-flash 故障把 v4-pro 也拉黑)。
 * D-18 改为 (channel, model) 粒度: 同一 model 在不同 channel 独立冷却 —— allegretto:kimi-k3 故障不影响
 * lite:kimi-k3。role-fallback 只知 channel 不知 model → channelInCooldown(channel) 查该 channel 是否有
 * **任意** model 在冷却 (宽门); inCooldown(coord) 按 channel:model 精确查 (窄门, callModel 重试用)。
 *
 * 纯内存 (进程级), 不落盘。「重启即清是对的」对**瞬时档**仍真; 2026-08-09 座位事故
 * (kimi 403 计费周期耗尽横扫四图, NOTES 样本 A) 证明它只对一半 —— 周期级下线是第二种态,
 * 30s 退避对它是错的。分档 (S-B1, 2026-08-10): 402/403 走 PERIOD_COOLDOWN_MS 长窗
 * (进程内 6h; 真周期边界从 403 里读不出来, 长窗 = 有界重试语义, 窗过重试一次失败再入窗,
 * 每进程每 6h 至多浪费一次瞬败调用)。跨进程持久化 = S-B2 (载体候选见普查 §1.7), 本片不做。
 * 独立模块避免 index ↔ role-fallback import 环。
 */

/** 默认冷却窗 (ms): 一次 provider-fault 后该 (channel, model) 静默 30s。 */
const DEFAULT_COOLDOWN_MS = 30_000;

/** 周期级冷却窗 (ms): 402/403 = 配额/计费级下线, 30s 退避无意义 (样本 A)。 */
export const PERIOD_COOLDOWN_MS = 6 * 3_600_000;

/**
 * 按 HTTP 状态给冷却窗时长: 402/403 → 周期档, 其余 (429/5xx/transport=undefined) → 瞬时档。
 * 判据 = 状态语义本身: 402/403 是配额/计费/权限拒, 不随时间自愈到下一次重试的粒度;
 * 429 是限流, 短退避是对的 (真周期窗限流会反复触发, 每次只多付一次瞬败调用)。
 */
export function cooldownMsFor(httpStatus: number | undefined): number {
  return httpStatus === 402 || httpStatus === 403 ? PERIOD_COOLDOWN_MS : DEFAULT_COOLDOWN_MS;
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
  cooldownUntil.set(keyOf(coord), Date.now() + Math.max(0, cooldownMs));
}

/**
 * 坐标是否在冷却窗内 (精确 channel:model)。窗已过 → 清条目返 false (自愈)。
 * `now` 可注入供测试。
 */
export function inCooldown(coord: string, now = Date.now()): boolean {
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
  const prefix = `${channel}:`;
  for (const [k, until] of cooldownUntil) {
    if (k.startsWith(prefix)) {
      if (until > now) return true;
      cooldownUntil.delete(k); // 窗过自愈
    }
  }
  return false;
}

/** 清全部冷却态 —— 测试钩子 (跨用例不串味)。 */
export function resetProviderCooldowns(): void {
  cooldownUntil.clear();
}