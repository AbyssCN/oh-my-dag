/**
 * src/model/provider-health —— (channel, model) 粒度熔断 (circuit breaker, D-18/INV-5)。
 *
 * 原设计按 provider 裸名冷却 → 同 provider 不同 model 共享冷却窗 (深seek v4-flash 故障把 v4-pro 也拉黑)。
 * D-18 改为 (channel, model) 粒度: 同一 model 在不同 channel 独立冷却 —— allegretto:kimi-k3 故障不影响
 * lite:kimi-k3。role-fallback 只知 channel 不知 model → channelInCooldown(channel) 查该 channel 是否有
 * **任意** model 在冷却 (宽门); inCooldown(coord) 按 channel:model 精确查 (窄门, callModel 重试用)。
 *
 * 纯内存 (进程级), 不落盘: 熔断是瞬时健康态, 重启即清是对的。独立模块避免 index ↔ role-fallback import 环。
 */

/** 默认冷却窗 (ms): 一次 provider-fault 后该 (channel, model) 静默 30s。 */
const DEFAULT_COOLDOWN_MS = 30_000;

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