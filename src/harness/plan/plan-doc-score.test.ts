/**
 * 计划文档打分闸 —— 每条判据正反各一例。
 *
 * 两个方向都得钉住:
 *  ① **该扣的扣**: 没有 GWT 的不变量、写着「合理」的 Then、没有证据的决策;
 *  ② **不该扣的一个都不许扣**: 这两个文件的前身就是因为"对每份 SDD 都报 blocker"被删的,
 *     所以「分母为 0 = 不适用」「样本太小不判」「同一件事的另一种写法照样认」全部要有网。
 *
 * 夹具一律**内联小片段** —— 不依赖 `docs/plan/` 里的真文件, 那些会变。
 */
import { describe, expect, test } from 'bun:test';
import { DEFAULT_PLAN_DOC_THRESHOLDS, parsePlanDoc, scorePlanDoc } from './plan-doc-score';

const doc = (...parts: string[]) => parts.join('\n\n');

const CONTRACT = (body: string) => `## 契约 (Contracts)\n\n${body}`;

describe('判据 1 · 不变量配 GWT 率', () => {
  test('正: 每条不变量下挂一条 GWT → 100%', () => {
    const s = scorePlanDoc(
      CONTRACT(
        [
          '- **INV-1 单一权威**:所有座位经同一 resolver。',
          '  - GWT:*Given* 裸 boot,*When* 跑一次,*Then* `ugrep deepseek src/` 0 命中。',
          '- **INV-2 响亮失败**:解不到凭证就响亮失败。',
          '  - GWT:*Given* 无凭证,*When* 启动,*Then* 退出码非零并指名该座位。',
        ].join('\n'),
      ),
    );
    expect(s.metrics.gwtCoverage).toMatchObject({ hit: 2, total: 2, value: 1 });
    expect(s.failures.map((f) => f.metric)).not.toContain('gwtCoverage');
  });

  test('反: 三条不变量只有一条配了 GWT → 未达标且**点名**是哪两条', () => {
    const s = scorePlanDoc(
      CONTRACT(
        [
          '- **INV-1 甲**:甲。',
          '  - GWT:*Given* a,*When* b,*Then* `bun test` 全绿。',
          '- **INV-2 乙**:乙。',
          '- **INV-3 丙**:丙。',
        ].join('\n'),
      ),
    );
    expect(s.metrics.gwtCoverage.value).toBeCloseTo(1 / 3);
    const f = s.failures.find((x) => x.metric === 'gwtCoverage');
    expect(f?.offenders).toEqual(['INV-2', 'INV-3']);
    expect(s.pass).toBe(false);
  });

  test('交叉编号引用也算配对 (GWT 正文点了不变量编号)', () => {
    const s = scorePlanDoc(
      CONTRACT(
        [
          '- **INV-7 不静默降级**:任何降级必须 log。',
          '',
          '- **GWT-1** *Given* 降级发生,*When* 收尾,*Then* log 里有 1 条降级记录(INV-7)。',
        ].join('\n'),
      ),
    );
    expect(parsePlanDoc(CONTRACT('- **INV-7 x**:x。')).invariants).toHaveLength(1);
    expect(s.metrics.gwtCoverage.value).toBe(1);
    expect(s.parse.invariants[0]!.gwtIds).toEqual(['GWT-1']);
  });

  test('**分离列表**(不变量一张表 / GWT 另一张表, 互不点名)退回数量覆盖, 不判 0', () => {
    const s = scorePlanDoc(
      CONTRACT(
        [
          '- **INV-1 甲**:甲。',
          '- **INV-2 乙**:乙。',
          '',
          '- **G-1**:Given 甲场景,When 跑,Then 命中 3 条。',
          '- **G-2**:Given 乙场景,When 跑,Then 命中 0 条。',
        ].join('\n'),
      ),
    );
    // 逐条追溯不到 (那是 plan-doc-gaps 的 minor), 但"有没有足够的验收量"这一层是满的。
    expect(s.parse.invariants.every((i) => i.gwtIds.length === 0)).toBe(true);
    expect(s.metrics.gwtCoverage.value).toBe(1);
  });

  test('**表格形态的闸** (`| G1 | 闸 | 判据 | 状态 |`) 与嵌套写法等价, 不判成空契约', () => {
    const s = scorePlanDoc(
      CONTRACT(
        [
          '| # | 闸 | 判据 | 状态 |',
          '|---|---|---|---|',
          '| **G1** | 成败信号可信 | 假阴性 < 10% 且假阳性不升 | Exercised |',
          '| **G2** | 崩溃不丢制品 | `bun test src/harness/plan` 全绿 | Missing |',
        ].join('\n'),
      ),
    );
    expect(s.parse.invariants.map((i) => i.id)).toEqual(['G1', 'G2']);
    expect(s.metrics.gwtCoverage.value).toBe(1);
    expect(s.metrics.gwtDecidable.value).toBe(1);
  });
});

describe('判据 2 · GWT 可判定率', () => {
  const g = (then: string) => CONTRACT(`- GWT:*Given* a,*When* b,*Then* ${then}`);

  test('正: Then 带反引号命令 / 数字量纲 / 文件路径 / 0 命中 —— 都算可判定', () => {
    for (const then of [
      '`bun run tsc --noEmit` 全绿。',
      '恰好尝试 3 次。',
      '产物落在 src/harness/plan/fixpoint.ts。',
      'runtime 解析路径 0 命中。',
      '恰好一轮修复后收敛。',
    ]) {
      const s = scorePlanDoc(g(then));
      expect(s.parse.gwts[0]!.decidable).toBe(true);
    }
  });

  test('反: Then 写「合理」「符合预期」这类判不了的词 → 不可判定', () => {
    for (const then of ['结果合理。', '产出符合预期。', '输出质量良好。']) {
      const s = scorePlanDoc(g(then));
      expect(s.parse.gwts[0]!.decidable).toBe(false);
      expect(s.parse.gwts[0]!.vague.length).toBeGreaterThan(0);
    }
  });

  test('**有锚但也有模糊词 → 仍判不可判定** (两个条件缺一不可)', () => {
    const s = scorePlanDoc(g('`bun test` 跑完, 结果合理。'));
    expect(s.parse.gwts[0]!.anchors).toContain('code');
    expect(s.parse.gwts[0]!.decidable).toBe(false);
  });

  test('反: 一个锚都没有的散文 Then 也算判不了', () => {
    const s = scorePlanDoc(g('它就能自己跑起来。'));
    expect(s.parse.gwts[0]!.anchors).toEqual([]);
    expect(s.parse.gwts[0]!.decidable).toBe(false);
  });

  test('未达标时点名, 并区分「判不了的词」与「无判据锚」', () => {
    const s = scorePlanDoc(
      CONTRACT(
        [
          '- **GWT-1** *Given* a,*When* b,*Then* 结果合理。',
          '- **GWT-2** *Given* a,*When* b,*Then* 它就能跑。',
          '- **GWT-3** *Given* a,*When* b,*Then* 它就能跑。',
          '- **GWT-4** *Given* a,*When* b,*Then* `bun test` 全绿。',
        ].join('\n'),
      ),
    );
    const f = s.failures.find((x) => x.metric === 'gwtDecidable');
    expect(f?.offenders).toEqual(['GWT-1(判不了的词)', 'GWT-2(无判据锚)', 'GWT-3(无判据锚)']);
  });
});

describe('判据 3 · 决策带证据率', () => {
  const d = (...items: string[]) => `## 决策 (Decisions)\n\n${items.join('\n')}`;

  test('正: 链接 / file:line / 实测读数 / owner 拍板 都算证据', () => {
    const s = scorePlanDoc(
      d(
        '- **D-1 甲**:定甲。证据:见 [报告](https://x.example/y)。',
        '- **D-2 乙**:定乙。证据:`primitive-registry.ts:587` 已有。',
        '- **D-3 丙**:定丙。证据:实测 200 次, low/high 无差。',
        '- **D-4 丁**:定丁。证据:owner 拍。',
      ),
    );
    expect(s.metrics.decisionEvidence).toMatchObject({ hit: 4, total: 4, value: 1 });
  });

  test('反: 只有理由没有证据 → 扣分并点名', () => {
    const s = scorePlanDoc(
      d(
        '- **D-1 甲**:定甲。为什么:这样更简单。',
        '- **D-2 乙**:定乙。为什么:面太大。',
        '- **D-3 丙**:定丙。证据:实测。',
      ),
    );
    expect(s.metrics.decisionEvidence.value).toBeCloseTo(1 / 3);
    expect(s.failures.find((x) => x.metric === 'decisionEvidence')?.offenders).toEqual(['D-1', 'D-2']);
  });

  test('`### D-N` 子节形态与 `| D-N |` 表行形态一样被数到', () => {
    const p = parsePlanDoc(
      [
        '## 决策 (Decisions)',
        '',
        '| # | 决策 | 证据 |',
        '|---|---|---|',
        '| D-A | 乙 | 全仓零命中 |',
        '',
        '### D-R 甲',
        '',
        '正文, 证据:实测。',
      ].join('\n'),
    );
    expect(p.decisions.map((x) => x.id)).toEqual(['D-A', 'D-R']);
    expect(p.decisions.every((x) => x.evidence.length > 0)).toBe(true);
  });
});

describe('判据 4 · 落点具体率', () => {
  const b = (...rows: string[]) => `## 分解 (Breakdown)\n\n${rows.join('\n')}`;

  test('正: 切片带文件路径 / 反引号符号 / 裸标识符 → 算有落点', () => {
    const s = scorePlanDoc(
      b(
        '- **P1**:改 src/harness/plan/fixpoint.ts。',
        '- **P2**:加 `max_retry` 旋钮。',
        '- **P3**:接 plan-passes/stamp。',
      ),
    );
    expect(s.metrics.sliceAnchors).toMatchObject({ hit: 3, total: 3, value: 1 });
    expect(s.parse.slices[0]!.paths).toEqual(['src/harness/plan/fixpoint.ts']);
  });

  test('反: 纯散文切片 → 扣分并点名', () => {
    const s = scorePlanDoc(
      b('- **P1**:把鲁棒性做好。', '- **P2**:再补一轮。', '- **P3**:把口收干净。', '- **P4**:改 `max_retry`。'),
    );
    expect(s.metrics.sliceAnchors.value).toBeCloseTo(0.25);
    const f = s.failures.find((x) => x.metric === 'sliceAnchors');
    expect(f?.offenders).toHaveLength(3);
    expect(f?.offenders[0]).toStartWith('P1');
  });

  test('噪声不算落点: `A/B`(方法名)与 `G-1/G-4`(交叉引用)都命不中', () => {
    const s = scorePlanDoc(b('| 片 | 内容 | 闸 |', '|---|---|---|', '| S1 | 跑 A/B 语料 | G-1/G-4 |'));
    expect(s.parse.slices[0]!.anchored).toBe(false);
  });

  test('表格切片: 表头行本身不算一片', () => {
    const p = parsePlanDoc(
      b('| 片 | 内容 | 依赖 |', '|---|---|---|', '| P0 | 改 `resolveSeatModel` | — |', '| P1 | 改 src/a.ts | P0 |'),
    );
    expect(p.slices.map((x) => x.label)).toEqual(['P0', 'P1']);
  });
});

describe('判据 5 · 未决段非空 —— **只报不拒**', () => {
  test('空的未决段 → 出软标记, 但 pass 不受影响', () => {
    const s = scorePlanDoc(doc(CONTRACT('- **INV-1 x**:x。\n  - GWT:*Given* a,*When* b,*Then* `bun test` 全绿。'), '## 未决 (Open)\n\n(暂无)'));
    expect(s.softFlags.map((f) => f.key)).toEqual(['open-empty']);
    expect(s.pass).toBe(true);
    expect(s.failures).toHaveLength(0);
  });

  test('非空未决段 → 无软标记; 只剩划掉条目的也算空', () => {
    expect(scorePlanDoc('## 未决 (Open)\n\n- **D-9 范围**:[待 owner]').softFlags).toHaveLength(0);
    expect(scorePlanDoc('## 未决 (Open)\n\n- ~~**已交付**~~:不再单独开票。').softFlags.map((f) => f.key)).toEqual([
      'open-empty',
    ]);
  });
});

describe('防"每份都报 blocker": 不适用 / 小样本 / 可配阈值', () => {
  test('分母为 0 → value 为 null 且**永不**构成 failure', () => {
    const s = scorePlanDoc('# 一份没有契约段的笔记\n\n随便写点什么。');
    expect(s.metrics.gwtCoverage.value).toBeNull();
    expect(s.metrics.gwtDecidable.value).toBeNull();
    expect(s.pass).toBe(true);
    expect(s.failures).toHaveLength(0);
  });

  test('样本 < 3 只展示不判 (两条决策里挂一条 ≠ 50% 的质量信号)', () => {
    const s = scorePlanDoc('## 决策 (Decisions)\n\n- **D-1 甲**:为什么:简单。\n- **D-2 乙**:证据:实测。');
    expect(s.metrics.decisionEvidence).toMatchObject({ hit: 1, total: 2, gated: false });
    expect(s.metrics.decisionEvidence.value).toBe(0.5);
    expect(s.pass).toBe(true);
  });

  test('阈值可覆盖, 且只覆盖传进来的那一项', () => {
    const md = CONTRACT(['- **INV-1 甲**:甲。', '  - GWT:*Given* a,*When* b,*Then* `x` 全绿。', '- **INV-2 乙**:乙。', '- **INV-3 丙**:丙。'].join('\n'));
    expect(scorePlanDoc(md).pass).toBe(false);
    const loose = scorePlanDoc(md, { gwtCoverage: 0.3 });
    expect(loose.pass).toBe(true);
    expect(loose.thresholds.gwtDecidable).toBe(DEFAULT_PLAN_DOC_THRESHOLDS.gwtDecidable);
  });

  test('围栏代码块里的 `##` / `- **INV-` 不参与结构判定', () => {
    const p = parsePlanDoc(
      ['## 契约 (Contracts)', '', '```md', '## 决策 (Decisions)', '- **INV-9 假的**:示例。', '```', '', '- **INV-1 真的**:真。'].join('\n'),
    );
    expect(p.invariants.map((i) => i.id)).toEqual(['INV-1']);
    expect(p.has.decisions).toBe(false);
  });

  test('节别名: 「上线闸 (Ship Gates)」「切片」与「契约」「分解」同类', () => {
    const p = parsePlanDoc('## 上线闸 (Ship Gates)\n\nx\n\n## 切片 (Breakdown)\n\ny');
    expect(p.has.contracts).toBe(true);
    expect(p.has.breakdown).toBe(true);
  });

  test('「非目标」不会被误判成「目标」', () => {
    const p = parsePlanDoc('## 非目标 (Non-goals)\n\n- 不引 Temporal。');
    expect(p.has.nongoals).toBe(true);
    expect(p.has.goal).toBe(false);
  });
});

describe('oracle 命令抽取', () => {
  test('反引号里的 / 围栏里的 / 散文裸写的命令都收得到', () => {
    const p = parsePlanDoc(['跑 `bun run tsc --noEmit`。', '', '```sh', 'bun test src/harness', '```', '', '*When* grep 全仓,*Then* 无残引。'].join('\n'));
    expect(p.oracleCommands.length).toBeGreaterThanOrEqual(3);
    expect(p.oracleCommands.some((c) => c.includes('tsc'))).toBe(true);
    expect(p.oracleCommands).toContain('grep');
  });

  test('纯散文不会凭空长出命令', () => {
    expect(parsePlanDoc('把这件事做完就行。').oracleCommands).toEqual([]);
  });
});
