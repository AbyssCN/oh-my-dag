/**
 * **图外只读观察者** (D-Q) 的两个确定性 producer (`plan/observers.ts`) + 检测者协议 (`plan/detector.ts`)。
 *
 * 这三样都是"判据必须苛刻"的东西 —— 它们能铸毒票、能让环提前停, 判宽了的代价是
 * ① 白白重跑没问题的节点 ② 明明再来一轮就好却停下来等人。所以本文件的一半用例是**反例**:
 * 什么情况下**不许**报。
 */
import { describe, expect, test } from 'bun:test';
import { lintArtifactEdges, detectLoopNoProgress, artifactLintObservations } from '../../src/harness/plan/observers';

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
