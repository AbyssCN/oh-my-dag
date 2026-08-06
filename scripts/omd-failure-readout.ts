#!/usr/bin/env bun
/**
 * omd-failure-readout —— 节点失败留痕的确定性读数 (承 omd-readout 的读数板语言: 纯函数 + 薄 CLI,
 * 零模型调用、零建议、零改动)。
 *
 * 读的是 continuity checkpoint 那棵树: 每个 root 下的 run 目录 (`<runId>/`) 里,
 * `<nodeId>.json` 节点 checkpoint (+ 覆写前的 `<nodeId>.__r<N>.json` 归档, 2026-08-06
 * checkpoint-archive 起存在) 与 `_loop-<nodeId>.json` 内环 journal。答四个问题:
 *
 *   ① 失败 checkpoint 里有多少份点名了盘上真有的文件 (`failurePaths` 非空)—— 它是
 *     「路径 → 谁写的」反查的起点, 但**只进可见性不参与判定**, 这一格量的就是那条通道的覆盖率;
 *   ② `empty-artifact` 到底空在哪: 带 `inputPaths` 的份数 —— "记了输入面" 与 "输入面缺席"
 *     分不开时, 这份数就是那两格的分界线;
 *   ③ 「判据红 ∧ judge 说收敛」出现过几次 (RoundVerdict 里 `criterion==='red' && judge==='converged'`)——
 *     D-I 预先声明"出现过才补守卫"的那条判据, 攒到成立就是一次 grep;
 *   ④ `infra-error` 与 `rounds-exhausted` 各几份 —— 两者的下一步**相反** (前者重试/换池,
 *     后者重试恒 0ms 同样死), 并进一格等于把两个方向焊死。
 *
 * ⚠ 口径纪律 (与 omd-readout 同一套):
 *   · **fail-open**: 单份文件读坏 (JSON 解析失败 / 权限) 计入 `unreadable` 后跳过, 绝不整体抛错 ——
 *     一棵树里一份烂文件不该让整次读数报废 (它是"这一份读不了", 不是"这一批都不算数")。
 *   · 分母为 0 的占比给 `null` (**算不出 ≠ 0%**, 不编 0)。
 *   · `dep-skip` / `gate-rejected` 不进 ① 的分母: dep-skip 恒 `status==='skipped'` (零执行零花费,
 *     它没有"失败产物"可言), gate-rejected 是白名单闸拒 (命令未执行) —— 并进分母会把覆盖率
 *     稀释成"结构上不可能有路径的格子也来投票"。
 *
 * ## 跑法
 *
 *   bun run scripts/omd-failure-readout.ts                  # 默认扫 cwd/.omd/continuity
 *   bun run scripts/omd-failure-readout.ts <root> [root…]   # 显式 root (如 OMD_DATA_HOME 投影)
 */
import { readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import type { NodeCheckpoint, NodeLoopJournal, RoundVerdict } from '../src/harness/continuity/types';

/** ① 的分母排除集: 见文件头口径纪律 —— 这两格的"失败"结构上带不出 failurePaths。 */
const DENOMINATOR_EXCLUDED = new Set(['dep-skip', 'gate-rejected'] as const);

/** 四个读数的汇总形状 (CLI 与测试都吃它, 禁止另起读数实现)。 */
export interface FailureReadout {
  /** 扫到的 run 目录数 (root 的直接子目录)。 */
  runDirs: number;
  /** 读坏的文件/目录份数 (JSON 解析失败 / 权限) —— fail-open 跳过, 不进任何一格。 */
  unreadable: number;
  /** ① 失败 checkpoint 中 `failurePaths` 非空的份数与占比。 */
  failurePaths: {
    /** 分母: `status==='failed'` 且 failureKind ∉ {dep-skip, gate-rejected} 的份数 (含 `__r<N>` 归档)。 */
    denominator: number;
    /** 分子: 分母内 `failurePaths` 非空 (存在且 length>0) 的份数。 */
    withPaths: number;
    /** withPaths ÷ denominator; 分母 0 → null (算不出 ≠ 0%)。 */
    rate: number | null;
  };
  /** ② `failureKind==='empty-artifact'` 的份数, 及其中带 `inputPaths` 的份数。 */
  emptyArtifact: { total: number; withInputPaths: number };
  /** ③ 所有 `_loop-*.json` 的 verdicts 里 `criterion==='red' && judge==='converged'` 的条数。 */
  redConverged: number;
  /** ④ 各自计数 (方向相反的两格, 不许合并)。 */
  infraError: number;
  roundsExhausted: number;
}

/** 非空 = 存在且 length>0; null / undefined / [] 都算空 (这一格只问"有没有可指的路径")。 */
function hasItems(xs: unknown): xs is unknown[] {
  return Array.isArray(xs) && xs.length > 0;
}

/** 遍历每个 root 下的 run 目录, 逐份读 checkpoint 与内环 journal, 汇成四格读数。 */
export function failureReadout(roots: string[]): FailureReadout {
  const out: FailureReadout = {
    runDirs: 0,
    unreadable: 0,
    failurePaths: { denominator: 0, withPaths: 0, rate: null },
    emptyArtifact: { total: 0, withInputPaths: 0 },
    redConverged: 0,
    infraError: 0,
    roundsExhausted: 0,
  };
  for (const root of roots) {
    let entries;
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      // root 不存在/不可读 → 这一个 root 零贡献, 不记 unreadable (那一位数的是"读到了但读坏"的文件)。
      continue;
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue; // run 目录是 root 的直接子目录, 平铺文件不是
      out.runDirs++;
      scanRunDir(join(root, ent.name), out);
    }
  }
  if (out.failurePaths.denominator > 0) {
    out.failurePaths.rate = out.failurePaths.withPaths / out.failurePaths.denominator;
  }
  return out;
}

/** 一个 run 目录内的两类文件: `_loop-*.json` 是内环 journal, 其余 `*.json` 是节点 checkpoint。 */
function scanRunDir(dir: string, out: FailureReadout): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    out.unreadable++; // 目录都读不了 → 这一份 run 整体不可读, 记一档 (fail-open)
    return;
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue; // out-*.txt / fail-*.txt 不是数据文件
    if (name.startsWith('_loop-')) {
      readLoopJournal(join(dir, name), out);
      continue;
    }
    // _dag / _goal / _fixpoint 是 run 级元数据, 不是节点 checkpoint —— 统一按 `_` 前缀排除
    // (checkpoint 归档 `__r<N>.json` 与运行时子节点 `parent::fp.json` 都不带 `_` 前缀)。
    if (name.startsWith('_')) continue;
    readCheckpoint(join(dir, name), out);
  }
}

function readCheckpoint(path: string, out: FailureReadout): void {
  let cp: NodeCheckpoint;
  try {
    cp = JSON.parse(readFileSync(path, 'utf-8')) as NodeCheckpoint;
  } catch {
    out.unreadable++; // 解析失败/权限 → fail-open, 这一份不进任何一格
    return;
  }
  if (cp.status !== 'failed') return; // done 绿节点 / skipped 级联 —— 失败读数只看 failed
  const kind = cp.failureKind;
  if (kind === 'infra-error') out.infraError++;
  else if (kind === 'rounds-exhausted') out.roundsExhausted++;
  if (kind === 'empty-artifact') {
    out.emptyArtifact.total++;
    if (hasItems(cp.inputPaths)) out.emptyArtifact.withInputPaths++;
  }
  if (kind === 'dep-skip' || kind === 'gate-rejected') return; // 分母排除集, 见文件头
  out.failurePaths.denominator++;
  if (hasItems(cp.failurePaths)) out.failurePaths.withPaths++;
}

function readLoopJournal(path: string, out: FailureReadout): void {
  let journal: NodeLoopJournal;
  try {
    journal = JSON.parse(readFileSync(path, 'utf-8')) as NodeLoopJournal;
  } catch {
    out.unreadable++; // 同上, fail-open
    return;
  }
  // verdicts 缺席 = 老记录 / 这个环没走到判决点 (不是 0 条); 非数组 = 数据坏 → 当没记, 不抛。
  if (!Array.isArray(journal.verdicts)) return;
  const verdicts: RoundVerdict[] = journal.verdicts;
  for (const v of verdicts) {
    if (v.criterion === 'red' && v.judge === 'converged') out.redConverged++;
  }
}

if (import.meta.main) {
  // 无参 → 扫**两个**约定根: 仓内 `.omd/continuity` 与 `~/.omd/projects/<slug>/continuity`。
  //
  // ⚠ 这一行原本只扫仓内那个, 而那**恰恰是本脚本要治的那种少数**: 实测默认 73 个 run 目录、
  //   带两个根 87 个 (empty-artifact 20 vs 21)。`checkpoint-manager.runDir` 的两条落点是
  //   `OMD_DATA_HOME` 设与未设的分野 —— 按最显然的方式跑它的人拿到少数的读数, 而没有任何东西
  //   告诉他。少的那一半不是噪声, 是另一半生产数据。
  //   不存在的根由 `failureReadout` 自己跳过 (它对缺失目录 fail-open), 所以多给一个是安全的。
  const defaultRoots = [
    join(process.cwd(), '.omd', 'continuity'),
    join(homedir(), '.omd', 'projects', basename(process.cwd()), 'continuity'),
  ];
  const roots = Bun.argv.length > 2 ? Bun.argv.slice(2) : defaultRoots;
  const r = failureReadout(roots);
  console.log(`root: ${roots.join(' · ')}`); // 报出量的是哪几棵树 —— 换根就换数, 不说等于读数没有出处
  const pct = (n: number | null) => (n === null ? '—' : `${(n * 100).toFixed(1)}%`);
  console.log(`omd-failure-readout — ${r.runDirs} 个 run 目录, 读坏 ${r.unreadable} 份 (fail-open 跳过)`);
  console.log(`  ① failurePaths 非空  ${r.failurePaths.withPaths}/${r.failurePaths.denominator} (${pct(r.failurePaths.rate)})`);
  console.log(`  ② empty-artifact     ${r.emptyArtifact.total} 份, 其中带 inputPaths ${r.emptyArtifact.withInputPaths} 份`);
  console.log(`  ③ 判据红 ∧ judge 收敛  ${r.redConverged} 条 (D-I 的守卫判据)`);
  console.log(`  ④ infra-error ${r.infraError} · rounds-exhausted ${r.roundsExhausted} (下一步相反, 别合并)`);
}
