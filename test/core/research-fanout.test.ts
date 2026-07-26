import { test, expect, describe } from 'bun:test';
import { buildCorpusIndex, researchFanout, type ResearchFanoutConfig } from '../../src/harness/research/fanout';

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

// ── 脊柱语料瘦身 (owner 2026-07-27): post-reduce 脊柱只带索引。
describe('buildCorpusIndex — 语料索引', () => {
  test('留骨架 (标题/来源 URL/规模), 丢正文', () => {
    const corpus = '# 检索: q\n\n## [A] SQLite 官方 — https://sqlite.org/wal.html\n\n正文段落 SECRET-BODY 很长很长\n\n<second-pass-corpus round="2">\n## https://x.example/p\n\n补抓正文 ALSO-BODY\n</second-pass-corpus>';
    const idx = buildCorpusIndex(corpus);
    expect(idx).toContain('# 检索: q');
    expect(idx).toContain('https://sqlite.org/wal.html');
    expect(idx).toContain('https://x.example/p');
    expect(idx).toContain('<second-pass-corpus round="2">');
    expect(idx).toContain(`chars="${corpus.length}"`);
    expect(idx).not.toContain('SECRET-BODY');
    expect(idx).not.toContain('ALSO-BODY');
  });

  test('超上限截断带标记', () => {
    const corpus = Array.from({ length: 900 }, (_, i) => `## 源 ${i} — https://s.example/${i}`).join('\n\n正文\n\n');
    const idx = buildCorpusIndex(corpus, 2_000);
    expect(idx.length).toBeLessThan(2_100);
    expect(idx).toContain('[索引截断]');
  });

  test('synth/judge/fusion/graft 全走索引, gen/reduce/gap 仍持全文', async () => {
    const seen: string[] = [];
    const fake = (async (req: { model: string; messages: { content: string }[] }) => {
      const p = req.messages[0]!.content as string;
      seen.push(p);
      let text = 'X';
      if (p.includes('缺口分析器')) text = '{"gaps":[{"key":"g","question":"q","why":"w"}]}';
      return { text, model: req.model, usage: { in: 1, out: 1 } };
    }) as unknown as ResearchFanoutConfig['_callModel'];
    await researchFanout({ ...baseCfg(fake), groundTruth: 'GT-FULL-BODY 事实', rounds: 2 });
    const spine = seen.filter((s) => s.includes('<framing>') || s.includes('评判维度【') || s.includes('据 panel') || s.includes('五元组') || s.includes('K-judge'));
    expect(spine.length).toBeGreaterThanOrEqual(5); // 2 synth + 2 judge + fusion/graft
    expect(spine.every((s) => !s.includes('GT-FULL-BODY'))).toBe(true);
    const fullText = seen.filter((s) => s.includes('sub-angle:') || s.includes('首席 judge') || s.includes('缺口分析器'));
    expect(fullText.every((s) => s.includes('GT-FULL-BODY'))).toBe(true);
  });
});

// ── research-second-pass (rounds): 引擎计数的多轮增量 —— shape: research-second-pass。
describe('researchFanout — research-second-pass rounds', () => {
  const GAP_JSON = JSON.stringify({
    gaps: [{ key: 'g1', question: '挖X的出处', why: '关键断言无来源', urls: ['https://miss.example/a'] }],
  });

  /** rounds 版 fake: 额外识别缺口分析 prompt; gapText 可注入 (空缺口 / 非 JSON 场景)。 */
  function makeRoundsFake(opts: { gapText?: string } = {}) {
    const seen: string[] = [];
    const fake = (async (req: { model: string; messages: { content: string }[] }) => {
      const p = req.messages[0]!.content as string;
      seen.push(p);
      let text = 'X';
      if (p.includes('缺口分析器')) text = opts.gapText ?? GAP_JSON;
      else if (p.includes('sub-angle:')) text = 'GEN';
      else if (p.includes('首席 judge')) text = 'CHAMPION';
      else if (p.includes('<framing>')) text = 'SYNTH';
      else if (p.includes('评判维度【')) text = 'CRIT';
      else if (p.includes('据 panel')) text = 'FINAL';
      return { text, model: req.model, usage: { in: 1, out: 1 } };
    }) as unknown as ResearchFanoutConfig['_callModel'];
    return { fake, seen };
  }

  test('rounds 缺省 = 单轮原行为: 无 gap 调用, roundsRun=1, secondPass=[]', async () => {
    const { fake, seen } = makeRoundsFake();
    const r = await researchFanout(baseCfg(fake));
    expect(r.roundsRun).toBe(1);
    expect(r.leafCount).toBe(11);
    expect(r.secondPass).toEqual([]);
    expect(seen.some((s) => s.includes('缺口分析器'))).toBe(false);
  });

  test('rounds=2: 二轮以 challenger lens 只挖缺口不重答原题, 冠军并入终局综合', async () => {
    const { fake, seen } = makeRoundsFake();
    const r = await researchFanout({ ...baseCfg(fake), rounds: 2 });
    expect(r.roundsRun).toBe(2);
    // 二轮冠军入列 (终局 synth 吃全部冠军)
    expect(r.lensChampions.map((c) => c.key)).toContain('second-pass-r2');
    // 二轮 gen: 1 gap → 1 sub-angle, prompt 标明增量不重答原题 + 带缺口问题
    const secondGen = seen.filter((s) => s.includes('research-second-pass') && s.includes('sub-angle:'));
    expect(secondGen.length).toBe(1);
    expect(secondGen[0]).toContain('挖X的出处');
    expect(secondGen[0]).toContain('不重答原题');
    // leafCount: r1(3 gen + 2 reduce) + 1 gap + r2(1 gen + 1 reduce) + 2 synth + 2 judge + 1 fusion + 1 graft = 14
    expect(r.leafCount).toBe(14);
    expect(r.secondPass.length).toBe(1);
    expect(r.secondPass[0]!.round).toBe(2);
    expect(r.secondPass[0]!.gaps[0]!.key).toBe('g1');
  });

  test('无新增即停 (引擎计数): gaps 空且无 probe → roundsRun=1, 不跑二轮', async () => {
    const { fake } = makeRoundsFake({ gapText: '{"gaps":[]}' });
    const r = await researchFanout({ ...baseCfg(fake), rounds: 3 });
    expect(r.roundsRun).toBe(1);
    expect(r.lensChampions.map((c) => c.key).sort()).toEqual(['a', 'b']);
    expect(r.leafCount).toBe(12); // 单轮 11 + 1 gap 分析
    expect(r.secondPass).toEqual([]);
  });

  test('probe (确定性下限): 收 digest+gaps, newCorpus 进二轮语料, probedUrls 留痕', async () => {
    const { fake, seen } = makeRoundsFake();
    const probeArgs: { round: number; digest: string; gaps: { key: string }[] }[] = [];
    const r = await researchFanout({
      ...baseCfg(fake),
      rounds: 2,
      probe: async (a) => {
        probeArgs.push(a as (typeof probeArgs)[number]);
        return { newCorpus: 'NEW-CORPUS-FACTS', fetchedUrls: ['https://miss.example/a'] };
      },
    });
    expect(probeArgs.length).toBe(1);
    expect(probeArgs[0]!.round).toBe(1);
    expect(probeArgs[0]!.digest).toContain('CHAMPION'); // 冠军全文喂 probe (抽引用 URL 用)
    expect(probeArgs[0]!.gaps[0]!.key).toBe('g1');
    // 二轮 gen prompt 含补抓语料 (append-only 进 corpus)
    const secondGen = seen.filter((s) => s.includes('NEW-CORPUS-FACTS') && s.includes('sub-angle:'));
    expect(secondGen.length).toBe(1);
    // 脊柱瘦身 (owner 2026-07-27): synth 只带语料索引不带全文 —— 事实经镜头冠军 digest 传递
    const synthPrompts = seen.filter((s) => s.includes('<framing>'));
    expect(synthPrompts.every((s) => !s.includes('NEW-CORPUS-FACTS'))).toBe(true);
    expect(synthPrompts.every((s) => s.includes('<corpus-index'))).toBe(true);
    expect(r.secondPass[0]!.probedUrls).toEqual(['https://miss.example/a']);
  });

  test('gap 产出不可解析 → fail-open 空缺口; probe 有新料时轮次照走 (泛化挖矿角)', async () => {
    const { fake, seen } = makeRoundsFake({ gapText: '这不是 JSON' });
    const r = await researchFanout({
      ...baseCfg(fake),
      rounds: 2,
      probe: async () => ({ newCorpus: 'PROBE-ONLY-CORPUS', fetchedUrls: [] }),
    });
    expect(r.roundsRun).toBe(2); // 确定性半边有新增 → 不因模型半边失败而停
    const secondGen = seen.filter((s) => s.includes('research-second-pass') && s.includes('sub-angle:'));
    expect(secondGen.length).toBe(1); // 无缺口 → 单个泛化 sub-angle 挖新增语料
    expect(secondGen[0]).toContain('PROBE-ONLY-CORPUS');
  });
});
