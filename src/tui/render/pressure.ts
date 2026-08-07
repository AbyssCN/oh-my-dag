/**
 * src/tui/render/pressure —— **上下文压力与用量的一行摘要**(2026-08-07)。
 *
 * ## 它回答的是一个此前问不出答案的问题
 *
 * S9 把压缩接上了,但那条判定是**沉默**的:压之前你不知道快满了,压完了也只在日志里留一行。
 * 屏幕上没有任何地方告诉你「冻结前缀多大 / 两份 harness 吃了多少 / 离压缩还有多远」——
 * 而这个仓的整套成本模型都建立在"冻结前缀是钱"上面。
 *
 * ## 窗口未知时画什么
 *
 * `ratio === null` = **模型目录里查不到窗口**,不是"占了 0%"。那时画绝对量、**不画百分比** ——
 * 编一个分母算出来的百分比比不画更坏(它看起来是个可信的数)。
 */
import type { ContextPressure } from '../../harness/chat/usage';
import type { ModelUsage } from '../../model/types';

/** `12.3k` / `456` —— 只在 ≥1000 时换单位,免得 `0.4k` 这种读起来比原数还费劲。 */
export function humanTokens(n: number): string {
  if (n < 1000) return String(Math.max(0, Math.round(n)));
  return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
}

/**
 * 一行摘要。`null` = **没有可报的东西**(还没跑过一轮)—— 调用方据此**不画这一段**,
 * 而不是画一行全零(全零会读成"跑过了、没花钱")。
 */
export function formatPressure(p: ContextPressure | null, usage?: ModelUsage | null): string | null {
  if (!p || p.usedTokens === 0) return null;
  const pct = p.ratio === null ? '窗口未知' : `${Math.round(p.ratio * 100)}%`;
  const win = p.windowTokens > 0 ? `/${humanTokens(p.windowTokens)}` : '';
  const parts = [`ctx ${humanTokens(p.usedTokens)}${win} ${pct}`];
  // 分项只在有内容时画: harness 0 份的仓里画一个 `harness 0` 是噪声。
  if (p.harnessTokens > 0) parts.push(`harness ${humanTokens(p.harnessTokens)}`);
  parts.push(`prompt ${humanTokens(p.systemTokens)}`);
  if (usage && (usage.in > 0 || usage.out > 0)) {
    const hit = usage.cacheHit ? ` cache ${humanTokens(usage.cacheHit)}` : '';
    parts.push(`本轮 in ${humanTokens(usage.in)} out ${humanTokens(usage.out)}${hit}`);
  }
  return parts.join('  ');
}
