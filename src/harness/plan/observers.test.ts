/**
 * D-12 / INV-P2-4 制品边 lint —— 判据 + **建议的可执行性** (2026-07-30 补网)。
 *
 * 第二段是 live 挖出来的, 也是这份测试真正的理由: lint 报得对不等于**按它做得了事**。
 * 那条建议的唯一读者是下一轮重画的 conductor, 它写的是自己起的可读名; 拿运行期内容寻址 id
 * 去点名, 它既没见过也造不出 —— 一条"真阳性但不可执行"的建议, 在读数上与修好了长得一样
 * (下一轮照样少画那条边, 而 lint 照样报, 谁也不会注意到建议本身是空的)。
 */
import { describe, expect, test } from 'bun:test';
import { lintArtifactEdges, artifactLintObservations } from './observers';
import type { LintNode, LintResult } from './observers';

const ROOT = '/repo';
const lint = (
  nodes: Record<string, LintNode>,
  results: Record<string, LintResult>,
): ReturnType<typeof lintArtifactEdges> => lintArtifactEdges(nodes, results, { root: ROOT });

describe('D-12 lint 判据 —— 图上没有的那条边', () => {
  test('B 读了 A 写的文件而图上无边 → 报', () => {
    const f = lint(
      { A: {}, B: {} },
      { A: { filesTouched: ['out/x.txt'] }, B: { filesRead: ['out/x.txt'] } },
    );
    expect(f).toEqual([{ reader: 'B', writer: 'A', path: '/repo/out/x.txt' }]);
  });

  test('边已经画了 → 不报 (含**间接**祖先: 闭包不是只看直接依赖)', () => {
    expect(lint(
      { A: {}, M: { depends_on: ['A'] }, B: { depends_on: ['M'] } },
      { A: { filesTouched: ['out/x.txt'] }, B: { filesRead: ['out/x.txt'] } },
    )).toEqual([]);
  });

  test('自己写自己读 → 不报 (没有边可言)', () => {
    expect(lint({ A: {} }, { A: { filesTouched: ['out/x.txt'], filesRead: ['out/x.txt'] } })).toEqual([]);
  });

  test('父子不算一条边 —— 父节点的 filesTouched 是子树并集, 报出来也修不了 (那是环)', () => {
    expect(lint(
      { P: {}, 'P::a': {}, 'P::b': {} },
      {
        P: { filesTouched: ['out/x.txt'] }, // 聚合写: 其实是 P::a 写的
        'P::b': { filesRead: ['out/x.txt'] },
      },
    )).toEqual([]);
  });

  test('相对/绝对路径归一到同一个制品 (否则这条 lint 基本不会命中)', () => {
    expect(lint(
      { A: {}, B: {} },
      { A: { filesTouched: ['./out/x.txt'] }, B: { filesRead: ['/repo/out/x.txt'] } },
    )).toHaveLength(1);
  });

  test('输出是确定序 (同一张图两次跑给同一份报告)', () => {
    const nodes = { A: {}, B: {}, C: {} };
    const results = {
      A: { filesTouched: ['out/x.txt'] },
      B: { filesTouched: ['out/y.txt'] },
      C: { filesRead: ['out/y.txt', 'out/x.txt'] },
    };
    expect(lint(nodes, results)).toEqual(lint(nodes, results));
    expect(lint(nodes, results).map((f) => f.writer)).toEqual(['A', 'B']);
  });
});

describe('D-12 建议的可执行性 —— 说给下一轮 conductor 听的话', () => {
  const findings = [{ reader: 'execute::1dsso', writer: 'execute::1errm', path: '/repo/docs/from-faq.md' }];

  test('给了可读名 → 用可读名, 且**不出现**内容寻址 id (它认不出那个)', () => {
    const [obs] = artifactLintObservations(
      findings,
      new Map([['execute::1dsso', 'conflict-record'], ['execute::1errm', 'summarize-faq']]),
    );
    expect(obs!.message).toContain('"conflict-record"');
    expect(obs!.message).toContain('"summarize-faq"');
    expect(obs!.message).not.toContain('execute::1dsso');
  });

  test('建议是**通则**不是点名 —— 下一轮的节点名可能又变了, 通则照做得了', () => {
    const [obs] = artifactLintObservations(findings, new Map([['execute::1dsso', 'conflict-record']]));
    expect(obs!.message).toContain('depends_on');
    expect(obs!.message).not.toMatch(/补上\s*\[/);
  });

  test('id 仍留在 nodes 字段供审计 (人话换名字, 事实不换)', () => {
    const [obs] = artifactLintObservations(findings, new Map([['execute::1dsso', 'conflict-record']]));
    expect(obs!.nodes).toEqual(['execute::1dsso', 'execute::1errm']);
  });

  test('没有可读名 (手写 plan / map 子节点) → 退回 id, 不是崩也不是空', () => {
    const [obs] = artifactLintObservations(findings);
    expect(obs!.message).toContain('[execute::1dsso]');
  });
});
