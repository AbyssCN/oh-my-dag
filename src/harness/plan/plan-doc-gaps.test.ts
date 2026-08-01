/**
 * 计划文档缺口清单 —— 每条规则正反各一例。
 *
 * 重点盯**误报**那一侧: 这个模块产 blocker, 而一个假 blocker 会让人把整个闸关掉 (那比没有闸更坏)。
 * 所以每条"该报"的旁边都配一条"这种情况不许报"。
 *
 * 夹具一律内联小片段, 不依赖 `docs/plan/` 里的真文件。
 */
import { describe, expect, test } from 'bun:test';
import { countGaps, findPlanDocGaps } from './plan-doc-gaps';

const ids = (md: string, opts?: Parameters<typeof findPlanDocGaps>[1]) => findPlanDocGaps(md, opts).map((g) => g.id);

/** 一份骨架齐、契约硬的最小 SDD —— 各条测试在它基础上做减法。 */
const OK_SDD = [
  '## 目标 (Destination)',
  '',
  '把座位解析收成一条链。',
  '',
  '## 决策 (Decisions)',
  '',
  '- **D-1 单 resolver**:收成一条链。证据:`primitive-registry.ts:587`。',
  '',
  '## 契约 (Contracts)',
  '',
  '- **INV-1 单一权威**:所有座位经同一 resolver。',
  '  - GWT:*Given* 裸 boot,*When* 跑一次,*Then* `ugrep deepseek src/` 0 命中。',
  '',
  '## 分解 (Breakdown)',
  '',
  '- **P0**:改 src/harness/model-seat.ts。',
  '',
  '## 非目标 (Non-goals)',
  '',
  '- 不引 Temporal。',
  '',
  '## 未决 (Open)',
  '',
  '- **范围**:[待 owner]。',
].join('\n');

describe('基线', () => {
  test('骨架齐 + 契约硬 + 有可跑命令 → 一条缺口都不报', () => {
    expect(findPlanDocGaps(OK_SDD)).toEqual([]);
  });

  test('排序是 blocker > major > minor', () => {
    const gaps = findPlanDocGaps('## 目标 (Destination)\n\nx\n\n## 决策 (Decisions)\n\n- **D-1 甲**:证据:实测。');
    expect(gaps.map((g) => g.severity)).toEqual([...gaps.map((g) => g.severity)].sort());
    expect(gaps[0]!.severity).toBe('blocker');
  });

  test('每条缺口都带**描述 + 影响面 + 修法**, 不是只报一个词', () => {
    for (const g of findPlanDocGaps('## 目标 (Destination)\n\nx\n\n## 未决 (Open)\n\n- a')) {
      expect(g.title.length).toBeGreaterThan(8);
      expect(g.impact.length).toBeGreaterThan(8);
      expect(g.fix.length).toBeGreaterThan(8);
    }
  });
});

describe('blocker · 验收面', () => {
  test('契约段整段缺失 → contracts-missing', () => {
    expect(ids(OK_SDD.replace('## 契约 (Contracts)', '## 闲聊'))).toContain('contracts-missing');
  });

  test('契约段在但零不变量零 GWT → contracts-empty', () => {
    const md = OK_SDD.replace(/- \*\*INV-1[\s\S]*?0 命中。/, '这一段还没写完, 先占个位。');
    expect(ids(md)).toContain('contracts-empty');
  });

  test('有不变量但整段零 GWT → inv-without-gwt, 且**点名**是哪几条', () => {
    const md = OK_SDD.replace(/\n {2}- GWT:.*/, '').replace('- **INV-1 单一权威**', '- **INV-2 乙**:乙。\n- **INV-1 单一权威**');
    const g = findPlanDocGaps(md).find((x) => x.id === 'inv-without-gwt');
    expect(g?.severity).toBe('blocker');
    expect(g?.evidence).toEqual(['INV-2', 'INV-1']);
  });

  test('有 GWT 但整篇没有任何可跑的 oracle 命令 → no-oracle-command', () => {
    const md = OK_SDD.replace('`ugrep deepseek src/` 0 命中', '命中 0 条').replace('src/harness/model-seat.ts', '座位模块');
    expect(ids(md)).toContain('no-oracle-command');
  });

  test('**不许误报**: 命令写在围栏块里也算数', () => {
    const md = OK_SDD.replace('`ugrep deepseek src/` 0 命中', '命中 0 条') + '\n\n```sh\nbun test src/harness/plan\n```\n';
    expect(ids(md)).not.toContain('no-oracle-command');
  });
});

describe('major · 结构与落点', () => {
  test('非目标段缺失 → nongoals-missing (major)', () => {
    const gaps = findPlanDocGaps(OK_SDD.replace('## 非目标 (Non-goals)', '## 顺带一提'));
    expect(gaps.find((g) => g.id === 'nongoals-missing')?.severity).toBe('major');
  });

  test('分解段缺失 → breakdown-missing (major)', () => {
    expect(ids(OK_SDD.replace('## 分解 (Breakdown)', '## 随手记'))).toContain('breakdown-missing');
  });

  test('分解段点名的文件不存在 → breakdown-path-missing, 点名到具体路径', () => {
    const g = findPlanDocGaps(OK_SDD, { fileExists: () => false }).find((x) => x.id === 'breakdown-path-missing');
    expect(g?.severity).toBe('major');
    expect(g?.evidence[0]).toContain('src/harness/model-seat.ts');
  });

  test('**不许误报**: 文件都在 → 不报; 不注入 fileExists → 根本不查 (拿不准不报)', () => {
    expect(ids(OK_SDD, { fileExists: () => true })).not.toContain('breakdown-path-missing');
    expect(ids(OK_SDD)).not.toContain('breakdown-path-missing');
  });
});

describe('minor · 追溯性与卫生', () => {
  test('GWT 与不变量对不上号 → gwt-untraceable (只是 minor, 不拦交付)', () => {
    const md = OK_SDD.replace(
      '- **INV-1 单一权威**:所有座位经同一 resolver。',
      '- **INV-1 甲**:甲。\n- **INV-2 乙**:乙。',
    ).replace('  - GWT:', '- GWT:');
    const g = findPlanDocGaps(md).find((x) => x.id === 'gwt-untraceable');
    expect(g?.severity).toBe('minor');
    expect(g?.evidence).toContain('INV-2');
  });

  test('**不许误报**: 嵌套配好的不报追溯性缺口', () => {
    expect(ids(OK_SDD)).not.toContain('gwt-untraceable');
  });

  test('Then 里有判不了的词 → gwt-vague-words, 点名到词', () => {
    const md = OK_SDD.replace('`ugrep deepseek src/` 0 命中', '`ugrep` 跑完, 结果合理');
    const g = findPlanDocGaps(md).find((x) => x.id === 'gwt-vague-words');
    expect(g?.severity).toBe('minor');
    expect(g?.evidence[0]).toContain('合理');
  });

  test('决策段 / 未决段缺失各报一条 minor', () => {
    const md = OK_SDD.replace('## 决策 (Decisions)', '## 闲话').replace('## 未决 (Open)', '## 结束语');
    expect(ids(md)).toEqual(expect.arrayContaining(['decisions-missing', 'open-missing']));
  });
});

describe('不是 SDD 的文档不许被当 SDD 判', () => {
  test('骨架节不足两个 → 只报一条 not-an-sdd, 不产任何 blocker', () => {
    const notes = ['# 台账', '', '## 2026-07-28 · 某个决定', '', '记一句话。', '', '## 未决(需 owner)', '', '- 一条'].join('\n');
    const gaps = findPlanDocGaps(notes);
    expect(gaps.map((g) => g.id)).toEqual(['not-an-sdd']);
    expect(countGaps(gaps)).toEqual({ blocker: 0, major: 0, minor: 1 });
  });

  test('一个 `##` 都没有的纯笔记同样按"不是 SDD"处理', () => {
    expect(ids('随手记两句, 没有任何节。')).toEqual(['not-an-sdd']);
  });

  test('**不许漏判**: 骨架够两个就照 SDD 判 (该报的 blocker 一条不少)', () => {
    const half = ['## 目标 (Destination)', '', 'x', '', '## 非目标 (Non-goals)', '', '- 不做 y'].join('\n');
    expect(ids(half)).toContain('contracts-missing');
  });
});

describe('countGaps', () => {
  test('按严重度计数', () => {
    expect(countGaps(findPlanDocGaps(OK_SDD))).toEqual({ blocker: 0, major: 0, minor: 0 });
  });
});
