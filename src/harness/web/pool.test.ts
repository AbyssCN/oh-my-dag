/**
 * src/harness/web/pool.test —— WebSearchPool 的 failover 语义闸(2026-08-14 新建)。
 *
 * 这个文件此前**不存在** —— 池子一个测试都没有,而下面这条洞正是在没有闸的那一格里活了很久:
 * failover 只保「provider 抛错」,不保「provider 返空」。一个 200 空手的 provider 把整条链
 * 短路掉,`researchWebFanout` 抛「检索零结果」,research 节点失败进毒集 → 语料双跑重画。
 *
 * **每条都写了怎么让它红。** 三条主闸:
 * ① 空手要换人(把 `if (results.length === 0) … continue` 删掉 → 红);
 * ② 全员空手仍**返空不抛**(改成 throw → 红;而那一改会把 `retrieveWeb` 里同一批
 *    `Promise.all` 中**别的 query 已搜到的结果**一起带走);
 * ③ 全员抛错仍**抛**(改成返空 → 红;「链挂了」与「确实没结果」不许合并成一种)。
 */
import { describe, expect, test } from 'bun:test';
import { createWebSearchPool } from './pool';
import type { SearchProvider, SearchResult } from './types';
import type { QuotaStore } from './quota-store';

const hit = (url: string): SearchResult => ({ title: url, url, snippet: '' }) as SearchResult;

/** 记账用的假 quota(池子唯一的外部副作用)。 */
function fakeQuota(): QuotaStore & { records: string[] } {
  const records: string[] = [];
  return {
    records,
    record: (name: string) => {
      records.push(name);
    },
    used: () => 0,
  } as unknown as QuotaStore & { records: string[] };
}

const prov = (impl: () => Promise<SearchResult[]>): SearchProvider => ({ search: impl }) as unknown as SearchProvider;
const empty = (): SearchProvider => prov(async () => []);
const boom = (msg: string): SearchProvider =>
  prov(async () => {
    throw new Error(msg);
  });
const gives = (...urls: string[]): SearchProvider => prov(async () => urls.map(hit));

const poolOf = (entries: { name: string; provider: SearchProvider }[], quota: QuotaStore) =>
  createWebSearchPool({ entries, quota, defaultProvider: entries[0]!.name, mode: 'failover' });

describe('failover —— 空手不算答 (2026-08-14 修的那条)', () => {
  test('★ 第一个 provider 返空 → 换下一个, 拿到真结果', async () => {
    // 证伪方式: 把 tryInOrder 里 `if (results.length === 0) { …; continue; }` 删掉 →
    // 这条返 0 条 (退回 2026-08-14 之前的行为, 即那次 research 节点失败的成因)。
    const q = fakeQuota();
    const r = await poolOf([{ name: 'a', provider: empty() }, { name: 'b', provider: gives('u1') }], q).search('x');
    expect(r.results.map((s) => s.url)).toEqual(['u1']);
    expect(r.providers).toEqual(['b']);
    // 空手那一发**也真的用掉了配额** —— 不记会让额度账虚高
    expect(q.records).toEqual(['a', 'b']);
  });

  test('★ 全员空手 → 返空但不抛 (抛会把同批别的 query 的结果一起带走)', async () => {
    // 证伪方式: 把末尾那句 `if (empties.length > 0) return …` 换成 throw → 这条红。
    const r = await poolOf([{ name: 'a', provider: empty() }, { name: 'b', provider: empty() }], fakeQuota()).search('x');
    expect(r.results).toEqual([]);
    expect(r.providers).toEqual(['a', 'b']); // 链**试遍了**才算空, 调用方看得出来
    expect(r.errors).toBeUndefined(); // 没人抛 → 不编一个错误出来
  });

  test('★ 全员抛错 → 仍然抛 (「链挂了」≠「确实没结果」)', async () => {
    // 证伪方式: 把那句 throw 改成返空 → 这条红。合并这两种状态就等于把基建故障
    // 记成「这个题没资料」, 而那正是事后再也分不开的那类抹平。
    const p = poolOf([{ name: 'a', provider: boom('429') }, { name: 'b', provider: boom('timeout') }], fakeQuota());
    await expect(p.search('x')).rejects.toThrow('all search providers failed');
  });

  test('★ 半挂半空 → 返空, 且错误原文留在 errors 里 (不吞证据)', async () => {
    // 证伪方式: 去掉返回值里的 `...(errors.length ? { errors } : {})` → 这条红。
    // 没有这一格的话「一半 provider 挂了」会被读成「链走完了没资料」。
    const r = await poolOf([{ name: 'a', provider: boom('429 rate limited') }, { name: 'b', provider: empty() }], fakeQuota()).search('x');
    expect(r.results).toEqual([]);
    expect(r.errors).toEqual(['a: 429 rate limited']);
  });

  test('半挂半中 → 拿到结果, 但挂掉那个的原文照样留着', async () => {
    const r = await poolOf([{ name: 'a', provider: boom('503') }, { name: 'b', provider: gives('u1') }], fakeQuota()).search('x');
    expect(r.results.map((s) => s.url)).toEqual(['u1']);
    expect(r.errors).toEqual(['a: 503']);
  });

  test('第一个就有结果 → 不多花第二个 provider 的额度 (省的那一半没被改坏)', async () => {
    const q = fakeQuota();
    const r = await poolOf([{ name: 'a', provider: gives('u1') }, { name: 'b', provider: gives('u2') }], q).search('x');
    expect(r.providers).toEqual(['a']);
    expect(q.records).toEqual(['a']);
  });
});

describe('aggregate —— 本来就不吃这条洞 (对照组)', () => {
  test('并行全发, 空手的那个只是没贡献, 不影响别人', async () => {
    const pool = createWebSearchPool({
      entries: [{ name: 'a', provider: empty() }, { name: 'b', provider: gives('u1') }],
      quota: fakeQuota(),
      defaultProvider: 'a',
      mode: 'aggregate',
    });
    const r = await pool.search('x');
    expect(r.results.map((s) => s.url)).toEqual(['u1']);
    expect(r.providers).toEqual(['a', 'b']); // 两个都真发了
  });
});
