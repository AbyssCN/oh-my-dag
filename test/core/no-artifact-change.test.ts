/**
 * 「产物没变」检测器 (2026-07-31, G5 正解)。
 *
 * ## 它绕的是什么
 *
 * D-AD 的诊断: 我们**所有**的"卡住"检测器都键在「agent 重复了自己」上 —— 而 LLM conductor
 * 每轮重画, 从不逐字重复自己。于是那几条在 live 上恒 0, 再跑多少次都是 0。
 * 这一条改键在**盘上有没有位移** —— 产物是 agent 不重新生成的东西, 是这个环里唯一稳定的信号。
 *
 * ## 这套网的重心在**误报**那一侧
 *
 * 一个只报不拦的检测器, 漏报的代价是"少给一句提示", 误报的代价是"给下一轮灌一句错的话,
 * 把它从对的方向支开"。所以下面**只有两条**在测它会响, 其余全在测它**不该响的时候真不响**:
 * 纯分析轮 · 读不到的文件 · 路径集变了 · 内容变了。
 *
 * ## 2026-08-06: 判据从二态改成三态, 而这套用例**正好测不出那个洞**
 *
 * 上面那句"不响"底下压着两件事: 「判了, 有位移」与「**根本判不了**」。旧接口两者都返 `null`,
 * 于是分母在返回值里就不存在 —— 读数板 ⑧ 段只好拿运行次数当分母, 把 53 跑 0 命中读成
 * "活体基率 ≈ 0"。而这套用例每一条都只断言"响不响", 一条都没问过"这次判得了吗", 所以它全绿。
 * 新增的 `unobserved` 那一组就是在补这一格。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyArtifactMove, type RoundArtifacts } from '../../src/harness/plan/observers';
import { type GenerateFn } from '../../src/harness/dag/engine';
import { runExecutorDag } from '../helpers/legacy-plan-entry';

const A = (hashes: Record<string, string | null>): RoundArtifacts => ({ hashes });
/** 旧接口的等价物 (命中→观察条目, 其余→null) —— 让"响不响"那一层的用例保持原样可读。 */
const detect = (prev: RoundArtifacts | null, cur: RoundArtifacts) => {
  const v = classifyArtifactMove(prev, cur);
  return v.kind === 'no-move' ? v.observation : null;
};

describe('产物没变 · 判据本身', () => {
  test('路径集与 hash 都相同 → 命中 (盘上零位移)', () => {
    const obs = detect(A({ 'a.md': 'h1', 'b.md': 'h2' }), A({ 'a.md': 'h1', 'b.md': 'h2' }));
    expect(obs?.kind).toBe('loop-no-artifact-change');
  });

  test('任一文件内容变了 → 不响 (有位移就是有位移)', () => {
    expect(detect(A({ 'a.md': 'h1' }), A({ 'a.md': 'h2' }))).toBeNull();
  });

  test('路径集变了 → 不响', () => {
    expect(detect(A({ 'a.md': 'h1' }), A({ 'a.md': 'h1', 'c.md': 'h3' }))).toBeNull();
  });

  test('第一轮没有比对对象 → 不响', () => {
    expect(detect(null, A({ 'a.md': 'h1' }))).toBeNull();
  });
});

describe('★ 产物没变 · 三态: 「判了没位移」/「判了有位移」/「判不了」', () => {
  // 证伪: 把 classifyArtifactMove 里那三条 `unobserved` 出口改回 `{ kind: 'moved' }`,
  // 这一组当场红 —— 而上面"响不响"那一组仍然全绿。分母的洞就长这样。
  test('两侧都可比 → **进分母**, 不管判成有位移还是没位移', () => {
    expect(classifyArtifactMove(A({ 'a.md': 'h1' }), A({ 'a.md': 'h1' })).kind).toBe('no-move');
    expect(classifyArtifactMove(A({ 'a.md': 'h1' }), A({ 'a.md': 'h2' })).kind).toBe('moved');
    expect(classifyArtifactMove(A({ 'a.md': 'h1' }), A({ 'b.md': 'h1' })).kind).toBe('moved');
  });

  test('没有上一轮 → `first-round`: 这**连一次跨轮都不算**, 不进 transitions', () => {
    expect(classifyArtifactMove(null, A({ 'a.md': 'h1' }))).toEqual({ kind: 'unobserved', why: 'first-round' });
  });

  test('产物信号为空 → `no-population`: 轮转发生了, 但**判不了** (不进基率分母)', () => {
    expect(classifyArtifactMove(A({}), A({}))).toEqual({ kind: 'unobserved', why: 'no-population' });
    expect(classifyArtifactMove(A({ 'a.md': 'h1' }), A({}))).toEqual({ kind: 'unobserved', why: 'no-population' });
  });

  test('有文件读不到 → `unreadable`: 同样是判不了, 但成因与上一条不同', () => {
    // 分开记不是洁癖: 前者要问"这个环为什么不产文件", 后者要问"产物根是不是拿错了"。
    expect(classifyArtifactMove(A({ 'a.md': null }), A({ 'a.md': 'h1' }))).toEqual({ kind: 'unobserved', why: 'unreadable' });
    // ★ 这一行是改三态时**当场抓到的一个真洞**: 旧判据写成 `p in prev ? prev[p] : cur[p]`,
    //   于是路径在上一轮出现过时, **本轮那侧的 null 永远看不到** —— 会掉进"hash 不等 → 有位移"。
    //   旧接口下两条路都返 null(不报), 用例全绿; 三态下它们的结论相反, 才露出来。
    //   证伪: 把 ② 那条改回 `p in prev.hashes ? ...` → 这一行当场红成 `{ kind: 'moved' }`。
    expect(classifyArtifactMove(A({ 'a.md': 'h1' }), A({ 'a.md': null }))).toEqual({ kind: 'unobserved', why: 'unreadable' });
  });
});

describe('产物没变 · 误报守卫 (这套网的重心)', () => {
  test('★ 纯分析轮 (一个文件都没碰) → 不响 —— 那是 Unobserved, 不是"没位移"', () => {
    // 少了这条闸, 所有非文件型的目标会被一路误报: 它们**按设计**就不产文件。
    expect(detect(A({}), A({}))).toBeNull();
    expect(detect(A({ 'a.md': 'h1' }), A({}))).toBeNull();
    expect(detect(A({}), A({ 'a.md': 'h1' }))).toBeNull();
  });

  test('★ 有文件读不到 (hash=null) → 不响 —— 量不到不是"没变"的证据', () => {
    // fail-open 方向: 宁可不报。把 null 当"没变"就是拿缺失冒充证据。
    expect(detect(A({ 'a.md': null }), A({ 'a.md': null }))).toBeNull();
    expect(detect(A({ 'a.md': 'h1' }), A({ 'a.md': null }))).toBeNull();
    expect(detect(A({ 'a.md': null }), A({ 'a.md': 'h1' }))).toBeNull();
  });

  test('两个 null 的 hash **不算相等** —— 别让"都读不到"凑成"都没变"', () => {
    const obs = detect(A({ 'a.md': null, 'b.md': 'h2' }), A({ 'a.md': null, 'b.md': 'h2' }));
    expect(obs).toBeNull(); // 哪怕另一个文件确实没变, 只要有一个量不到就整轮不判
  });
});

describe('产物没变 · 消息要能让下一轮做点什么 (A5 判据)', () => {
  test('不播报状态, 给具体做法 + 点破最可能的无效功', () => {
    const msg = detect(A({ 'a.md': 'h1' }), A({ 'a.md': 'h1' }))!.message;
    expect(msg).toContain('盘上没有位移');
    expect(msg).toContain('换个名字重排'); // 点破它最可能正在做的无效功
    expect(msg).toContain('改**内容**而不是改结构'); // 做得了的事
    expect(msg).toContain('能判对错的验证步骤'); // 若它判断产物已对, 也有一条出路
  });
});
