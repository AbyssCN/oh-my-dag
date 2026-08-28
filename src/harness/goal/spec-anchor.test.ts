/**
 * T-1b 规格锚 —— S-51 的真修法(2026-08-28)。
 *
 * ## 这组测试要证的那条链
 *
 * 改契约的**决策段** ⇒ 规格锚变 ⇒ 编译出来的实施节点变 ⇒ 语义指纹变 ⇒
 * T-1a 的规格守卫在 resume 时判「不是同一个节点」⇒ 整片重跑。
 *
 * 链上每一跳单独钉一条,**最后一条把整条链端到端跑一遍** —— 只钉纯函数的话,
 * 「零件全绿、没人调它」那个病(#206)照样成立。
 *
 * ## 反向自检(每条真跑过)
 * · 把排除表 `NARRATIVE_HEADING` 清空(叙述段也进锚)→ ★③ 红(改现场的错别字作废所有片)。
 * · 把「认不出的段一律当规格」写反(变成白名单:认不出就排除)→ ★② 红。
 * · 把 `compileBreakdown` 里那句盖章删掉 → ★④ 红(节点上没有锚)。
 * · 把 `nodeFieldsKey` 里的 `spec_anchor` 那一行删掉 → ★⑤ 红(锚变了指纹不动, 白盖)。
 */
import { describe, expect, test } from 'bun:test';
import { governingSpecText, specAnchor } from './spec-anchor';
import { compileBreakdown } from './sdd-compile';
import { parseBreakdown } from './sdd-direct';
import { merkleFingerprints } from '../plan-passes/semantic-key';

/** 一份最小但形状真实的契约:六段齐, 两片。 */
const contract = (opts: { decision: string; evidence: string }): string =>
  [
    '# 执行契约 —— 测试用',
    '',
    '## 目标 (Goal)',
    '- 把 X 做对',
    '',
    '## 现场 (Evidence)',
    `- ${opts.evidence}`,
    '',
    '## 决策 (Decisions)',
    `### D-1 ${opts.decision}`,
    '理由略。',
    '',
    '## 契约 (Contracts)',
    '- G-1 不变量',
    '',
    '## 分解 (Breakdown)',
    '',
    '| 切片 | 写集 | 依赖 | verify |',
    '|---|---|---|---|',
    '| 1 甲 | src/a.ts + test | — | bun test src/a.test.ts |',
    '| 2 乙 | src/b.ts + test | 1 | bun test src/b.test.ts |',
    '',
    '## 未决 (Open)',
    '- 还没定的事',
    '',
    '## 非目标 (Non-goals)',
    '- 无',
  ].join('\n');

const BASE = { decision: '原来的决策', evidence: '原来的现场' };

const compile = (text: string) =>
  compileBreakdown(parseBreakdown(text), {
    acceptCommand: 'bun test',
    name: 'anchor-fixture',
    specAnchor: specAnchor(text),
  });

describe('T-1b 规格锚 · 段的取舍', () => {
  test('★① 叙述段整段不进锚 (现场 / 未决 的正文都不在规格文本里)', () => {
    const spec = governingSpecText(contract(BASE));
    expect(spec).toContain('原来的决策'); // 决策段在
    expect(spec).toContain('G-1 不变量'); // 契约段在
    expect(spec).toContain('把 X 做对'); // 目标段在
    expect(spec).not.toContain('原来的现场'); // 现场段不在
    expect(spec).not.toContain('还没定的事'); // 未决段不在
  });

  test('★② 认不出的段一律当规格 (fail-closed: 排除表是黑名单不是白名单)', () => {
    // 文档格式漂了 / 出现新段名时, 闸只许变**严**。写反了 (认不出就排除) 的话,
    // 一次改标题就能让整道闸静默失效 —— 那是本仓最贵的一类死法。
    const withUnknown = contract(BASE).replace('## 非目标 (Non-goals)', '## 某个没人见过的新段');
    expect(governingSpecText(withUnknown)).toContain('## 某个没人见过的新段');
  });

  test('★③ 改现场的一个错别字 → 锚不动 (会作废所有片的闸会被人关掉)', () => {
    expect(specAnchor(contract({ ...BASE, evidence: '改了个错别字的现场' }))).toBe(
      specAnchor(contract(BASE)),
    );
  });

  test('★④ 改决策段 → 锚变 (S-51 那一格)', () => {
    expect(specAnchor(contract({ ...BASE, decision: '改过的决策 D-8a' }))).not.toBe(
      specAnchor(contract(BASE)),
    );
  });
});

describe('T-1b 规格锚 · 接线 (零件绿不算, 得有人调它)', () => {
  test('★⑤ 编译器把锚盖在**实施节点**上, 不盖在 command 节点上', () => {
    const plan = compile(contract(BASE));
    const anchor = specAnchor(contract(BASE));
    // 实施节点 (agent, 会被 resume 当绿跳过的正是它们)
    expect((plan.nodes.s1 as { spec_anchor?: string }).spec_anchor).toBe(anchor);
    expect((plan.nodes.s2 as { spec_anchor?: string }).spec_anchor).toBe(anchor);
    // GREEN 是 command 节点 —— shouldSkip 对 command 恒不跳 (#167), 盖章只是噪声
    expect((plan.nodes['s1-green'] as { spec_anchor?: string }).spec_anchor).toBeUndefined();
  });

  test('★⑥ 不给 specAnchor → 字段缺席, 编出来的图与今天逐字节相同 (零涟漪)', () => {
    const withAnchor = compileBreakdown(parseBreakdown(contract(BASE)), {
      acceptCommand: 'bun test',
      name: 'anchor-fixture',
    });
    expect((withAnchor.nodes.s1 as { spec_anchor?: string }).spec_anchor).toBeUndefined();
  });

  test('★⑦ 端到端: 改决策段 ⇒ 实施节点的语义指纹变 (T-1a 的守卫才看得见 S-51)', () => {
    const before = merkleFingerprints(compile(contract(BASE)));
    const after = merkleFingerprints(compile(contract({ ...BASE, decision: '改过的决策 D-8a' })));

    // 这是整票的判据: 契约的决策段改了, 而切片表行逐字未变 (名/写集/依赖/verify 全一样)。
    // T-1b 之前这两份指纹相等 —— 那正是 S-51 里「整片被跳过」的机械原因。
    expect(after.get('s1')).not.toBe(before.get('s1'));
    expect(after.get('s2')).not.toBe(before.get('s2'));
  });

  test('★⑧ 改现场 ⇒ 指纹一个都不动 (每片该重跑的才重跑)', () => {
    const before = merkleFingerprints(compile(contract(BASE)));
    const after = merkleFingerprints(compile(contract({ ...BASE, evidence: '改了个错别字的现场' })));
    expect(after.get('s1')).toBe(before.get('s1'));
    expect(after.get('s2')).toBe(before.get('s2'));
  });
});
