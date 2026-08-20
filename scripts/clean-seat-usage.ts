/**
 * scripts/clean-seat-usage —— 把座位账本里的**测试夹具合成记录**分出去(2026-08-21, owner 点名)。
 *
 * ## 为什么要跑一次
 *
 * `test/setup/tmpdir-isolation.ts` 从今天起把测试期的账本改道到一次性目录, **新的污染止住了**。
 * 但历史沉积还在:实测 `.omd/seat-usage.jsonl` 里 **21,028 / 23,392 条是合成的(≈90%)**。
 * 不清掉的话, 任何直接读这个账本的统计仍然是九成噪声 —— 而它**读起来一切正常**。
 *
 * ## 不删数据
 *
 * 三个文件, 一条都不丢:
 *   - `seat-usage.jsonl`                → 只留真调用(重写);
 *   - `seat-usage.synthetic.jsonl`      → 合成记录搬这里(留着, 想复核随时看);
 *   - `seat-usage.jsonl.bak-<stamp>`    → 动手前的整份原样备份。
 *
 * 判据来自 `src/model/seat-usage.ts` 的 `syntheticSeatUsageReason` —— **与闸同一份**,
 * 不在这里抄第二份(抄了早晚一份先漂, 而漂掉的那份就是下一次错读数)。
 *
 * 用法:
 *   bun scripts/clean-seat-usage.ts --dry-run   # 只报数, 不动文件(默认)
 *   bun scripts/clean-seat-usage.ts --apply     # 真写
 */
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { omdRepoRoot } from '../src/harness/repo-root';
import { SEAT_USAGE_FILE, syntheticSeatUsageReason } from '../src/model/seat-usage';

const APPLY = process.argv.includes('--apply');
const root = omdRepoRoot();
const ledger = process.env.OMD_SEAT_USAGE_PATH || join(root, '.omd', SEAT_USAGE_FILE);
const syntheticOut = `${ledger.replace(/\.jsonl$/, '')}.synthetic.jsonl`;

if (!existsSync(ledger)) {
  console.error(`[clean-seat-usage] 账本不存在: ${ledger}`);
  process.exit(1);
}

const lines = readFileSync(ledger, 'utf8').split('\n');
const real: string[] = [];
const synthetic: string[] = [];
const reasons = new Map<string, number>();
let unparsable = 0;

for (const line of lines) {
  if (!line.trim()) continue;
  let entry: { model?: unknown; in?: unknown };
  try {
    entry = JSON.parse(line) as typeof entry;
  } catch {
    // 解不出来的行**留在真账本里**, 不当合成扔掉 —— 「读不出来」与「是夹具写的」是两件事,
    // 而前者本身就是要留的证据(仓规: fail-open 可以吞异常, 不许吞证据)。
    unparsable++;
    real.push(line);
    continue;
  }
  const reason = syntheticSeatUsageReason({
    model: entry.model as string,
    in: typeof entry.in === 'number' ? entry.in : null,
  });
  if (reason) {
    synthetic.push(line);
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
  } else {
    real.push(line);
  }
}

const total = real.length + synthetic.length;
console.log(`[clean-seat-usage] ${ledger}`);
console.log(`  总行数     ${total.toLocaleString()}`);
console.log(`  真调用     ${real.length.toLocaleString()}  (${((real.length / total) * 100).toFixed(1)}%)`);
console.log(`  合成       ${synthetic.length.toLocaleString()}  (${((synthetic.length / total) * 100).toFixed(1)}%)`);
for (const [r, n] of [...reasons].sort((a, b) => b[1] - a[1])) console.log(`    ${r.padEnd(12)} ${n.toLocaleString()}`);
if (unparsable > 0) console.log(`  ⚠ 解不出的行 ${unparsable} 条 —— 保留在真账本里(读不出来 ≠ 是夹具写的)`);

if (!APPLY) {
  console.log('\n  (dry-run — 没动任何文件。要真写: --apply)');
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const backup = `${ledger}.bak-${stamp}`;
copyFileSync(ledger, backup);

// 原子写: tmp + rename, 读的人永远看不到半截账本。
const tmp = `${ledger}.tmp`;
writeFileSync(tmp, real.length > 0 ? `${real.join('\n')}\n` : '', 'utf8');
renameSync(tmp, ledger);
writeFileSync(syntheticOut, synthetic.length > 0 ? `${synthetic.join('\n')}\n` : '', 'utf8');

console.log(`\n  ✓ 备份     ${backup}`);
console.log(`  ✓ 合成搬到 ${syntheticOut}`);
console.log(`  ✓ 账本重写 ${ledger} (${real.length.toLocaleString()} 行)`);
console.log('  一条都没删 —— 三个文件加起来 = 原来的全部。');
