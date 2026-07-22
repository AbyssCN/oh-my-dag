/**
 * review/run-dag 测试 —— DAG 结果 → 冻结契约 RunReviewResult 映射(REVIEW-1/3)。
 * 注入 fake runDag(不碰 live 模型 / executor-dag);验 findings 逐维度、verified 从 map JSON 解析、
 * verdict 词映射(REJECTED→REFUTED, UNCLEAR→UNVERIFIED)、specSkipped、outPath 落盘。
 */
import { describe, expect, test } from 'bun:test';
import { runReviewDag } from './run-dag';
import { VERIFY_NODE_ID, JUDGE_NODE_ID } from './review-plan';
import type { ExecutorDagResult } from '../executor-dag-types';

const OUT = `${process.env.TMPDIR ?? '/tmp'}/omd-review-dag-test-${process.pid}.md`;

/** 造 fake DAG 结果: find 节点文本 + verify map JSON(childResults)+ judge。 */
function fakeResult(opts: {
  findText?: Record<string, string>;
  verifyChildren?: { key: string; item: Record<string, unknown>; output: string }[];
  judge?: string;
}): ExecutorDagResult {
  const results: Record<string, unknown> = {};
  for (const [id, text] of Object.entries(opts.findText ?? {})) {
    results[id] = { id, status: 'done', kind: 'agent', output: text, deps: [], usage: {} };
  }
  results[VERIFY_NODE_ID] = { id: VERIFY_NODE_ID, status: 'done', kind: 'map', output: JSON.stringify(opts.verifyChildren ?? []), deps: [], usage: {} };
  results[JUDGE_NODE_ID] = { id: JUDGE_NODE_ID, status: 'done', kind: 'inproc', output: opts.judge ?? '收敛清单', deps: [], usage: {} };
  return { results, plan: { name: 'dag-review', nodes: {} }, sessionId: 's', levels: [], usage: {} } as unknown as ExecutorDagResult;
}

const BASE = {
  diff: 'diff --git a/x.ts b/x.ts\n+const y=1;',
  scope: 'x.ts',
  gate: 'G2' as const,
  outPath: OUT,
};

describe('runReviewDag 契约映射', () => {
  test('findings 逐维度 + verified 从 map JSON 解析 + verdict 词映射', async () => {
    const r = await runReviewDag({
      ...BASE,
      deps: {
        env: {},
        runDag: async () =>
          fakeResult({
            findText: {
              find_correctness: 'x.ts:2 y 未使用 (P1)',
              find_security: '无 P0/P1',
              find_boundary: '无',
            },
            verifyChildren: [
              { key: 'x-unused', item: { id: 'x-unused', severity: 'P1', file: 'x.ts', line: 2, claim: 'y 未使用', symbols: ['y'], dimension: 'correctness' }, output: 'VERDICT: CONFIRMED\ny 确实无引用' },
              { key: 'x-inj', item: { id: 'x-inj', severity: 'P0', file: 'x.ts', claim: '注入', symbols: [], dimension: 'security' }, output: 'VERDICT: REJECTED\n参数是常量' },
              { key: 'x-unc', item: { id: 'x-unc', severity: 'P1', file: 'x.ts', claim: '竞态?', symbols: [], dimension: 'boundary' }, output: 'VERDICT: UNCLEAR\n证据不足' },
            ],
          }),
      },
    });
    // findings: 3 维度各一条(G2 = correctness/security/boundary)
    expect(r.findings.map((f) => f.dimension)).toEqual(['correctness', 'security', 'boundary']);
    expect(r.findings[0]!.text).toContain('y 未使用');
    // verified: map JSON → 3 条,verdict 词映射
    expect(r.verified).toHaveLength(3);
    const byId = Object.fromEntries(r.verified!.map((v) => [v.claim, v.verdict]));
    expect(byId['y 未使用']).toBe('CONFIRMED');
    expect(byId['注入']).toBe('REFUTED'); // REJECTED → REFUTED
    expect(byId['竞态?']).toBe('UNVERIFIED'); // UNCLEAR → UNVERIFIED(fail-open)
    // 结构化字段从 item 带回
    const p0 = r.verified!.find((v) => v.severity === 'P0')!;
    expect(p0.file).toBe('x.ts');
    expect(p0.dimension).toBe('security');
    // 契约: outPath 落盘 + model
    expect(r.outPath).toBe(OUT);
    expect(await Bun.file(OUT).exists()).toBe(true);
    expect(r.model).toBeTruthy();
  });

  test('verify=false → 不产 verified(契约同 runReview)', async () => {
    const r = await runReviewDag({
      ...BASE, verify: false,
      deps: { env: {}, runDag: async () => fakeResult({ findText: { find_correctness: 'a', find_security: 'b', find_boundary: 'c' } }) },
    });
    expect(r.verified).toBeUndefined();
  });

  test('spec ∈ dims 但无 SDD → specSkipped + findings 含跳过条', async () => {
    const r = await runReviewDag({
      ...BASE, gate: 'G3',
      deps: {
        env: {},
        findSdd: () => null, // 无 SDD
        runDag: async () => fakeResult({ findText: { find_correctness: 'a', find_security: 'b', find_boundary: 'c', find_contract: 'd' } }),
      },
    });
    expect(r.specSkipped).toBe(true);
    const spec = r.findings.find((f) => f.dimension === 'spec')!;
    expect(spec.skipped).toBe(true);
  });

  test('map output 非法 JSON → verified 空(不炸)', async () => {
    const r = await runReviewDag({
      ...BASE,
      deps: {
        env: {},
        runDag: async () => {
          const res = fakeResult({ findText: { find_correctness: 'a', find_security: 'b', find_boundary: 'c' } });
          (res.results[VERIFY_NODE_ID] as { output: string }).output = '不是 JSON';
          return res;
        },
      },
    });
    expect(r.verified).toEqual([]);
  });
});
