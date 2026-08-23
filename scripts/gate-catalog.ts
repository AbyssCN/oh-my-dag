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
 *   具体: 表里登记稳定 id;每条 id 的判词原文由 `scanGateVerdicts` 从
 *   `src/harness/dag/engine.ts` 源码里**扫**出来,而不是手抄进表里 —— 同一 id 的
 *   多个出口 / 文案微调,改一处不再要求同步抬表。
 *
 * 用法:
 *   `bun run scripts/gate-catalog.ts`         打印表 + 对账,漂移则 exit 1
 *   `bun run scripts/gate-catalog.ts --quiet` 只对账,绿则不打印
 *
 * ⚠ 它**不**写文件。目录存盘由 owner 决定要不要做,现在没有消费者就不造。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  GATE_REGISTRY,
  scanGateVerdicts,
  reconcileGateIds,
} from '../src/harness/gates/gate-registry';

const ROOT = join(import.meta.dir, '..');
const quiet = process.argv.includes('--quiet');

// 派生视图 (D-4): 判词原文从 engine.ts 源码里扫,不再从表里手抄。
const ENGINE_FILE = 'src/harness/dag/engine.ts';
const source = readFileSync(join(ROOT, ENGINE_FILE), 'utf8');
const verdicts = scanGateVerdicts(source);

if (!quiet) {
  console.log(`| id | verdict (扫自 \`${ENGINE_FILE}\`) |`);
  console.log('|---|---|');
  for (const g of GATE_REGISTRY) {
    const verdict = verdicts.get(g.id);
    console.log(`| \`${g.id}\` | ${verdict ?? '`(源码未扫到)`'} |`);
  }
  console.log(`\n共 ${GATE_REGISTRY.length} 道判生死的图级闸。`);
}

const drift = reconcileGateIds(source);
const driftTotal = drift.missing.length + drift.unregistered.length + drift.empty.length;

if (driftTotal > 0) {
  console.error(`\n闸门目录漂移 (${driftTotal} 条):`);
  if (drift.missing.length > 0) {
    console.error(`  missing (登记的 id 在 ${ENGINE_FILE} 源码里扫不到):`);
    for (const id of drift.missing) console.error(`    - \`${id}\``);
  }
  if (drift.unregistered.length > 0) {
    console.error(`  unregistered (源码里有但表没登记):`);
    for (const id of drift.unregistered) console.error(`    - \`${id}\``);
  }
  if (drift.empty.length > 0) {
    console.error(`  empty (扫到了但判词原文为空):`);
    for (const id of drift.empty) console.error(`    - \`${id}\``);
  }
  process.exit(1);
}

if (!quiet) console.log('对账通过: 表与实装一致。');
process.exit(0);
