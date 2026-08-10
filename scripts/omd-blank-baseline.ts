#!/usr/bin/env bun
/**
 * scripts/omd-blank-baseline —— 空白基线缓存的派单侧入口(C-6)。
 *
 * 用法(派单任务书的基线节点调它,替代裸跑全量):
 *   bun run scripts/omd-blank-baseline.ts --root <worktree> [--run-id <id>] [--force]
 *
 * 行为:
 *   命中(HEAD + 干净树 + lockfile 全等)→ 打印缓存记录(含采集时刻 + 来源 runId +
 *   fail 名字全集),exit 0,**不跑**全量 —— 消费方必须把这段原样贴进自己的报告。
 *   未命中 / --force / 脏树 → 真跑 `bunx tsc --noEmit` + `bun test`,打印并(仅干净树)写缓存。
 */
import { execSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  baselineStorePath,
  extractFailSet,
  lockHashOf,
  lookupBaseline,
  writeBaseline,
  type BaselineKey,
} from '../src/harness/blank-baseline';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const root = arg('--root') ?? process.cwd();
const runId = arg('--run-id');
const force = process.argv.includes('--force');

const head = execSync('git rev-parse HEAD', { cwd: root }).toString().trim();
const cleanTree = execSync('git status --porcelain', { cwd: root }).toString().trim() === '';
const lockHash = lockHashOf(readFileSync(join(root, 'bun.lock'), 'utf8'));
const key: BaselineKey = { head, cleanTree, lockHash };
const store = baselineStorePath(root);

if (!force) {
  const hit = lookupBaseline(store, key);
  if (hit) {
    console.log(`[blank-baseline] HIT — 采集时刻 ${hit.at} · 来源 runId ${hit.runId ?? '(未记)'} · HEAD ${hit.key.head.slice(0, 7)}`);
    console.log(`[blank-baseline] tscExit=${hit.tscExit} pass=${hit.pass} fail=${hit.fail} skip=${hit.skip}`);
    console.log(`[blank-baseline] failSet (${hit.failSet.length}):`);
    for (const f of hit.failSet) console.log(`  (fail) ${f}`);
    console.log('[blank-baseline] ⚠ 消费方须把采集时刻+来源 runId 写进报告 (不许无声使用)');
    process.exit(0);
  }
}

console.log(`[blank-baseline] MISS (head=${head.slice(0, 7)} clean=${cleanTree}) → 真跑全量`);
const tsc = spawnSync('bunx', ['tsc', '--noEmit'], { cwd: root, encoding: 'utf8' });
const test = spawnSync('bun', ['test'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const testOut = `${test.stdout ?? ''}\n${test.stderr ?? ''}`;
const failSet = extractFailSet(testOut);
const sum = (re: RegExp): number => Number(testOut.match(re)?.[1] ?? 0);
const record = {
  key,
  at: new Date().toISOString(),
  ...(runId ? { runId } : {}),
  tscExit: tsc.status ?? -1,
  failSet,
  pass: sum(/(\d+) pass/),
  fail: sum(/(\d+) fail/),
  skip: sum(/(\d+) skip/),
};
console.log(`[blank-baseline] tscExit=${record.tscExit} pass=${record.pass} fail=${record.fail} skip=${record.skip}`);
for (const f of failSet) console.log(`  (fail) ${f}`);
if (cleanTree) {
  writeBaseline(store, record);
  console.log(`[blank-baseline] 已写缓存 ${store}`);
} else {
  console.log('[blank-baseline] 脏树 → 不写缓存 (悲观陈旧会赦免真回归)');
}
process.exit(0);
