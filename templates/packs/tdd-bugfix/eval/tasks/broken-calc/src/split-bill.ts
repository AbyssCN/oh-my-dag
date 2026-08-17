/** 按人头分账 (单位: 分)。种了 bug: 整除丢余数 —— 3 人分 100 分只分出 99 分。 */
export function splitBill(totalCents: number, people: number): number[] {
  if (people <= 0) throw new Error('people must be positive');
  const share = Math.floor(totalCents / people);
  return Array.from({ length: people }, () => share);
}
