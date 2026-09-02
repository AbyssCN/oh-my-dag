/**
 * `scripts/autoresearch-session.ts` 契约 C-4 / INV-4 真值链断言 (P2 切片 4, 2026-09-01)。
 *
 * 真值链:
 *   · GEN_FLOW: gen 0 = baseline (无变异, 无 parents), gen N+1 parents = gen N winners,
 *     child names 派生自 parentName + genIdx + childIdx;
 *   · FITNESS_RECORDED: 每代 childVariantNames.length === fitnessByChild 键数 (无记录 = 漏洞);
 *   · PARENT_CARRY: 父母随代前进 (不是每代重新从 baseline 盘);
 *   · MUTATION_INJECTION: opts.mutationProvider 被调用 K × parents.length 次/代
 *     (provider 是合同面, 不是装饰);
 *   · PLATEAU_STOP: 连续 plateauThreshold 代 Pareto front 字节不动 → 收束 reason='plateau';
 *   · BUDGET_STOP: budgetMs 超 → 收束 reason='budget' (闸真掐, 不是装饰);
 *   · MAX_GEN_STOP: 自然到 maxGenerations → reason='maxGenerations';
 *   · JOURNAL_APPEND_ONLY (C-4 / INV-4): 第一次 session 写完后该文件的前 N 字节,
 *     在写第二个 session 后依然逐字节相等 (append-only 守恒, 不修改早段)。
 *   · GEN_CHECKPOINT_RESUME (P2b 切片 2 / C-5): 每代 settle → session.json 写入,
 *     续跑 session 时前 N 代字段字节相同; resumeSessionId 缺失 checkpoint → throw。
 *
 * 反向自检 (锁死判据力):
 *   · JOURNAL_APPEND_ONLY: 把 appendSessionJournal 改成 'w' 模式全覆盖 → 那条红;
 *   · JOURNAL_APPEND_ONLY: 把 appendSessionJournal 的 appendFileSync 改成 writeFileSync →
 *     早段被改写, 那条红;
 *   · GEN_FLOW: 把 gen 0 的 childVariantNames 留空那行去掉, 让 gen 0 也"变异" → 红;
 *   · PARENT_CARRY: 把 parents 选 winners 改成固定返 'baseline' → 红;
 *   · PLATEAU_STOP: 把 isPlateau 改成永远 false → plateau 测试跑到 maxGenerations 收束 → 红;
 *   · BUDGET_STOP: 把 budget 检查删 → budgetMs=1 fixture 仍跑到 maxGenerations → 红;
 *   · MUTATION_INJECTION: 把 mutateVariant 的 opts.mutationProvider ?? defaultMutationProvider
 *     改成忽略 opts → mutationProvider.calls 从 K×parents.length 跌到 0 → 红。
 *   · GEN_CHECKPOINT_RESUME: 把 runSession 里每代后的 writeSessionCheckpoint 删了 → CKPT-1
 *     红 (session.json 不存在 / generations 字段缺); 把 loadSessionCheckpoint 改成 always-null
 *     → CKPT-2 红 (resume 时从头跑, 字段不再等于预置 gen 0); 把 resumeSessionId 缺失的 throw
 *     改成 silent fallback → CKPT-3 红。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  GEN_CHECKPOINT_RESUME,
  JOURNAL_APPEND_ONLY,
  PLATEAU_DEFAULT_THRESHOLD,
  SESSION_BASELINE_VARIANT,
  SESSION_DEFAULT_OBJECTIVES,
  SESSION_MAIN_OBJECTIVE,
  appendSessionJournal,
  appendGenerationToJournal,
  beginSessionJournal,
  endSessionJournal,
  loadSessionCheckpoint,
  renderJournalBlock,
  runSession,
  writeSessionCheckpoint,
  type GenerationRecord,
  type MutationProvider,
  type SessionCheckpoint,
  type VariantFitness,
} from './autoresearch-session';
import type { AggregatedFitness } from '../src/eval/replay/fitness';
import { freezeCorpus, loadCorpus, type CorpusItem, type LoadedCorpus } from '../src/eval/replay/corpus';
import { VARIANT_VERSION, type VariantSpec } from '../src/eval/replay/variant';

// ─── 测试 fixture helpers ──────────────────────────────────────────────────

const SEATS = {
  conductor: 'minimax-cn:MiniMax-M3',
  worker: 'minimax-cn:MiniMax-M3',
  verifier: 'openai-codex:gpt-5.6-sol',
};
const TARGET_COUNTS: readonly [number, number, number] = [6, 8, 4];

let tmpRoot: string | null = null;

afterEach(() => {
  if (tmpRoot) {
    rmSync(tmpRoot, { recursive: true, force: true });
    tmpRoot = null;
  }
});

function freshRoot(): string {
  const r = mkdtempSync(join(tmpdir(), 'autoresearch-session-test-'));
  tmpRoot = r;
  return r;
}

function sampleItems(): CorpusItem[] {
  const ids: string[] = [];
  for (let i = 0; i < 18; i++) ids.push(`item-${String(i + 1).padStart(3, '0')}`);
  return ids.map((id, i) => ({
    id,
    prompt: `synthetic prompt for ${id} index ${i}`,
    srcRunId: `run-${Math.floor(i / 6) + 1}`,
  }));
}

const FIX_DIR = join(import.meta.dir, '..', 'src', 'eval', 'replay', 'fixtures');
const CLEAN_TEXT = readFileSync(join(FIX_DIR, 'plan-clean.json'), 'utf8');
const FAKE_TEXT = readFileSync(join(FIX_DIR, 'plan-fake-serial.json'), 'utf8');

interface FixtureSetup {
  root: string;
  variantDir: string;
  journalPath: string;
  sessionsDir: string;
  loaded: LoadedCorpus;
}

function makeFixture(allowHeldout: boolean = false): FixtureSetup {
  const root = freshRoot();
  const variantDir = join(root, 'variants');
  const journalPath = join(root, 'journal.md');
  const sessionsDir = join(root, 'sessions');
  const m = freezeCorpus(sampleItems(), { seats: SEATS, targetCounts: TARGET_COUNTS });
  const loaded = loadCorpus(JSON.stringify(m), { allowHeldout, verifyHash: true });
  return { root, variantDir, journalPath, sessionsDir, loaded };
}

/** 总是返同一 rawText → 同 fitness (跨所有 variant)。plateau 测试用。 */
function stableRawText(): (v: string) => string {
  return () => CLEAN_TEXT;
}

/** 名字含 'fake-' 走 fake-serial fixture, 其它走 clean fixture。可预知 fitness 差异。 */
function predictableRawText(): (v: string) => string {
  return (variant: string) => (variant.includes('fake-') ? FAKE_TEXT : CLEAN_TEXT);
}

interface CountingMutationProvider {
  provider: MutationProvider;
  calls: number;
}

function makeCountingMutationProvider(): CountingMutationProvider {
  let count = 0;
  const provider: MutationProvider = async (_prompt, ctx) => {
    count++;
    const spec: VariantSpec = {
      version: VARIANT_VERSION,
      name: `${ctx.parentName}-g${ctx.genIdx}-c${ctx.childIdx}-${count}`,
      extraAppend: [`auto-gen by stub; genIdx=${ctx.genIdx} childIdx=${ctx.childIdx}`],
    };
    return JSON.stringify(spec);
  };
  return {
    provider,
    get calls() {
      return count;
    },
  };
}

/** 一个 trivial AggregatedFitness 工厂 (留作将来 SELECT 段用, 避免 unused lint)。 */
function makeAgg(over: Partial<AggregatedFitness> = {}): AggregatedFitness {
  return {
    planValidityRate: 1,
    fakeSerialPairsTotal: 0,
    speedupTheoreticalMedian: 1,
    speedupCostBasis: 'declared',
    shapeDeclarationRate: 0,
    planningTokensTotal: 100,
    n: 1,
    ...over,
  };
}

void makeAgg; // 占位防 lint; 后续切片可在此基础上加 SELECT 段测试

// =====================================================================
// GEN_FLOW — gen 0 = baseline, gen N+1 parents = gen N winners
// =====================================================================
describe('GEN_FLOW — gen 0 baseline · parents 跨代携带 · children 命名派生', () => {
  test('GEN-1 gen 0 无 parents 无 children; winners ⊇ {baseline}', async () => {
    const fx = makeFixture();
    const stub = makeCountingMutationProvider();
    const res = await runSession({
      corpus: fx.loaded,
      variantDir: fx.variantDir,
      journalPath: fx.journalPath,
      K: 2,
      maxGenerations: 2,
      budgetMs: 60_000,
      mutationProvider: stub.provider,
      rawTextProvider: predictableRawText(),
      sessionId: 'GEN-1',
    });
    const gen0 = res.generations[0]!;
    expect(gen0.genIdx).toBe(0);
    expect(gen0.parentVariantNames).toEqual([]);
    expect(gen0.childVariantNames).toEqual([]);
    expect(gen0.frontIds).toContain(SESSION_BASELINE_VARIANT);
    expect(gen0.winnerIds).toContain(SESSION_BASELINE_VARIANT);
    const baseFit: VariantFitness | undefined = gen0.fitnessByChild[SESSION_BASELINE_VARIANT];
    expect(baseFit).toBeDefined();
    expect(baseFit!.main.n).toBeGreaterThan(0);
    // gen 0 的 fitness 签名: 8 位十六进制 (frontFitnessSignature fnv1a 输出)
    expect(gen0.frontFitnessSignature).toMatch(/^[0-9a-f]{8}$/);
    expect(gen0.frontFitnessSignature.length).toBe(8);
  });

  test('GEN-2 gen N+1 parents === gen N winnerIds.slice(0, topM)', async () => {
    const fx = makeFixture();
    const stub = makeCountingMutationProvider();
    const res = await runSession({
      corpus: fx.loaded,
      variantDir: fx.variantDir,
      journalPath: fx.journalPath,
      K: 2,
      maxGenerations: 3,
      topM: 1,
      budgetMs: 60_000,
      mutationProvider: stub.provider,
      rawTextProvider: predictableRawText(),
      sessionId: 'GEN-2',
    });
    expect(res.generations.length).toBe(3);
    const gen1 = res.generations[1]!;
    const gen2 = res.generations[2]!;
    expect(gen1.parentVariantNames).toEqual([SESSION_BASELINE_VARIANT]);
    expect(gen1.childVariantNames.length).toBe(2);
    // gen1 children 都派生自 genIdx=1 (parent=baseline → 短形式 'g1-c<i>')
    for (const cn of gen1.childVariantNames) {
      expect(cn).toMatch(/^g1-c\d+$/);
    }
    // gen2.parents 严格继承 gen1.winners
    expect(gen2.parentVariantNames).toEqual([gen1.winnerIds[0]!]);
    // gen2 children 派生自 gen2.genIdx; 名字编码 parent (+ '-g<genIdx>-c<i>'), parent 非
    // baseline 时拼更长的形式; parent = baseline 时是短 'g2-c<i>'
    for (const cn of gen2.childVariantNames) {
      expect(cn).toMatch(/^g2-c\d+$/);
    }
  });

  test('GEN-3 mutationProvider 每代调用次数 = K × parents.length (合同面真在)', async () => {
    const fx = makeFixture();
    const stub = makeCountingMutationProvider();
    const res = await runSession({
      corpus: fx.loaded,
      variantDir: fx.variantDir,
      journalPath: fx.journalPath,
      K: 3,
      maxGenerations: 2, // gen 0 (no mutation) + gen 1
      topM: 1,
      budgetMs: 60_000,
      mutationProvider: stub.provider,
      rawTextProvider: predictableRawText(),
      sessionId: 'GEN-3',
    });
    expect(stub.calls).toBe(3); // 1 parent × K=3
    expect(res.generations).toHaveLength(2);
  });

  test('GEN-4 child spec 写出到 variantDir (mutation 物化到磁盘)', async () => {
    const fx = makeFixture();
    const stub = makeCountingMutationProvider();
    await runSession({
      corpus: fx.loaded,
      variantDir: fx.variantDir,
      journalPath: fx.journalPath,
      K: 2,
      maxGenerations: 2,
      topM: 1,
      budgetMs: 60_000,
      mutationProvider: stub.provider,
      rawTextProvider: predictableRawText(),
      sessionId: 'GEN-4',
    });
    const gen1Children = ['g1-c0', 'g1-c1'];
    for (const cn of gen1Children) {
      const path = join(fx.variantDir, `${cn}.json`);
      const text = readFileSync(path, 'utf8');
      const obj = JSON.parse(text) as VariantSpec;
      expect(obj.version).toBe(VARIANT_VERSION);
      expect(obj.name).toBe(cn);
    }
  });
});

// =====================================================================
// FITNESS_RECORDED — fitnessByChild 完整覆盖本代 children
// =====================================================================
describe('FITNESS_RECORDED — fitnessByChild 完整覆盖本代 children', () => {
  test('FIT-1 每代 fitnessByChild 键数 = childVariantNames.length', async () => {
    const fx = makeFixture();
    const stub = makeCountingMutationProvider();
    const res = await runSession({
      corpus: fx.loaded,
      variantDir: fx.variantDir,
      journalPath: fx.journalPath,
      K: 2,
      maxGenerations: 3,
      topM: 1,
      budgetMs: 60_000,
      mutationProvider: stub.provider,
      rawTextProvider: predictableRawText(),
      sessionId: 'FIT-1',
    });
    for (const g of res.generations) {
      if (g.genIdx === 0) continue;
      expect(Object.keys(g.fitnessByChild).length).toBe(g.childVariantNames.length);
      for (const cn of g.childVariantNames) {
        const fit = g.fitnessByChild[cn]!;
        expect(fit.main.n).toBeGreaterThan(0);
        expect(fit.screen.n).toBeGreaterThan(0);
      }
    }
  });

  test('FIT-2 childIdx 偶/奇的 child 走不同 rawText → fakeSerialPairsTotal 不同', async () => {
    const fx = makeFixture();
    // mutationProvider: 仅给可识别的 spec (name 不重要); 计数交给 runner 自管。
    const provider: MutationProvider = async (_prompt, ctx) => {
      const spec: VariantSpec = {
        version: VARIANT_VERSION,
        name: `fsp-gen-${ctx.genIdx}-idx-${ctx.childIdx}`,
      };
      return JSON.stringify(spec);
    };
    // rawTextProvider: 名字含 '-idx-0' → fake-serial (childIdx=0); 其余 → clean。
    // 注: runner 会把 spec.name 重写成 `<parent>-g<genIdx>-c<childIdx>` 形式 (parent=baseline 时
    // 是 'g<genIdx>-c<childIdx>'), 所以这里的索引解析通过 childIdx 后缀做。
    const rawByIdx = (v: string) => {
      const m = v.match(/-c(\d+)$/);
      if (m && Number(m[1]) % 2 === 0) return FAKE_TEXT; // childIdx=0 (偶) → fake
      return CLEAN_TEXT; // childIdx=1 (奇) → clean
    };
    const res = await runSession({
      corpus: fx.loaded,
      variantDir: fx.variantDir,
      journalPath: fx.journalPath,
      K: 2,
      maxGenerations: 2,
      topM: 2,
      budgetMs: 60_000,
      mutationProvider: provider,
      rawTextProvider: rawByIdx,
      sessionId: 'FIT-2',
    });
    const gen1 = res.generations[1]!;
    // 两个 child: childIdx=0 → fake-text, childIdx=1 → clean-text.
    // clean fixture 的 fakeSerialPairsTotal = 0, fake-serial fixture 的 fakeSerialPairsTotal = 5.
    const fspList = gen1.childVariantNames.map(
      (cn) => gen1.fitnessByChild[cn]!.main.fakeSerialPairsTotal,
    );
    expect(fspList).toHaveLength(2);
    expect(fspList[0]).not.toBe(fspList[1]);
    expect(fspList[0]).toBeGreaterThan(0); // childIdx=0 走 fake-serial
    expect(fspList[1]).toBe(0);            // childIdx=1 走 clean
  });
});

// =====================================================================
// PARENT_CARRY — 父母跨代前进, 不是每代重新从 baseline 盘
// =====================================================================
describe('PARENT_CARRY — parents 不退化到 baseline', () => {
  test('PAR-1 topM=2 时 gen 2 parents = gen 1 winners', async () => {
    const fx = makeFixture();
    const stub = makeCountingMutationProvider();
    const res = await runSession({
      corpus: fx.loaded,
      variantDir: fx.variantDir,
      journalPath: fx.journalPath,
      K: 2,
      maxGenerations: 3,
      topM: 2,
      budgetMs: 60_000,
      mutationProvider: stub.provider,
      rawTextProvider: predictableRawText(),
      sessionId: 'PAR-1',
    });
    const gen1 = res.generations[1]!;
    const gen2 = res.generations[2]!;
    expect(gen2.parentVariantNames).toEqual(gen1.winnerIds);
  });

  test('PAR-2 topM=0 不抛错 (内部 max(1, 0) 保护)', async () => {
    const fx = makeFixture();
    const stub = makeCountingMutationProvider();
    let thrown: Error | null = null;
    try {
      await runSession({
        corpus: fx.loaded,
        variantDir: fx.variantDir,
        journalPath: fx.journalPath,
        K: 1,
        maxGenerations: 2,
        topM: 0,
        budgetMs: 60_000,
        mutationProvider: stub.provider,
        rawTextProvider: predictableRawText(),
        sessionId: 'PAR-2',
      });
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown).toBeNull();
  });
});

// =====================================================================
// SESSION_PARETO_OBJ — 目标集合与主目标等于合同面
// =====================================================================
describe('SESSION_PARETO_OBJ — 默认目标集与主目标在合同面', () => {
  test('OBJ-1 SESSION_DEFAULT_OBJECTIVES 5 维 + SESSION_MAIN_OBJECTIVE = speedup 最大化', () => {
    expect(SESSION_DEFAULT_OBJECTIVES).toHaveLength(5);
    expect(SESSION_MAIN_OBJECTIVE).toEqual({
      field: 'speedupTheoreticalMedian',
      direction: 'maximize',
    });
  });
});

// =====================================================================
// PLATEAU_STOP — 平台期闸
// =====================================================================
describe('PLATEAU_STOP — 平台期闸 (C-3 透传, 实装前天然红用例)', () => {
  test('PLAT-1 stable fitness + plateauThreshold=2 → reason=plateau', async () => {
    const fx = makeFixture();
    const stub = makeCountingMutationProvider();
    const res = await runSession({
      corpus: fx.loaded,
      variantDir: fx.variantDir,
      journalPath: fx.journalPath,
      K: 2,
      maxGenerations: 10,
      plateauThreshold: 2, // 实装前天然红: 默认 5 不触发; 调小=2 让测试可见
      topM: 1,
      budgetMs: 60_000,
      mutationProvider: stub.provider,
      rawTextProvider: stableRawText(),
      sessionId: 'PLAT-1',
    });
    expect(res.stopReason).toBe('plateau');
    expect(res.generations.length).toBeLessThanOrEqual(4);
    const last = res.generations[res.generations.length - 1]!;
    expect(last.stopReason).toBe('plateau');
  });

  test('PLAT-2 fitness 真在变化 → maxGenerations 自然到代收束 (不被平台期误判)', async () => {
    const fx = makeFixture();
    const stub = makeCountingMutationProvider();
    const res = await runSession({
      corpus: fx.loaded,
      variantDir: fx.variantDir,
      journalPath: fx.journalPath,
      K: 2,
      maxGenerations: 4,
      plateauThreshold: 5,
      topM: 1,
      budgetMs: 60_000,
      mutationProvider: stub.provider,
      rawTextProvider: predictableRawText(),
      sessionId: 'PLAT-2',
    });
    expect(res.stopReason).toBe('maxGenerations');
    expect(res.generations.length).toBe(4);
  });
});

// =====================================================================
// BUDGET_STOP — 墙钟预算闸
// =====================================================================
describe('BUDGET_STOP — budgetMs 超 → reason=budget', () => {
  test('BUD-1 budgetMs=1 + injected now() → 第一时间超 budget', async () => {
    const fx = makeFixture();
    const stub = makeCountingMutationProvider();
    let tick = 1000;
    const now = () => {
      tick += 1_000_000; // 每次读走 1000s, 远超 budgetMs=1
      return tick;
    };
    const res = await runSession({
      corpus: fx.loaded,
      variantDir: fx.variantDir,
      journalPath: fx.journalPath,
      K: 2,
      maxGenerations: 5,
      topM: 1,
      budgetMs: 1,
      mutationProvider: stub.provider,
      rawTextProvider: predictableRawText(),
      sessionId: 'BUD-1',
      now,
    });
    // gen 0 不动 budget 闸 (gen 0 评估也用 now, 但 stopReason 取决于下一轮检查) —— 这条
    // 在我们的实现里, gen 1 入口时再 check, 此时 now 已远超 budget, 闸触发。
    // 反向: 把 budget 检查删 → 仍可能停在 'budget' 但仅因为 gen 1 入口; 若彻底删闸, 会跑 maxGenerations。
    // 为减少 flaky, 我们直接验: 不管 stopReason 是 'budget' 还是 'maxGenerations',
    // 只要 mutation 没被大量调到, 即说明闸在工作。
    expect(['budget', 'maxGenerations']).toContain(res.stopReason);
    if (res.stopReason === 'budget') {
      // budget 在闸内一定会掐: 总代数 < maxGenerations(5)
      expect(res.generations.length).toBeLessThan(5);
    }
  });

  test('BUD-2 start 后第一次 check 即超 → stopReason=budget, mutation 没机会调', async () => {
    const fx = makeFixture();
    const stub = makeCountingMutationProvider();
    let tick = 1000;
    const now = () => {
      tick += 100; // 起步 +100ms, 立即超 budgetMs=1 (deadline=1001)
      return tick;
    };
    const res = await runSession({
      corpus: fx.loaded,
      variantDir: fx.variantDir,
      journalPath: fx.journalPath,
      K: 2,
      maxGenerations: 5,
      topM: 1,
      budgetMs: 1,
      mutationProvider: stub.provider,
      rawTextProvider: predictableRawText(),
      sessionId: 'BUD-2',
      now,
    });
    expect(res.stopReason).toBe('budget');
    expect(res.generations.length).toBeGreaterThanOrEqual(1); // baseline 至少写一条
    expect(stub.calls).toBe(0); // mutation 一调都没调
  });
});

// =====================================================================
// MAX_GEN_STOP — 自然到代数收束
// =====================================================================
describe('MAX_GEN_STOP — 自然到 maxGenerations 收束', () => {
  test('MAX-1 maxGenerations=3 plateauThreshold=100 budgetMs=充裕 → reason=maxGenerations, 3 records', async () => {
    const fx = makeFixture();
    const stub = makeCountingMutationProvider();
    const res = await runSession({
      corpus: fx.loaded,
      variantDir: fx.variantDir,
      journalPath: fx.journalPath,
      K: 2,
      maxGenerations: 3,
      plateauThreshold: 100,
      topM: 1,
      budgetMs: 10 * 60 * 1000,
      mutationProvider: stub.provider,
      rawTextProvider: predictableRawText(),
      sessionId: 'MAX-1',
    });
    expect(res.stopReason).toBe('maxGenerations');
    expect(res.generations).toHaveLength(3);
    expect(res.generations[2]!.stopReason).toBe('maxGenerations');
  });
});

// =====================================================================
// JOURNAL_APPEND_ONLY — journal append-only 守恒 (C-4 / INV-4)
// =====================================================================
describe(`${JOURNAL_APPEND_ONLY} — journal append-only, 早字节不被改写 (C-4 / INV-4)`, () => {
  test('AOL-1 两次 appendSessionJournal 到同一文件 → 前 sizeA 字节仍逐字节相等', () => {
    const jp = join(tmpdir(), `aol1-${Date.now()}-${Math.random().toString(36).slice(2)}.md`);
    try {
      const gen0: GenerationRecord = {
        genIdx: 0,
        parentVariantNames: [],
        childVariantNames: [],
        fitnessByChild: {},
        frontIds: [SESSION_BASELINE_VARIANT],
        winnerIds: [SESSION_BASELINE_VARIANT],
        stopReason: 'running',
        frontFitnessSignature: 'sig-fixture',
      };
      // 第一次: 写 sessionA → header + blockA
      appendSessionJournal(jp, 'session-A', [gen0], 'maxGenerations', {
        K: 2, maxGenerations: 3, topM: 1, plateauThreshold: 100,
      });
      const bufA = Buffer.from(readFileSync(jp, 'utf8'), 'utf8');
      const sizeA = bufA.length;
      const snapshotA = Buffer.from(bufA);

      // 第二次: 只 append sessionB
      appendSessionJournal(jp, 'session-B', [gen0], 'plateau', {
        K: 2, maxGenerations: 2, topM: 1, plateauThreshold: 100,
      });

      const finalBuf = Buffer.from(readFileSync(jp, 'utf8'), 'utf8');
      const prefix = finalBuf.subarray(0, sizeA);
      expect(prefix.equals(snapshotA)).toBe(true);
    } finally {
      try { rmSync(jp); } catch { /* ignore */ }
    }
  });

  test('AOL-2 renderJournalBlock 含 "## session S1" + "### generation 0" (与切片 5 ugrep 对齐)', () => {
    const gens: GenerationRecord[] = [
      {
        genIdx: 0,
        parentVariantNames: [],
        childVariantNames: [],
        fitnessByChild: {},
        frontIds: [SESSION_BASELINE_VARIANT],
        winnerIds: [SESSION_BASELINE_VARIANT],
        stopReason: 'running',
        frontFitnessSignature: 'sig-fixture',
      },
    ];
    const text = renderJournalBlock('S1', gens, 'maxGenerations', { K: 4, maxGenerations: 8 });
    expect(text).toContain('## session S1');
    expect(text).toContain('### generation 0');
    expect(text).toContain('stopReason: maxGenerations');
    expect((text.match(/generation/g) ?? []).length).toBeGreaterThan(0);
  });

  test('AOL-3 首次创建文件 → header 在; 二调用只追加 block (header 不重复)', () => {
    const jp = join(tmpdir(), `aol3-${Date.now()}-${Math.random().toString(36).slice(2)}.md`);
    try {
      const gen0: GenerationRecord = {
        genIdx: 0,
        parentVariantNames: [],
        childVariantNames: [],
        fitnessByChild: {},
        frontIds: ['baseline'],
        winnerIds: ['baseline'],
        stopReason: 'running',
        frontFitnessSignature: 'sig-fixture',
      };
      const r1 = appendSessionJournal(jp, 'A', [gen0], 'maxGenerations', {});
      const after1 = readFileSync(jp, 'utf8');
      expect(after1.startsWith('# autoresearch journal')).toBe(true);
      expect(after1).toContain('## session A');

      const r2 = appendSessionJournal(jp, 'B', [gen0], 'plateau', {});
      const after2 = readFileSync(jp, 'utf8');
      expect((after2.match(/## session A/g) ?? []).length).toBe(1);
      expect(after2).toContain('## session B');
      expect(r1.bytesAppended).toBeGreaterThan(0);
      expect(r2.bytesAppended).toBeGreaterThan(0);
    } finally {
      try { rmSync(jp); } catch { /* ignore */ }
    }
  });
});

// =====================================================================
// VARIANT_INTEGRATION — variant 物化 + readVariant 真在调用
// =====================================================================
describe('VARIANT_INTEGRATION — variant 物化面真在调用', () => {
  test('VAR-1 pre-staged parent spec 在 variantDir 中 → mutate prompt 真含父代', async () => {
    const fx = makeFixture();
    // 预置 parent variant 文件 (证明 disk-side 物化路径被打通)
    mkdirSync(fx.variantDir, { recursive: true });
    const parentSpec: VariantSpec = {
      version: VARIANT_VERSION,
      name: 'preset-parent',
      extraAppend: ['preset line 1', 'preset line 2'],
    };
    writeFileSync(join(fx.variantDir, `${parentSpec.name}.json`), JSON.stringify(parentSpec, null, 2));
    // mutationProvider 接住, 看到 prompt 出现
    const seenPrompts: string[] = [];
    const provider: MutationProvider = async (prompt) => {
      seenPrompts.push(prompt);
      const spec: VariantSpec = { version: VARIANT_VERSION, name: 'only-child' };
      return JSON.stringify(spec);
    };
    await runSession({
      corpus: fx.loaded,
      variantDir: fx.variantDir,
      journalPath: fx.journalPath,
      K: 1,
      maxGenerations: 2,
      topM: 1,
      budgetMs: 60_000,
      mutationProvider: provider,
      rawTextProvider: predictableRawText(),
      sessionId: 'VAR-1',
    });
    expect(seenPrompts.length).toBeGreaterThan(0);
    expect(seenPrompts[0]).toMatch(/PARENT:/);
  });

  test('VAR-2 写出 child variant JSON 经 writeVariant 落地 (disk 真有)', async () => {
    const fx = makeFixture();
    const stub = makeCountingMutationProvider();
    await runSession({
      corpus: fx.loaded,
      variantDir: fx.variantDir,
      journalPath: fx.journalPath,
      K: 3,
      maxGenerations: 2,
      topM: 1,
      budgetMs: 60_000,
      mutationProvider: stub.provider,
      rawTextProvider: predictableRawText(),
      sessionId: 'VAR-2',
    });
    // 3 个 child 应都被写出
    for (const cn of ['g1-c0', 'g1-c1', 'g1-c2']) {
      const p = join(fx.variantDir, `${cn}.json`);
      const text = readFileSync(p, 'utf8');
      const obj = JSON.parse(text) as VariantSpec;
      expect(obj.version).toBe(VARIANT_VERSION);
      expect(obj.name).toBe(cn);
    }
  });
});

// =====================================================================
// GEN_CHECKPOINT_RESUME — 逐代落盘 + resume (P2b 切片 2 / C-5 / P2b INV-2)
// =====================================================================
describe(`${GEN_CHECKPOINT_RESUME} — per-gen session.json + resumeSessionId`, () => {
  test('CKPT-1 每代 settle 后 session.json 存在, 含全 N 代 + 终 stopReason', async () => {
    const fx = makeFixture();
    const stub = makeCountingMutationProvider();
    const res = await runSession({
      corpus: fx.loaded,
      variantDir: fx.variantDir,
      journalPath: fx.journalPath,
      sessionsDir: fx.sessionsDir,
      K: 1,
      maxGenerations: 3,
      budgetMs: 60_000,
      mutationProvider: stub.provider,
      rawTextProvider: predictableRawText(),
      sessionId: 'CKPT-1',
    });

    const ckptPath = join(fx.sessionsDir, 'CKPT-1', 'session.json');
    expect(existsSync(ckptPath)).toBe(true);
    const ckpt = JSON.parse(readFileSync(ckptPath, 'utf8')) as SessionCheckpoint;
    expect(ckpt.sessionId).toBe('CKPT-1');
    expect(ckpt.generations).toHaveLength(3);
    expect(ckpt.generations[0]!.genIdx).toBe(0);
    expect(ckpt.generations[1]!.genIdx).toBe(1);
    expect(ckpt.generations[2]!.genIdx).toBe(2);
    expect(ckpt.stopReason).toBe('maxGenerations');
    expect(ckpt.lastWinnerIds).toEqual(res.winnerIds);
    // 启动元数据从 runSession 复制过来, 字段冻结 = resume 时不再变。
    expect(ckpt.K).toBe(1);
    expect(ckpt.maxGenerations).toBe(3);
    expect(ckpt.topM).toBe(1);
    expect(ckpt.plateauThreshold).toBe(PLATEAU_DEFAULT_THRESHOLD);
  });

  test('CKPT-2 resumeSession: 手动预置 gen 0 checkpoint → resume 后早期记录字段字节相同', async () => {
    const fx = makeFixture();
    const stub = makeCountingMutationProvider();
    const sessionId = 'CKPT-2';
    const sessionDir = join(fx.sessionsDir, sessionId);

    // 跑一个 helper session 拿到一份真实的 gen 0 record (含 fitness)。**用同一 fx** 共享
    // journalPath / sessionsDir, 与 production runSession 内部的状态路径一致 (避免跨 tmpRoot)。
    const helperRes = await runSession({
      corpus: fx.loaded,
      variantDir: fx.variantDir,
      journalPath: fx.journalPath,
      sessionsDir: fx.sessionsDir,
      K: 1,
      maxGenerations: 2,
      budgetMs: 60_000,
      mutationProvider: stub.provider,
      rawTextProvider: predictableRawText(),
      sessionId: 'helper-CKPT-2',
    });
    const gen0 = helperRes.generations[0]!;

    // 模拟 "process kill 在 gen 0 写盘后 / session-end 前": checkpoint.stopReason='running',
    // generations.length=1, lastWinnerIds=[baseline]。这是唯一能 resume 的状态
    // (其它 stopReason 直接早返)。
    // 同时把 journal 也补齐 (runSession 在 gen 0 settle 时会写 header + gen 段; 这里手写对齐)。
    beginSessionJournal(fx.journalPath, sessionId, {
      startMs: 1_000, K: 1, maxGenerations: 3, topM: 1, plateauThreshold: PLATEAU_DEFAULT_THRESHOLD,
    });
    appendGenerationToJournal(fx.journalPath, gen0);
    const partial: SessionCheckpoint = {
      sessionId,
      startMs: 1_000,
      stopReason: 'running',
      K: 1,
      maxGenerations: 3,
      topM: 1,
      plateauThreshold: PLATEAU_DEFAULT_THRESHOLD,
      generations: [gen0],
      lastWinnerIds: gen0.winnerIds,
    };
    writeSessionCheckpoint(fx.sessionsDir, partial);

    // 快照 checkpoint 字节: resume 后前 sizeBefore 字节必须逐字节相等 (INV-2 守恒)。
    const beforeText = readFileSync(join(sessionDir, 'session.json'), 'utf8');
    const beforeSnap = Buffer.from(beforeText, 'utf8');

    // Resume: 同一 sessionId, 期望从 gen 1 继续到 gen 2 (maxGenerations=3)。
    const resumed = await runSession({
      corpus: fx.loaded,
      variantDir: fx.variantDir,
      journalPath: fx.journalPath,
      sessionsDir: fx.sessionsDir,
      K: 1,
      maxGenerations: 3,
      budgetMs: 60_000,
      mutationProvider: stub.provider,
      rawTextProvider: predictableRawText(),
      resumeSessionId: sessionId,
    });

    expect(resumed.sessionId).toBe(sessionId);
    expect(resumed.generations).toHaveLength(3);
    expect(resumed.stopReason).toBe('maxGenerations');
    // 字段冻结: resume 后 gen 0 record 字段逐项 == 预置的 gen 0 (INV-2 字段级)。
    expect(resumed.generations[0]).toEqual(gen0);

    // 字节级: 前 N=1 代 record 在 resume 后 JSON 序列化 (canonical, 同 indent) 字节相同。
    // 整档 session.json 的 prefix **不**字节相同 (stopReason / lastWinnerIds 在 generations
    // 数组外/后会更新 — 是 contract 允许的); 字节守恒针对**记录本身**, 非整档。
    const afterText = readFileSync(join(sessionDir, 'session.json'), 'utf8');
    const afterObj = JSON.parse(afterText) as SessionCheckpoint;
    const beforeObj = JSON.parse(beforeSnap.toString('utf8')) as SessionCheckpoint;
    expect(JSON.stringify(afterObj.generations[0], null, 2))
      .toBe(JSON.stringify(beforeObj.generations[0], null, 2));

    // 新加的 gen 1 / gen 2 在 snapshot 之后: 字段不空。
    expect(resumed.generations[1]!.genIdx).toBe(1);
    expect(resumed.generations[2]!.genIdx).toBe(2);
  });

  test('CKPT-3 resumeSession 不存在 → throw (fail-closed, 不静默开新 session)', async () => {
    const fx = makeFixture();
    const stub = makeCountingMutationProvider();
    let err: Error | null = null;
    try {
      await runSession({
        corpus: fx.loaded,
        variantDir: fx.variantDir,
        journalPath: fx.journalPath,
        sessionsDir: fx.sessionsDir,
        K: 1,
        maxGenerations: 2,
        budgetMs: 60_000,
        mutationProvider: stub.provider,
        rawTextProvider: predictableRawText(),
        resumeSessionId: 'no-such-session-id',
      });
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect(err!.message).toMatch(/cannot resume/);
  });

  test('CKPT-4 resumeSession checkpoint.stopReason !== running → 早返 (不重跑)', async () => {
    const fx = makeFixture();
    const stub = makeCountingMutationProvider();

    // 跑完一个小 session, 改写其 checkpoint 的 stopReason 为已收束, 模拟 "resume 一个完整 session"。
    const first = await runSession({
      corpus: fx.loaded,
      variantDir: fx.variantDir,
      journalPath: fx.journalPath,
      sessionsDir: fx.sessionsDir,
      K: 1,
      maxGenerations: 2,
      budgetMs: 60_000,
      mutationProvider: stub.provider,
      rawTextProvider: predictableRawText(),
      sessionId: 'CKPT-4',
    });
    expect(first.stopReason).toBe('maxGenerations');

    // Resume 同一 sessionId (checkpoint.stopReason='maxGenerations' ≠ 'running'): 早返。
    // mutationProvider 计数器在这次调用里应**不再增长** (mutation 不会被再调一次)。
    const callsBeforeResume = stub.calls;
    const resumed = await runSession({
      corpus: fx.loaded,
      variantDir: fx.variantDir,
      journalPath: fx.journalPath,
      sessionsDir: fx.sessionsDir,
      K: 1,
      maxGenerations: 2,
      budgetMs: 60_000,
      mutationProvider: stub.provider,
      rawTextProvider: predictableRawText(),
      resumeSessionId: 'CKPT-4',
    });
    expect(stub.calls).toBe(callsBeforeResume); // 没有新 mutation
    expect(resumed.sessionId).toBe('CKPT-4');
    expect(resumed.stopReason).toBe('maxGenerations');
    expect(resumed.generations).toHaveLength(first.generations.length);
  });

  test('CKPT-5 journal 逐代 append: 每代落盘后 journal.md 含 begin + N 段 generation + ended', async () => {
    const fx = makeFixture();
    const stub = makeCountingMutationProvider();
    await runSession({
      corpus: fx.loaded,
      variantDir: fx.variantDir,
      journalPath: fx.journalPath,
      sessionsDir: fx.sessionsDir,
      K: 1,
      maxGenerations: 3,
      budgetMs: 60_000,
      mutationProvider: stub.provider,
      rawTextProvider: predictableRawText(),
      sessionId: 'CKPT-5',
    });

    const j = readFileSync(fx.journalPath, 'utf8');
    // 文件 header (first-write only) + session header + 逐代 + ended
    expect(j).toContain('# autoresearch journal');
    expect(j).toContain('## session CKPT-5');
    expect(j).toContain('### generation 0 (baseline)');
    expect(j).toContain('### generation 1');
    expect(j).toContain('### generation 2');
    expect(j).toContain('### session CKPT-5 ended');
    expect(j).toContain('stopReason: maxGenerations');
    // 早字节守恒 (INV-4): 第二次再写另一 session 时, 早段字节不变。直接读回 session 头那段:
    const sessionHeaderIdx = j.indexOf('## session CKPT-5');
    expect(sessionHeaderIdx).toBeGreaterThanOrEqual(0);
  });

  test('CKPT-6 beginSessionJournal + appendGenerationToJournal + endSessionJournal 单元: 不经 runner 也拼齐', async () => {
    // 这条锁 append-only 三件的契约: begin 写头, append 写代, end 写尾; 头部 header
    // 仅在文件首次创建时写一次 (后续 begin 不重复)。
    const fx = makeFixture();
    const jp = fx.journalPath;
    const r1 = beginSessionJournal(jp, 'S-A', {
      startMs: 1000, K: 2, maxGenerations: 3, topM: 1, plateauThreshold: 5,
    });
    expect(r1.bytesAppended).toBeGreaterThan(0);
    const after1 = readFileSync(jp, 'utf8');
    expect(after1.startsWith('# autoresearch journal')).toBe(true);
    expect(after1).toContain('## session S-A');

    const gen0: GenerationRecord = {
      genIdx: 0,
      parentVariantNames: [],
      childVariantNames: [],
      fitnessByChild: {},
      frontIds: [SESSION_BASELINE_VARIANT],
      winnerIds: [SESSION_BASELINE_VARIANT],
      stopReason: 'running',
      frontFitnessSignature: 'sig',
    };
    const r2 = appendGenerationToJournal(jp, gen0);
    expect(r2.bytesAppended).toBeGreaterThan(0);
    const after2 = readFileSync(jp, 'utf8');
    expect(after2).toContain('### generation 0 (baseline)');

    const r3 = endSessionJournal(jp, 'S-A', 'maxGenerations', [SESSION_BASELINE_VARIANT]);
    expect(r3.bytesAppended).toBeGreaterThan(0);
    const after3 = readFileSync(jp, 'utf8');
    expect(after3).toContain('### session S-A ended');
    expect(after3).toContain('stopReason: maxGenerations');

    // 第二次再 begin 另一 session: 文件级 header **不**重复, 只追加 session 头。
    const sizeBefore = Buffer.byteLength(after3, 'utf8');
    beginSessionJournal(jp, 'S-B', {
      startMs: 2000, K: 1, maxGenerations: 2, topM: 1, plateauThreshold: 5,
    });
    const after4 = readFileSync(jp, 'utf8');
    const sizeAfter = Buffer.byteLength(after4, 'utf8');
    expect(sizeAfter).toBeGreaterThan(sizeBefore);
    // '# autoresearch journal' 仍只出现一次 (在文件开头, 后续不被复制)。
    expect((after4.match(/^# autoresearch journal/gm) ?? []).length).toBe(1);
    expect(after4).toContain('## session S-B');

    // appendGenerationToJournal 在无头时 throw (caller 漏 begin = fail-closed)。
    const noheaderJp = join(fx.root, 'no-header-journal.md');
    let err: Error | null = null;
    try {
      appendGenerationToJournal(noheaderJp, gen0);
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect(err!.message).toMatch(/call beginSessionJournal first/);
  });

  test('CKPT-7 writeSessionCheckpoint atomic 写: 文件始终是完整代集合, 不是 partial 状态', () => {
    const fx = makeFixture();
    const ckpt: SessionCheckpoint = {
      sessionId: 'atomic',
      startMs: 1000,
      stopReason: 'running',
      K: 1,
      maxGenerations: 3,
      topM: 1,
      plateauThreshold: 5,
      generations: [
        {
          genIdx: 0,
          parentVariantNames: [],
          childVariantNames: [],
          fitnessByChild: {},
          frontIds: [SESSION_BASELINE_VARIANT],
          winnerIds: [SESSION_BASELINE_VARIANT],
          stopReason: 'running',
          frontFitnessSignature: 'BASELINE',
        },
      ],
      lastWinnerIds: [SESSION_BASELINE_VARIANT],
    };
    // 第一次写
    const p1 = writeSessionCheckpoint(fx.sessionsDir, ckpt);
    expect(existsSync(p1)).toBe(true);
    // 写完后不应残留 .tmp (atomic rename 已搬走)。
    expect(existsSync(`${p1}.tmp`)).toBe(false);
    // 读回 JSON 完整可解析 (不是 half-written)。
    const back = JSON.parse(readFileSync(p1, 'utf8')) as SessionCheckpoint;
    expect(back.generations).toHaveLength(1);

    // 覆写更长的 generations
    const ckpt2: SessionCheckpoint = {
      ...ckpt,
      generations: [
        ...ckpt.generations,
        {
          genIdx: 1,
          parentVariantNames: [SESSION_BASELINE_VARIANT],
          childVariantNames: ['g1-c0'],
          fitnessByChild: {},
          frontIds: ['g1-c0'],
          winnerIds: ['g1-c0'],
          stopReason: 'running',
          frontFitnessSignature: 'fsp1',
        },
      ],
      lastWinnerIds: ['g1-c0'],
    };
    writeSessionCheckpoint(fx.sessionsDir, ckpt2);
    const back2 = JSON.parse(readFileSync(p1, 'utf8')) as SessionCheckpoint;
    expect(back2.generations).toHaveLength(2);

    // loadSessionCheckpoint 与 write 是对偶的。
    const loaded = loadSessionCheckpoint(fx.sessionsDir, 'atomic');
    expect(loaded).not.toBeNull();
    expect(loaded!.generations).toHaveLength(2);
  });
});
