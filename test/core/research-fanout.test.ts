import { test, expect, describe } from 'bun:test';
import { researchFanout, type ResearchFanoutConfig } from '../../src/harness/research/fanout';

// fake callModel: 回 prompt 的 stage 标记 (据 prompt 内容判断在哪个 stage), 计调用次数。
function makeFakeCall() {
  let calls = 0;
  const seen: string[] = [];
  const fake = (async (req: { model: string; messages: { content: string }[] }) => {
    calls++;
    const p = req.messages[0]!.content;
    seen.push(p.slice(0, 40));
    let text = 'X';
    if (p.includes('sub-angle:')) text = 'GEN';
    else if (p.includes('首席 judge')) text = 'CHAMPION';
    else if (p.includes('<framing>')) text = 'SYNTH';
    else if (p.includes('评判维度【')) text = 'CRIT';
    else if (p.includes('据 panel')) text = 'FINAL';
    return { text, model: req.model, usage: { in: 1, out: 1 } };
  }) as unknown as ResearchFanoutConfig['_callModel'];
  return { fake, getCalls: () => calls };
}

const baseCfg = (call: ResearchFanoutConfig['_callModel']): ResearchFanoutConfig => ({
  question: 'Q?',
  groundTruth: 'GT',
  lenses: [
    { key: 'a', persona: 'pa', subAngles: ['a1', 'a2'], abstraction: 'ABS' },
    { key: 'b', persona: 'pb', subAngles: ['b1'] },
  ],
  synthesisFramings: [
    { key: 'min', framing: 'fmin' },
    { key: 'max', framing: 'fmax' },
  ],
  judgeCriteria: [
    { key: 'correct', criterion: 'correctness' },
    { key: 'simple', criterion: 'simplicity' },
  ],
  lensModel: 'fake:flash',
  reasonModel: 'fake:pro',
  _callModel: call,
});

describe('researchFanout — L×V staging', () => {
  test('leafCount = ΣV + L + M + K + 1 fusion + 1 graft', async () => {
    const { fake, getCalls } = makeFakeCall();
    const r = await researchFanout(baseCfg(fake));
    // ΣV=3 (a:2 + b:1) + L=2 reduce + M=2 synth + K=2 judge + 1 fusion + 1 graft = 11
    expect(r.leafCount).toBe(11);
    expect(getCalls()).toBe(11);
    expect(typeof r.fusionAnalysis).toBe('string'); // Stage 4.5 融合分析产出
  });

  test('每 lens 产一个冠军; M 综合候选; K judge 评判', async () => {
    const { fake } = makeFakeCall();
    const r = await researchFanout(baseCfg(fake));
    expect(r.lensChampions.map((c) => c.key).sort()).toEqual(['a', 'b']);
    expect(r.synthCandidates.map((s) => s.key).sort()).toEqual(['max', 'min']);
    expect(r.judgeCritiques.map((j) => j.key).sort()).toEqual(['correct', 'simple']);
    expect(r.final).toBe('FINAL');
  });

  test('抽象块只在有 abstraction 的 lens 注入', async () => {
    const seen: string[] = [];
    const fake = (async (req: { model: string; messages: { content: string }[] }) => {
      seen.push(req.messages[0]!.content);
      return { text: 'x', model: req.model, usage: { in: 1, out: 1 } };
    }) as unknown as ResearchFanoutConfig['_callModel'];
    await researchFanout(baseCfg(fake));
    const genA = seen.filter((s) => s.includes('sub-angle: a'));
    const genB = seen.filter((s) => s.includes('sub-angle: b'));
    expect(genA.every((s) => s.includes('domain-abstraction'))).toBe(true); // lens a 有 abstraction
    expect(genB.some((s) => s.includes('domain-abstraction'))).toBe(false); // lens b 无
  });
});
