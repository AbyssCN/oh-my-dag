/**
 * review/run-single 测试 —— 单 agent review 契约映射(REVIEW-1)。
 * 注入 fake agentRun(单 agent 输出)+ fake verifyFindings → 不碰 live 模型 / grep。
 */
import { describe, expect, test } from 'bun:test';
import { runReviewSingle } from './run-single';
import type { VerifiedFinding } from './verify';

const OUT = `${process.env.TMPDIR ?? '/tmp'}/omd-review-single-test-${process.pid}.md`;

const fakeVerify = async (dimTexts: { dimension: string; text: string }[]): Promise<VerifiedFinding[]> =>
  dimTexts.map((d) => ({
    severity: 'P0', file: 'x.ts', line: 12, claim: `from ${d.dimension}`, symbols: [], dimension: d.dimension,
    verdict: 'CONFIRMED', reason: 'fake',
  }));

const BASE = { diff: 'diff\n+const y=1;', scope: 'x.ts', gate: 'G2' as const, outPath: OUT };

describe('runReviewSingle 契约映射', () => {
  test('单 agent 输出 → findings + verifyFindings → verified + 落盘', async () => {
    let gotPrompt = '';
    const r = await runReviewSingle({
      ...BASE,
      deps: {
        env: {},
        agentRun: async ({ prompt }) => { gotPrompt = prompt; return { text: 'P0 x.ts:12 越权 bug' }; },
        verifyFindings: fakeVerify,
      },
    });
    // 单 agent → 一条 find 全文(非分解)
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]!.text).toContain('越权 bug');
    // prompt 综合了所有维度 + 代码库/oracle 纪律
    expect(gotPrompt).toContain('综合覆盖下列所有维度');
    expect(gotPrompt).toContain('bun -e'); // 强制 oracle 实测
    // verify 来自 verifyFindings(把单 agent 全文当 dimension='all' 喂)
    expect(r.verified).toHaveLength(1);
    expect(r.verified![0]!.dimension).toBe('all');
    expect(r.verified![0]!.verdict).toBe('CONFIRMED');
    // 契约
    expect(r.outPath).toBe(OUT);
    expect(await Bun.file(OUT).exists()).toBe(true);
    expect(r.model).toBeTruthy();
  });

  test('verify=false → 不产 verified', async () => {
    const r = await runReviewSingle({
      ...BASE, verify: false,
      deps: { env: {}, agentRun: async () => ({ text: 'x' }), verifyFindings: fakeVerify },
    });
    expect(r.verified).toBeUndefined();
  });

  test('spec ∈ dims 无 SDD → specSkipped(不炸)', async () => {
    const r = await runReviewSingle({
      ...BASE, gate: 'G3',
      deps: { env: {}, findSdd: () => null, agentRun: async () => ({ text: 'x' }), verifyFindings: fakeVerify },
    });
    expect(r.specSkipped).toBe(true);
  });
});
