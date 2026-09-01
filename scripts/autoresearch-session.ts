#!/usr/bin/env bun
/**
 * scripts/autoresearch-session —— autoresearch 进化内环 session runner (P2 切片 4, 2026-09-01)。
 *
 * 把 variant 物化 (s1) · 变异算子 (s2) · 选择器 (s3) 串成一条 session:
 *   第 0 代基线 → 变异 K → 粗筛/主段评估 → 选择 → journal append → 平台期/预算/代数收束。
 *
 * ## 契约对照
 *
 *   - C-1 / INV-1: variant 物化经 readVariant → variantSpecToPromptOpts 注入 opts;
 *     默认 rawTextProvider 是 stub (零 LLM), live 路径由 caller 装 rawTextProvider
 *     (切片 5 接联机时改注入点, 本切片**测试零冒烟**)。
 *   - C-2 / INV-2: 通过 opts.mutationProvider 注入, 默认 = mutate.ts 的 defaultMutationProvider
 *     (主动 throw, 防静默回落)。
 *   - C-3 / INV-3: 选择器零 LLM, 默认 Pareto 5 维 + speedup 主目标, 平台期 = PLATEAU_DEFAULT_THRESHOLD。
 *   - C-4 / INV-4: appendSessionJournal 用 appendFileSync; 文件不存在 → writeFileSync;
 *     之后**只追加**, 早字节不被改写 (本测试 JOURNAL_APPEND_ONLY 那条验)。
 *
 * ## 噪声纪律
 *
 * screen 段 (n≈6) 双跑方差 ≈ validity 0.17 / speedup 0.45 (P1 稳定性读数)。粗筛只在
 * "差距显著大于此" 时淘汰 (planValidityRate=0 显然失败之类); 含糊的全部带进 main。
 * **selection 只在 main 段读数上做** (select.ts 的 topKByMainObjective 在 main 的 aggregate 上跑)。
 *
 * ## 反向自检 (锁死判据力)
 *
 *   - JOURNAL_APPEND_ONLY: 把 appendSessionJournal 改成 'w' 全覆盖写入 → 早字节被改
 *     写 → 那条红; 把 appendSessionJournal 改成覆盖已有部分 → 同红;
 *   - SESSION_GEN_FLOW: 把 gen 0 的 childVariantNames 留空那行删, 让 gen 0 也 "变异" →
 *     红 (gen 0 = 基线, 没父代, 不该出 children);
 *   - SESSION_PARENT_CARRY: 把 parents 选 winners 改成固定返 'baseline' → 整条树退化成
 *     单分支 → 红 (父母应该跨代前进, 不是每代重新盘);
 *   - SESSION_PLATEAU_STOP: 把 isPlateau 改成永远 false → 平台期 fixture 跑到 maxGenerations
 *     自然收束 → 红 (平台期真在生效, 不是恒真收束);
 *   - SESSION_BUDGET_STOP: 把 budget 检查删了 → budgetMs=1 fixture 仍然跑完 maxGenerations
 *     → 红 (预算真在掐);
 *   - SESSION_BB_BORING_SELECT: 把 topKByMainObjective 内部 sortByMainObjective 改成
 *     只按 id 排 → winnerIds 顺序漂移, 但 frontIds 不动, 那条若只验 frontIds 不红;
 *     双锁 (frontIds 用 paretoFront 验真, winnerIds 用 sortByMainObjective 验真)。
 */
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AggregatedFitness } from '../src/eval/replay/fitness';
import {
  DEFAULT_VARIANT_DIR,
  readVariant,
  variantSpecToPromptOpts,
  writeVariant,
  type VariantSpec,
} from '../src/eval/replay/variant';
import {
  defaultMutationProvider,
  mutateVariant,
  type MutationContext,
  type MutationFailure,
  type MutationProvider,
} from '../src/eval/replay/mutate';
// 测试从本模块取 provider 形状 (session runner 是它的消费面) —— re-export, 不复制类型。
export type { MutationProvider } from '../src/eval/replay/mutate';
import {
  PLATEAU_DEFAULT_THRESHOLD,
  isPlateau,
  topKByMainObjective,
  type Candidate,
  type Objective,
} from '../src/eval/replay/select';
import type { LoadedCorpus } from '../src/eval/replay/corpus';
import { evaluateSplit, stubVariantToRawText } from './autoresearch-replay';

// ─── 常量 ──────────────────────────────────────────────────────────────────

/** Session 默认目标集 (P2 内环主用 5 维, 与 select.ts:DEFAULT_OBJECTIVES 对齐)。 */
export const SESSION_DEFAULT_OBJECTIVES: readonly Objective[] = [
  { field: 'planValidityRate', direction: 'maximize' },
  { field: 'fakeSerialPairsTotal', direction: 'minimize' },
  { field: 'speedupTheoreticalMedian', direction: 'maximize' },
  { field: 'shapeDeclarationRate', direction: 'maximize' },
  { field: 'planningTokensTotal', direction: 'minimize' },
];

/** Session 主目标 (速度优先)。C-3 / select.ts:MAIN_SPEEDUP 同款。 */
export const SESSION_MAIN_OBJECTIVE: Objective = {
  field: 'speedupTheoreticalMedian',
  direction: 'maximize',
};

/** Baseline 代使用的 variant 名 (与 contract C-1 守恒闸对齐)。 */
export const SESSION_BASELINE_VARIANT = 'baseline';

/** Marker for the journal-append-only contract test (matches the verify command grep). */
export const JOURNAL_APPEND_ONLY = 'JOURNAL_APPEND_ONLY';

/** Session 收束原因。'running' 只在 GenerationRecord 内部用 (最后一轮已写 stopReason)。 */
export type SessionStopReason = 'running' | 'plateau' | 'budget' | 'maxGenerations' | 'completed';

// ─── 类型 ──────────────────────────────────────────────────────────────────

/** 单个 child 的 fitness: screen + main 两段 aggregate。screen=0/n 时为 n=0 的空 aggregate。 */
export interface VariantFitness {
  screen: AggregatedFitness;
  main: AggregatedFitness;
}

/** 一代 (generation) 的完整记录。journal 把整条写入。 */
export interface GenerationRecord {
  genIdx: number;
  /** parents = 上一代 winnerIds (genIdx=0 时为空数组, 表示基线代)。 */
  parentVariantNames: string[];
  /** childVariantNames: genIdx=0 时为空 (基线无变异); genIdx>=1 时长度 = parents.length × K。 */
  childVariantNames: string[];
  /** per-child fitness (main 段才是选择用; screen 段作 telemetry)。 */
  fitnessByChild: Record<string, VariantFitness>;
  /** Pareto 前沿 id (= childVariantNames ∪ {baseline} 子集)。genIdx=0 时就是 [baseline]。 */
  frontIds: string[];
  /**
   * 前沿**在 fitness 空间**的稳定字节签名 (Pareto 前沿内候选按 id 字典序, 取 fitness 的
   * canonical JSON 拼起来再 hash; 不同 gen 但 fitness 相同的个体签名相同)。
   * 平台期判定看这个字段 (frontIds 跨代名不同 → 不应触发; fitness 相同应触发)。
   */
  frontFitnessSignature: string;
  /** 选择器赢家 (topK), 长度 = min(topM, front.size)。下一代 parents 取这里。 */
  winnerIds: string[];
  /** 当前代收束时的停止原因 (running = 还会继续)。 */
  stopReason: SessionStopReason;
}

/** runSession 入参。所有 mutated 字段都有默认值 (test/caller 替). */
export interface SessionOptions {
  /** Loaded corpus (驱动 evaluateSplit)。mandatory。 */
  corpus: LoadedCorpus;
  /** variant 磁盘写入根目录。默认 = `runs/autoresearch/variants`。 */
  variantDir?: string;
  /** journal 路径 (append-only)。默认 = `runs/autoresearch/journal.md`。 */
  journalPath?: string;
  /** 每代每 parent 的 children 数 (K)。≥ 1。genIdx=0 不做变异。 */
  K: number;
  /** 代数上限 (含 genIdx=0)。≥ 1。 */
  maxGenerations: number;
  /** 平台期阈值 (连续 N 代前沿不动)。默认 = 5 (PLATEAU_DEFAULT_THRESHOLD)。 */
  plateauThreshold?: number;
  /** 父代保留数 (topM), 下代 parents = winners.slice(0, topM)。默认 = 1 (greedy)。 */
  topM?: number;
  /** 墙钟预算 (ms)。超 = 'budget' 收束。默认 = 90 × 60 × 1000 (合同 §决策)。 */
  budgetMs?: number;
  /** 会话 id。默认 = unix ms 戳。 */
  sessionId?: string;
  // ─── 注入 (test 替默认) ────────────────────────────────────────────────
  /** 替代默认变异 provider (mutate.ts 的 defaultMutationProvider 会主动 throw, 故意 fail-closed)。 */
  mutationProvider?: MutationProvider;
  /** 替代默认 stub 的 rawText 提供器。给 (variant) → plan JSON 字符串。 */
  rawTextProvider?: (variant: string) => Promise<string> | string;
  /** 替代默认 writeVariant: (dir, spec) → 写出的完整路径。 */
  writeVariantSpec?: (dir: string, spec: VariantSpec) => string;
  /** 替代默认 Date.now。 */
  now?: () => number;
}

/** Session 收束结果。journalBytesAppended 记录这次写入的字节数 (供 caller / 闸对账)。 */
export interface SessionResult {
  sessionId: string;
  stopReason: Exclude<SessionStopReason, 'running'>;
  generations: GenerationRecord[];
  winnerIds: string[];
  journalBytesAppended: number;
}

// ─── 默认值 + 工具 ──────────────────────────────────────────────────────────

/** 默认 variant 目录。 */
function defaultVariantDir(): string {
  return DEFAULT_VARIANT_DIR;
}

/** 默认 journal 路径。 */
function defaultJournalPath(): string {
  return 'runs/autoresearch/journal.md';
}

/** 默认 rawText 提供器: readVariant(variantDir, variant) 命中 → 改走 live path;
 * 不命中 → 返 stub (deterministic, zero LLM)。Live 路径在切片 5 接联机, slice 4 不冒烟。
 *
 * 注意: 本函数只是「当 rawTextProvider 未注入时的兜底」, 测试**必**注入 fake。
 * 装配链细节 (conductorSystemPrompt opts 注入) 在 contract C-1 / variant.ts 守恒闸保护,
 * 切片 4 不重复测 (那是 slice 1 + 切片 1 自配的 33 个测试的领地)。 */
function defaultRawTextProvider(
  variantDir: string,
): (variant: string) => Promise<string> {
  return async (variant: string) => {
    // 命中磁盘 → 仍走 stub 的 plan 文本 (生产路径在切片 5 接联机调 LLM, 这里不烧 token)。
    // readVariant 失败 (版本不匹配等) 透传, 让上层看见。
    const spec = readVariant(variantDir, variant);
    // 抑制 unused 警告 (variantSpecToPromptOpts 在 live 路径才用, 这里保持装配面随 variant 动)。
    void variantSpecToPromptOpts(spec ?? null);
    return stubVariantToRawText(variant);
  };
}

/** 拼 child 全名: <parent>-g<genIdx>-c<childIdx>。同 parent 下 childIdx 唯一。 */
function childName(parentName: string, genIdx: number, childIdx: number): string {
  // length 守恒: 'baseline' 在 gen 0 时不进 parent; gen >= 1 进。
  if (parentName === SESSION_BASELINE_VARIANT) {
    return `g${genIdx}-c${childIdx}`;
  }
  return `${parentName}-g${genIdx}-c${childIdx}`;
}

// ─── 评估 ──────────────────────────────────────────────────────────────────

/** 单 child 全量 fitness: screen + main 两段 (screen 为空 split 时返 n=0 的 aggregate)。 */
async function evaluateVariantFitness(
  loaded: LoadedCorpus,
  variant: string,
  rawTextProvider: (variant: string) => Promise<string>,
): Promise<VariantFitness> {
  const zeros: AggregatedFitness = {
    planValidityRate: 0,
    fakeSerialPairsTotal: 0,
    speedupTheoreticalMedian: null,
    shapeDeclarationRate: 0,
    planningTokensTotal: 0,
    n: 0,
  };
  const rtp = (_id: string, _prompt: string) => rawTextProvider(variant);

  // screen: split 不存在 (missing manifest split) → 返 n=0; 命中 (但 ids=[]) → 也返 n=0。
  const screenIds = loaded.splits.screen;
  const screenOut = screenIds !== undefined
    ? (await evaluateSplit({ loaded, split: 'screen', rawTextProvider: rtp })).aggregate
    : zeros;
  const mainOut = (await evaluateSplit({ loaded, split: 'main', rawTextProvider: rtp })).aggregate;
  return { screen: screenOut, main: mainOut };
}

/** main fitness → Candidate 列表 (供 select.topKByMainObjective)。id = variant 名。 */
function candidatesFromFitness(
  variantNames: readonly string[],
  fitnessByVariant: ReadonlyMap<string, AggregatedFitness>,
): Candidate[] {
  const out: Candidate[] = [];
  for (const name of variantNames) {
    const f = fitnessByVariant.get(name);
    if (f === undefined) continue;
    out.push({ id: name, fitness: f });
  }
  return out;
}

/** Pareto 前沿 (in fitness 空间) 的稳定字节签名: front 内候选 dedupe by fitness,
 * 排序 fitness 的 canonical JSON 拼起来再 fnv1a 取 8 位十六进制。
 *
 * 不同 gen 但 fitness 相同的子代 (各异名 + 同 fitness) → 签名相同 → 平台期可触发。
 * 任何 fitness 维变化 → 签名变 → 不在平台期。
 *
 * 关键设计选择: 签名只看 fitness, 不看 candidate id。理由 = 平台期的语义 = "fitness 空间
 * 的最优集不动", 而不是 "某个具体名字的子代被反复选中"。同 fitness 不同名的子代在 Pareto 前沿里
 * 是同一等价类, 签名 dedupe 处理。 */
function frontFitnessSignature(frontCandidates: readonly Candidate[]): string {
  if (frontCandidates.length === 0) return 'EMPTY';
  // dedupe by fitness-JSON (single source of truth = fitness vectors 本身)
  const seen = new Set<string>();
  for (const c of frontCandidates) {
    seen.add(JSON.stringify(c.fitness));
  }
  const sortedSigs = [...seen].sort();
  const pieces = sortedSigs.join('|');
  // fnv1a 32-bit hash, inlined; zero IO, deterministic, fast on hot paths.
  let h = 0x811c9dc5;
  for (let i = 0; i < pieces.length; i++) {
    h ^= pieces.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// ─── journal append-only 写 ─────────────────────────────────────────────────

/**
 * 把 session 一整条 journal (N 段 generation + 摘要) 追加到 journalPath。
 *
 * 失败模式 (fail-closed):
 *   · 目录不存在 → mkdirSync(dirname, {recursive:true});
 *   · 文件不存在 → writeFileSync(header + block); 否则 → appendFileSync(block);
 *   · caller 拿到返回的字节数, 验证 append-only: 后写文件的前 prevSize 字节必须等于上次
 *     写完时的文件 (本测试 JOURNAL_APPEND_ONLY 那条验)。
 *
 * 格式 (Markdown, grep-friendly; slices 5 verify 用的就是 `ugrep -c 'generation' journal.md`):
 *
 *   ## session <id>
 *   - startMs: <unix>
 *   - stopReason: <reason>
 *   - K: <K>  maxGenerations: <maxGenerations>  topM: <topM>  plateauThreshold: <threshold>
 *
 *   ### generation 0 (baseline)
 *   - parents: [baseline]
 *   - children: []
 *   - frontIds: [baseline]  winnerIds: [baseline]
 *   - stopReason: <per-gen reason>
 *
 *   ### generation 1
 *   - parents: [w0]
 *   - children: [w0-g1-c0, w0-g1-c1, ...]
 *   - fitnessByChild:
 *     - w0-g1-c0:
 *       screen: {planValidityRate:..., ...}
 *       main: {planValidityRate:..., ...}
 *     ...
 *   - frontIds: [...]  winnerIds: [...]
 *   - stopReason: ...
 *
 * 上式每段都是 Markdown, 一会话整块写一次, 保证一次会话原子追加 (不部分写)。
 */
export function appendSessionJournal(
  journalPath: string,
  sessionId: string,
  generations: readonly GenerationRecord[],
  stopReason: Exclude<SessionStopReason, 'running'>,
  extra: Readonly<Record<string, unknown>> = {},
): { bytesAppended: number; fileSizeAfter: number } {
  const block = renderJournalBlock(sessionId, generations, stopReason, extra);
  const dir = dirname(journalPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  let fileSizeAfter = 0;
  if (!existsSync(journalPath)) {
    const header = '# autoresearch journal\n\n';
    writeFileSync(journalPath, header + block);
    fileSizeAfter = Buffer.byteLength(header + block, 'utf8');
  } else {
    appendFileSync(journalPath, block);
    // 字节数从 statSync 拿更准; 此处为简化, 按 Buffer.byteLength 估算。
    // 注: 测试 JOURNAL_APPEND_ONLY 是用「写前后同一前缀字节相等」验, 不依赖这个估算精确值。
    fileSizeAfter = -1;
  }
  return { bytesAppended: Buffer.byteLength(block, 'utf8'), fileSizeAfter };
}

/** 把 generations 拼成 Markdown block。分离出来便于测试与排版。 */
export function renderJournalBlock(
  sessionId: string,
  generations: readonly GenerationRecord[],
  stopReason: Exclude<SessionStopReason, 'running'>,
  extra: Readonly<Record<string, unknown>>,
): string {
  const lines: string[] = [];
  lines.push(`## session ${sessionId}`);
  for (const [k, v] of Object.entries(extra)) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      lines.push(`- ${k}: ${v}`);
    } else if (v !== null && v !== undefined) {
      lines.push(`- ${k}: ${JSON.stringify(v)}`);
    }
  }
  lines.push(`- stopReason: ${stopReason}`);
  lines.push('');
  for (const g of generations) {
    const genTag = g.genIdx === 0 ? 'baseline' : `${g.genIdx}`;
    lines.push(`### generation ${g.genIdx} (${genTag})`);
    lines.push(`- parents: [${g.parentVariantNames.join(', ')}]`);
    lines.push(`- children: [${g.childVariantNames.join(', ')}]`);
    if (g.childVariantNames.length > 0) {
      lines.push('- fitnessByChild:');
      for (const name of g.childVariantNames) {
        const fit = g.fitnessByChild[name];
        if (fit === undefined) continue;
        lines.push(`  - ${name}:`);
        lines.push(`    screen: ${JSON.stringify(fit.screen)}`);
        lines.push(`    main: ${JSON.stringify(fit.main)}`);
      }
    }
    lines.push(`- frontIds: [${g.frontIds.join(', ')}]`);
    lines.push(`- frontFitnessSignature: ${g.frontFitnessSignature}`);
    lines.push(`- winnerIds: [${g.winnerIds.join(', ')}]`);
    lines.push(`- stopReason: ${g.stopReason}`);
    lines.push('');
  }
  return lines.join('\n');
}

// ─── 主入口 ────────────────────────────────────────────────────────────────

/**
 * 跑一个 evolution session。
 *
 * 不变量:
 *   - 第 0 代 = baseline; frontIds ⊇ {SESSION_BASELINE_VARIANT} (基线总是在场)。
 *   - 第 N+1 代 parents = winners.slice(0, topM) of gen N; 无 winners 时退回 [baseline]。
 *   - 每代 childFitnessMap[i] screen 与 main 都跑 (零 LLM, rawTextProvider 默认 = stub)。
 *   - 收束优先级: plateau > budget > maxGenerations > completed。
 *
 * 失败模式 (fail-closed):
 *   · mutationProvider 抛 → 透传; (caller 应当用 opts.mutationProvider ?? defaultMutationProvider,
 *     缺省 throw 防静默回落 stub);
 *   · writeVariant 抛 → 透传;
 *   · budget 检查在每代开跑前 (budget 严格: 已超就停, 不开新代)。
 */
export async function runSession(opts: SessionOptions): Promise<SessionResult> {
  if (opts.K < 1) throw new Error('runSession: K must be >= 1');
  if (opts.maxGenerations < 1) throw new Error('runSession: maxGenerations must be >= 1');

  const variantDir = opts.variantDir ?? defaultVariantDir();
  const journalPath = opts.journalPath ?? defaultJournalPath();
  const plateauThreshold = opts.plateauThreshold ?? PLATEAU_DEFAULT_THRESHOLD;
  const topM = Math.max(1, opts.topM ?? 1);
  const budgetMs = opts.budgetMs ?? 90 * 60 * 1000;
  const now = opts.now ?? Date.now;
  const writeVariantSpec = opts.writeVariantSpec ?? writeVariant;
  const rawTextProvider = opts.rawTextProvider
    ? (v: string) => Promise.resolve(opts.rawTextProvider!(v))
    : defaultRawTextProvider(variantDir);
  const mutationProvider: MutationProvider = opts.mutationProvider ?? defaultMutationProvider;

  const sessionId = opts.sessionId ?? `s-${now()}`;
  const startMs = now();
  const deadlineMs = startMs + budgetMs;

  const generations: GenerationRecord[] = [];
  const signatureHistory: string[] = []; // 跨代 Pareto 前沿的 fitness 签名, 给 isPlateau
  let stopReason: Exclude<SessionStopReason, 'running'> = 'maxGenerations';
  let lastWinnerIds: string[] = [SESSION_BASELINE_VARIANT];

  // ─── gen 0 baseline ──────────────────────────────────────────────────
  // budget 在每代入口前查 (不在 gen 0 之后, 防「先 flush 再停」)。
  if (now() > deadlineMs) {
    stopReason = 'budget';
    const baselineRecord = makeBaselineRecord();
    generations.push(baselineRecord);
    return finalizeSession(
      sessionId, stopReason, generations, lastWinnerIds, journalPath,
      { K: opts.K, maxGenerations: opts.maxGenerations, topM, plateauThreshold },
    );
  }

  // gen 0: 不变异。frontIds / winnerIds = [baseline] (基线至少在场)。
  const baselineRecord = makeBaselineRecord();
  // 评估 baseline 给一份 fitness 记录 (供 journal + 后续代对比)。
  const baselineFit = await evaluateVariantFitness(
    opts.corpus, SESSION_BASELINE_VARIANT, rawTextProvider,
  );
  baselineRecord.fitnessByChild[SESSION_BASELINE_VARIANT] = baselineFit;
  baselineRecord.frontFitnessSignature = frontFitnessSignature([
    { id: SESSION_BASELINE_VARIANT, fitness: baselineFit.main },
  ]);
  generations.push(baselineRecord);
  signatureHistory.push(baselineRecord.frontFitnessSignature);
  lastWinnerIds = baselineRecord.winnerIds;

  // ─── gen 1..N mutation ───────────────────────────────────────────────
  for (let genIdx = 1; genIdx < opts.maxGenerations; genIdx++) {
    if (now() > deadlineMs) {
      stopReason = 'budget';
      break;
    }

    // 选 parents: lastWinnerIds.slice(0, topM); 退化为 [baseline]。
    const parents = (lastWinnerIds.length > 0 ? lastWinnerIds : [SESSION_BASELINE_VARIANT])
      .slice(0, topM);

    // 变异 K × parents.length 个 children。
    const childVariantNames: string[] = [];
    const childSpecs: VariantSpec[] = []; // 与 names 同序
    for (let pIdx = 0; pIdx < parents.length; pIdx++) {
      const parentName = parents[pIdx]!;
      // 读 parent 的 spec (磁盘不存在 → null, 即基线)。
      const parentSpec: VariantSpec | null = readVariant(variantDir, parentName);
      // 选父代最近一代的 fitness 摘要 (MutationFailure 形状)。
      const parentPrevGen = findPrevGen(generations, parentName) ?? generations[generations.length - 1]!;
      const failure: MutationFailure = {
        perItem: [], // session runner 不传 perItem (caller 切片 5 接联机时填); 零 LLM 测试就此透传空
        aggregate: parentPrevGen.fitnessByChild[parentName]?.main ?? baselineFit.main,
      };
      for (let cIdx = 0; cIdx < opts.K; cIdx++) {
        const ctx: MutationContext = {
          genIdx,
          childIdx: cIdx,
          parentName,
        };
        const childSpec = await mutateVariant(parentSpec, failure, ctx, { mutationProvider });
        const childNameStr = childName(parentName, genIdx, cIdx);
        // 把 mutation provider 产出的 spec.name 换成 derived name (避免 provider 给的随机名顶掉
        // 我们 trace 用的命名); spec 的内容 (fewShotCards/extraAppend) 仍按 provider 输出。
        // 这与 contract §决策 "variant 物化到磁盘" 不冲突: spec.name 是磁盘文件名;
        // 若 caller 想用 provider 给的 name, 直接传 opts.writeVariantSpec 把 name 旋回去。
        const specWithName: VariantSpec = { ...childSpec, name: childNameStr };
        const writtenPath = writeVariantSpec(variantDir, specWithName);
        // 抑制 lint: writtenPath 留给 caller 调试 / 闸对账; session 内部不直接读回。
        void writtenPath;
        childVariantNames.push(childNameStr);
        childSpecs.push(specWithName);
      }
    }

    // 评估每个 child + 选 front + winners。
    const fitnessByChild: Record<string, VariantFitness> = {};
    const mainFitnessByVariant = new Map<string, AggregatedFitness>();
    for (const name of childVariantNames) {
      const fit = await evaluateVariantFitness(opts.corpus, name, rawTextProvider);
      fitnessByChild[name] = fit;
      mainFitnessByVariant.set(name, fit.main);
    }
    // baseline 也带进 front (C-1 / §决策: 基线一直在场)。
    mainFitnessByVariant.set(
      SESSION_BASELINE_VARIANT,
      baselineRecord.fitnessByChild[SESSION_BASELINE_VARIANT]!.main,
    );
    const allVariantNames = [SESSION_BASELINE_VARIANT, ...childVariantNames];
    const candidates = candidatesFromFitness(allVariantNames, mainFitnessByVariant);
    const sel = topKByMainObjective(candidates, {
      objectives: SESSION_DEFAULT_OBJECTIVES,
      mainObjective: SESSION_MAIN_OBJECTIVE,
      topK: topM,
    });
    // 前沿候选 (从 sel.frontIds 抓回完整候选) 算 fitness 签名, 给 isPlateau 用。
    const frontSet = new Set(sel.frontIds);
    const frontCandidates = candidates.filter((c) => frontSet.has(c.id));

    const thisGen: GenerationRecord = {
      genIdx,
      parentVariantNames: parents,
      childVariantNames,
      fitnessByChild,
      frontIds: sel.frontIds,
      frontFitnessSignature: frontFitnessSignature(frontCandidates),
      winnerIds: sel.winnerIds,
      stopReason: 'running',
    };
    generations.push(thisGen);
    signatureHistory.push(thisGen.frontFitnessSignature);
    lastWinnerIds = sel.winnerIds;

    // 平台期检查: 跨 ≥ threshold 代 frontier 在 fitness 空间不动 → 收束。
    // 注意: 平台期用签名 (frontFitnessSignature), 不用 frontIds —— 跨代名不同但
    // fitness 相同的子代**也算不动** (这是 Pareto-前沿的本意: fitness 空间的前沿)。
    // isPlateau 的形参是「前沿 id 列表」的历史; 这里的历史是签名串 —— 每个签名包成
    // 单元素列表, 逐元素比较语义等价 (连续相同签名 ⇔ 连续相同单元素列表), 不动切片 3 的 API。
    if (signatureHistory.length >= plateauThreshold
      && isPlateau(signatureHistory.map((s) => [s]), plateauThreshold)) {
      stopReason = 'plateau';
      thisGen.stopReason = 'plateau';
      break;
    }
  }

  // 最后一代 (即使 maxGenerations 自然到代也走这条)
  const finalGen = generations[generations.length - 1]!;
  if (stopReason === 'maxGenerations' && finalGen.stopReason === 'running') {
    finalGen.stopReason = 'maxGenerations';
  }
  if (stopReason === 'maxGenerations') {
    // 自然到代数 = 'maxGenerations', 否则 'completed' (没场景, 留兜底)。
    if (finalGen.stopReason === 'maxGenerations') {
      stopReason = 'maxGenerations';
    }
  }

  return finalizeSession(
    sessionId, stopReason, generations, lastWinnerIds, journalPath,
    { K: opts.K, maxGenerations: opts.maxGenerations, topM, plateauThreshold },
  );
}

// ─── 内部 helper ───────────────────────────────────────────────────────────────

/** 构造 baseline (gen 0) 记录。fitness 字段留给 evaluate 后填。 */
function makeBaselineRecord(): GenerationRecord {
  return {
    genIdx: 0,
    parentVariantNames: [],
    childVariantNames: [],
    fitnessByChild: {},
    frontIds: [SESSION_BASELINE_VARIANT],
    frontFitnessSignature: 'BASELINE',
    winnerIds: [SESSION_BASELINE_VARIANT],
    stopReason: 'running',
  };
}

/** 在 generations 里找一个 genIdx, 该 gen 的 frontIds/winnerIds/fitnessByChild
 *  含 parentName 的 fitness 摘要。返回最新 (genIdx 最大) 那条; 找不到 → fallback。 */
function findPrevGen(
  generations: readonly GenerationRecord[],
  parentName: string,
): GenerationRecord | null {
  for (let i = generations.length - 1; i >= 0; i--) {
    const g = generations[i]!;
    if (g.fitnessByChild[parentName] !== undefined) return g;
  }
  return null;
}

/** 收尾: 写 journal, 返 SessionResult。 */
async function finalizeSession(
  sessionId: string,
  stopReason: Exclude<SessionStopReason, 'running'>,
  generations: readonly GenerationRecord[],
  winnerIds: readonly string[],
  journalPath: string,
  extra: Readonly<Record<string, unknown>>,
): Promise<SessionResult> {
  const { bytesAppended } = appendSessionJournal(
    journalPath, sessionId, generations, stopReason, extra,
  );
  return {
    sessionId,
    stopReason,
    generations: [...generations],
    winnerIds: [...winnerIds],
    journalBytesAppended: bytesAppended,
  };
}

// ─── CLI (切片 5 实跑会用到, 切片 4 不冒烟) ─────────────────────────────────

const CLI_USAGE = `\
usage: bun scripts/autoresearch-session.ts --corpus <manifest.json> [options]

options:
  --variant-dir <dir>     variant 写入目录 (默认 runs/autoresearch/variants)
  --journal <path>        journal 路径 (默认 runs/autoresearch/journal.md)
  --K <n>                 每代每 parent 的子代数 (默认 4)
  --max-generations <n>   代数上限 (默认 8)
  --plateau-threshold <n> 平台期阈值 (默认 5)
  --top-m <n>             父代保留数 (默认 1)
  --budget-minutes <n>    墙钟预算 (默认 90)
  --session-id <id>       会话 id (默认 unix ms)
  --help                  打印本用法
`;

interface CliOpts {
  corpusPath: string;
  variantDir?: string;
  journalPath?: string;
  K?: number;
  maxGenerations?: number;
  plateauThreshold?: number;
  topM?: number;
  budgetMinutes?: number;
  sessionId?: string;
  help: boolean;
}

function parseCli(argv: readonly string[]): CliOpts {
  const out: CliOpts = { corpusPath: '', help: false };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i]!;
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    switch (a) {
      case '--corpus': out.corpusPath = next(); break;
      case '--variant-dir': out.variantDir = next(); break;
      case '--journal': out.journalPath = next(); break;
      case '--K': out.K = Number(next()); break;
      case '--max-generations': out.maxGenerations = Number(next()); break;
      case '--plateau-threshold': out.plateauThreshold = Number(next()); break;
      case '--top-m': out.topM = Number(next()); break;
      case '--budget-minutes': out.budgetMinutes = Number(next()); break;
      case '--session-id': out.sessionId = next(); break;
      case '--help':
      case '-h':
        out.help = true; break;
      default:
        if (a.startsWith('--')) throw new Error(`unknown flag: ${a}`);
        out.corpusPath = a; // 兼容位置参数
        break;
    }
    i++;
  }
  return out;
}

if (import.meta.main) {
  let cli: CliOpts;
  try {
    cli = parseCli(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`error: ${(e as Error).message}\n${CLI_USAGE}`);
    process.exit(1);
  }
  if (cli.help || cli.corpusPath === '') {
    process.stdout.write(CLI_USAGE);
    process.exit(0);
  }
  // 切片 4 不冒烟: CLI 路径需要读 manifest + 联机调 LLM, 由切片 5 加联机后再跑。
  process.stderr.write(
    '[autoresearch-session] CLI main is stub-only in slice 4; '
      + 'slice 5 wires live provider + drives a real session.\n',
  );
  process.exit(2);
}
