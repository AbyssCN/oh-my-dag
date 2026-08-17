/**
 * src/harness/goal/ignition-preflight —— 点火预检硬闸 (S2 / INV-5)。
 *
 * 已结晶 SDD 点火 (sddPath 直通) 前查一次板上活 run: 写集相交 + 对方活 → 拒点火。
 * 判据与介质全部来自 S1 的 run-board (readBoard/liveRuns), 本模块只做集合运算, 零 LLM (INV-6)。
 *
 * ## 三路判据
 * ① **活 run 相交 → blocked** (INV-5 前半): '运行中' = board 的 claimed 且无对应 terminal
 *    条目 (D-9), **不做进程探测** —— 进程探活会误杀刚崩的 run 的写面 (它可能正在被 owner 续跑)。
 * ② **force → 'ok' 但必留账** (INV-5 后半): 越闸不是偷偷的, 板上留一行 note 证据
 *    (runId 用 BOARD_RUN_ID —— 与 S1 的坏行/超限 note 同一个惯用法: note 是板级证据, 不挂 run)。
 *    无冲突时 force 不产生记录 —— 没有闸可越, 就没有越闸这回事。
 * ③ **已结晶未点火 SDD 相交 → 只进 advisories** (D-1/D-10): docs/plan/*.md 里已结晶
 *    (契约+分解两段齐、表可解析) 且**未被任何活 run 占用**的 SDD, 其写集与本 run 相交时
 *    只建议合图/协商, 不拒 —— 未点火的 SDD 是投机性存在, 不配占住别人的写面。
 *
 * ## 接口冻结 (S2 契约)
 * - 调用方在点火路径拿到自己的写集 (SDD 分解表各切片写集的并集) 后调本函数;
 * - `opts.force` 是 owner 的显式越闸声明, 不是默认逃生门。
 *
 * @module
 */
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { appendBoard, BOARD_RUN_ID, liveRuns, readBoard } from '../board/run-board';
import { loadSddContract, parseBreakdown } from './sdd-direct';

// ─── 冻结接口 ────────────────────────────────────────────────────────────────

export interface PreflightReport {
  verdict: 'ok' | 'blocked';
  conflicts: { runId: string; overlap: string[] }[];
  advisories: string[];
}

// ─── 内部工具 ────────────────────────────────────────────────────────────────

const FORCE_NOTE_PREFIX = 'ignition-preflight 越闸 (INV-5): force=true — 写集与板上活 run 相交仍点火: ';

/** 已结晶可执行 SDD: docs/plan/*.md 里契约+分解两段齐且表可解析的那批 (解析失败 = 不是已结晶 SDD, 跳过)。 */
function crystallizedSdds(root: string): { file: string; union: string[] }[] {
  let files: string[];
  try {
    files = readdirSync(join(root, 'docs', 'plan')).filter((f) => f.endsWith('.md'));
  } catch {
    return []; // docs/plan 不存在/读不到 → 无已结晶 SDD 可建议 (fail-open)
  }
  const out: { file: string; union: string[] }[] = [];
  for (const f of files) {
    try {
      const path = resolve(root, join('docs', 'plan', f));
      const bd = parseBreakdown(loadSddContract(path).text);
      out.push({ file: f, union: [...new Set(bd.slices.flatMap((s) => s.writeSet))] });
    } catch {
      // 缺段/表坏 = 不是已结晶可执行 SDD —— 对散文提合图建议是噪声, 跳过。
    }
  }
  return out;
}

// ─── 冻结接口实现 ────────────────────────────────────────────────────────────

export function ignitionPreflight(
  root: string,
  myWriteSet: string[],
  opts?: {
    force?: boolean;
    /** 测试/外部注入: 替身 `crystallizedSdds(root)` —— 用于断言「不走磁盘扫描」或注入假数据。 */
    crystallizedProvider?: (root: string) => { file: string; union: string[] }[];
    /** 票源真值 (D-1): 当 ticket 自带写集 → crystallized advisory 按票读, **不**触发 docs/plan 目录扫描。 */
    ticketSource?: { writeSet: string[] };
  },
): PreflightReport {
  const mine = new Set(myWriteSet);
  const live = liveRuns(readBoard(root));

  // ② 活 run 写集相交 (D-9 判据: claimed 无 terminal, 不做进程探测)。
  const conflicts: { runId: string; overlap: string[] }[] = [];
  for (const [runId, theirs] of live) {
    const overlap = theirs.filter((f) => mine.has(f)).sort();
    if (overlap.length > 0) conflicts.push({ runId, overlap });
  }

  // ③ 已结晶未点火 SDD 相交 → 只进 advisories (D-1/D-10)。
  //    票上有 writeSet 真源 → 按票读 (注入 provider **不**被调, 零磁盘访问);
  //    票缺席 → 回落 provider ?? 今天的目录扫描 (crystallizedSdds 内部已 try/catch fail-open)。
  const advisories: string[] = [];
  if (mine.size > 0) {
    const crystallized =
      opts?.ticketSource?.writeSet !== undefined
        ? [{ file: '(ticket)', union: opts.ticketSource.writeSet }]
        : (opts?.crystallizedProvider?.(root) ?? crystallizedSdds(root));
    for (const sdd of crystallized) {
      const sddSet = new Set(sdd.union);
      const overlap = sdd.union.filter((f) => mine.has(f)).sort();
      if (overlap.length === 0) continue;
      // 写集与某活 run 相交 = 该 SDD 已被占用 → 那是 ② 的事, 不再重复建议。
      const ignited = [...live.values()].some((ws) => ws.some((f) => sddSet.has(f)));
      if (ignited) continue;
      // 并集逐字等于本 run 写集 = 正是正在点火的这份 (或同写集孪生) —— 建议自己合图是噪声。
      if (sddSet.size === mine.size && sdd.union.every((f) => mine.has(f))) continue;
      advisories.push(
        `docs/plan/${sdd.file}: 已结晶未点火 SDD 写集相交 (${overlap.join('、')}) — 若将点火, 先与它合图/协商写面 (D-1/D-10)`,
      );
    }
  }

  const blocked = conflicts.length > 0 && !opts?.force;
  if (conflicts.length > 0 && opts?.force) {
    // INV-5 后半: 越闸必留账 —— 板上 note 一行, 写明撞了谁、撞了哪些文件。
    appendBoard(root, {
      v: 1,
      ts: new Date().toISOString(),
      runId: BOARD_RUN_ID,
      event: 'note',
      note: `${FORCE_NOTE_PREFIX}${conflicts.map((c) => `${c.runId} (${c.overlap.join('、')})`).join('; ')}`,
    });
  }

  return { verdict: blocked ? 'blocked' : 'ok', conflicts, advisories };
}
