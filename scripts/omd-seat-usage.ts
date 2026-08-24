/**
 * scripts/omd-seat-usage —— **把 per-seat 台账读成一张表**(`bun run scripts/omd-seat-usage.ts`)。
 *
 * 真源是 `.omd/seat-usage.jsonl`(网关每发一行,见 `src/model/seat-usage.ts`);
 * 这里只渲染,**不加任何座位知识** —— 加了就是第二份会漂的表。
 *
 * 用法:
 *   bun run scripts/omd-seat-usage.ts                # 全本, 按座位
 *   bun run scripts/omd-seat-usage.ts --run <runId>  # 只看某一次 run (= 验收路径)
 *   bun run scripts/omd-seat-usage.ts --trace        # 再摊开到 traceName 一层
 *   bun run scripts/omd-seat-usage.ts --path <file>  # 指定账本
 *
 * ⚠ 读出来的是**下界**:只有经 gateway.send 的调用在册。agent leaf(pi 循环)与
 * dream/extract-* 直调 callModel,不在这本账里 —— 缺席 ≠ 0。
 */
import { aggregateSeatUsage, readSeatUsage, seatUsagePath, type SeatUsageBucket } from '../src/model/seat-usage';

const argv = process.argv.slice(2);
const argOf = (flag: string): string | undefined => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};

const path = argOf('--path') ?? seatUsagePath();
const runId = argOf('--run');
const rows = readSeatUsage(path);

if (rows.length === 0) {
  console.log(`(空账本: ${path})`);
  console.log('还没有经 gateway.send 的调用写进账本 —— 跑一次 dag_run 再来读。');
  process.exit(0);
}

const summary = aggregateSeatUsage(rows, runId);
const n = (v: number): string => v.toLocaleString('en-US');

function table(title: string, buckets: Record<string, SeatUsageBucket>): void {
  const entries = Object.entries(buckets).sort((a, b) => b[1].in - a[1].in);
  console.log(`\n${title}`);
  console.log('  ' + '键'.padEnd(28) + '调用'.padStart(7) + 'in'.padStart(14) + 'out'.padStart(12) + 'cacheHit'.padStart(13) + '未读到'.padStart(9));
  for (const [key, b] of entries) {
    console.log(
      '  ' +
        key.padEnd(28) +
        String(b.calls).padStart(7) +
        n(b.in).padStart(14) +
        n(b.out).padStart(12) +
        n(b.cacheHit).padStart(13) +
        // 「未读到」= 那几发的 token 是 null 不是 0。非零时上面三列是下界。
        String(b.unmeasured).padStart(9),
    );
  }
}

console.log(`账本: ${path}  ·  ${rows.length} 行${runId ? `  ·  只算 run ${runId}` : ''}`);
table('按座位 (seat 由 traceName 反查; 归不了座的进 (unattributed))', summary.bySeat);
if (argv.includes('--trace')) table('按 traceName (原始观测面)', summary.byTrace);

const t = summary.total;
console.log(`\n合计: ${t.calls} 发 · in ${n(t.in)} · out ${n(t.out)} · cacheHit ${n(t.cacheHit)}${t.unmeasured ? ` · ${t.unmeasured} 发没读到 token (上面是下界)` : ''}`);
