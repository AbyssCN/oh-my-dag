/**
 * src/harness/chat/compaction-journal —— chat 压缩的**事务日志**(H4, issue #185)。
 *
 * ## 为什么要有它
 *
 * 轮前压缩的完整周期是四步:`start`(决定压)→ `summary`(模型调一次生成摘要)→ `replace`
 * (摘要落成一条 compaction 条目, 投影据此截断旧消息)→ `end`(干净收尾)。这四步里只有
 * `replace` 落盘、`summary` 花钱, 而它们之间隔着**一次模型调用 + 一次 JSONL append** ——
 * 进程在这里死掉, 盘上没有任何痕迹能说清「停在哪一步」:
 *
 *   - 摘要已经生成但 `replace` 没落 → 下次重跑会**再花一次钱**把同一段话重新摘要一遍;
 *   - `replace` 落了一半(实际是 append 原子, 只会"有/没有")→ 恢复时**猜「换没换」**。
 *
 * 对标 DSH 的 start/summary/replace/end 四步入日志:本文件把每一步**原子写**进会话文件的
 * sidecar(会话路径 + `.compaction-journal`), 中途崩溃留下「有 start 无 end」的可检测状态,
 * `recoverCompaction` 读它 + 交叉查 store, 把状态**封闭穷举**成下面那五个词 —— 不猜。
 *
 * ## 铁律(与本仓 fail-open 同族)
 *
 * - **全程 fail-open**:日志写/清/读失败都只 `logger.warn`, 永不抛 —— 压缩本身照跑,
 *   日志是安全网不是正确性闸, 不能因为它坏了就拦下压缩。
 * - **写前一步( write-ahead )**:`replace` 在 appendEntry **之前**写, 并带上 entryId ——
 *   恢复时拿 entryId 反查 store, 「换没换」由事实回答(条目在 = 换了, 不在 = 没换)。
 * - **原子写**:tmp + rename, 读的人永远看不到半截 JSON(半截 = 读不出来 = 当作没有 + 留证)。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { logger } from '../../logger';

/** 事务四步(与 DSH 对齐;`end` 不落盘 —— 干净收尾直接删 sidecar)。 */
export type CompactionStep = 'start' | 'summary' | 'replace' | 'end';

const STEPS: readonly CompactionStep[] = ['start', 'summary', 'replace', 'end'];

/** sidecar 里的**最后一步**快照(整体原子覆盖, 不是追加)。 */
export interface CompactionJournal {
  step: CompactionStep;
  sessionId: string;
  /** 压缩前的 token 估算(pureEstimate)。 */
  tokensBefore?: number;
  /** `summary` 起携带:生成的摘要全文(恢复可复用, 不必再花一次模型调用)。 */
  summary?: string;
  /** 摘要生成的 retainedTail 条数。 */
  retainedTailLength?: number;
  /** `replace` 起携带:本次 compaction 条目 id(恢复反查 store 用)。 */
  entryId?: string;
  at: number;
}

/**
 * 恢复态(**封闭穷举** —— H4「失败类别封闭可穷举」)。五个词, 没有「其它」。
 *
 * - `clean`:没日志, 或已干净收尾。
 * - `crashed-before-summary`:死在模型调用前/中 —— 摘要没生成, 重跑即可。
 * - `crashed-before-replace`:摘要已生成(在日志里), replace 没落 —— 可复用摘要只补 replace。
 * - `replace-lost`:写了 replace 意图但 store 里没有那个 entryId —— 换**没**发生。
 * - `replace-done-unended`:store 里有 entryId, 只差 end —— 换**已经**发生, 别再换。
 */
export type CompactionRecovery =
  | { status: 'clean' }
  | { status: 'crashed-before-summary'; tokensBefore?: number }
  | { status: 'crashed-before-replace'; summary: string; retainedTailLength?: number }
  | { status: 'replace-lost'; summary: string; entryId: string }
  | { status: 'replace-done-unended'; entryId: string };

/** 会话文件 → sidecar 路径(与 `session-lock.ts` 的 `${path}.lock` 同一族)。 */
export function journalPathFor(sessionPath: string): string {
  return `${sessionPath}.compaction-journal`;
}

/** 原子写一步快照。失败 fail-open:留一行, 不抛(压缩照跑)。 */
export function writeCompactionJournal(path: string, entry: CompactionJournal): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(entry), 'utf-8');
    renameSync(tmp, path);
  } catch (e) {
    logger.warn({ path, reason: (e as Error).message }, '[compaction-journal] 写日志失败 (fail-open: 压缩照跑)');
  }
}

/** 干净收尾:删 sidecar。失败 fail-open。 */
export function clearCompactionJournal(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch (e) {
    logger.warn({ path, reason: (e as Error).message }, '[compaction-journal] 清日志失败 (fail-open)');
  }
}

/** 读 sidecar。不存在 / 字段不全 / 坏 JSON / step 非法 → null(当作没有 + 留一行)。 */
export function readCompactionJournal(path: string): CompactionJournal | null {
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Partial<CompactionJournal>;
    if (
      typeof raw.step !== 'string' ||
      !(STEPS as readonly string[]).includes(raw.step) ||
      typeof raw.sessionId !== 'string' ||
      typeof raw.at !== 'number'
    ) {
      throw new Error('字段不全或 step 非法');
    }
    return raw as CompactionJournal;
  } catch (e) {
    logger.warn({ path, reason: (e as Error).message }, '[compaction-journal] 日志读不出来, 当作没有');
    return null;
  }
}

/**
 * 恢复态判定。`hasEntry(entryId)` 由调用方给 —— 查 store 里有没有那个 compaction 条目 id
 * (「换没换」的唯一事实来源, 不靠推断)。
 */
export function recoverCompaction(
  path: string,
  hasEntry: (entryId: string) => boolean,
): CompactionRecovery {
  const j = readCompactionJournal(path);
  if (!j || j.step === 'end') return { status: 'clean' };
  switch (j.step) {
    case 'start':
      return { status: 'crashed-before-summary', tokensBefore: j.tokensBefore };
    case 'summary':
      return {
        status: 'crashed-before-replace',
        summary: j.summary ?? '',
        retainedTailLength: j.retainedTailLength,
      };
    case 'replace': {
      const entryId = j.entryId ?? '';
      return hasEntry(entryId)
        ? { status: 'replace-done-unended', entryId }
        : { status: 'replace-lost', summary: j.summary ?? '', entryId };
    }
    default:
      // readCompactionJournal 已拦非法 step, 这里只兜类型收口。
      return { status: 'clean' };
  }
}
