/**
 * src/harness/dream/merge —— dream SDD §S2 记忆固化合并器(零 LLM)。
 *
 * 合并经过 validate 的候选 fact: identityKey 命中走既有 checkEvolve 三态
 * (evolution-lock.ts:72,一字不改),预算 K 超限整跑 fail(不是截断),
 * supersession 只增 1 且旧行 tombstone(永不 UPDATE-in-place)。
 *
 * 写入全走既有 OmdMemory 写路径(writeFact),merge 不自己写 SQL。
 */
import { join } from 'node:path';
import { createOmdMemory, type OmdMemory } from '../memory';
import type { WriteFactResult } from '../memory/types';
import { dreamFactInput, type DreamCandidate } from './validate';

// 契约类型(DreamCandidate/DreamNamespace)的唯一真源在 validate.ts —— 这里只 re-export,
// 不复制(验收改判 2026-08-09:两实现节点各自定义过一份,注释写着「共用」代码各写各的,坑 #3 形态)。
export type { DreamCandidate, DreamNamespace } from './validate';

// ---------------------------------------------------------------------------
// 预算 K(tentative,§1.9:拍的)
// ---------------------------------------------------------------------------

/** 每 extract 叶候选上限。tentative。 */
export const K_leaf = 8;
/** 整跑写入上限。tentative。 */
export const K_run = 30;

// ---------------------------------------------------------------------------
// 选项与报告
// ---------------------------------------------------------------------------

export interface MergeDreamOpts {
  /** 工作目录(仓根),所有路径锚此。 */
  cwd: string;
  /** 注入的记忆库(省略=按 cwd 创建 `.omd/memory.db`)。 */
  memory?: OmdMemory;
  /** 本次 merge 所属 run 的 id(来源追踪)。 */
  runId: string;
}

export interface MergeReport {
  ok: boolean;
  added: number;
  evolved: number;
  replaced: number;
  rejected: Array<{ candidate: DreamCandidate; reason: string }>;
  conflictsRaised: number;
  /** 预算超限时填,判词含实际数与上限。 */
  failReason?: string;
}

// ---------------------------------------------------------------------------
// mergeDreamCandidates
// ---------------------------------------------------------------------------

export async function mergeDreamCandidates(
  candidates: Array<{ leafId: string; candidate: DreamCandidate }>,
  opts: MergeDreamOpts,
): Promise<MergeReport> {
  const report: MergeReport = {
    ok: true,
    added: 0,
    evolved: 0,
    replaced: 0,
    rejected: [],
    conflictsRaised: 0,
  };

  // ── 预算 K:**先验前置闸,超限 = 零写入 + 整跑 fail**(验收改判 2026-08-09:
  // 原实装是「照写完再插 ok:false 旗」——比截断更糟:副作用全落库,fail 只是事后旗。
  // 「整跑 fail 不是截断」的语义 = 一条都不许写。证伪见 merge.test.ts 零写入断言。)──
  const byLeaf = new Map<string, number>();
  for (const { leafId } of candidates) byLeaf.set(leafId, (byLeaf.get(leafId) ?? 0) + 1);

  const budgetFailures: string[] = [];
  for (const [leafId, n] of byLeaf) {
    if (n > K_leaf) {
      budgetFailures.push(
        `K_leaf exceeded: leaf "${leafId}" produced ${n} candidates > limit ${K_leaf}`,
      );
    }
  }
  if (candidates.length > K_run) {
    budgetFailures.push(
      `K_run exceeded: run "${opts.runId}" attempted ${candidates.length} candidates > limit ${K_run}`,
    );
  }
  if (budgetFailures.length > 0) {
    report.ok = false;
    report.failReason = budgetFailures.join('; ');
    return report; // 零写入:memory 根本不开
  }

  const ownMemory = !opts.memory;
  const memory: OmdMemory =
    opts.memory ??
    createOmdMemory({ path: join(opts.cwd, '.omd', 'memory.db') });

  // ── 逐条写入(走既有 writeFact,含 scanSecrets:true;构造 = dreamFactInput,
  //    与 validate 校验的是同一个 fact —— D-1)──
  for (const { candidate } of candidates) {
    const result: WriteFactResult = await memory.writeFact(dreamFactInput(candidate), {
      scanSecrets: true,
    });

    if (result.status === 'written') {
      switch (result.action) {
        case 'insert':
          report.added++;
          break;
        case 'evolve':
          report.evolved++;
          break;
        case 'replace':
          report.replaced++;
          break;
      }
    } else {
      report.rejected.push({ candidate, reason: result.reason });
      if (result.raiseToInbox) {
        report.conflictsRaised++;
      }
    }
  }

  if (ownMemory) memory.close();

  return report;
}
