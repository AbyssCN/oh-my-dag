/**
 * 按权重结算 (单位: 分)。
 * 规格: 各份额 = floor(total*w/W) 起步; 余数按「小数部分最大者优先, 平局按靠前索引」逐分分配
 * (最大余数法)。总和必须恒等于 total。
 *
 * 种的 bug: 只做了 floor, 余数整个丢掉 —— settle(101,[1,3]) 返回 [25,75], 丢 1 分。
 */
export function settleWeighted(totalCents: number, weights: number[]): number[] {
  if (weights.length === 0) throw new Error('weights must be non-empty');
  if (weights.some((w) => w <= 0)) throw new Error('weights must be positive');
  const W = weights.reduce((a, b) => a + b, 0);
  return weights.map((w) => Math.floor((totalCents * w) / W));
}
