/**
 * src/tui/render/pressure —— token 数字的人类可读格式(2026-08-07)。
 *
 * ⚠ 原来的 `formatPressure`(压力一行摘要)已被切片②的底栏行①②取代并删除 ——
 * ctx 段在 `render/statusbar.ts`,分项(system/harness)在 /settings 面板。

 */
/** `12.3k` / `456` —— 只在 ≥1000 时换单位,免得 `0.4k` 这种读起来比原数还费劲。 */
export function humanTokens(n: number): string {
  if (n < 1000) return String(Math.max(0, Math.round(n)));
  return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
}
