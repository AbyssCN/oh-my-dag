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

/**
 * 直通可编译性(2026-08-18)——「这份文档机器吃不吃得下」与「它写得好不好」是两个问题。
 *
 * 起因:两次结晶两次被解析器当场拦(第一次 `S1` 切片列点火即拒,第二次波形被静默丢掉),
 * 而 `plan-doc-check` 那时**一次都没跑过 `parseBreakdown`** —— 它只评分,不验可消费性。
 * 全量量过:149 份 plan 文档里 23 份**自称**直通契约(表头声明了写集 + verify),
 * 其中 9 份解析抛错、6 份波形读不到。而 `sddPath` 直通是夜批的默认路径。
 *
 * ## 判据为什么收窄到「表头声明写集 + verify」
 *
 * 不是所有分解段都打算走直通:实验契约、对比报告、`| 序 | 切片 | 内容 |` 这类人读表本来就不是
 * 直通输入,拿这把尺子量它们是**尺子量错对象**(会一次红 38 份,然后闸被关掉)。
 * 表头同时声明「写集」与 verify = 它自称是直通契约,才该被量。
 */
describe('直通可编译性 (sddPath 能不能吃下这份文档)', () => {
  const head = ['## 目标 (Destination)', '', 'x', '', '## 契约 (Contracts)', '', '- **INV-1 x**:y。', '  - GWT:*Given* a,*When* b,*Then* c。', '', '## 分解 (Breakdown)', ''];
  const tail = ['', '## 非目标 (Non-goals)', '', '- 不做 y'];
  const table = (sliceCol: string) => ['| 切片 | 写集 | 依赖 | verify |', '|---|---|---|---|', `| ${sliceCol} | \`src/a.ts\` | 无 | \`bun test src/a.test.ts\` |`];

  // 证伪: 删掉 plan-doc-gaps 里那段 parseBreakdown 调用 → 本条红 (不再报 unparseable),
  // 读到的正是 2026-08-18 那两次点火当场拒之前的状态: 闸全绿而文档吃不下。
  test('★ 自称直通契约但切片列不是裸数字 → 报 unparseable (major)', () => {
    const md = [...head, ...table('S1 做事'), '', '并行波形:`{1}`', ...tail].join('\n');
    expect(ids(md)).toContain('sdd-breakdown-unparseable');
  });

  // 证伪: 把 waves 那一格判据删掉 → 本条红。波形读不到不拦交付 (图退回按依赖边排), 故 minor。
  test('★ 能解析但波形写在行中间(锚行首读不到) → 报 waves-unread (minor)', () => {
    const md = [...head, ...table('1 做事'), '', '写集两两不相交 ✓。并行波形:`{1}`', ...tail].join('\n');
    const gs = findPlanDocGaps(md);
    expect(gs.map((g) => g.id)).toContain('sdd-waves-unread');
    expect(gs.find((g) => g.id === 'sdd-waves-unread')!.severity).toBe('minor');
  });

  test('合法的直通表 → 两条都不报', () => {
    const md = [...head, ...table('1 做事'), '', '并行波形:`{1}`', ...tail].join('\n');
    const got = ids(md);
    expect(got).not.toContain('sdd-breakdown-unparseable');
    expect(got).not.toContain('sdd-waves-unread');
  });

  // **不许误报**那一侧 —— 这条比上面三条更重要: 一个假 major 会让人把整个闸关掉。
  test('不外溢: 分解段是列表 / 表头不声明写集+verify → 一条都不报', () => {
    const list = ids(OK_SDD); // OK_SDD 的分解段是列表
    expect(list).not.toContain('sdd-breakdown-unparseable');
    const humanTable = [...head, '| 序 | 切片 | 内容 |', '|---|---|---|', '| 一 | A | 做 A |', ...tail].join('\n');
    expect(ids(humanTable)).not.toContain('sdd-breakdown-unparseable');
  });
});

// ---------------------------------------------------------------------------
// S-45: 分解表能不能被真正吃它的那个编译器吃下
// ---------------------------------------------------------------------------

/** 把 OK_SDD 的分解段换成给定内容 (其余骨架不动)。 */
const withBreakdown = (body: string) =>
  OK_SDD.replace('- **P0**:改 src/harness/model-seat.ts。', body);

describe('S-45 · 分解表与直通编译器不许各说各话', () => {
  test('写成表格但首列不是编号 → 报 breakdown-not-compilable, 且带编译器原话', () => {
    const md = withBreakdown(
      [
        '| 片 | 内容 | 改哪里 | verify |',
        '|---|---|---|---|',
        '| **A** | 加五列 | 改 src/harness/dag-record.ts | 新建 x.test.ts |',
      ].join('\n'),
    );
    const gaps = findPlanDocGaps(md);
    const hit = gaps.find((g) => g.id === 'breakdown-not-compilable');
    expect(hit).toBeDefined();
    // 判词必须转述编译器自己的话 —— 否则读的人还得再猜一次它到底嫌什么。
    expect(hit!.evidence.join(' ')).toContain('编号');
  });

  test('四列 + 首列编号 + 波形 → 不报 (这是编译器吃得下的形状)', () => {
    const md = withBreakdown(
      [
        '| 切片 | 写集 | 依赖 | verify |',
        '|---|---|---|---|',
        '| 1 加五列 | src/harness/dag-record.ts | — | bun test src/harness/dag-record.test.ts |',
        '| 2 尺子 | scripts/omd-waste.ts | 1 | bun test scripts/omd-waste.test.ts |',
        '',
        '波形: {1}{2}',
      ].join('\n'),
    );
    expect(ids(md)).not.toContain('breakdown-not-compilable');
  });

  test('误报侧: 分解段写成列表 (不主张直通) → 一个字都不许报', () => {
    // 本仓多数 SDD 是这个形状。对它们开火 = 假 major = 整条闸被关掉。
    expect(ids(OK_SDD)).not.toContain('breakdown-not-compilable');
    expect(findPlanDocGaps(OK_SDD)).toEqual([]);
  });

  test('误报侧: 压根没有分解段 → 只报 breakdown-missing, 不报编译不过', () => {
    const md = OK_SDD.replace(/## 分解 \(Breakdown\)[\s\S]*?(?=## 非目标)/, '');
    const got = ids(md);
    expect(got).toContain('breakdown-missing');
    expect(got).not.toContain('breakdown-not-compilable');
  });
});
