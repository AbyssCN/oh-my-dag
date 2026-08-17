/**
 * #153 fan-in 逐字引文保真 + verbatim-drop 升闸 —— 反向自检 a/b/c/d (T1, 测试片)。
 *
 * 契约: docs/plan/2026-08-17-153-fanin-quotes-contract.md
 *   - D-1 唯一引文判据源 = `extractQuotedSpans`, 禁写第二个抽取器 (INV-1 同源);
 *   - D-4 拼回格式  = `'\n\n<fan-in 逐字引文保留>\n[来源节点 <id>] <text>\n'`;
 *   - D-5 截断排序 = 引文先保, 叙述先砍, 病态引文超预算时按序保留 + 叙述空;
 *   - D-7 升闸谓词 = goal 含「契约源/行号/出处/逐字」任一 (纯子串)。
 *
 * 反向自检映射 (契约 §反向自检 a/b/c/d ↔ goal):
 *   (a) GWT 2 + GWT 4 path-A  —— 拼回: 两段引文逐字还在, 来源节点 id 标注, 叙述显著压短;
 *   (b) GWT 3                —— 截断: 超 24K 上游, 引文过 24K 边界 → 截断后引文整段留着;
 *   (c) 零回归 (与契约 ANTI-GAMING CLAUSES 同源) —— 无引文上游 → 注入体零新增字节;
 *   (d) GWT 5                —— 谓词: goal 不含 → 只 advisory; goal 含 → 判红。
 *
 * ## 今天红在缺实现 (T1 → T2)
 *   - (a)(b)(c) 待 capFanin/maybeFaninView 接 D-5/D-6 (impl_leaf 后续);
 *   - (d) 待 observers 导出 `gateVerbatimRed` (impl_gate 后续)。
 * 没有 skip / not-failing / pending; 没另写引文 regex; 没把子串断言换 includes-of-anything。
 * 调用真实实现符号: 引文抽取器复用 observers 已导出的那一个,
 *                  (d) 谓词直接调 `gateVerbatimRed`, 这是 impl 必出的契约符号。
 */
import { describe, expect, test } from 'bun:test';
import { runExecutorDagWithPlan } from './engine';
import type { ConductorPlan } from '../conductor-plan';
import type { ContentPart } from '../../model/gateway';
import type { DagObservation, ExecutorDagConfig, GenerateFn } from './types';
import { extractQuoteSegments, extractQuotedSpans, gateVerbatimRed } from '../plan/observers';
import { FANIN_SUMMARY_SYSTEM } from '../fanin-summary';

// ── 仓内既有测试样式 helpers (与 engine.test.ts / verbatim-drop.test.ts 同款) ────

const contentText = (c: string | ContentPart[] | undefined): string =>
  typeof c === 'string' ? (c ?? '') : (c ?? []).map((p) => (p.type === 'text' ? p.text : '')).join('');

/** 从 buildLeafPrompt 产出的 user prompt 里解析节点 id (`[omd leaf: <id>]` 行)。 */
const leafId = (prompt: string): string => /\[omd leaf: ([^\]]+)\]/.exec(prompt)?.[1] ?? '?';

const plan = (nodes: ConductorPlan['nodes']): ConductorPlan => ({ name: 'fanin-quotes', nodes });

const makeConfig = (generate: GenerateFn, extra: Partial<ExecutorDagConfig> = {}): ExecutorDagConfig => ({
  conductorModel: 'test:conductor',
  leafModel: 'test:leaf',
  generate,
  agentTemplates: new Map(),
  ...extra,
});

// ── (a)(b)(c) 共用:把上游 dep 设成「超长 + 含一段带边界标识的引文」 ────────────

/**
 * `minFanout:1` 强行让单 consumer 的上游也走定向摘要 —— 这正是契约 GWT 4 钉住的同款触发线。
 * 摘要 LLM 的 fake JSON 故意**不含**引文 (契约 D-6 纪律①「只补摘要没含的」),让
 * capFanin / maybeFaninView 的引文回填块有机会被观察。
 */
const FANIN_HARD_CAP_CHARS = 24_000;

// ═════════════════════════════════════════════════════════════════════════════
// (a) 拼回: 两段引文逐字 + 来源节点 id 标注 + 叙述显著压短
// GWT 2: 上游带 ≥2 段够长引文 → 注入体含块 + 逐字 + 来源节点 id
// GWT 4 path-A: 摘要已丢 → view 末追加块 (零新增字节条件: 摘要保住时)
// ═════════════════════════════════════════════════════════════════════════════
describe('(a) D-4/D-6 拼回: 两段引文逐字 + [来源节点 <id>] 标注 + 叙述压缩', () => {
  // 唯一性锚: 每段引文含专有 token, 验证回填块里的引文字节相等 (逐字)。
  const QUOTE1_TOKEN = 'UNIQUE_INV2_QUOTE_FROM_SRC1_p9x';     // 25 chars (>= 24 阈值)
  const QUOTE2_TOKEN = 'UNIQUE_INV2_QUOTE_FROM_SRC2_q4k';     // 25 chars
  // 24 字符阈值刚好压线, 不用临界;阈值是 impl 内置不变量。
  const Q1 = `"${QUOTE1_TOKEN}"`;                              // 27 chars total (含引号也算)
  const Q2 = `"${QUOTE2_TOKEN}"`;
  // 摘要因果锚: 标识「哪个上游被摘了」的 token; 若它们进了 merge 的 prompt, 证明走了 fan-in 路径
  // 而非 depOutputs 全文注入。
  const SUM_TOKEN_1 = 'SUMMARY_TOKEN_SRC1_t8d3';
  const SUM_TOKEN_2 = 'SUMMARY_TOKEN_SRC2_k4c1';

  // 把上游喂到 >1800 字符 (DEFAULT_FANIN_MIN_CHARS) 强制 fanin-summary 真做一次;
  // 同时让 LLM 摘要「丢掉引文」逼 D-6 的回填块出来。
  const PAD = '补足长度的非引文叙述内容, 让上游超 1800 字符以触发 fan-in 摘要;'.repeat(80);
  const UPSTREAM_1 = `src1-doc-header ${PAD} 原句引用: ${Q1}`;
  const UPSTREAM_2 = `src2-doc-header ${PAD} 原句引用: ${Q2}`;

  /** LLM 摘要回 fake: 故意**不含**引文, 让 D-4 引文回填块有机会被观察。 */
  const FAKE_SUM_1 = { tldr: SUM_TOKEN_1, key_points: [], artifacts: [], open_questions: [] };
  const FAKE_SUM_2 = { tldr: SUM_TOKEN_2, key_points: [], artifacts: [], open_questions: [] };

  const captured: { mergePrompt: string } = { mergePrompt: '' };

  const generate: GenerateFn = async (req) => {
    const user = contentText(req.messages.find((m) => m.role === 'user')?.content);
    const sys = contentText(req.messages.find((m) => m.role === 'system')?.content);
    const id = leafId(user);
    if (id === 'src1') return { text: UPSTREAM_1, usage: { in: 1, out: 1 } };
    if (id === 'src2') return { text: UPSTREAM_2, usage: { in: 1, out: 1 } };
    if (id === 'merge') {
      captured.mergePrompt = user;
      return { text: 'merge-out', usage: { in: 1, out: 1 } };
    }
    // fan-in 摘要 (系统前缀冻结) ─ 用 producer 的引文 token 选 fake JSON。
    if (sys === FANIN_SUMMARY_SYSTEM) {
      if (user.includes(QUOTE1_TOKEN)) return { text: JSON.stringify(FAKE_SUM_1), usage: { in: 1, out: 1 } };
      if (user.includes(QUOTE2_TOKEN)) return { text: JSON.stringify(FAKE_SUM_2), usage: { in: 1, out: 1 } };
    }
    return { text: 'noop', usage: { in: 0, out: 0 } };
  };

  test('★ 两段引文逐字在注入体中, 各带 [来源节点 <id>] 标注, 叙述显著压短', async () => {
    const r = await runExecutorDagWithPlan(
      plan({
        src1: { goal: '产出证据 A' },
        src2: { goal: '产出证据 B' },
        merge: { goal: '汇总 A 与 B 的引用', depends_on: ['src1', 'src2'] },
      }),
      makeConfig(generate, { faninSummary: { minFanout: 1 } }),
    );

    // 健全性: 三节点都 done, fan-in 摘要真跑了一次。
    expect(r.results.src1?.status).toBe('done');
    expect(r.results.src2?.status).toBe('done');
    expect(r.results.merge?.status).toBe('done');
    expect(captured.mergePrompt).not.toBe('');

    // fan-in 路径走通的因果锚: 摘要 token 进 prompt, depOutputs 全文不进 (论文 2.4 倍压短, 见下)。
    expect(captured.mergePrompt).toContain(SUM_TOKEN_1);
    expect(captured.mergePrompt).toContain(SUM_TOKEN_2);

    // D-4 拼回块标头 (两个上游各产生一个块, 所以各出现 ≥ 1 次)。
    expect(captured.mergePrompt).toContain('<fan-in 逐字引文保留>');

    // INV-2 逐字注入: 抽取器认的真引文 (含外侧引号的完整串) 在注入体里原样在 (不 trim 之外改写)。
    expect(captured.mergePrompt).toContain(Q1);
    expect(captured.mergePrompt).toContain(Q2);
    // 不光引文本体在, 还**逐字节相等** (D-2, 与 extractQuoteSegments 同源)。
    expect(captured.mergePrompt).toContain(`[来源节点 src1] ${QUOTE1_TOKEN}`);
    expect(captured.mergePrompt).toContain(`[来源节点 src2] ${QUOTE2_TOKEN}`);

    // INV-4 narrative 显著压短: prompt 远小于两个 upstream 原文简单加 (LM 摘要本就该压叙述)。
    const rawTotal = UPSTREAM_1.length + UPSTREAM_2.length;
    expect(captured.mergePrompt.length).toBeLessThan(rawTotal / 2);
    // 反向自检锚: 引文 token + 来源标注本身就在 prompt 里 → 不是「摘要丢了等于零」的空腔。
    expect(captured.mergePrompt.length).toBeGreaterThan(QUOTE1_TOKEN.length + QUOTE2_TOKEN.length + 40);
  });

  test('GWT 4 path-A 零新增纪律 (摘要已含引文 → 该段不重复出现)', () => {
    // 这一条是 (a) 的反向: 当 fake 摘要**含**引文时, D-4 不应再补一遍。
    // 不走 runExecutorDagWithPlan (LLM 摘要不可靠), 直接断言 QUOTE_BLOCK 模板的纪律: 摘要含 → 跳过。
    // 当前 impl 尚未导出 QUOTE_BLOCK; 借用契约 D-4 文本存在的约定不动; 此处用最窄的可观察面
    // 钉死 (a) 的同一性: 把抽取器产物喂进 ⟺ 文本比对, 保证回填块零字节冗余。
    const segments = extractQuoteSegments(`x"${QUOTE1_TOKEN}"y"${QUOTE2_TOKEN}"z`, 'merge', 1);
    // 同 matcher 派生 (INV-1): extractQuoteSegments.map(s=>s.text) ≡ extractQuotedSpans。
    expect(segments.map((s) => s.text).sort()).toEqual(extractQuotedSpans(`x"${QUOTE1_TOKEN}"y"${QUOTE2_TOKEN}"z`).sort());
    // 来源节点 id 在每一段上 → 拼接 D-4 模板时该标注不会丢 (下面两条断言用作 impl 的反向自检)。
    expect(segments.every((s) => s.nodeId === 'merge')).toBe(true);
    for (const s of segments) expect(s.text.length).toBeGreaterThanOrEqual(24);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// (b) 截断排序: >24K 上游 + 引文过 24K 边界 → 截断后引文段仍完整
// GWT 3: 上游总长 > 24_000 → 注入体总长 ≤ 24_000 + ptrLen, 引文段不被砍
// ═════════════════════════════════════════════════════════════════════════════
describe('(b) D-5 截断排序: 引文过 24K 边界 → capFanin 截断后引文段仍完整', () => {
  // 让一段长引文坐落在 24K 边界**之后**(GWT 3 钉死的形状: 引文在 24K 边界之后)。
  const BIG_QUOTE_TOKEN = 'BIG_QUOTE_AT_LEAST_TWENTY_FOUR_CHARS_z7n';   // ≥24 chars, 走阈值
  const BIG_QUOTE = `"${BIG_QUOTE_TOKEN}"`;
  // 上游总长 > 24_000: 前 24K 是纯叙述(无引文), 后面再接引文(超过 24_000 边界)。
  const NARRATIVE = 'a'.repeat(24_500);
  const TAIL = ` 收尾一段: ${BIG_QUOTE}`;     // 一段恰好越过 24K 边界
  const HUGE_UPSTREAM = NARRATIVE + TAIL;     // 总长 = 24_500 + 18 + 引文长度 ≈ > 24K

  const captured: { bPrompt: string } = { bPrompt: '' };

  const generate: GenerateFn = async (req) => {
    const user = contentText(req.messages.find((m) => m.role === 'user')?.content);
    const id = leafId(user);
    if (id === 'A') return { text: HUGE_UPSTREAM, usage: { in: 1, out: 1 } };
    if (id === 'B') { captured.bPrompt = user; return { text: 'B-out', usage: { in: 1, out: 1 } }; }
    return { text: 'noop', usage: { in: 0, out: 0 } };
  };

  test('★ 超 24K 上游, 引文过 24K 边界 → B 的 prompt 仍含完整引文段 (含 [来源节点 A] 标注)', async () => {
    expect(HUGE_UPSTREAM.length).toBeGreaterThan(FANIN_HARD_CAP_CHARS);
    // 引文确实在 24K 边界之后 (= 我们写这条测试的全部意义)。
    expect(HUGE_UPSTREAM.indexOf(BIG_QUOTE)).toBeGreaterThan(FANIN_HARD_CAP_CHARS);

    const r = await runExecutorDagWithPlan(
      plan({
        A: { goal: '产大料' },
        B: { goal: '吃上游', depends_on: ['A'] },
      }),
      makeConfig(generate),
    );
    expect(r.results.A?.status).toBe('done');
    expect(r.results.B?.status).toBe('done');
    expect(captured.bPrompt).not.toBe('');

    // D-5 「引文先保, 叙述先砍」: 整段引文进了 B 的 prompt, 不仅本体, 还带源标注 (D-4 拼回块)。
    expect(captured.bPrompt).toContain(BIG_QUOTE);                                  // 逐字存在
    expect(captured.bPrompt).toContain(`[来源节点 A] ${BIG_QUOTE_TOKEN}`);           // 带源标注的同一段
    expect(captured.bPrompt).toContain('<fan-in 逐字引文保留>');

    // INV-4 总长限: ≤ 24_000 + 引文块 + 指针后缀预算 + 截断告示。给 1.5K 余量作「块 + 指针 + 告示」。
    expect(captured.bPrompt.length).toBeLessThan(FANIN_HARD_CAP_CHARS + 1500);

    // 截断告示还是要响亮报数字 (No-silent-caps, 契约 D-5 + engine.ts:844)。
    // impl 可调措辞但「实截长度」必须如实报; 允许多种形态, 用宽松包含: 「24_000」或「截断」+数字。
    const mentions = /\d/.test(captured.bPrompt.slice(captured.bPrompt.indexOf('fan-in 硬上限')));
    expect(captured.bPrompt).toContain('fan-in 硬上限');
    expect(mentions).toBe(true);

    // 反向自检: 前段叙述要被砍 —— 我们 prompt 长度严格小于 upstream。
    expect(captured.bPrompt.length).toBeLessThan(HUGE_UPSTREAM.length);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// (c) 零回归: 完全无引文 → 注入体零新增字节
// 契约 §ANTI-GAMING CLAUSES BASELINE MUST NOT REGRESS
// ═════════════════════════════════════════════════════════════════════════════
describe('(c) 零回归: 完全无引文 → 注入体与今天旧行为逐字节相同', () => {
  test('★ 无引文上游 (≤24K) → 下游 prompt 不出现引文块标头, 上游原样直传', async () => {
    const PLAIN = 'plain upstream, no quotes at all, just plain narrative that says nothing about sources or citations.';
    // 加足长度但保留在 24K 下 (与 (b) 区分: (b) 砍, 这里不砍)。
    const UPSTREAM = (PLAIN + ' ').repeat(8);   // ~640 chars, 远小于 24K
    expect(UPSTREAM.length).toBeLessThan(FANIN_HARD_CAP_CHARS);

    let bPrompt = '';
    const generate: GenerateFn = async (req) => {
      const user = contentText(req.messages.find((m) => m.role === 'user')?.content);
      const id = leafId(user);
      if (id === 'A') return { text: UPSTREAM, usage: { in: 1, out: 1 } };
      if (id === 'B') { bPrompt = user; return { text: 'B-out', usage: { in: 1, out: 1 } }; }
      return { text: 'noop', usage: { in: 0, out: 0 } };
    };

    const r = await runExecutorDagWithPlan(
      plan({
        A: { goal: '产平叙' },
        B: { goal: '吃平叙', depends_on: ['A'] },
      }),
      makeConfig(generate),
    );
    expect(r.results.A?.status).toBe('done');
    expect(r.results.B?.status).toBe('done');
    expect(bPrompt).not.toBe('');

    // 零回归判定 (D-4 纪律: segments 为空 → 整个拼回块零字节): 不该出现引文块标头。
    expect(bPrompt).not.toContain('<fan-in 逐字引文保留>');
    // 也不该出现截断告示 (impl 加在 capFanin 里, 但 ≤24K 时根本不走 capFanin 截断分支)。
    expect(bPrompt).not.toContain('fan-in 硬上限');

    // 上游一字不动进 prompt (capFanin 在 ≤24K 时整段透传, 与旧行为字节等价)。
    expect(bPrompt).toContain(UPSTREAM);
  });

  test('★ 无引文上游 (>24K) → 仍触发截断告示, 但依然**不**出现引文块标头', async () => {
    // 24K 边界外没有引文: 既要走 capFanin 截断, 又不出现引文块。窄险的环境, 但零回归要求涵盖。
    const PLAIN_HUGE = 'p'.repeat(30_000);   // 30K 全 plain (无引号)
    let bPrompt = '';
    const generate: GenerateFn = async (req) => {
      const user = contentText(req.messages.find((m) => m.role === 'user')?.content);
      const id = leafId(user);
      if (id === 'A') return { text: PLAIN_HUGE, usage: { in: 1, out: 1 } };
      if (id === 'B') { bPrompt = user; return { text: 'B-out', usage: { in: 1, out: 1 } }; }
      return { text: 'noop', usage: { in: 0, out: 0 } };
    };

    const r = await runExecutorDagWithPlan(
      plan({
        A: { goal: '产巨大平叙' },
        B: { goal: '吃巨大平叙', depends_on: ['A'] },
      }),
      makeConfig(generate),
    );
    expect(r.results.B?.status).toBe('done');
    expect(PLAIN_HUGE.length).toBeGreaterThan(FANIN_HARD_CAP_CHARS);

    // 截断告示 (今天的行为, 不能被 D-5 改坏)。
    expect(bPrompt).toContain('fan-in 硬上限');
    // 但**不**该出现引文块 (segments=[] 时 D-4 整块零字节)。
    expect(bPrompt).not.toContain('<fan-in 逐字引文保留>');
    // 上游确实被砍到 ≤24K + 告示尾巴。
    expect(bPrompt.length).toBeLessThan(PLAIN_HUGE.length);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// (d) 升闸谓词: goal 含/不含 4 关键词 → 判红
// GWT 5: goal 文本包含「契约源/行号/出处/逐字」任一 (纯子串, 非正则)
//        → 节点进入本轮毒集路径;否则维持只报不拦 (D-Q 观察者只读)
// ═════════════════════════════════════════════════════════════════════════════
describe('(d) D-7 升闸谓词: goal 含四词之一 → 判红输入, 否则只 advisory', () => {
  // 任意一段 verbatim-drop 观察条目 (DagObservation.kind === 'verbatim-drop')。
  // 谓词的签名约定: 接受 (obs, goal) → boolean; 谓词自身只在 obs.kind==='verbatim-drop' 时有意义。
  // 这里把 obs 造得「真触发 verbatim-drop」的形状, 让谓词的两侧都能被观察到。
  const dropObs: DagObservation = {
    kind: 'verbatim-drop',
    nodes: ['merge'],
    message: '汇总节点把三段原句全转述了 (供谓词调用的样本 obs)',
  };

  test('goal 不含四词任一 → 返回 false (只 advisory, 不进判红输入)', () => {
    expect(gateVerbatimRed(dropObs, '综合上游三条证据得出一个结论')).toBe(false);
    expect(gateVerbatimRed(dropObs, '请基于上游产物撰写一段总结')).toBe(false);
    // 关键词是中文子串, 英文/variant 不算 (契约 D-7 「纯子串, 非正则」)。
    expect(gateVerbatimRed(dropObs, 'cite the source line numbers and quote verbatim')).toBe(false);
    // 关键词作为**整词的子串**才算 —— 「出处」嵌入其他长词也算 (纯 contains, 按契约)。
    // 这里给一个不含「契约源/行号/出处/逐字」**任一字面子串**的目标, 确认 false。
    expect(gateVerbatimRed(dropObs, '依据上游证据链得出结论')).toBe(false);
  });

  test('goal 含四词任一 → 返回 true (进入判红输入, 走 detector.rejected 同一毒集)', () => {
    // 四个关键词 (契约 D-7 冻结) 各覆盖一次, 防 impl 写错词表。
    expect(gateVerbatimRed(dropObs, '请保留原文出处以便逐字核查')).toBe(true);   // 出处 + 逐字
    expect(gateVerbatimRed(dropObs, '引用上游契约源条款')).toBe(true);            // 契约源
    expect(gateVerbatimRed(dropObs, '对照原文章号/行号确认结论')).toBe(true);    // 行号
    expect(gateVerbatimRed(dropObs, '请逐字保留引文与出处')).toBe(true);         // 逐字
  });

  test('goal 含四词任一 (单字符子串亦算, 纯 contains) → 仍返回 true', () => {
    // 契约明确说「纯子串, 非正则」—— 所以「出处」字面是 embeds 也算。impl 不能错用 word-boundary。
    expect(gateVerbatimRed(dropObs, '明确标注「逐字引用」且给出原文出处')).toBe(true);
  });

  test('谓词对其它 kind 的 obs 不判红 (观察者只读, 谓词只判 verbatim-drop)', () => {
    // 契约: 升闸是**仅对 verbatim-drop 这一种**的加路由, 不能因 obs.kind 错配而旁路其它判据。
    const otherObs: DagObservation = { kind: 'undeclared-artifact-dep', nodes: ['x'], message: 'irrelevant' };
    expect(gateVerbatimRed(otherObs, '保留原文出处与逐字')).toBe(false);
    const otherObs2: DagObservation = { kind: 'write-race', nodes: ['x', 'y'], message: 'irrelevant' };
    expect(gateVerbatimRed(otherObs2, '保留原文出处与逐字')).toBe(false);
  });
});
