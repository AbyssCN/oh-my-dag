/**
 * hygiene-tickets.test —— INV-7「票聚类不爆炸」(GWT-7)。
 *
 * 反向自检 (逐条, 撤掉判据 → 该条当场红):
 *   · 把 `buildTickets` 里 failed-runs 那一段改成逐条 item 一票 (不读 metrics.count)
 *     → 「156 条 5 簇出 5 张票」那条红。
 *   · 把 fork 汇总改成逐 fork 一票 → 「汇总票 ≤ 2」那条红。
 *   · 把去重的 `startsWith(dedupPrefix)` 改成全文相等 → 「计数变了仍算同一张票」那条红。
 *   · 去掉 `skipped` 的记录 → 「跳过要留证据」那条红。
 */
import { describe, expect, test } from 'bun:test';
import {
  MAX_SUMMARY_TICKETS,
  TICKET_PREFIX,
  buildTickets,
  summaryTicketCount,
  type BuildTicketsInput,
} from './hygiene-tickets';
import { mineFailedRuns, mineForks } from '../src/harness/hygiene/miners';
import { emptyCounts, type HygieneItem, type HygieneScan } from '../src/harness/hygiene/types';

/** 156 条失败 run 分 5 簇 (68/40/30/13/5) —— GWT-7 的对照数据。 */
const CLUSTER_SIZES = [68, 40, 30, 13, 5];
const TOTAL_RUNS = CLUSTER_SIZES.reduce((a, b) => a + b, 0);

function failedRunItems(): HygieneItem[] {
  const rows = CLUSTER_SIZES.flatMap((n, ci) =>
    Array.from({ length: n }, (_, i) => ({
      run_id: `run-${ci}-${i}`,
      status: 'failed',
      error: `终止原因: reason-${ci} (X) · 下一步: 看判词`,
    })),
  );
  return mineFailedRuns(rows);
}

function scanOf(items: HygieneItem[]): HygieneScan {
  const counts = emptyCounts();
  for (const i of items) counts[i.source] += 1;
  return { version: 1, generatedAt: '2026-09-02T00:00:00Z', sha: 'abc', counts, items, errors: [] };
}

const baseInput = (over: Partial<BuildTicketsInput> = {}): BuildTicketsInput => ({
  scan: scanOf(failedRunItems()),
  verdicts: [],
  fallbackIds: [],
  slug: 'hygiene',
  existingOpenTitles: [],
  generatedAt: '2026-09-02T00:00:00Z',
  ...over,
});

describe('INV-7 GWT-7 聚类成票', () => {
  test(`${TOTAL_RUNS} 条失败 run 分 5 簇 → 5 张簇票`, () => {
    expect(TOTAL_RUNS).toBe(156);
    const r = buildTickets(baseInput());
    expect(r.tickets).toHaveLength(CLUSTER_SIZES.length);
    expect(summaryTicketCount(r)).toBe(0);
  });

  test('每票 metrics.count 与簇大小相等', () => {
    const r = buildTickets(baseInput());
    expect(r.tickets.map((t) => t.metrics.count).sort((a, b) => b - a)).toEqual([...CLUSTER_SIZES].sort((a, b) => b - a));
  });

  test('票 title 带统一前缀 + 计数, 正文带判词原文与样本 runId', () => {
    const t = buildTickets(baseInput()).tickets[0]!;
    expect(t.title.startsWith(TICKET_PREFIX)).toBe(true);
    expect(t.title).toContain('共 68 条');
    expect(t.body).toContain('终止原因: reason-0');
    expect(t.body).toContain('样本 runId:');
  });

  test('fork 与残余各一张汇总票, 上限 2 不随数量涨', () => {
    const forks = mineForks(
      Array.from({ length: 40 }, (_, i) => ({ id: `f${i}`, run_id: `r${i}`, question: `问题 ${i}` })),
    );
    const r = buildTickets(
      baseInput({
        scan: scanOf([...failedRunItems(), ...forks]),
        verdicts: Array.from({ length: 30 }, (_, i) => ({
          itemId: `knip-files:src/${i}.ts`,
          verdict: 'refuted' as const,
          checks: [{ name: 'ugrep 引用计数', ok: false, detail: 'd' }],
        })),
        fallbackIds: ['todo:a', 'todo:b'],
      }),
    );
    expect(summaryTicketCount(r)).toBe(MAX_SUMMARY_TICKETS);
    expect(r.tickets).toHaveLength(CLUSTER_SIZES.length + MAX_SUMMARY_TICKETS);
    const residue = r.tickets.find((t) => t.dedupPrefix.includes('残余'))!;
    expect(residue.metrics.count).toBe(32);
  });

  test('零 fork 零残余 → 不造空汇总票', () => {
    expect(summaryTicketCount(buildTickets(baseInput()))).toBe(0);
  });
});

describe('INV-7 去重: 再跑一次不重复', () => {
  test('图上已有同前缀未终结票 → 不造新票, 且跳过留证据', () => {
    const first = buildTickets(baseInput());
    const again = buildTickets(baseInput({ existingOpenTitles: first.tickets.map((t) => t.title) }));
    expect(again.tickets).toEqual([]);
    expect(again.skipped).toHaveLength(CLUSTER_SIZES.length);
    expect(again.skipped[0]!.detail).toContain('图上已有');
  });

  test('计数变了仍算同一张票 (去重比的是不含计数的前缀)', () => {
    // 上周簇里 68 条, 这周涨到 99 条 —— 同一个原因, 不该再开一张。
    const oldTitle = `${TICKET_PREFIX} 失败 run 簇「reason-0」 — 共 68 条`;
    const r = buildTickets(baseInput({ existingOpenTitles: [oldTitle] }));
    expect(r.tickets.some((t) => t.dedupPrefix.includes('reason-0'))).toBe(false);
    expect(r.skipped[0]!.detail).toContain('本次计数 68');
  });

  test('不相干的已有票不影响新票', () => {
    const r = buildTickets(baseInput({ existingOpenTitles: ['别的活: 重构 engine.ts'] }));
    expect(r.tickets).toHaveLength(CLUSTER_SIZES.length);
    expect(r.skipped).toEqual([]);
  });
});

describe('票草稿字段与 map_add 同名', () => {
  test('title / type / executorKind / slug 四个键都在且值域合法', () => {
    const t = buildTickets(baseInput({ slug: 'repo-hygiene' })).tickets[0]!;
    expect(Object.keys(t)).toEqual(expect.arrayContaining(['title', 'type', 'executorKind', 'slug']));
    expect(['research', 'grill', 'prototype', 'task']).toContain(t.type);
    expect(['command', 'inproc', 'agent', 'map', 'primitive', 'goal']).toContain(t.executorKind);
    expect(t.slug).toBe('repo-hygiene');
  });
});
