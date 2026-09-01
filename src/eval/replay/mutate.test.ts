/**
 * `src/eval/replay/mutate.ts` 契约 INV-2 / C-2 真值链断言 (P2 切片 2, 2026-09-01)。
 *
 * 真值链三段:
 *   · prompt 构造: `buildMutationPrompt(parent, failure, ctx)` 含父代 + 败因 + ctx,
 *     **不含** fitness.ts 函数名 + 不含 caller 未传的 heldout id;
 *   · 子代解析: `parseChildSpec(raw)` → `validateChildSpec(value)` 拒非法 JSON /
 *     错 version / 未知字段 (anti-cheat);
 *   · provider 注入: `mutateVariant(..., opts)` 接 `opts.mutationProvider`, 测试
 *     装 fake, 整链零 LLM 调用 (与 autoresearch-replay.ts:LiveProvider 同层同形)。
 *
 * 反向自检 (锁死判据力, 与 corpus.test.ts / variant.test.ts 注释惯例同款):
 *   - MUTATE_BLIND_TO_RULER (a): 在 buildMutationPrompt 的 sys 模板里加
 *     `fakeSerialPairsOf` 之类的函数名 → (a) 红 (反查闸真在, 不是文档旁路);
 *   - MUTATE_BLIND_TO_RULER (b): 把 heldout 解饵 id 偷塞进 sys 模板 → (b) 红
 *     (caller 不传的 id 不出现在 prompt);
 *   - PROMPT_HAS_LINEAGE: 把 buildMutationPrompt 的 parentSection 删掉 →
 *     「prompt 真含父代 + 败因」那条红 (lineage 失据);
 *   - PROMPT_HAS_LINEAGE: 把 failureSection 删掉 → 同上;
 *   - PARSE_REJECTS_BAD_VERSION: 把 validateChildSpec 的 version 校验删掉 →
 *     「version 不匹配 → throw」那条红 (校验真在);
 *   - PARSE_REJECTS_UNKNOWN_FIELD: 把 ALLOWED_KEYS 检查删掉 →
 *     「未知字段 (e.g. profileOverride) → throw」那条红 (anti-cheat 真接);
 *   - PROVIDER_INJECTION: 把 mutateVariant 的 `opts.mutationProvider ?? defaultMutationProvider`
 *     改成忽略 opts → 「装 fake 后 mutateVariant 返 fake 输出」那条红 (注入面真在)。
 */
import { describe, expect, test } from 'bun:test';
import type { AggregatedFitness } from './fitness';
import {
  MUTATE_BLIND_TO_RULER,
  buildMutationPrompt,
  defaultMutationProvider,
  mutateVariant,
  parseChildSpec,
  validateChildSpec,
  type MutationContext,
  type MutationFailure,
  type MutationProvider,
} from './mutate';
import { VARIANT_VERSION, type VariantSpec } from './variant';

// ─── 测试 fixture ──────────────────────────────────────────────────────────

function makeParent(): VariantSpec {
  return {
    version: VARIANT_VERSION,
    name: 'parent-dense-fanout',
    fewShotCards: [
      {
        id: 'fewshot-parent-1',
        name: 'three-parallel-fanout',
        body: 'Plan with three parallel leaves after a single scan.',
      },
    ],
    extraAppend: ['parent extra line A'],
  };
}

function makeAggregate(): AggregatedFitness {
  return {
    planValidityRate: 0.75,
    fakeSerialPairsTotal: 4,
    speedupTheoreticalMedian: 1.42,
    shapeDeclarationRate: 0.5,
    planningTokensTotal: 8400,
    n: 6,
  };
}

function makeFailure(): MutationFailure {
  return {
    perItem: [
      { id: 'screen-001', reason: 'plan failed parsePlan at nodes[2]' },
      { id: 'screen-003', reason: 'fake serial pair: lint→format→test without observable output' },
      { id: 'main-007', reason: 'speedupTheoretical null: all nodes zero cost' },
    ],
    aggregate: makeAggregate(),
  };
}

const BASE_CTX: MutationContext = {
  genIdx: 1,
  childIdx: 2,
  parentName: 'parent-dense-fanout',
};

// fitness.ts 真源导出的全部函数名 + 内部辅助名 (锁反查闸)。
const FITNESS_FUNCTION_NAMES = [
  'fakeSerialPairsOf',
  'speedupTheoreticalOf',
  'computeFitness',
  'aggregateFitness',
  'estimateTokens',
  'costOf',
  'haystackOf',
  'median',
];

// =====================================================================
// MUTATE_BLIND_TO_RULER — prompt 不可见尺子实现与 heldout (P2 INV-2 / C-2)
// =====================================================================
describe(`${MUTATE_BLIND_TO_RULER} — 变异 prompt 不可见尺子实现与 heldout (P2 INV-2 / C-2)`, () => {
  test('(a) prompt 不含 fitness.ts 任何函数名 (变异只见 lineage + 败因, 不见尺子实现)', () => {
    // 真值链: buildMutationPrompt 的 sys 模板硬编码, 不引用 fakeSerialPairsOf 等;
    // 反向: 在 sys 里塞一个函数名 → 本断言红 (反查闸真在)。
    const prompt = buildMutationPrompt(makeParent(), makeFailure(), BASE_CTX);
    for (const name of FITNESS_FUNCTION_NAMES) {
      expect(prompt).not.toContain(name);
    }
  });

  test('(b) prompt 不注入 caller 未传的 heldout 形态 id (解饵对照)', () => {
    // heldout-decoy-* 是本测试的解饵 id, caller 没传 → mutate 不该在 prompt 里出现它们。
    // 若它们出现 → mutate 偷持了 corpus 知识 → INV-2 破。
    const HELDOUT_DECOY_IDS = [
      'heldout-decoy-001',
      'heldout-decoy-002',
      'heldout-secret-X',
    ];
    const prompt = buildMutationPrompt(makeParent(), makeFailure(), BASE_CTX);
    for (const id of HELDOUT_DECOY_IDS) {
      expect(prompt).not.toContain(id);
    }
  });

  test('(c) parent=null (基线代) → prompt 不抛, 含 <baseline> 标记, 不含 fitness 名', () => {
    // 基线代允许 parent 为 null (gen 0); prompt 仍合法, <baseline> 占位, 仍不含尺名。
    const prompt = buildMutationPrompt(null, makeFailure(), {
      genIdx: 0,
      childIdx: 0,
      parentName: 'baseline',
    });
    expect(prompt).toContain('<baseline');
    for (const name of FITNESS_FUNCTION_NAMES) {
      expect(prompt).not.toContain(name);
    }
  });

  test('(d) failure.perItem 为空 → prompt 不抛, 仍含 aggregate, 不含尺名', () => {
    const prompt = buildMutationPrompt(makeParent(), { perItem: [], aggregate: makeAggregate() }, BASE_CTX);
    expect(prompt).toContain('Per-item failures (top 0):');
    for (const name of FITNESS_FUNCTION_NAMES) {
      expect(prompt).not.toContain(name);
    }
  });
});

// =====================================================================
// PROMPT_HAS_LINEAGE — prompt 真含父代 + 败因 (P2 INV-2 积极面)
// =====================================================================
describe('PROMPT_HAS_LINEAGE — prompt 真含父代 + 败因 (lineage 条件)', () => {
  test('prompt 含父代 variant 全字段 (JSON 序列化进 prompt)', () => {
    const parent = makeParent();
    const prompt = buildMutationPrompt(parent, makeFailure(), BASE_CTX);
    expect(prompt).toContain(`name=${parent.name}`);
    expect(prompt).toContain('fewShotCards');
    expect(prompt).toContain(parent.fewShotCards![0]!.id);
    expect(prompt).toContain(parent.fewShotCards![0]!.body);
    expect(prompt).toContain(parent.extraAppend![0]!);
  });

  test('prompt 含 aggregate 全维 (planValidityRate / fakeSerialPairsTotal / 等)', () => {
    const prompt = buildMutationPrompt(makeParent(), makeFailure(), BASE_CTX);
    const agg = makeAggregate();
    expect(prompt).toContain('planValidityRate');
    expect(prompt).toContain(agg.planValidityRate.toFixed(4));
    expect(prompt).toContain('fakeSerialPairsTotal');
    expect(prompt).toContain(String(agg.fakeSerialPairsTotal));
    expect(prompt).toContain('speedupTheoreticalMedian');
    expect(prompt).toContain('shapeDeclarationRate');
    expect(prompt).toContain('planningTokensTotal');
    expect(prompt).toContain(String(agg.n));
  });

  test('prompt 含每条 per-item 败因 (id + reason)', () => {
    const failure = makeFailure();
    const prompt = buildMutationPrompt(makeParent(), failure, BASE_CTX);
    expect(prompt).toContain('Per-item failures');
    for (const it of failure.perItem) {
      expect(prompt).toContain(`id=${it.id}`);
      expect(prompt).toContain(`reason=${it.reason}`);
    }
  });

  test('prompt 含 ctx (genIdx / childIdx / parentName)', () => {
    const prompt = buildMutationPrompt(makeParent(), makeFailure(), BASE_CTX);
    expect(prompt).toContain('CTX:');
    expect(prompt).toContain(`genIdx: ${BASE_CTX.genIdx}`);
    expect(prompt).toContain(`childIdx: ${BASE_CTX.childIdx}`);
    expect(prompt).toContain(`parentName: ${BASE_CTX.parentName}`);
  });

  test('同入参两次 buildMutationPrompt → 字节级同输出 (确定性, 供 session 复盘)', () => {
    const a = buildMutationPrompt(makeParent(), makeFailure(), BASE_CTX);
    const b = buildMutationPrompt(makeParent(), makeFailure(), BASE_CTX);
    expect(a).toBe(b);
  });

  test('speedupTheoreticalMedian=null → prompt 含字面 null, 不抛', () => {
    const failure: MutationFailure = {
      perItem: [],
      aggregate: { ...makeAggregate(), speedupTheoreticalMedian: null },
    };
    const prompt = buildMutationPrompt(makeParent(), failure, BASE_CTX);
    expect(prompt).toContain('speedupTheoreticalMedian: null');
  });
});

// =====================================================================
// PARSE_REJECTS — 子代 spec 解析与校验 (P2 INV-2 配套闸)
// =====================================================================
describe('PARSE_REJECTS — 子代 spec 解析与校验 (P2 INV-2 配套)', () => {
  const VALID_CHILD_JSON = JSON.stringify({
    version: 1,
    name: 'child-from-failure',
    fewShotCards: [{ id: 'card-1', name: 'one', body: 'one body' }],
    extraAppend: ['extra-line'],
  });

  test('parseChildSpec: 合法 JSON → 返 VariantSpec', () => {
    const spec = parseChildSpec(VALID_CHILD_JSON);
    expect(spec.version).toBe(VARIANT_VERSION);
    expect(spec.name).toBe('child-from-failure');
    expect(spec.fewShotCards).toHaveLength(1);
    expect(spec.extraAppend).toEqual(['extra-line']);
  });

  test('parseChildSpec: 非 JSON → throw (fail-closed)', () => {
    expect(() => parseChildSpec('not json')).toThrow(/not valid JSON/);
  });

  test('parseChildSpec: JSON 但根非对象 → throw', () => {
    expect(() => parseChildSpec('"a string"')).toThrow(/JSON object/);
  });

  test('validateChildSpec: version 不匹配 → throw', () => {
    expect(() =>
      validateChildSpec({ version: 99, name: 'x' }),
    ).toThrow(/version/);
  });

  test('validateChildSpec: 缺 name → throw', () => {
    expect(() => validateChildSpec({ version: 1 })).toThrow(/name/);
  });

  test('validateChildSpec: name 非 kebab-case → throw', () => {
    expect(() => validateChildSpec({ version: 1, name: 'Has Spaces' })).toThrow(/kebab-case/);
    expect(() => validateChildSpec({ version: 1, name: 'UPPER' })).toThrow(/kebab-case/);
  });

  test('validateChildSpec: name > 40 chars → throw', () => {
    expect(() =>
      validateChildSpec({ version: 1, name: 'a'.repeat(41) }),
    ).toThrow(/40 chars/);
  });

  test('validateChildSpec: fewShotCards 非数组 → throw', () => {
    expect(() =>
      validateChildSpec({ version: 1, name: 'x', fewShotCards: 'not-array' }),
    ).toThrow(/fewShotCards must be an array/);
  });

  test('validateChildSpec: few-shot card 缺 id / name / body → throw', () => {
    expect(() =>
      validateChildSpec({
        version: 1,
        name: 'x',
        fewShotCards: [{ name: 'n', body: 'b' }],
      }),
    ).toThrow(/id/);
    expect(() =>
      validateChildSpec({
        version: 1,
        name: 'x',
        fewShotCards: [{ id: 'a', body: 'b' }],
      }),
    ).toThrow(/name/);
    expect(() =>
      validateChildSpec({
        version: 1,
        name: 'x',
        fewShotCards: [{ id: 'a', name: 'n' }],
      }),
    ).toThrow(/body/);
  });

  test('validateChildSpec: few-shot card 重名 id → throw', () => {
    expect(() =>
      validateChildSpec({
        version: 1,
        name: 'x',
        fewShotCards: [
          { id: 'dup', name: 'a', body: 'a' },
          { id: 'dup', name: 'b', body: 'b' },
        ],
      }),
    ).toThrow(/duplicate few-shot card id "dup"/);
  });

  test('validateChildSpec: extraAppend 含空字符串 → throw', () => {
    expect(() =>
      validateChildSpec({ version: 1, name: 'x', extraAppend: [''] }),
    ).toThrow(/non-empty string/);
  });

  test('validateChildSpec: extraAppend 非数组 → throw', () => {
    expect(() =>
      validateChildSpec({ version: 1, name: 'x', extraAppend: 'nope' }),
    ).toThrow(/extraAppend must be an array/);
  });

  test('PARSE_REJECTS_UNKNOWN_FIELD: 偷塞 profileOverride → throw (anti-cheat)', () => {
    // 这条是 anti-cheat 的真值闸: profileOverride 是 VariantSpec 合法字段, 但
    // mutate 输出不许带它 (profile 由 caller 链消费, 不经变异算子)。
    expect(() =>
      validateChildSpec({
        version: 1,
        name: 'x',
        profileOverride: 'full',
      }),
    ).toThrow(/unknown field "profileOverride"/);
  });

  test('PARSE_REJECTS_UNKNOWN_FIELD: 偷塞 raw prompt 字段 → throw', () => {
    expect(() =>
      validateChildSpec({
        version: 1,
        name: 'x',
        systemPrompt: 'malicious',
      }),
    ).toThrow(/unknown field/);
  });
});

// =====================================================================
// PROVIDER_INJECTION — provider 注入点 + 端到端 mutateVariant (P2 INV-2 wiring)
// =====================================================================
describe('PROVIDER_INJECTION — mutationProvider 注入点 (P2 INV-2 wiring)', () => {
  /** Stub provider: 记录调用 + 返指定 rawText。 */
  function makeStub(rawText: string, recorded?: { prompts: string[]; ctxs: MutationContext[] }): MutationProvider {
    return async (prompt, ctx) => {
      recorded?.prompts.push(prompt);
      recorded?.ctxs.push(ctx);
      return rawText;
    };
  }

  test('mutateVariant: 装 fake provider → 返其 JSON 解析出的子代 (端到端)', async () => {
    const fakeRaw = JSON.stringify({
      version: 1,
      name: 'fake-child',
      fewShotCards: [{ id: 'fake-card', name: 'F', body: 'F-body' }],
      extraAppend: ['fake-line'],
    });
    const provider = makeStub(fakeRaw);
    const child = await mutateVariant(makeParent(), makeFailure(), BASE_CTX, {
      mutationProvider: provider,
    });
    expect(child.version).toBe(VARIANT_VERSION);
    expect(child.name).toBe('fake-child');
    expect(child.fewShotCards).toHaveLength(1);
    expect(child.extraAppend).toEqual(['fake-line']);
  });

  test('mutateVariant: provider 拿到 prompt = buildMutationPrompt 输出 (无再加工)', async () => {
    const recorded: { prompts: string[]; ctxs: MutationContext[] } = { prompts: [], ctxs: [] };
    const provider = makeStub(JSON.stringify({ version: 1, name: 'x' }), recorded);
    await mutateVariant(makeParent(), makeFailure(), BASE_CTX, {
      mutationProvider: provider,
    });
    expect(recorded.prompts).toHaveLength(1);
    expect(recorded.ctxs[0]).toEqual(BASE_CTX);
    expect(recorded.prompts[0]).toBe(
      buildMutationPrompt(makeParent(), makeFailure(), BASE_CTX),
    );
  });

  test('mutateVariant: provider 返非法 JSON → mutateVariant throw (fail-closed)', async () => {
    const provider = makeStub('not json at all');
    await expect(
      mutateVariant(makeParent(), makeFailure(), BASE_CTX, { mutationProvider: provider }),
    ).rejects.toThrow(/not valid JSON/);
  });

  test('mutateVariant: provider 返 JSON 但缺 version → mutateVariant throw', async () => {
    const provider = makeStub(JSON.stringify({ name: 'x' }));
    await expect(
      mutateVariant(makeParent(), makeFailure(), BASE_CTX, { mutationProvider: provider }),
    ).rejects.toThrow(/version/);
  });

  test('mutateVariant: 不装 provider → defaultMutationProvider throw (wiring guard)', async () => {
    // 真值链: mutateVariant 显式 throw (没接联机) → 调用方必须注入。失败模式 =
    // fail-closed, 与 corpus.readManifestText 同哲学。
    await expect(
      mutateVariant(makeParent(), makeFailure(), BASE_CTX),
    ).rejects.toThrow(/not wired in slice 2/);
  });

  test('defaultMutationProvider 直接调 → throw (不是 silent noop)', async () => {
    await expect(
      defaultMutationProvider('p', BASE_CTX),
    ).rejects.toThrow(/not wired in slice 2/);
  });

  test('同 stub + 同入参两跑 → 返同 child (deterministic over provider)', async () => {
    const fakeRaw = JSON.stringify({
      version: 1,
      name: 'det-child',
      fewShotCards: [{ id: 'd', name: 'D', body: 'D-body' }],
    });
    const a = await mutateVariant(makeParent(), makeFailure(), BASE_CTX, {
      mutationProvider: makeStub(fakeRaw),
    });
    const b = await mutateVariant(makeParent(), makeFailure(), BASE_CTX, {
      mutationProvider: makeStub(fakeRaw),
    });
    expect(a).toEqual(b);
  });
});