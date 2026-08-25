/**
 * #153 fan-in 摘要视图保引文 —— 反向自检 a/b/c (T1, 切片 1 / D-2)。
 *
 * 契约: docs/plan/2026-08-25-fanin-verbatim-contract.md
 *   - D-2 摘要视图在摘要正文后追加「逐字引文段」附录, 抽取器复用 `extractQuotedSpans`
 *     (INV-1 同源, 禁写第二个抽取器);
 *   - 附录预算默认 ≤4000 字符 (FANIN_VERBATIM_APPENDIX_MAX_CHARS), 超预算显式截断标记;
 *   - 零引文 → 零附录 (视图与现状逐字一致, INV-1 GWT-3)。
 *
 * 反向自检映射 (契约 §GWT ↔ describe):
 *   (a) GWT-1 视图含 3 段引文原文;  (b) GWT-2 超预算截断标记;  (c) GWT-3 零回归。
 *
 * ## 测试形态说明 (切片 1 vs 切片 2)
 *
 * 切片 1 写集只动 fanin-summary.ts + 本文件, 不动 engine.ts。视图由 `composeFaninView` 直接产出
 * —— 传 `output` 即在视图层附附录, 不传则与旧视图逐字一致 (INV-1 GWT-3 零回归)。切片 2 收尾会
 * 把 engine.ts:4466 那一行的 `composeFaninView` 调用补上 `output` 参数 —— 本测试形态不受影响。
 *
 * 没有 skip / not-failing / pending; 没另写引文 regex; 没把子串断言换 includes-of-anything。
 */
import { describe, expect, test } from 'bun:test';
import {
  FANIN_VERBATIM_APPENDIX_MAX_CHARS,
  composeFaninView,
  composeVerbatimAppendix,
} from './fanin-summary';
import { extractQuotedSpans } from './plan/observers';

// ── 仓内既有测试样式 helpers ─────────────────────────────────────────────────

/**
 * 唯一性锚: 每段引文含专有 token, 验证附录里的引文字节相等 (逐字)。
 * 25 chars, ≥ 24 chars 阈值, 走 extractQuotedSpans。
 */
const QUOTE_A = 'UNIQUE_INV2_QUOTE_FROM_PROD_p9x';
const QUOTE_B = 'UNIQUE_INV2_QUOTE_FROM_PROD_q4k';
const QUOTE_C = 'UNIQUE_INV2_QUOTE_FROM_PROD_n7m';
const Q1 = `"${QUOTE_A}"`;
const Q2 = `"${QUOTE_B}"`;
const Q3 = `"${QUOTE_C}"`;
const PAD = '补足长度的非引文叙述内容, 让上游超 1800 字符以触发 fan-in 摘要;'.repeat(80);

// ═════════════════════════════════════════════════════════════════════════════
// (a) GWT-1: producer 输出 ≥1800 字符 + 3 段 ≥24 字符引文 + ≥2 消费者触发摘要
//     → 构造 fan-in 视图, 视图字符串 `.includes()` 三段引文原文各自为 true
// ═════════════════════════════════════════════════════════════════════════════
describe('(a) GWT-1: 三段引文逐字在视图中', () => {
  // 让 producer 输出超 1800 字符 (DEFAULT_FANIN_MIN_CHARS) 强制走 fan-in 摘要路径。
  const PRODUCER_OUTPUT = `producer-doc-header ${PAD} 原句引用: ${Q1} 又一引用 ${Q2} 第三段 ${Q3}`;

  test('★ 视图含三段引文原文 (逐字, `.includes()` 三段各自为 true)', () => {
    expect(PRODUCER_OUTPUT.length).toBeGreaterThanOrEqual(1800);
    // 抽取器断言 (INV-1 同源 — 反向自检锚): 用了真正的 extractQuotedSpans,
    // 出现 3 段就是 3 段, 不在测试里手数。
    expect(extractQuotedSpans(PRODUCER_OUTPUT)).toHaveLength(3);

    // 真实调用面: fan-in 视图 = composeFaninView(summary, path, len, anchors?, output?)
    // D-2 让引擎自己保逐字引文 —— output 是 producer 原文, 视图层附回。
    const view = composeFaninView(
      { tldr: '总结' },
      '/tmp/full.txt',
      PRODUCER_OUTPUT.length,
      undefined,
      PRODUCER_OUTPUT,
    );

    // GWT-1 钉死的同款断言: 三段引文原文各自被视图包含。
    expect(view.includes(Q1)).toBe(true);
    expect(view.includes(Q2)).toBe(true);
    expect(view.includes(Q3)).toBe(true);

    // 反向自检锚: 不是「摘要包含了别的东西蒙混过关」 —— 视图里**逐字**含有这三段 inner text。
    expect(view.includes(QUOTE_A)).toBe(true);
    expect(view.includes(QUOTE_B)).toBe(true);
    expect(view.includes(QUOTE_C)).toBe(true);
  });

  test('★ 反向自检: 不传 output → 视图不含引文 (证明 (a) 是附录起的效, 不是 base 自带)', () => {
    // base 视图 (摘要 + 指针, 不附引文段) 不应包含 producer 引文段 —— 这正是 §治理点 1 的
    // 「摘要本来就会丢引文」。证明 GWT-1 的效果来自附录、不是来自 base。
    const base = composeFaninView({ tldr: '总结' }, '/tmp/full.txt', PRODUCER_OUTPUT.length);
    expect(base.includes(Q1)).toBe(false);
    expect(base.includes(Q2)).toBe(false);
    expect(base.includes(Q3)).toBe(false);
  });

  test('★ 反向自检: 引文抽取器为 0 时, 传 output 的视图与不传 output 逐字一致 (GWT-3 同形)', () => {
    // 没有引文的 producer: 附录必空, view(output) ≡ view() (byte-equal, 不是「差不多」)。
    const NO_QUOTE = `producer-doc-header ${PAD}`;
    expect(extractQuotedSpans(NO_QUOTE)).toHaveLength(0);

    const base = composeFaninView({ tldr: '总结' }, '/tmp/full.txt', NO_QUOTE.length);
    const withOutput = composeFaninView({ tldr: '总结' }, '/tmp/full.txt', NO_QUOTE.length, undefined, NO_QUOTE);
    expect(withOutput).toBe(base);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// (b) GWT-2: 引文合计超附录预算 → 视图含显式截断标记字样且 full output 指针仍在
// ═════════════════════════════════════════════════════════════════════════════
describe('(b) GWT-2: 超预算 → 显式截断标记 + 全文指针仍在', () => {
  // 拼一段引文密度极高的 producer: 每段 100 字符, 50 段 ≈ 5000 字符外加 wrapper,
  // 直接顶穿 4000 字符预算。
  test('★ 50 段长引文 (合计 ≈5K 字符) → 显式截断标记 + full output 指针仍在', () => {
    const QUOTE_LEN = 100;
    const N = 50;
    const chunks: string[] = [];
    for (let i = 0; i < N; i++) {
      const token = `LONG_QUOTE_SEGMENT_${String(i).padStart(2, '0')}_`.padEnd(QUOTE_LEN - 2, 'x');
      chunks.push(`"${token}"`); // 102 chars per segment including outer quotes
    }
    const PRODUCER_OUTPUT = `producer-header\n${chunks.join(' ')}\nproducer-tail`;
    expect(extractQuotedSpans(PRODUCER_OUTPUT)).toHaveLength(N);
    // 合计超预算: 这是写这条测试的全部意义 —— 没超就根本走不到截断路径。
    const approxLen = N * (QUOTE_LEN + 2); // ≈ 5100 chars of inner text
    expect(approxLen).toBeGreaterThan(FANIN_VERBATIM_APPENDIX_MAX_CHARS);

    const view = composeFaninView(
      { tldr: '总结' },
      '/tmp/full.txt',
      PRODUCER_OUTPUT.length,
      undefined,
      PRODUCER_OUTPUT,
    );

    // GWT-2 钉死的两条同款断言: 截断标记字样 + full output 指针仍在。
    expect(view).toContain('逐字引文段截断');
    expect(view).toContain('/tmp/full.txt'); // full output 指针 (来自 base 视图, 写集兼容)

    // 数字说话 (纪律③, 与 composeAnchorBlock「另有 N 个未列」同源): 标记里要写出真实段数。
    expect(view).toContain(`共 ${N} 段`);
    // 至少保留了一段 (否则这条截断用例本身没意义)。
    const kept = (view.match(/^"LONG_QUOTE/gm) ?? []).length;
    expect(kept).toBeGreaterThan(0);
    expect(kept).toBeLessThan(N); // 真截了 —— 满 50 段不该都在视图里

    // 显式数字 vs 截断长度挂钩: 保留段数 = 视图里 `"..."` 行数 (GWT-2 「数字说话」纪律)。
    const noteMatch = view.match(/仅前 (\d+) 段/);
    expect(noteMatch).not.toBeNull();
    expect(Number(noteMatch![1])).toBe(kept);
  });

  test('★ 反向自检: 不超预算 → 视图**不**出现截断标记 (证明 (b) 是真触发, 不是默认行为)', () => {
    // 3 段中等长度引文, 远小于 4000: 附录必完整列出, 不该有截断标记。
    const PRODUCER_OUTPUT = `${PAD.repeat(40)} ${Q1} ${Q2} ${Q3}`;
    expect(extractQuotedSpans(PRODUCER_OUTPUT)).toHaveLength(3);
    const view = composeFaninView(
      { tldr: '总结' },
      '/tmp/full.txt',
      PRODUCER_OUTPUT.length,
      undefined,
      PRODUCER_OUTPUT,
    );

    expect(view).not.toContain('逐字引文段截断');
    expect(view).not.toContain('共 3 段'); // 「共 N 段」是截断标记的字段, 不应出现
  });

  test('★ 自定义预算 (maxChars=200) → 截断按新预算生效 (opts 可调)', () => {
    // 5 段 ≈ 510 字符 inner, 自定义预算 200 字符必然截断。
    const chunks: string[] = [];
    for (let i = 0; i < 5; i++) {
      const token = `CUSTOM_BUDGET_QUOTE_${i}_`.padEnd(100, 'x');
      chunks.push(`"${token}"`);
    }
    const PRODUCER_OUTPUT = chunks.join(' ');
    const view = composeFaninView(
      { tldr: '总结' },
      '/tmp/full.txt',
      PRODUCER_OUTPUT.length,
      undefined,
      PRODUCER_OUTPUT,
      { maxChars: 200 },
    );
    // 附录段自身受 200 上限 (view 整体含摘要 + 指针 + 附录, 不强求 ≤ 200)。
    const appendix = composeVerbatimAppendix(PRODUCER_OUTPUT, { maxChars: 200 });
    expect(appendix.length).toBeLessThanOrEqual(200);
    expect(view).toContain('逐字引文段截断');
    expect(view).toContain('共 5 段');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// (c) GWT-3: 零引文 → 视图与现状实现逐字一致 (零回归)
// ═════════════════════════════════════════════════════════════════════════════
describe('(c) GWT-3: 零引文 → 零附录 (视图逐字不变)', () => {
  test('★ producer 零引文 → composeVerbatimAppendix 返空串', () => {
    expect(composeVerbatimAppendix('一段完全没有引号的叙述文字。')).toBe('');
    expect(composeVerbatimAppendix(`${PAD} 全程无引号`)).toBe('');
    // 短引号 (< 24 字符) 不被认作引文 —— 纪律与 extractQuotedSpans 同源。
    expect(composeVerbatimAppendix('"短" "不达阈值" "的引号"')).toBe('');
  });

  test('★ producer 零引文 → 传 output 的视图与不传 output 逐字节相等 (零回归钉死)', () => {
    const PRODUCER_OUTPUT = `${PAD} 完全平叙, 不含任何引号`;
    const base = composeFaninView({ tldr: '总结' }, '/tmp/full.txt', PRODUCER_OUTPUT.length);
    const withOutput = composeFaninView({ tldr: '总结' }, '/tmp/full.txt', PRODUCER_OUTPUT.length, undefined, PRODUCER_OUTPUT);
    // 不是「差不多」, 是 byte-equal (GWT-3 的全部意义)。
    expect(withOutput).toBe(base);
  });

  test('★ 反向自检: 抽取器真没漏认 —— 同一段散文塞一段引文必出附录', () => {
    // 上条 zero 是因为零引文, 不是函数瘫了: 同一段里塞 1 段引文必出附录。
    const PRODUCER_OUTPUT = `${PAD} 关键证据: ${Q1}`;
    expect(extractQuotedSpans(PRODUCER_OUTPUT)).toHaveLength(1);
    const appendix = composeVerbatimAppendix(PRODUCER_OUTPUT);
    expect(appendix).not.toBe('');
    expect(appendix).toContain(QUOTE_A);
  });
});