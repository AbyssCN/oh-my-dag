/**
 * src/model/provider-health —— provider 运行时熔断 (circuit breaker, 补 role-fallback 的健康维度)。
 *
 * role-fallback 原判据只有「凭证维度」(启动时有没有 key)。缺「运行时健康」: 一个配了 key 但正在
 * 限流/宕机的 provider 仍被 usable 放行, 照样往它打。本模块补一层短时冷却:
 *   callModel 命中 provider-fault (fetch 失败 / HTTP 429 / 5xx) → reportProviderFailure 冷却 N 秒;
 *   冷却窗内 inCooldown=true → role-fallback 的 usable 判 false → 该角色顺延到 fallback;
 *   窗过自动放回 (无需显式 recovery 探测 —— 下次解析即重试。LKGP「粘住上次成功」对我们候选少
 *   收益低, 故不做)。
 *
 * 纯内存 (进程级), 不落盘: 熔断是瞬时健康态, 重启即清是对的。**独立模块**避免 index ↔ role-fallback
 * 的 import 环 —— index (callModel) 与 role-fallback (usable) 都只依赖本模块, 本模块不反向依赖二者。
 */

/** 默认冷却窗 (ms): 一次 provider-fault 后该 provider 静默 30s, 期间角色顺延兜底。 */
const DEFAULT_COOLDOWN_MS = 30_000;

/** provider 名 → 冷却截止 epoch ms。 */
const cooldownUntil = new Map<string, number>();

/** 坐标/裸名 → 裸 provider 名 ('deepseek:xx' → 'deepseek'; 裸名原样) —— report 与 query 归一, 防错位漏命中。 */
function providerOf(coordOrName: string): string {
  const i = coordOrName.indexOf(':');
  return i === -1 ? coordOrName : coordOrName.slice(0, i);
}

/**
 * 上报一次 provider 故障 → 冷却该 provider。接受坐标或裸名 (内部归一到 provider)。
 * 幂等: 重复上报只刷新截止时间。空串忽略。
 */
export function reportProviderFailure(coordOrName: string, cooldownMs = DEFAULT_COOLDOWN_MS): void {
  const p = providerOf(coordOrName);
  if (!p) return;
  cooldownUntil.set(p, Date.now() + Math.max(0, cooldownMs));
}

/**
 * provider 是否在冷却窗内 (= 运行时不健康, 应顺延兜底)。窗已过 → 顺手清条目 + 返 false (自愈)。
 * `now` 可注入供测试。
 */
export function inCooldown(coordOrName: string, now = Date.now()): boolean {
  const p = providerOf(coordOrName);
  const until = cooldownUntil.get(p);
  if (until === undefined) return false;
  if (until <= now) {
    cooldownUntil.delete(p);
    return false;
  }
  return true;
}

/** 清全部冷却态 —— 测试钩子 (跨用例不串味)。 */
export function resetProviderCooldowns(): void {
  cooldownUntil.clear();
}
