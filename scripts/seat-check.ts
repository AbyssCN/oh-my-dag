#!/usr/bin/env bun
/**
 * 座位对账 —— `seats.ts` 的规格 vs `.omd/config.json` 的实配(2026-08-23,issue #142/#143)。
 *
 * 为什么是脚本而不是只有测试:
 * ① `reachability.test.ts` 的可达性闸要求 `src/` 下每个非测试 `.ts` 都从生产入口
 *    (`cli.ts` + `scripts/*.ts`)可达,报错原文写死了「**"它有测试啊" 不是理由**」;
 * ② 更实在的理由 —— **闸要能在真配置上跑**。测试只能跑注入的假配置(不然换台机器就红),
 *    而漂发生在**真** `config.json` 上。这个脚本就是那条真路。
 *
 * 用法:
 *   `bun run scripts/seat-check.ts`          打印全部座位 + 漂移;有 error 则 exit 1
 *   `bun run scripts/seat-check.ts --quiet`  只在有漂移时说话
 */
import { tryResolveSeatModel } from '../src/model/role-models';
import { SEATS } from '../src/model/seats';
import { formatSeatDrift, reconcileSeats } from '../src/model/seat-conformance';

const quiet = process.argv.includes('--quiet');

// ⚠ **必须走 `tryResolveSeatModel`, 不能读某一层的原始 map** (2026-08-23 第一版就错在这):
//   座位坐标在 config 的 `models` 段, 而 `fileSeats()` 读的是 `seats` **覆盖层**(当前是空的)
//   ⇒ 闸看见 0 个座位, 于是「对账通过」—— **一条永远绿的闸不是闸**。
//   生产解析走的是 env → 内存 override → seats 覆盖 → models → 缺省的整条链, 闸得查同一条。
const configured: Record<string, string | undefined> = {};
for (const s of SEATS) {
  configured[s.id] = tryResolveSeatModel(s.id)?.model;
}

const drifts = reconcileSeats(configured);
const errors = drifts.filter((d) => d.severity === 'error');

if (!quiet) {
  console.log('| 座位 | 实配 | crossFamily | 规格首选 |');
  console.log('|---|---|---|---|');
  for (const s of SEATS) {
    const actual = configured[s.id] ?? '(未配)';
    console.log(`| \`${s.id}\` | ${actual} | ${s.crossFamily} | ${s.preferredCoord ?? '—'} |`);
  }
  console.log(`\n共 ${SEATS.length} 个座位, 实配 ${Object.keys(configured).length} 个。`);
}

if (drifts.length > 0) {
  console.error(`\n座位漂移 ${drifts.length} 条 (error ${errors.length} · warn ${drifts.length - errors.length}):`);
  for (const d of drifts) console.error(`  ${formatSeatDrift(d)}`);
}

if (errors.length > 0) {
  console.error('\n⛔ 有 error 级漂移 —— 跨家族对抗在这些座位上结构性失效。');
  process.exit(1);
}
if (!quiet) console.log(drifts.length === 0 ? '对账通过: 规格与实配一致。' : '\n(只有 warn, 不拦)');
process.exit(0);
