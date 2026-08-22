/**
 * src/harness/verifier-body-tail —— **C-1 卷面正文头尾双保** 闸
 * (SDD 2026-08-23 verifier-body-tail, 切片 1)。
 *
 * ## 这道闸治什么
 *
 * 引擎手上有「6684 pass / 0 fail」这一行, 但 `summarizeResults` 的截断只留头
 * (`slice(0, n)`), 那行在最末尾 ⇒ verifier 拿不到 = 没法判据。run `07e219e3`
 * 的 verifier 判词逐字写「全量 bun test 虽有引擎 exit 0, 但输出中缺少明确要求的
 * 原样 pass/fail/总数」—— 它没冤枉, 那行确实不在卷面上。
 *
 * 修法: 头尾都保。头有「节点在讲自己做了什么」(声称面), 尾有机械判词 (证据面)。
 * 判据本体是「声称 ⊆ 记录」, 两侧都要。
 *
 * ## 七条 GWT (来自 C-1)
 *
 * - GWT-1 INV-1 短输出零回归 (≤ 预算 ⇒ 正文与今天逐字节同, 无省略标记)
 * - GWT-2 INV-2 超预算取尾 (> 预算 ⇒ 末尾判词行必现) ← **修前必红, 本片全部理由**
 * - GWT-3 INV-3 总量不涨 (头 + 尾 ≤ 预算, 含标记 ≤ 预算 × 2)
 * - GWT-4 INV-4 头段不许空 (头 > 0), 尾重于头 (尾 > 头)
 * - GWT-5 INV-5 省略标记带被省略字节数 (D-4 防 NULL/0/不适用 抹平)
 * - GWT-6 INV-6 失败节点正文仍是 `(failed)`, 一字不动 (D-5)
 * - GWT-7 INV-7 空 / 缺席输出零回归
 *
 * ## 反向自检
 *
 * | # | 文件 | oldText | newText |
 * |---|---|---|---|
 * | 1 | src/harness/verifier.ts | `output.slice(-tailLen)` | `''` |
 *
 * 把尾段拼成空 ⇒ GWT-2 / GWT-4 当场红 (卷面里不再含末尾判词行 / 头段首行外的尾段内容),
 * 红的理由只准是「卷面里没有那一行」(对得上单条 `toContain` 失败信息)。承重那一跳是
 * **「尾段到底在不在」** —— 它假, 闸假。
 */
import { describe, expect, test } from 'bun:test';
import { summarizeResults } from './verifier';
import type { ConductorPlan } from './conductor-plan';
import type { LeafResult } from './dag/engine';

const leaf = (over: Partial<LeafResult> & { id: string }): LeafResult =>
  ({ status: 'done', kind: 'agent', output: '', deps: [], usage: { in: 0, out: 0 }, ...over }) as LeafResult;

/** 取出节点段的整段 body (可能含换行: 头 + 省略标记 + 尾)。无匹配则抛。 */
function bodyOf(s: string, nodeId: string): string {
  for (const sec of s.split('\n\n')) {
    if (sec.startsWith(`### ${nodeId} `)) {
      const firstNl = sec.indexOf('\n');
      return firstNl === -1 ? '' : sec.slice(firstNl + 1);
    }
  }
  throw new Error(`section for ${nodeId} not found in:\n${s}`);
}

describe('C-1 卷面正文头尾双保', () => {
  test('★ GWT-1: 短输出零回归 (INV-1) —— 100B / 预算 1200, 正文逐字同原, 无省略标记', () => {
    const plan: ConductorPlan = { name: 'p', nodes: { n: { goal: 'g', executor: 'leaf' } } };
    const output = 'a'.repeat(100);
    const results: Record<string, LeafResult> = { n: leaf({ id: 'n', output }) };
    const s = summarizeResults(plan, results, 1200);
    // INV-1: 正文 === 那 100 字节原串, 没有「省略」标记 (因为没超预算)。
    expect(bodyOf(s, 'n')).toBe(output);
    expect(s).not.toContain('省略');
  });

  test('★ GWT-2: 超预算取尾 (INV-2) —— 60000B 末尾含判词行, 预算 1200, 该行必现', () => {
    // 修前必红: `slice(0, 1200)` 只留头, 「6684 pass / 0 fail」在最末 ⇒ 丢失。
    // 修后绿: 尾段保留判词行, verifier 一眼能读。
    const plan: ConductorPlan = { name: 'p', nodes: { n: { goal: 'g', executor: 'leaf' } } };
    const trailer = '6684 pass / 0 fail';
    const output = 'x'.repeat(60000 - trailer.length) + trailer;
    const results: Record<string, LeafResult> = { n: leaf({ id: 'n', output }) };
    const s = summarizeResults(plan, results, 1200);
    expect(s).toContain(trailer);
  });

  test('★ GWT-3: 总量不涨 (INV-3) —— head + tail ≤ 预算, 含标记总长 ≤ 预算 × 2', () => {
    const plan: ConductorPlan = { name: 'p', nodes: { n: { goal: 'g', executor: 'leaf' } } };
    const output = 'x'.repeat(60000);
    const results: Record<string, LeafResult> = { n: leaf({ id: 'n', output }) };
    const s = summarizeResults(plan, results, 1200);
    // body 段 = 头 + 一行标记 + 尾; body 字符串总长 ≤ 2 × 1200 = 2400 (D-2)。
    expect(bodyOf(s, 'n').length).toBeLessThanOrEqual(2400);
    // 头 + 尾字节和 ≤ 1200 (D-2 严格上界); 从 body 中切出 head / tail / 标记三段估算。
    const body = bodyOf(s, 'n');
    const parts = body.split('\n');
    // [head..., marker, tail...]
    const markerIdx = parts.findIndex((p) => p.includes('省略'));
    expect(markerIdx).toBeGreaterThan(-1);
    const head = parts.slice(0, markerIdx).join('\n');
    const tail = parts.slice(markerIdx + 1).join('\n');
    expect(head.length + tail.length).toBeLessThanOrEqual(1200);
  });

  test('★ GWT-4: 头段不许空 + 尾重于头 (INV-4) —— 60000B 首行 HEAD_MARKER, 头段必现', () => {
    const plan: ConductorPlan = { name: 'p', nodes: { n: { goal: 'g', executor: 'leaf' } } };
    const headMarker = 'HEAD_MARKER —— 这是节点自述的开头';
    const output = headMarker + '\n' + 'x'.repeat(60000 - headMarker.length - 1);
    const results: Record<string, LeafResult> = { n: leaf({ id: 'n', output }) };
    const s = summarizeResults(plan, results, 1200);
    // INV-4 「头 > 0」侧: 头段必含首行。
    expect(s).toContain(headMarker);
    // 隐含的「尾 > 头」: tail = 预算 - headLen, headLen = floor(0.3 * 1200) = 360,
    // tail = 1200 - 360 = 840, 故 tail > head (840 > 360)。在 GWT-3 已间接验过。
  });

  test('★ GWT-5: 省略标记带被省略字节数 (INV-5) —— 60000B / 1200, 标记里那个数 > 0', () => {
    const plan: ConductorPlan = { name: 'p', nodes: { n: { goal: 'g', executor: 'leaf' } } };
    const output = 'x'.repeat(60000);
    const results: Record<string, LeafResult> = { n: leaf({ id: 'n', output }) };
    const s = summarizeResults(plan, results, 1200);
    // INV-5: 标记里含「被省略的字节数」 —— 任意 3+ 位数字命中, 且 > 0。
    const body = bodyOf(s, 'n');
    expect(body).toMatch(/\d{3,}/);
    const numMatch = body.match(/省略 (\d+) 字节/);
    expect(numMatch).not.toBeNull();
    expect(Number(numMatch![1])).toBeGreaterThan(0);
    // 算术闭环: head + tail + omitted = output.length (在数量级上, 标记本身的换行不计入)。
    const headLen = Math.floor(1200 * 0.3); // 360, 实现侧钉的初值
    const tailLen = 1200 - headLen;
    const omitted = Number(numMatch![1]);
    expect(headLen + tailLen + omitted).toBe(60000);
  });

  test('★ GWT-6: 失败节点正文不动 (INV-6) —— status=failed / 60000B, 仍是 (failed)', () => {
    // D-5: 失败节点的 `(failed)` 那条没有校准读数支持, 别搭车改。
    const plan: ConductorPlan = { name: 'p', nodes: { n: { goal: 'g', executor: 'leaf' } } };
    const results: Record<string, LeafResult> = {
      n: leaf({ id: 'n', status: 'failed', output: 'x'.repeat(60000) }),
    };
    const s = summarizeResults(plan, results, 1200);
    expect(bodyOf(s, 'n')).toBe('(failed)');
    // 即便 output 有 60000 字节, 也没被截断成头+省略+尾 —— 因为走的是 (failed) 分支。
    expect(s).not.toContain('省略');
  });

  test('★ GWT-7: 空输出零回归 (INV-7) —— output 缺席 / 空串, 与改动前逐字相同', () => {
    // 改动前同一函数对同一输入的输出: sectionLines 拼出 ['### n [done] — g', ''],
    // body = '' 整段就只是空行。
    const plan: ConductorPlan = { name: 'p', nodes: { n: { goal: 'g', executor: 'leaf' } } };

    const absent: Record<string, LeafResult> = { n: leaf({ id: 'n' }) }; // output 缺席 → undefined → ''
    const empty: Record<string, LeafResult> = { n: leaf({ id: 'n', output: '' }) };

    const expected = 'plan: p · 1 nodes\n\n### n [done] — g\n';
    expect(summarizeResults(plan, absent, 1200)).toBe(expected);
    expect(summarizeResults(plan, empty, 1200)).toBe(expected);
    expect(summarizeResults(plan, absent, 1200)).not.toContain('省略');
    expect(summarizeResults(plan, empty, 1200)).not.toContain('省略');
  });
});
