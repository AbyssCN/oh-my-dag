/** 结算报告 (依赖链: report → settle)。总计行**从份额求和**得出 —— settle 丢分, 报告就撒谎。 */
import { settleWeighted } from './settle';

export function settlementReport(totalCents: number, weights: number[]): string {
  const shares = settleWeighted(totalCents, weights);
  const lines = shares.map((s, i) => `参与者${i + 1} (权重 ${weights[i]}): ${(s / 100).toFixed(2)} 元`);
  const sum = shares.reduce((a, b) => a + b, 0);
  lines.push(`总计: ${(sum / 100).toFixed(2)} 元`);
  return lines.join('\n');
}
