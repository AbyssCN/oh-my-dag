/**
 * compaction-journal 恢复态判定 (H4, issue #185)。
 *
 * 证伪方式 (当场验过): 把 `recoverCompaction` 的 `hasEntry` 判定反掉 / 把某个 case 挪到别的
 * status → 下面「注入崩溃点」那组用例必红。核心要证的是「封闭穷举」:每一步崩溃都能被
 * 精确分到**唯一**一个词, 不靠猜「换没换」。
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  clearCompactionJournal,
  journalPathFor,
  readCompactionJournal,
  recoverCompaction,
  writeCompactionJournal,
  type CompactionJournal,
} from './compaction-journal';

const dir = mkdtempSync(join(tmpdir(), 'compaction-journal-'));
const sessionPath = join(dir, 'sess.jsonl');
const journal = journalPathFor(sessionPath);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const at = 1_700_000_000_000;
const base: CompactionJournal = { step: 'start', sessionId: 's1', at };

describe('compaction-journal 恢复态 (#185 封闭失败集)', () => {
  test('无日志 → clean', () => {
    expect(recoverCompaction(journal, () => false)).toEqual({ status: 'clean' });
  });

  test('干净收尾 (clear) → clean (end 不落盘, 删 sidecar)', () => {
    writeCompactionJournal(journal, { ...base, step: 'replace', entryId: 'e1', at });
    clearCompactionJournal(journal);
    expect(readCompactionJournal(journal)).toBeNull();
    expect(recoverCompaction(journal, () => false)).toEqual({ status: 'clean' });
  });

  test('注入崩溃点 ①: start 后死 → crashed-before-summary', () => {
    writeCompactionJournal(journal, { ...base, step: 'start', tokensBefore: 123, at });
    expect(recoverCompaction(journal, () => false)).toEqual({
      status: 'crashed-before-summary',
      tokensBefore: 123,
    });
  });

  test('注入崩溃点 ②: summary 后死 → crashed-before-replace (摘要可复用)', () => {
    writeCompactionJournal(journal, { ...base, step: 'summary', summary: 'S', retainedTailLength: 3, at });
    expect(recoverCompaction(journal, () => false)).toEqual({
      status: 'crashed-before-replace',
      summary: 'S',
      retainedTailLength: 3,
    });
  });

  test('注入崩溃点 ③: replace 写了意图但 append 没落 → replace-lost (换没发生)', () => {
    writeCompactionJournal(journal, { ...base, step: 'replace', entryId: 'e9', summary: 'S', at });
    expect(recoverCompaction(journal, () => false)).toEqual({
      status: 'replace-lost',
      summary: 'S',
      entryId: 'e9',
    });
  });

  test('注入崩溃点 ④: append 已落但 end 没写 → replace-done-unended (换已发生, 别再换)', () => {
    writeCompactionJournal(journal, { ...base, step: 'replace', entryId: 'e9', at });
    expect(recoverCompaction(journal, (id) => id === 'e9')).toEqual({
      status: 'replace-done-unended',
      entryId: 'e9',
    });
  });

  test('坏 JSON → 当作没有 → clean (fail-open, 不留静默)', () => {
    writeFileSync(journal, '{not json', 'utf-8');
    expect(recoverCompaction(journal, () => false)).toEqual({ status: 'clean' });
  });

  test('step 非法 → 当作没有 → clean (封闭集外的值不落进恢复态)', () => {
    writeCompactionJournal(journal, { ...base, step: 'garbage' as CompactionJournal['step'], at });
    expect(readCompactionJournal(journal)).toBeNull();
    expect(recoverCompaction(journal, () => false)).toEqual({ status: 'clean' });
  });
});
