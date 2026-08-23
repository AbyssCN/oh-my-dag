#!/usr/bin/env bun
/**
 * 闸门目录 —— 把 {@link GATE_REGISTRY} 打成人读的表,并**当场对一次账**。
 *
 * 为什么是脚本而不是只有测试:
 * `src/harness/reachability.test.ts` 的可达性闸要求 `src/` 下每个非测试 `.ts` 都从
 * **生产入口**(`src/harness/cli.ts` + `scripts/*.ts`)走 import 图到得了,
 * 而它的报错原文写死了「**"它有测试啊" 不是理由**」。一张只有自己的测试 import 的登记表
 * 按本仓标准就是孤儿 —— 2026-08-23 实测:片 5a 第一版正是这么被那道闸抓红的。
 *
 * ⇒ 这个脚本是它的生产调用点,同时兑现片 5 定义里的另一半:
 * **闸门清单由代码维护,文档降级为派生视图**(owner 2026-08-22)。
 *
 * 用法:
 *   `bun run scripts/gate-catalog.ts`         打印表 + 对账,漂移则 exit 1
 *   `bun run scripts/gate-catalog.ts --quiet` 只对账,绿则不打印
 *
 * ⚠ 它**不**写文件。目录落盘由 owner 决定要不要做,现在没有消费者就不造。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GATE_REGISTRY, formatGateDrift, reconcileGates } from '../src/harness/gates/gate-registry';

const ROOT = join(import.meta.dir, '..');
const quiet = process.argv.includes('--quiet');

const drifts = reconcileGates(GATE_REGISTRY, (p) => readFileSync(join(ROOT, p), 'utf8'));

if (!quiet) {
  console.log('| id | family | file | count | verdict |');
  console.log('|---|---|---|---|---|');
  for (const g of GATE_REGISTRY) {
    console.log(`| \`${g.id}\` | ${g.family} | \`${g.file}\` | ${g.count} | ${g.verdict} |`);
  }
  console.log(`\n共 ${GATE_REGISTRY.length} 道判生死的图级闸。`);
}

if (drifts.length > 0) {
  console.error(`\n闸门目录漂移 ${drifts.length} 条:`);
  for (const d of drifts) console.error(`  ${formatGateDrift(d)}`);
  process.exit(1);
}

if (!quiet) console.log('对账通过: 表与实装一致。');
