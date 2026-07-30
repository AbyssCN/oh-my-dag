/**
 * **图外只读观察者** (D-Q) 的两个确定性 producer (`plan/observers.ts`) + 检测者协议 (`plan/detector.ts`)。
 *
 * 这三样都是"判据必须苛刻"的东西 —— 它们能铸毒票、能让环提前停, 判宽了的代价是
 * ① 白白重跑没问题的节点 ② 明明再来一轮就好却停下来等人。所以本文件的一半用例是**反例**:
 * 什么情况下**不许**报。
 */
import { describe, expect, test } from 'bun:test';
import { lintArtifactEdges, detectLoopNoProgress, artifactLintObservations } from '../../src/harness/plan/observers';
import { parseDetectorVerdict } from '../../src/harness/plan/detector';

const ROOT = '/repo';

describe('D-12 制品边 lint — 未声明的制品依赖 (INV-P2-4)', () => {
  test('B 读了 A 写的文件而图上无边 → 报, 且**指名两个节点**', () => {
    const f = lintArtifactEdges(
      { A: {}, B: {} },
      { A: { filesTouched: ['out/spec.md'] }, B: { filesRead: ['out/spec.md'] } },
      { root: ROOT },
    );
    expect(f).toEqual([{ reader: 'B', writer: 'A', path: '/repo/out/spec.md' }]);
    // GWT 要的是"指名两个节点" —— 观察条目里两个 id 都在。
    const obs = artifactLintObservations(f);
    expect(obs[0]!.nodes).toEqual(['B', 'A']);
    expect(obs[0]!.message).toContain('A');
    expect(obs[0]!.message).toContain('B');
  });

  test('图上**有**边 (直接依赖) → 不报', () => {
    const f = lintArtifactEdges(
      { A: {}, B: { depends_on: ['A'] } },
      { A: { filesTouched: ['out/spec.md'] }, B: { filesRead: ['out/spec.md'] } },
      { root: ROOT },
    );
    expect(f).toEqual([]);
  });

  test('祖先 (间接依赖) 也算已声明 → 不报', () => {
    const f = lintArtifactEdges(
      { A: {}, M: { depends_on: ['A'] }, B: { depends_on: ['M'] } },
      { A: { filesTouched: ['x.ts'] }, B: { filesRead: ['x.ts'] } },
      { root: ROOT },
    );
    expect(f).toEqual([]);
  });

  test('自己写自己读 → 不报 (没有边可言)', () => {
    const f = lintArtifactEdges({ A: {} }, { A: { filesTouched: ['x.ts'], filesRead: ['x.ts'] } }, { root: ROOT });
    expect(f).toEqual([]);
  });

  test('绝对路径与相对路径指同一个文件 → 认得出来 (归一按 root)', () => {
    const f = lintArtifactEdges(
      { A: {}, B: {} },
      { A: { filesTouched: ['/repo/x.ts'] }, B: { filesRead: ['./x.ts'] } },
      { root: ROOT },
    );
    expect(f).toHaveLength(1);
  });

  test('父节点冒泡的产物不算第二个写方 → 不报 (2026-07-30 实测揪出的误报)', () => {
    // conductor/map 父节点的 filesTouched 是**子树并集** —— 它自己没写。拿子节点的读去配父亲的
    // 聚合写等于把同一次写数两遍, 而且报出来的边根本修不了 (子依赖父 = 环)。
    const f = lintArtifactEdges(
      { C: {}, 'C::w': {}, 'C::r': {} },
      {
        C: { filesTouched: ['art.txt'] }, // 并集冒泡
        'C::w': { filesTouched: ['art.txt'] },
        'C::r': { filesRead: ['art.txt'] },
      },
      { root: ROOT },
    );
    expect(f).toEqual([{ reader: 'C::r', writer: 'C::w', path: '/repo/art.txt' }]);
  });

  test('读的文件没有任何节点写过 (仓里本来就有的) → 不报', () => {
    const f = lintArtifactEdges({ A: {}, B: {} }, { A: {}, B: { filesRead: ['src/existing.ts'] } }, { root: ROOT });
    expect(f).toEqual([]);
  });

  test('确定性: 同一份输入两次跑给出同一份报告 (观察面不许有并发时序的痕迹)', () => {
    const nodes = { A: {}, B: {}, C: {} };
    const results = {
      A: { filesTouched: ['a.ts'] },
      B: { filesTouched: ['b.ts'] },
      C: { filesRead: ['b.ts', 'a.ts'] },
    };
    expect(lintArtifactEdges(nodes, results, { root: ROOT })).toEqual(lintArtifactEdges(nodes, results, { root: ROOT }));
    expect(lintArtifactEdges(nodes, results, { root: ROOT }).map((f) => f.path)).toEqual(['/repo/a.ts', '/repo/b.ts']);
  });
});

describe('D-Q 环空转检测 — BLOCKED 的判据', () => {
  const shape = (childIds: string[], rejected: string[]) => ({ childIds, rejected });

  test('第一轮没有比对对象 → 不判 (prev=null)', () => {
    expect(detectLoopNoProgress(null, shape(['a'], ['a']))).toBeNull();
  });

  test('子图**完全相同** + 拒的是同一批 → 判空转', () => {
    const o = detectLoopNoProgress(shape(['a', 'b'], ['b']), shape(['b', 'a'], ['b']));
    expect(o?.kind).toBe('loop-no-progress');
    expect(o?.nodes).toEqual(['b']);
  });

  test('重展开画出了**不一样的**子图 → 不判 (环正在起作用)', () => {
    expect(detectLoopNoProgress(shape(['a'], ['a']), shape(['a', 'c'], ['a']))).toBeNull();
  });

  test('同一张子图但拒的**换了一批** → 不判 (信息在变)', () => {
    expect(detectLoopNoProgress(shape(['a', 'b'], ['a']), shape(['a', 'b'], ['b']))).toBeNull();
  });

  test('一个都没被点名 → 不判 —— 那是 judge 漏填票, 不是空转 (重画仍可能有用)', () => {
    expect(detectLoopNoProgress(shape(['a'], []), shape(['a'], []))).toBeNull();
  });
});

describe('D-Q 检测者输出协议', () => {
  test('REJECT/BLOCKED 行被读成裁决, 正文其余部分不影响', () => {
    const v = parseDetectorVerdict(
      ['分析: 两份产出对不上。', 'REJECT: c::a1', '这里随便写点别的', 'BLOCKED: 目标本身自相矛盾, 需要 owner 拍板'].join('\n'),
      ['c::a1', 'c::b2'],
    );
    expect(v.rejected).toEqual(['c::a1']);
    expect(v.blocked).toBe('目标本身自相矛盾, 需要 owner 拍板');
  });

  test('点名图里没有的 id → 幽灵 (留痕不入毒集)', () => {
    const v = parseDetectorVerdict('REJECT: send-report\nREJECT: c::a1', ['c::a1']);
    expect(v.rejected).toEqual(['c::a1']);
    expect(v.ghosts).toEqual(['send-report']);
  });

  test('没有协议行 = 没有裁决 (不是全批准也不是全拒绝)', () => {
    const v = parseDetectorVerdict('看着都挺好的, 我没意见。', ['c::a1']);
    expect(v.rejected).toEqual([]);
    expect(v.blocked).toBeUndefined();
  });

  test('正文里出现小写 reject: 之类的话 → 不误命中 (关键词大写 + 行首)', () => {
    const v = parseDetectorVerdict('我 reject: 这个说法\n下面 REJECT 不带冒号也不算', ['c::a1']);
    expect(v.rejected).toEqual([]);
    expect(v.ghosts).toEqual([]);
  });

  test('多条 BLOCKED → 取第一条 (同一件事的不同说法)', () => {
    const v = parseDetectorVerdict('BLOCKED: 第一条\nBLOCKED: 第二条', []);
    expect(v.blocked).toBe('第一条');
  });

  test('同一个 id 点两次 → 去重', () => {
    const v = parseDetectorVerdict('REJECT: x\nREJECT: x', ['x']);
    expect(v.rejected).toEqual(['x']);
  });
});
