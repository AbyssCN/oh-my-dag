/**
 * verbatim-seen-view —— 观察者判节点真实所见 (D-3, 2026-08-25)。
 *
 * 反向自检: `detectVerbatimDrop` 的判据本体与 `gateVerbatimRed` 谓词在
 * `src/harness/plan/observers.ts` 不动; 本文件只验**接线对** (faninView / depOutputs
 * → 观察者入参): 节点没见过的引文不报 (GWT-4), 节点看过的引文没留真报 (GWT-5),
 * 没摘要时观察者入参 = 原文 (GWT-7)。
 *
 * 接缝源头 = `seenUpstreamOutputs` (`src/harness/dag/engine.ts`), 模块级 + 纯函数,
 * 单测直接喂最小 fixture, 不跑整张图。
 */
import { describe, expect, test } from 'bun:test';
import { seenUpstreamOutputs } from './engine';
import type { ConductorPlan } from '../conductor-plan';
import { detectVerbatimDrop } from '../plan/observers';

// 三段各 ≥24 字符的逐字引文 —— 共用一份, 多处复用避免字面量漂移。
const SPAN_A = '这是一段来自上游 A 的逐字引文,长到不会被当作术语剔除';
const SPAN_B = '这是来自上游 B 的一段完整原文,逐字保留供下游核对出处';
const SPAN_C = '上游 C 的第三段引文,长到足以让观察者把它当证据来判';

// 简易 plan 构造器 —— 只造 `nodes.<id>.depends_on`, 其它字段本测试不读。
const plan = (graph: Record<string, string[]>): Pick<ConductorPlan, 'nodes'> => ({
  nodes: Object.fromEntries(
    Object.entries(graph).map(([id, deps]) => [id, { depends_on: deps }]),
  ) as ConductorPlan['nodes'],
});

// capFanin 短输入(< 23_500)走恒等 —— 测试 fixture 全在此范围内, 直接用 `(_, x) => x`。
const id = (_d: string, body: string): string => body;

// 检 detectVerbatimDrop 的「输入形」: 不报 = null, 报 = { kind: 'verbatim-drop', … }
// 不解包全文 message, 只看是否报告。
const dropReport = (
  inputs: readonly string[],
  ownOutput: string,
): { kind: string } | null => detectVerbatimDrop('N', inputs, ownOutput);

describe('seenUpstreamOutputs —— D-3 接线 (节点真实所见喂观察者)', () => {
  test('GWT-7 零回归: 无 faninView 条目 → 返回值与原 depOutputs 链逐字相等', () => {
    const p = plan({ N: ['A', 'B'] });
    const depOut = { A: `producer A body`, B: `producer B body` };
    const fanView: Record<string, string> = {};

    const got = seenUpstreamOutputs('N', p, depOut, fanView, id);

    // 顺序 = depends_on 顺序; 内容 = capFanin(d, depOutputs[d] ?? raw) —— 短输入 capFanin 恒等,
    // 所以与直接 .map(d => depOutputs[d]).filter(...) 的旧行逐字相等。
    expect(got).toEqual([`producer A body`, `producer B body`]);
  });

  test('faninView 命中: 取 faninView[d] 而不是 depOutputs[d]', () => {
    const p = plan({ N: ['A'] });
    const depOut = { A: `producer A original` };
    const fanView = { A: `producer A SUMMARY WITHOUT QUOTES` };

    const got = seenUpstreamOutputs('N', p, depOut, fanView, id);

    expect(got).toEqual([`producer A SUMMARY WITHOUT QUOTES`]);
  });

  test('faninView 命中但值为空字符串 → 不进 (与原过滤「非 string/空」逐字一致)', () => {
    const p = plan({ N: ['A'] });
    const depOut = { A: `producer A original` };
    const fanView: Record<string, string> = { A: '' };

    const got = seenUpstreamOutputs('N', p, depOut, fanView, id);

    // 空字符串 fanView 命中, 但 raw 非空 + ?? 兜底走 raw (行为不变)。
    expect(got).toEqual([]);
  });

  test('depOutputs 缺位 (undefined / 空串) → 跳过, 不污染 upstream 列表', () => {
    const p = plan({ N: ['A', 'MISSING', 'B'] });
    const depOut = { A: `producer A body`, B: `producer B body` };

    const got = seenUpstreamOutputs('N', p, depOut, {}, id);

    expect(got).toEqual([`producer A body`, `producer B body`]);
  });

  test('capFanin 透传: 调用方传的 capFanin 与上游 body 同时进, 出即调用方预期的', () => {
    const p = plan({ N: ['A'] });
    const depOut = { A: 'long enough producer A body — capFanin can trim' };
    // 自定义 capFanin: 给 dep id 加 [d] 前缀 ── 验证上游确实经过它。
    const wrap = (d: string, body: string): string => `[${d}] ${body}`;

    const got = seenUpstreamOutputs('N', p, depOut, {}, wrap);

    expect(got).toEqual([`[A] long enough producer A body — capFanin can trim`]);
  });
});

describe('detectVerbatimDrop —— 接线后果 (判词说真话)', () => {
  // 构造 N 的 3 个上游, 各塞 1 段 ≥24 字符引文 —— 满足 detectVerbatimDrop 的 ≥3 spans 触线。
  const upstreamWithAllSpans = [
    `preface A says: "${SPAN_A}" trailing`,
    `preface B says: "${SPAN_B}" trailing`,
    `preface C says: "${SPAN_C}" trailing`,
  ];

  test('GWT-4 不冤枉: faninView 不带引文 + 节点输出无引文 → 不报 verbatim-drop', () => {
    // 原始上游 3 段引文都在 (若观察者被喂原始, 会报 drop)。
    // 但 faninView 把它们都脱掉了 → 节点从未见过 → 接线喂去摘要视图 → 不该报。
    const seenByNode = upstreamWithAllSpans.map((t, i) => `summary node ${i}`);
    const ownOutput = `本节点输出,不含任何逐字引文段`;

    const report = dropReport(seenByNode, ownOutput);

    expect(report).toBeNull();
  });

  test('GWT-5 真报: faninView 带引文 + 节点输出全脱 → 报 verbatim-drop', () => {
    // 切片 1 (D-2) 让 faninView 自带引文附录 → 节点收到含原文的视图 → 真有逐字保留义务。
    // 此时节点输出把引文全脱掉 → 应报。
    const ownOutput = `本节点完全改写,一段引文都没留,全用自己的话`;

    const report = dropReport(upstreamWithAllSpans, ownOutput);

    expect(report).not.toBeNull();
    expect(report!.kind).toBe('verbatim-drop');
  });

  test('GWT-7 零回归: 未触发摘要时, 观察者入参 = 原文 (无 faninView 覆盖)', () => {
    // 上游带 3 段引文, 节点输出脱光 → 与 D-3 之前的观察者行为逐字一致 → 报。
    const ownOutput = `节点输出不含任何上游原文片段`;

    const report = dropReport(upstreamWithAllSpans, ownOutput);

    expect(report).not.toBeNull();
    expect(report!.kind).toBe('verbatim-drop');
  });
});

describe('seenUpstreamOutputs —— 引擎接线位引用 (D-3 oracle 锚)', () => {
  // 这条测试在片 2 已合入前必然红, 因为 `seenUpstreamOutputs` 在 engine.ts 里
  // 0 命中。合入后绿 —— oracle 钉死「两处都接到了 helper, 没漂」。
  test('两处 detectVerbatimDrop 调用点上都用 seenUpstreamOutputs 喂 upstream (引擎源码字面)', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('./engine.ts', import.meta.url), 'utf8');

    // D-3 接手前: 两处都写的是 `depends_on.map(depOutputs[d]).filter(...)`。
    // 接手后: 两处都该拿到 `const ups = seenUpstreamOutputs(id, plan!, depOutputs, faninView, capFanin);`
    // 数这两条赋值式在 engine.ts 里出现的次数 (module 导出版本不计) —— 至少 = 2
    // (外层 settle + 子节点旁路)。
    const callRe = /=\s*seenUpstreamOutputs\(/g;
    const helperAssigns = src.match(callRe) ?? [];
    expect(helperAssigns.length).toBeGreaterThanOrEqual(1) // 2026-09-04: 内环那处随 v1 退役, 只剩平铺路径一处;
  });

  test('detectVerbatimDrop 不会被直接喂手写 depOutputs 链 (反锚: 旧链式不得残留)', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('./engine.ts', import.meta.url), 'utf8');

    // 把看到原始 depOutputs 喂给 detectVerbatimDrop 的旧写法置 0 ——
    // 任何一处残留 = 通道断一条, 形式 = `detectVerbatimDrop(` 紧邻
    // `(plan!.nodes[X]?.depends_on ?? []).map(...)`。
    // 用宽 neg-look-around 避免在 comment / string 里误报 (本文件无 detectVerbatimDrop 字面量)。
    const oldChainRe = /detectVerbatimDrop\([^)]*depends_on\s*\?\?\s*\[\][^)]*\)\s*\.map\(/;
    expect(src.match(oldChainRe)).toBeNull();
  });
});
