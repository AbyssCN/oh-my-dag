/**
 * `src/eval/replay/mutate.ts` 契约 INV-2 / C-2 真值链断言 (P2 切片 2 + P2b 切片 1, 2026-09-01)。
 *
 * 真值链四段:
 *   · prompt 构造: `buildMutationPrompt(parent, failure, ctx)` 含父代 + 败因 + ctx,
 *     **不含** fitness.ts 函数名 + 不含 caller 未传的 heldout id;
 *   · 子代解析: `parseChildSpec(raw)` → `validateChildSpec(value)` 拒非法 JSON /
 *     错 version / 未知字段 (anti-cheat);
 *   · provider 注入: `mutateVariant(..., opts)` 接 `opts.mutationProvider`, 测试
 *     装 fake, 整链零 LLM 调用 (与 autoresearch-replay.ts:LiveProvider 同层同形);
 *   · live 联机通路 (P2b 切片 1 LIVE_MUTATION_WIRED): `defaultMutationProvider` 真接
 *     `src/model/gateway.send` (座位 = conductor, M3), 测试通过 `deps.llmCaller`
 *     注入 fake transport, 整链零发请求 —— 与 defaultLiveProvider 同形。
 *
 * 反向自检 (锁死判据力, 与 corpus.test.ts / variant.test.ts 注释惯例同款):
 *   - MUTATE_BLIND_TO_RULER (a): 在 buildMutationPrompt 的 sys 模板里加
 *     `fakeSerialPairsOf` 之类的函数名 → (a) 红 (反查闸真在, 不是文档旁路);
 *   - MUTATE_BLIND_TO_RULER (b): 把 heldout 解饵 id 偷塞进 sys 模板 → (b) 红
 *     (caller 不传的 id 不出现在 prompt);
 *   - MUTATE_BLIND_TO_RULER (e): live 构造路径 (defaultMutationProvider + fake transport)
 *     把 `fakeSerialPairsOf` 之类的尺名透到 llmCaller.req → (e) 红 (闸真在 live 链上,
 *     不是 buildMutationPrompt 单层闸);
 *   - PROMPT_HAS_LINEAGE: 把 buildMutationPrompt 的 parentSection 删掉 →
 *     「prompt 真含父代 + 败因」那条红 (lineage 失据);
 *   - PROMPT_HAS_LINEAGE: 把 failureSection 删掉 → 同上;
 *   - PARSE_REJECTS_BAD_VERSION: 把 validateChildSpec 的 version 校验删掉 →
 *     「version 不匹配 → throw」那条红 (校验真在);
 *   - PARSE_REJECTS_UNKNOWN_FIELD: 把 ALLOWED_KEYS 检查删掉 →
 *     「未知字段 (e.g. profileOverride) → throw」那条红 (anti-cheat 真接);
 *   - PROVIDER_INJECTION: 把 mutateVariant 的 `opts.mutationProvider ?? defaultMutationProvider`
 *     改成忽略 opts → 「装 fake 后 mutateVariant 返 fake 输出」那条红 (注入面真在);
 *   - LIVE_MUTATION_WIRED: 把 defaultMutationProvider 的 `await llmCaller(` 删了 → LIVE-3
 *     红 (真联机路径存在, 不是 stub 短路);
 *   - LIVE_MUTATION_WIRED: 把 seats 强校验删了 → LIVE-1 红 (fail-closed 真在, 不是 silent noop)。
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
import type { GatewayRequest, ModelResponse } from '../../model/gateway';

/** Marker for the live-mutation wiring test (matches the verify command grep). */
const LIVE_MUTATION_WIRED = 'LIVE_MUTATION_WIRED';

/** 测试用 frozen seats (与 autoresearch-replay.test.ts:SEATS 同形 —— 锁源头一致)。 */
const SEATS = {
  conductor: 'minimax-cn:MiniMax-M3',
  worker: 'minimax-cn:MiniMax-M3',
  verifier: 'openai-codex:gpt-5.6-sol',
};

/** fake transport: 计调 + 返指定 rawText (与 autoresearch-replay.test.ts 同形)。 */
function makeFakeTransport(rawText: string): {
  calls: GatewayRequest[];
  caller: (req: GatewayRequest) => Promise<ModelResponse>;
} {
  const calls: GatewayRequest[] = [];
  const caller = async (req: GatewayRequest): Promise<ModelResponse> => {
    calls.push(req);
    return {
      text: rawText,
      usage: { in: 100, out: 200 },
      raw: { mocked: true },
      model: req.model ?? 'fake:fake',
      attempts: 1,
    };
  };
  return { calls, caller };
}

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

  test('(e) live 构造路径: defaultMutationProvider + fake transport → 进 llmCaller.req 的消息也不含尺名/未传 heldout id (P2b LIVE_MUTATION_WIRED)', async () => {
    // 真值链: buildMutationPrompt 的 INV-2 闸是字符串硬编码, 但 live 通路再经
    // gateway.send 一次 (可能有人想在 defaultMutationProvider 里"加段"或"改段") →
    // 闸也必须守住出口端。这条把 buildMutationPrompt 的输出丢进
    // defaultMutationProvider + fake llmCaller, 验 messages[].content 全段不含尺名 +
    // 不含 caller 未传的 heldout id。
    // 反向自检: 把 defaultMutationProvider 改成往 messages 里塞一段拼接 'fakeSerialPairsOf' →
    // 本断言红 (闸真在 live 链上, 不是 buildMutationPrompt 单层闸)。
    const HELDOUT_DECOY_IDS = [
      'heldout-decoy-001',
      'heldout-decoy-002',
      'heldout-secret-X',
    ];
    const prompt = buildMutationPrompt(makeParent(), makeFailure(), {
      ...BASE_CTX,
      seats: SEATS,
    });
    const fakeChildJson = JSON.stringify({ version: 1, name: 'live-fake-child' });
    const { calls, caller } = makeFakeTransport(fakeChildJson);
    const got = await defaultMutationProvider(prompt, { ...BASE_CTX, seats: SEATS }, {
      llmCaller: caller,
      bootstrap: () => [],
    });
    expect(got).toBe(fakeChildJson);
    expect(calls).toHaveLength(1);
    const req = calls[0]!;
    const allContent = req.messages.map((m) => String(m.content)).join('\n');
    for (const name of FITNESS_FUNCTION_NAMES) {
      expect(allContent).not.toContain(name);
    }
    for (const id of HELDOUT_DECOY_IDS) {
      expect(allContent).not.toContain(id);
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

  test('mutateVariant: 不装 provider + ctx 没 seats → defaultMutationProvider throw (seats guard, fail-closed)', async () => {
    // 真值链 (P2b 切片 1): defaultMutationProvider 走联机 → 必须有 seats 才能解析
    // conductor 坐标; BASE_CTX 没 seats → throw (fail-closed, 与 corpus.readManifestText
    // 同哲学)。失败模式 = 调用方要么注入 opts.mutationProvider, 要么给 ctx.seats;
    // 静默 fallback = wiring bug, 不许。
    // 反向自检: 把 seats 强校验删了 → 本断言红 (闸真在, 不是文档旁路)。
    await expect(
      mutateVariant(makeParent(), makeFailure(), BASE_CTX),
    ).rejects.toThrow(/seats missing/);
  });

  test('defaultMutationProvider 直接调 + 没 seats → throw (不是 silent noop)', async () => {
    // 真值链: 同上, 直接调用 defaultMutationProvider 不走 mutateVariant 也得 fail-closed。
    await expect(
      defaultMutationProvider('p', BASE_CTX),
    ).rejects.toThrow(/seats missing/);
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

// =====================================================================
// LIVE_MUTATION_WIRED — defaultMutationProvider 真接联机通路 (座位 = conductor),
// 测试用 fake transport 注入 (零冒烟) (P2b 切片 1, 2026-09-01)
// =====================================================================
describe(`${LIVE_MUTATION_WIRED} — defaultMutationProvider 真接联机通路, 测试用 fake transport 注入 (零冒烟)`, () => {
  test('LIVE-1 defaultMutationProvider 是函数 + 接 (prompt, ctx, deps) 签名 + 默认实现真存在 (路径真在)', () => {
    // 真值链: defaultMutationProvider 必须存在且签名匹配 MutationProvider 接口。
    // 这是「路径真在」闸: 不调它去发请求 (否则 CI 无凭证 / 无网络会挂), 只确认它的
    // shape + 源里确实引用了 send / bootstrap / tryResolveSeatModel (联机路径真接入),
    // 防有人把它删了换成 not-implemented 短路。
    // 反向自检:
    //   · 把 defaultMutationProvider 删 → import 报 undefined → typeof 红;
    //   · 把 defaultMutationProvider 改成抛 LIVE_NOT_IMPLEMENTED → typeof 还是 function,
    //     但源码 grep 'await llmCaller(' 失守 → LIVE-3 红;
    //   · 把 seats 强校验删了 → LIVE-4 红 (fail-closed 真在)。
    expect(typeof defaultMutationProvider).toBe('function');
    // Function.length 不数带默认值的形参 (deps: MutationProviderDeps = {})。源里 deps
    // 是第 3 形参, 故 length === 2; 通过参数列表透出 deps 的存在 + 类型 import 锁形状。
    expect(defaultMutationProvider.length).toBe(2);
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const { join } = require('node:path') as typeof import('node:path');
    const src = readFileSync(join(import.meta.dir, 'mutate.ts'), 'utf8');
    const sig = src.split('export async function defaultMutationProvider')[1]?.split('{')[0] ?? '';
    // 签名里 ctx (MutationContext) + deps (MutationProviderDeps) 两参数 (deps 是 mock transport 注入点)
    expect(sig).toMatch(/MutationContext/);
    expect(sig).toMatch(/MutationProviderDeps/);
    // 源文件真引用了 send (走 gateway.send) + bootstrapModelRuntime + tryResolveSeatModel —
    // 这三行是「真联机」承诺的源码硬证据, 不是注释承诺。
    expect(src).toContain('await llmCaller(');
    expect(src).toContain('bootstrapModelRuntime');
    expect(src).toContain('tryResolveSeatModel');
    // ctx.seats 真强校验 (fail-closed, 不是 silent noop)
    expect(src).toMatch(/ctx\.seats/);
  });

  test('LIVE-2 mock transport: deps.llmCaller 替换 send, defaultMutationProvider 装配链真跑, 零发请求', async () => {
    // 真值链: deps.llmCaller 装 fake → defaultMutationProvider 完整跑 bootstrap +
    //   seats 解析 + model 解析 + meta 拼装, 最后调 llmCaller(req) (本测试 fake);
    //   llmCaller 收到的 req → 验: model = seats.conductor, messages[0].role='user'
    //   含 buildMutationPrompt 全段 (含 'MUTATION OPERATOR'), thinkingLevel='high',
    //   maxTokens=32_768, meta.role='conductor' + meta.sessionId/runLabel 拼装正确。
    // 反向自检:
    //   · 把 deps.llmCaller 抽走 (代码删) → 真走 send → CI 无凭证 → 挂;
    //   · 把 defaultMutationProvider 改成 return fakeChildJson (短路) → llmCaller
    //     计数仍 0 → 本断言红 (LLM 真被调到, 不是 stub)。
    const prompt = buildMutationPrompt(makeParent(), makeFailure(), BASE_CTX);
    const fakeChildJson = JSON.stringify({ version: 1, name: 'live-mut-child' });
    const { calls, caller } = makeFakeTransport(fakeChildJson);
    const got = await defaultMutationProvider(prompt, { ...BASE_CTX, seats: SEATS }, {
      llmCaller: caller,
      bootstrap: () => [],
    });
    expect(got).toBe(fakeChildJson);
    expect(calls).toHaveLength(1);
    const req = calls[0]!;
    expect(req.model).toBe(SEATS.conductor);
    expect(req.messages).toHaveLength(1);
    expect(req.messages[0]!.role).toBe('user');
    const userContent = String(req.messages[0]!.content);
    expect(userContent).toBe(prompt); // 整段 prompt 进 user, 不重塑
    expect(userContent).toContain('MUTATION OPERATOR');
    expect(userContent).toContain('PARENT');
    expect(req.thinkingLevel).toBe('high');
    expect(req.maxTokens).toBe(32_768);
    // 归座在 TRACE_SEAT_RULES: mutate:live → conductor 座 (seat-usage 覆盖闸要求命名空间化标签)
    expect(req.meta?.role).toBe('mutate:live');
    expect(req.meta?.sessionId).toBe(`autoresearch-mutate:${BASE_CTX.genIdx}-${BASE_CTX.childIdx}`);
    expect(req.meta?.runLabel).toBe(`mutate/${BASE_CTX.parentName}`);
  });

  test('LIVE-3 llmCaller 返空 text → defaultMutationProvider throw (fail-closed, 不返空 spec 让 parseChildSpec 拒)', async () => {
    // 真值链: 真接联机时 provider 偶发返空 (rate limit / 超时返回空 text);
    //   fail-closed: 空 text → throw, 不让空串进 parseChildSpec (那会报「非 JSON」,
    //   错误信息丢失源头)。反向自检: 把空 text 校验删了 → 本断言红。
    const prompt = buildMutationPrompt(makeParent(), makeFailure(), BASE_CTX);
    const emptyCaller = async (_req: GatewayRequest): Promise<ModelResponse> => ({
      text: '',
      usage: { in: 0, out: 0 },
      raw: { mocked: true },
      model: 'fake:fake',
      attempts: 1,
    });
    await expect(
      defaultMutationProvider(prompt, { ...BASE_CTX, seats: SEATS }, {
        llmCaller: emptyCaller,
        bootstrap: () => [],
      }),
    ).rejects.toThrow(/empty text/);
  });

  test('LIVE-4 ctx.seats 缺席 → defaultMutationProvider throw (fail-closed, 不静默回落)', async () => {
    // 真值链: ctx.seats 缺 → 无法解析 conductor 坐标 → throw (fail-closed)。
    //   静默回落到某个 default seat 是 wiring bug, 不许。
    // 反向自检: 把 seats 强校验删了 → 本断言红 (闸真在, 不是注释承诺)。
    const prompt = buildMutationPrompt(makeParent(), makeFailure(), BASE_CTX);
    const { caller } = makeFakeTransport('{}');
    await expect(
      defaultMutationProvider(prompt, BASE_CTX, {
        llmCaller: caller,
        bootstrap: () => [],
      }),
    ).rejects.toThrow(/seats missing/);
  });

  test('LIVE-5 ctx.seats.conductor 缺席 → throw (车辆未登记, 不静默 fallback)', async () => {
    // 真值链: seats 在但 conductor 缺 → tryResolveSeatModel 拿到 undefined 但
    //   explicit 路径不抛, 默认实现应主动抛 (防静默用 defaultModel 走错车)。
    // 反向自检: 把 conductor 强校验删了 → 本断言红。
    const prompt = buildMutationPrompt(makeParent(), makeFailure(), BASE_CTX);
    const seatsMissingConductor = { worker: 'minimax-cn:MiniMax-M3' }; // 无 conductor
    const { caller } = makeFakeTransport('{}');
    await expect(
      defaultMutationProvider(prompt, { ...BASE_CTX, seats: seatsMissingConductor }, {
        llmCaller: caller,
        bootstrap: () => [],
      }),
    ).rejects.toThrow(/seats\.conductor missing/);
  });

  test('LIVE-6 mutateVariant 端到端: 装 fake transport (via MutationProviderDeps 替代路径) → 仍可独立走 opts.mutationProvider', async () => {
    // 真值链: opts.mutationProvider 注入 fake → mutateVariant 走 fake (不走 default);
    //   反向: 删 opts.mutationProvider → mutateVariant 走 defaultMutationProvider
    //   → 需 seats, 这条已在 PROVIDER_INJECTION「不装 provider + ctx 没 seats → throw」
    //   锁住, 不重复。这里锁的是「两条注入路径**互不干扰**」: deps.llmCaller 是 default
    //   路径注入, opts.mutationProvider 是任意路径短路, 两者都接同一份 buildMutationPrompt
    //   输出, 但互不可见。
    const fakeChildJson = JSON.stringify({ version: 1, name: 'two-path-child' });
    const prompt = buildMutationPrompt(makeParent(), makeFailure(), BASE_CTX);
    // 路径 A: opts.mutationProvider
    const childA = await mutateVariant(makeParent(), makeFailure(), BASE_CTX, {
      mutationProvider: async (_p, _c) => fakeChildJson,
    });
    expect(childA.name).toBe('two-path-child');
    // 路径 B: deps.llmCaller (走 defaultMutationProvider)
    const { caller } = makeFakeTransport(fakeChildJson);
    const rawB = await defaultMutationProvider(prompt, { ...BASE_CTX, seats: SEATS }, {
      llmCaller: caller,
      bootstrap: () => [],
    });
    const childB = parseChildSpec(rawB);
    expect(childB.name).toBe('two-path-child');
    // 两条路径出 spec 字节同 (同 buildMutationPrompt + 同 fake rawText)
    expect(childA).toEqual(childB);
  });
});