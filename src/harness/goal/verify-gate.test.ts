/**
 * src/harness/goal/verify-gate.test —— D4.1 切片 3 冻结判据 (GWT-4a / GWT-4b / GWT-5)
 *
 *   GWT-4a (INV-4) 假 leaf 恒判 refuted + params.gate=true → invocation.run() 抛错,
 *               错误文本含 claim 前 20 字
 *   GWT-4b (INV-4) 同样输入但 params 缺 gate → status='done', output 含 '"survived":false'
 *   GWT-5  (INV-5) verify 词链 → compileChain 产物序列化含 '"primitive":"verify"',
 *               该节点 params.gate === true, depends_on 仍含前站 id (文本绑定未丢)
 *
 * 反向自检:闸摘任一 → test 当场由绿转红 (sanity 见下注释锚)。
 */
import { describe, test, expect } from 'bun:test';
import { compileChain } from './stage-chain';
import type { StageChain } from './stage-chain';
import { compilePrimitive, type PrimitiveCtx } from '../primitive-registry';
import type { ModelUsage } from '../../model/types';

// 假 leaf:每次调用恒吐同一条 JSON, 测 verify 在 adversarialVerify 内被解析为 refuted。
const REFUTED_TEXT = '{"refuted": true, "reason": "反例存在"}';

function makeStubCtx(): { ctx: PrimitiveCtx; calls: { leafCalls: number } } {
  const calls = { leafCalls: 0 };
  const ctx: PrimitiveCtx = {
    leaf: async () => {
      calls.leafCalls++;
      return REFUTED_TEXT;
    },
    usage: () => ({ in: 0, out: 0 }) satisfies ModelUsage,
  };
  return { ctx, calls };
}

// ── GWT-4a (INV-4): gate=true + refuted → invocation.run() 抛错, 错误文本含 claim 前 20 字 ─

describe('GWT-4a INV-4 verify gate=true + 假 leaf 恒判 refuted → run() 抛错, 错误文本含 claim 片段', () => {
  // 锚:claim 文本故意 ≥20 字并混入 ASCII 与中文, 保证 slice(0,20) 锚定的稳定性。
  const CLAIM = 'verify-gate-GWT-4a: 关键断言必须在 refuted 时抛错并把原文带回来——不要静默';

  test('compilePrimitive(verify, {claim, gate:true}) 编译成功', () => {
    const { ctx } = makeStubCtx();
    const compiled = compilePrimitive('verify', { claim: CLAIM, gate: true }, ctx);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) throw new Error(compiled.error);
  });

  test('invocation.run() throws with claim first 20 chars included', async () => {
    const { ctx } = makeStubCtx();
    const compiled = compilePrimitive('verify', { claim: CLAIM, gate: true }, ctx);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) throw new Error(compiled.error);
    // 锚:抛错 → 经 engine.runPrimitiveNode catch 包成 [primitive 失败: msg], 此处直接断言 msg。
    await expect(compiled.invocation.run()).rejects.toThrow(CLAIM.slice(0, 20));
  });

  test('错误信息是 Error 实例, message 含 claim 锚 (不靠字符串巧合)', async () => {
    const { ctx } = makeStubCtx();
    const compiled = compilePrimitive('verify', { claim: CLAIM, gate: true }, ctx);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) throw new Error(compiled.error);
    let caught: unknown;
    try {
      await compiled.invocation.run();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain(CLAIM.slice(0, 20));
  });
});

// ── GWT-4b (INV-4): gate 缺省 + refuted → run() 完成, output 含 '"survived":false' (向后兼容) ─

describe('GWT-4b INV-4 verify 无 gate + 假 leaf 恒判 refuted → run() 完成, output 含 "survived":false', () => {
  const CLAIM = 'GWT-4b: 向下兼容断言, 缺 gate 时不抛 — 内容锚定 alpha beta gamma delta';

  test('不传 gate 时 invocation.run() resolve 而非 reject (向后兼容)', async () => {
    const { ctx } = makeStubCtx();
    const compiled = compilePrimitive('verify', { claim: CLAIM }, ctx); // 缺 gate
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) throw new Error(compiled.error);
    const { output } = await compiled.invocation.run();
    expect(output).toContain('"survived":false');
    expect(output).toContain(CLAIM);
    // Q1③ (2026-09-03): 逐席细账随 output 出 —— 否决不再只是一个 bool。
    const parsed = JSON.parse(output) as { verdicts: { lens: string; verdict: { refuted: boolean } | null }[] };
    expect(parsed.verdicts.length).toBeGreaterThan(0);
    expect(parsed.verdicts.every((v) => v.verdict?.refuted === true)).toBe(true);
  });

  test('gate 显式 false 行为与缺省相同 (闸向缺省对齐)', async () => {
    const { ctx } = makeStubCtx();
    const compiled = compilePrimitive('verify', { claim: CLAIM, gate: false }, ctx);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) throw new Error(compiled.error);
    const { output } = await compiled.invocation.run();
    expect(output).toContain('"survived":false');
  });
});

// ── GWT-5 (INV-5): compile 改词 — verify 词 → primitive(verify, gate:true), depends_on 含前站 ─

describe('GWT-5 INV-5 verify 词 → primitive 节点 + gate:true + depends_on 含前站 id', () => {
  function verifyInChain(prev: StageChain['stages'][number]): StageChain {
    return {
      stages: [prev, { id: 'v', word: 'verify', goal: '核对 X.1 — alpha beta gamma delta' }],
    };
  }

  test('序列化文本含 "primitive":"verify"', () => {
    const chain = verifyInChain({ id: 'r', word: 'research', goal: '前置研究' });
    const plan = compileChain(chain);
    expect(JSON.stringify(plan)).toContain('"primitive":"verify"');
  });

  test('verify 节点 kind="primitive" 且 params.gate === true', () => {
    const chain = verifyInChain({ id: 'r', word: 'research', goal: '前置' });
    const plan = compileChain(chain);
    const v = plan.nodes['v'] as { kind?: string; primitive?: string; params?: Record<string, unknown> };
    expect(v.kind).toBe('primitive');
    expect(v.primitive).toBe('verify');
    expect(v.params).toBeDefined();
    expect(v.params!.gate).toBe(true);
  });

  test('verify 节点 params.claim === stage.goal (文本槽 → claim 槽)', () => {
    const claimText = '这是 GWT-5 claim 槽文本 — alpha beta gamma delta epsilon';
    const chain: StageChain = {
      stages: [
        { id: 'r', word: 'research', goal: 'g' },
        { id: 'v', word: 'verify', goal: claimText },
      ],
    };
    const plan = compileChain(chain);
    const v = plan.nodes['v'] as { params?: Record<string, unknown> };
    expect(v.params!.claim).toBe(claimText);
  });

  test('verify 节点 depends_on 仍含前一阶段 id (文本绑定未丢)', () => {
    const chain = verifyInChain({ id: 'r', word: 'research', goal: 'g' });
    const plan = compileChain(chain);
    const v = plan.nodes['v'] as { depends_on?: string[] };
    expect(v.depends_on).toContain('r');
  });
});
