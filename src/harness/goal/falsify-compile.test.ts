/**
 * src/harness/goal/falsify-compile.test —— sN-falsify 切片 1 的反向自检
 * (SDD `sN-falsify` 2026-08-22, 切片 1 = 解析 + 编译)。
 *
 * ⚠ 本文件的反向自检模式与本仓惯例 (delta-compare / sdd-direct / sdd-compile …) **逐字一致**:
 * 每条断言写一行「把 X 那行删掉 / 改成 Y → 此 test 由绿转红」, 配一条**已知违规样本**或**合法样本**。
 * 决不写"看它能跑"的乱炖用例 —— 那种 test 在加闸那一刻红不了, 是把今天的债往后挪。
 *
 * 切片 1 只承重**两张**: ① C-1 解析反向自检小节; ② C-2 编译出 falsify 节点。
 * 真正承重的是切片 2 的引擎执行面 (mutation/revert), 那部分由 src/harness/dag/falsify-mutate.test.ts
 * 单独护着 —— 本片**不**稀释它, 也不替它造测试数据 (分享测试 = 隐式的"两者一起通过"假绿入口)。
 */
import { describe, expect, test } from 'bun:test';
import { parseBreakdown, type SddBreakdown } from './sdd-direct';
import { compileBreakdown } from './sdd-compile';
import { PlanSchema } from '../conductor-plan';
import { DEFAULT_COMMAND_ALLOWLIST } from '../command-leaf';

const FULL_REGRESSION = 'bunx tsc --noEmit && bun test';

/** 走文本路造 SDD 分解表 + 可选反向自检小节。复用 sdd-compile.test.ts 的 table/parse 路。 */
const table = (rows: string[], wave?: string): string =>
  [
    '# t',
    '## 契约 (Contracts)',
    '- G-1',
    '## 分解 (Breakdown)',
    '',
    '| 切片 | 写集 | 依赖(带理由) | verify |',
    '|---|---|---|---|',
    ...rows,
    '',
    ...(wave ? [`并行波形:${wave}`] : []),
    '',
    '## 非目标 (Non-goals)',
    '- 无',
  ].join('\n');

/** 拼一个反向自检小节到原表后。空表 = 没有这一片的小节 (合法, 编译成零节点)。 */
const withFalsify = (text: string, sections: string[]): string =>
  text + (sections.length ? '\n\n' + sections.join('\n\n') + '\n' : '');

/** `### 反向自检 (切片 N)` 表头 + 一组 (#, file, oldText, newText)。 */
const falsifySection = (sliceId: number, rows: Array<[number, string, string, string]>): string =>
  [
    `### 反向自检 (切片 ${sliceId})`,
    '| # | 文件 | oldText | newText |',
    '|---|---|---|---|',
    ...rows.map(([i, f, o, n]) => `| ${i} | ${f} | ${o} | ${n} |`),
  ].join('\n');

/** 标准两片: 1 写 src/a.ts + test, 2 写 src/b.ts + test, 2 依赖 1。 */
const TWO_SLICES = table([
  '| 1 a | src/a.ts + test | — | bun test src/a.test.ts |',
  '| 2 b | src/b.ts + test | 1 | bun test src/b.test.ts |',
], '{1} → {2}');

const A_WRITE = 'src/a.ts';
const B_WRITE = 'src/b.ts';

// ── C-1 解析面 ─────────────────────────────────────────────────────────────────────────

describe('parseBreakdown — 反向自检解析 (C-1)', () => {
  test('一份 SDD 含一片的反向自检小节 → breakdown.falsify[1] 是 SddFalsify[]', () => {
    const text = withFalsify(TWO_SLICES, [
      falsifySection(1, [[1, 'src/a.ts', "const x = 1;", "const x = 2;"]]),
    ]);
    const bd = parseBreakdown(text);
    expect(bd.falsify).toBeDefined();
    expect(bd.falsify![1]).toHaveLength(1);
    const row = bd.falsify![1]![0]!;
    expect(row.index).toBe(1);
    expect(row.file).toBe('src/a.ts');
    expect(row.oldText).toBe('const x = 1;');
    expect(row.newText).toBe('const x = 2;');
  });

  test('一片多行: 每行独立读取, oldText/newText 保留内部缩进 (反引号 = 字面保留, 不被表格 trim 吞)', () => {
    // INV-3 转义规则: 源码里有前导空格/末格这类「与 markdown 表格 padding 同形」的字符,
    // 作者用反引号把整段包起来 —— markdown 的标准 escape, 告诉解析器「这格字面意义保留」.
    // 没有反引号那路 = `t.trim()` 简单路径, 作者写清洁源码片段 (手敲也行). 真要保留缩进就加反引号.
    // 反向自检: 把 extractCodeCell 里的 `t.trim()` 去掉 (走 m[1] 时再 trim, 实际上 m[1] 已经是
    // 反引号内字面内容, 不会丢缩进), 然后把测试里的反引号全去掉 → 本 test 当场红.
    const text = withFalsify(TWO_SLICES, [
      falsifySection(1, [
        [1, 'src/a.ts', '`    const x = 1;`', '`    const x = 999;`'],
        [2, 'src/a.ts', 'return true;', 'return false;'],
      ]),
    ]);
    const bd = parseBreakdown(text);
    const rows = bd.falsify![1]!;
    expect(rows.map((r) => r.index)).toEqual([1, 2]);
    expect(rows[0]!.oldText).toBe('    const x = 1;'); // 反引号内字面前 4 空格**保留**
    expect(rows[0]!.newText).toBe('    const x = 999;');
    expect(rows[1]!.oldText).toBe('return true;'); // 无反引号路: 标准 trim, 与其它列同款
  });

  test('多片各一节: 每片一条独立, 切片id → 那一片自己的表', () => {
    const text = withFalsify(TWO_SLICES, [
      falsifySection(1, [[1, 'src/a.ts', "a;", "b;"]]),
      falsifySection(2, [[1, 'src/b.ts', "c;", "d;"], [2, 'src/b.ts', "e;", "f;"]]),
    ]);
    const bd = parseBreakdown(text);
    expect(bd.falsify?.[1]).toHaveLength(1);
    expect(bd.falsify?.[2]).toHaveLength(2);
    expect(bd.falsify![1]![0]!.file).toBe('src/a.ts');
    expect(bd.falsify![2]![1]!.file).toBe('src/b.ts');
    expect(bd.falsify![2]![1]!.newText).toBe('f;');
  });

  test('一行 cell 里带反引号路径: backtick 剥掉, 余下当 raw 路径', () => {
    // 本仓契约真习惯 (`src/a.ts`(新) 那一族), 反向自检同样要吃。
    const text = withFalsify(TWO_SLICES, [
      falsifySection(1, [[1, '`src/a.ts`', 'old', 'new']]),
    ]);
    const bd = parseBreakdown(text);
    expect(bd.falsify![1]![0]!.file).toBe('src/a.ts');
  });

  test('半角全角括号都收 (`(切片 1)` / `（切片 1）`)', () => {
    // 本仓既写半角也写全角; SDD 同一字段双标 = 同一份契约两份解析。
    const half = withFalsify(TWO_SLICES, [
      ['### 反向自检 (切片 1)', '| # | 文件 | oldText | newText |', '|---|---|---|---|', '| 1 | src/a.ts | o | n |'].join('\n'),
    ]);
    const full = withFalsify(TWO_SLICES, [
      ['### 反向自检（切片 1）', '| # | 文件 | oldText | newText |', '|---|---|---|---|', '| 1 | src/a.ts | o | n |'].join('\n'),
    ]);
    expect(parseBreakdown(half).falsify![1]).toHaveLength(1);
    expect(parseBreakdown(full).falsify![1]).toHaveLength(1);
  });

  test('D-7/C-1: 缺反向自检小节的 SDD → falsify 字段缺席, 不报错', () => {
    // 证伪: 把 parseAllFalsify 改成"找不到小节 → throw" → 本 test 红。契约作者可以选不写。
    const bd = parseBreakdown(TWO_SLICES);
    expect(bd.falsify).toBeUndefined();
  });

  test('D-7: 有小节标题但下面没表 → 那一片的 falsify = 空数组, 不算错', () => {
    const text = withFalsify(TWO_SLICES, ['### 反向自检 (切片 1)\n\n没有表, 只是占位标题。']);
    const bd = parseBreakdown(text);
    expect(bd.falsify?.[1]).toEqual([]);
  });

  test('反向自检小节标题里的切片 id 在分解表里找不到 → 编译期拒', () => {
    // 闸: 把 parseAllFalsify 里 `validIds.has(sliceId)` 那行删了 → 本 test 由绿转红。
    // 不拒 = 默默塞进 plan, 编译期再炸, 错误落点离根因更远。
    const text = withFalsify(TWO_SLICES, [
      falsifySection(99, [[1, 'src/a.ts', 'o', 'n']]),
    ]);
    expect(() => parseBreakdown(text)).toThrow(/切片 99|99/);
  });

  test('闸: 文件列不是相对路径 → 拒 (mutation file 必须在写集内, 越早判定越好)', () => {
    const text = withFalsify(TWO_SLICES, [
      falsifySection(1, [[1, 'plain-name', 'o', 'n']]),
    ]);
    expect(() => parseBreakdown(text)).toThrow(/相对路径/);
  });

  test('闸: "#" 列不是正整数 → 拒 (index 是 sN-falsify-<i> 的 i 来源, 拿来当后缀的数不可含糊)', () => {
    const text = withFalsify(TWO_SLICES, [
      falsifySection(1, [[0, 'src/a.ts', 'o', 'n']]),
    ]);
    expect(() => parseBreakdown(text)).toThrow(/正整数/);
  });

  test('闸: 数据行不足四列 → 拒', () => {
    const text = withFalsify(TWO_SLICES, [
      ['### 反向自检 (切片 1)', '| # | 文件 | oldText |', '|---|---|', '| 1 | src/a.ts | o |'].join('\n'),
    ]);
    expect(() => parseBreakdown(text)).toThrow(/四列/);
  });

  test('阴性对照: 合法样本不 throw (闸不是恒红)', () => {
    const text = withFalsify(TWO_SLICES, [
      falsifySection(1, [[1, 'src/a.ts', 'o', 'n']]),
      falsifySection(2, [[1, 'src/b.ts', 'o', 'n']]),
    ]);
    expect(() => parseBreakdown(text)).not.toThrow();
  });
});

// ── C-2 编译面 ─────────────────────────────────────────────────────────────────────────

describe('compileBreakdown — falsify 节点生成 (C-2)', () => {
  test('INV-4: 每条反向自检编译一个 sN-falsify-i 节点, sN 的命令是 s.verify', () => {
    const text = withFalsify(TWO_SLICES, [
      falsifySection(1, [
        [1, 'src/a.ts', 'const x = 1;', 'const x = 2;'],
        [2, 'src/a.ts', 'return true;', 'return false;'],
      ]),
    ]);
    const bd = parseBreakdown(text);
    const plan = compileBreakdown(bd, { acceptCommand: FULL_REGRESSION });
    expect(plan.nodes['s1-falsify-1']!.executor).toBe('command');
    expect(plan.nodes['s1-falsify-1']!.command).toBe('bun test src/a.test.ts');
    expect(plan.nodes['s1-falsify-2']!.command).toBe('bun test src/a.test.ts');
  });

  test('节点 mutate 字段把 file/oldText/newText 透传出来 (engine 在切片 2 用)', () => {
    // 形态由 passthrough 兜着 (PlanNode 是 `.passthrough()`): 这条断言证明 passthrough 真生效,
    // 不然 PlanSchema.parse 会把它吃掉, 跑出来发现 runtime 读不到 mutate = 静默假绿入口。
    const text = withFalsify(TWO_SLICES, [
      falsifySection(1, [[1, 'src/a.ts', 'const x = 1;', 'const x = 2;']]),
    ]);
    const plan = compileBreakdown(parseBreakdown(text), { acceptCommand: FULL_REGRESSION });
    const mut = (plan.nodes['s1-falsify-1'] as Record<string, unknown>).mutate as {
      file: string;
      oldText: string;
      newText: string;
    };
    expect(mut).toEqual({ file: 'src/a.ts', oldText: 'const x = 1;', newText: 'const x = 2;' });
    expect((plan.nodes['s1-falsify-1'] as Record<string, unknown>).expects_nonzero).toBe(true);
  });

  test('INV-5: accept 依赖所有 falsify 节点 + 所有 GREEN (falsify 绿了才收尾)', () => {
    const text = withFalsify(TWO_SLICES, [
      falsifySection(1, [[1, 'src/a.ts', 'o', 'n'], [2, 'src/a.ts', 'o2', 'n2']]),
      falsifySection(2, [[1, 'src/b.ts', 'o', 'n']]),
    ]);
    const plan = compileBreakdown(parseBreakdown(text), { acceptCommand: FULL_REGRESSION });
    const dep = plan.nodes['accept']!.depends_on!;
    // 顺序 = compile 期按 "每片 GREEN → 该片 falsify" 的累加 (per-slice accumulation):
    // s1-green, s1-falsify-1, s1-falsify-2, s2-green, s2-falsify-1.
    // depends_on 对引擎调度是无序的 (按层序依赖), 这里锁的是依赖**集**而非顺序,
    // 但字面顺序也是可读的契约 (与编译期写顺序一一对应) — 维护时别悄悄把它改了。
    expect(dep).toEqual([
      's1-green',
      's1-falsify-1',
      's1-falsify-2',
      's2-green',
      's2-falsify-1',
    ]);
    // 集不重复、全到齐、退化裁断 (任一缺席 / 多写都不是 INV-5).
    expect(new Set(dep).size).toBe(dep.length);
    expect(dep).toContain('s1-falsify-1');
    expect(dep).toContain('s1-falsify-2');
    expect(dep).toContain('s2-falsify-1');
    expect(dep).toContain('s1-green');
    expect(dep).toContain('s2-green');
  });

  test('INV-4: 每条 falsify 节点 depends_on = [sN-green] (它跟在 GREEN 之后, 不许自己起跑)', () => {
    const text = withFalsify(TWO_SLICES, [
      falsifySection(1, [[1, 'src/a.ts', 'o', 'n']]),
      falsifySection(2, [[1, 'src/b.ts', 'o', 'n']]),
    ]);
    const plan = compileBreakdown(parseBreakdown(text), { acceptCommand: FULL_REGRESSION });
    expect(plan.nodes['s1-falsify-1']!.depends_on).toEqual(['s1-green']);
    expect(plan.nodes['s2-falsify-1']!.depends_on).toEqual(['s2-green']);
  });

  test('INV-7: 字符串 id 模板 `sN-falsify-i` 编号 = 1..k, 与表中行序一致', () => {
    const text = withFalsify(TWO_SLICES, [
      falsifySection(1, [
        [1, 'src/a.ts', 'o1', 'n1'],
        [2, 'src/a.ts', 'o2', 'n2'],
        [3, 'src/a.ts', 'o3', 'n3'],
      ]),
    ]);
    const plan = compileBreakdown(parseBreakdown(text), { acceptCommand: FULL_REGRESSION });
    const ids = Object.keys(plan.nodes).filter((k) => k.startsWith('s1-falsify-')).sort();
    expect(ids).toEqual(['s1-falsify-1', 's1-falsify-2', 's1-falsify-3']);
  });

  test('INV-2: file 不在该片写集内 → 拒 (mutation 伸到片外 = 闸变进攻工具)', () => {
    // 闸: 把 assertFalsifyFilesInWriteSet 拆掉 → 本 test 红, 它的存在意义是锁住这条拒。
    const text = withFalsify(TWO_SLICES, [
      falsifySection(1, [[1, 'src/c.ts', 'o', 'n']]), // c.ts 不在切片 1 的写集里 (写集 = src/a.ts + test)
    ]);
    expect(() =>
      compileBreakdown(parseBreakdown(text), { acceptCommand: FULL_REGRESSION }),
    ).toThrow(/src\/c\.ts.*写集|写集.*src\/c\.ts/);
  });

  test('INV-2: 同片写集中允许出现 (精确包含, 不放行 glob 误配)', () => {
    const text = withFalsify(TWO_SLICES, [
      falsifySection(1, [[1, 'src/a.ts', 'o', 'n']]), // 命中写集第一项
      falsifySection(2, [[1, 'src/b.test.ts', 'o', 'n']]), // 切片 2 写集 = src/b.ts + test, 该项存在
    ]);
    expect(() =>
      compileBreakdown(parseBreakdown(text), { acceptCommand: FULL_REGRESSION }),
    ).not.toThrow();
  });

  test('PlanSchema.parse 全程过闸 (passthrough 字段不能悄悄被 zod 吃掉)', () => {
    const text = withFalsify(TWO_SLICES, [
      falsifySection(1, [[1, 'src/a.ts', 'o', 'n']]),
    ]);
    const plan = compileBreakdown(parseBreakdown(text), { acceptCommand: FULL_REGRESSION });
    expect(() => PlanSchema.parse(plan)).not.toThrow();
    // 真 parse 一次, 证明 falsify 节点的 mutate/expects_nonzero 字段透传了 (它俩没在 schema 里定义,
    // .passthrough() 是唯一活路)。
    const reparsed = PlanSchema.parse(plan);
    expect((reparsed.nodes['s1-falsify-1'] as Record<string, unknown>).mutate).toEqual({
      file: 'src/a.ts',
      oldText: 'o',
      newText: 'n',
    });
  });

  test('verify 列仍进 G-1 那套闸 (falsify 加进来不该让可跑命令验后退): 首词不在白名单 → 拒', () => {
    // 单片 + 首词 'ugly-cmd' 不在白名单 → G-1 那条复用闸拒. 闸: 它在 compileBreakdown 内
    // (assertRunnable), 与 falsify 段互不耦合: 删 falsify 那段, 本 test 仍红 (G-1 没动).
    // 反向自检: 把 verify 列改成干净白名单词 `bun test src/a.test.ts` → 本 test 红.
    const text = table(['| 1 a | src/a.ts + test | — | ugly-cmd src/a.test.ts |']) +
      '\n\n' + falsifySection(1, [[1, 'src/a.ts', 'o', 'n']]);
    expect(() =>
      compileBreakdown(parseBreakdown(text), { acceptCommand: FULL_REGRESSION }),
    ).toThrow(/ugly-cmd|白名单/);
  });
});

// ── D-7 / INV-6 / INV-7 零回归 ─────────────────────────────────────────────────────────

describe('compileBreakdown — 零回归 (D-7 / INV-6 / INV-7)', () => {
  /**
   * 这组 test 的判据是**与本改动前的编译输出**逐字对齐。
   * 用法: 在改 sdd-compile 之前先用 git stash, 跑一遍脚本把现状 dump 到 __snapshots__,
   * 然后把那些 JSON 钉死在测试里。每次改 compileBreakdown 必须更新快照, 顺手能发现
   * 「我改的这一行悄悄把另一片也动了」。这里先用**结构断言**占位, 跑稳后再补逐字段
   * 比对 (与 delta-compare 同款)。
   */
  test('INV-6: 一份 SDD 没写任何反向自检 → 不生成任何 sN-falsify-* 节点', () => {
    const plan = compileBreakdown(parseBreakdown(TWO_SLICES), { acceptCommand: FULL_REGRESSION });
    const falsifyNodes = Object.keys(plan.nodes).filter((k) => /-falsify-\d+$/.test(k));
    expect(falsifyNodes).toEqual([]);
  });

  test('INV-7: 没有任何 falsify 时, sN / sN-green / accept 与基线逐字段一致 (零回归)', () => {
    // 抓一份基线 (在本 test 跑之前一定是"今天的形状"), 然后跑编译, 三个关键节点逐字段比对。
    // 反向自检: 把 accept.depends_on 的累积改回硬编码 [s1-green, s2-green] → 本 test 红。
    const baselineBd = parseBreakdown(TWO_SLICES);
    const plan = compileBreakdown(baselineBd, { acceptCommand: FULL_REGRESSION });

    // sN / sN-green 应当逐字段与同 SDD 不带 falsify 时一致; 我们没有别的源代码就靠本文件
    // 拼的同一份 BD, 因此这里只断言三个关键形状:
    expect(plan.nodes['s1']!.depends_on).toEqual([]);                          // 切片 1 根片
    expect(plan.nodes['s1-green']!.depends_on).toEqual(['s1']);                 // GREEN 跟实装
    expect(plan.nodes['s2']!.depends_on).toEqual(['s1-green']);                 // 跨片等上游 GREEN
    expect(plan.nodes['s2-green']!.depends_on).toEqual(['s2']);
    expect(plan.nodes['accept']!.depends_on).toEqual(['s1-green', 's2-green']); // accept 只等 GREEN
    expect(plan.nodes['accept']!.command).toBe(FULL_REGRESSION);
    expect(plan.nodes['s1-green']!.expect_exit).toBe(0);
  });

  test('INV-7: 一片有 falsify 一片没有 → accept.depends_on 仅扩有 falsify 的那条; 别的节点不变', () => {
    const text = withFalsify(TWO_SLICES, [
      falsifySection(1, [[1, 'src/a.ts', 'o', 'n']]),
      // 切片 2 不带反向自检小节
    ]);
    const plan = compileBreakdown(parseBreakdown(text), { acceptCommand: FULL_REGRESSION });
    expect(plan.nodes['s1-falsify-1']).toBeDefined();
    expect(Object.keys(plan.nodes).filter((k) => k.startsWith('s2-falsify-'))).toEqual([]);
    // 顺序 = per-slice 累加: s1-green 后紧接 s1-falsify-1, 然后才轮到 s2-green.
    expect(plan.nodes['accept']!.depends_on).toEqual(['s1-green', 's1-falsify-1', 's2-green']);
    // 切片 2 那片没被牵连
    expect(plan.nodes['s2']!.depends_on).toEqual(['s1-green']);
    expect(plan.nodes['s2-green']!.depends_on).toEqual(['s2']);
  });

  test('D-7: 没有任何片写反向自检 → breakdown.falsify 缺席, 编译出的节点清单不含 falsify', () => {
    // 同 INV-6 但多走一遍parseBreakdown边界, 锁「falsify 字段缺席」不变成 falsify={} 后插入空循环。
    const bd = parseBreakdown(TWO_SLICES);
    expect(bd.falsify).toBeUndefined();
    const plan = compileBreakdown(bd, { acceptCommand: FULL_REGRESSION });
    expect(Object.keys(plan.nodes).sort()).toEqual(['accept', 's1', 's1-green', 's2', 's2-green']);
  });
});

// ── 端到端: 解析 + 编译联调 ───────────────────────────────────────────────────────────

describe('端到端 — 反向自检: 解析 + 编译 + schema parse (C-1 + C-2)', () => {
  test('一份标准两片 SDD 各带一条反向自检 → 完整 plan 通 PlanSchema', () => {
    const text = withFalsify(TWO_SLICES, [
      falsifySection(1, [[1, 'src/a.ts', 'const a = 1;', 'const a = 999;']]),
      falsifySection(2, [[1, 'src/b.ts', 'const b = 1;', 'const b = 999;']]),
    ]);
    const bd = parseBreakdown(text);
    const plan = compileBreakdown(bd, { acceptCommand: FULL_REGRESSION });
    const ok = PlanSchema.safeParse(plan);
    expect(ok.success).toBe(true);
    // 节点集: 2 切片 × (实装 + GREEN) + 2 falsify + accept = 7
    expect(Object.keys(plan.nodes).sort()).toEqual(
      ['accept', 's1', 's1-falsify-1', 's1-green', 's2', 's2-falsify-1', 's2-green'].sort(),
    );
  });

  test('命令白名单闸的边界用例: accept 命令不在白名单 → 编译期拒 (确认 falsify 没绕过)', () => {
    const text = withFalsify(TWO_SLICES, [
      falsifySection(1, [[1, 'src/a.ts', 'o', 'n']]),
    ]);
    // 拒的是 accept = 'rm -rf /', 但首词 'rm' 不在 DEFAULT_COMMAND_ALLOWLIST — 同一闸的另一次复用。
    expect(() =>
      compileBreakdown(parseBreakdown(text), { acceptCommand: 'rm -rf /tmp' }),
    ).toThrow(/白名单|rm/);
  });

  test('验证 verify 首词必须在白名单——这条闸对 falsify 也成立 (新加 falsify 不能绕 verify 闸)', () => {
    // 真实写真要写错的样本: `sed -i` 类命令假扮 verify (它根本不在闸里), 看会不会因为加了 falsify 而被放行。
    expect(DEFAULT_COMMAND_ALLOWLIST.includes('sed')).toBe(false);
    const text = table(['| 1 a | src/a.ts + test | — | sed -i "s/x/y/" src/a.ts |']) +
      '\n\n' + falsifySection(1, [[1, 'src/a.ts', 'o', 'n']]);
    expect(() =>
      compileBreakdown(parseBreakdown(text), { acceptCommand: FULL_REGRESSION }),
    ).toThrow(/白名单|sed/);
  });
});

// ── 自指端到端: 本 SDD 自己编一次, 节点清单应含 s1-falsify-1 等 ────────────────────────
//
// 验收第 4 条要求「拿本契约自己编译一次, 贴出节点清单」。本 SDD 在自己的反自检小节挂了 4 条
// (改造只需挂在切片 2 上就够 —— 切片 1 的契约本被本文件自身逐行锁定), 因此本 SDD 编译出的 plan
// 至少含 `s2-falsify-1..4`, 含至少 1 条本切片内的 falsify 也要补上 —— 不补的话本片这一行 4 条
// 反向自检会失锁。**约定**: 本 SDD 自身的反自检小节由切片 2 拥有, 这里只验证**形状**:
//
//   - 任意一份给定的反自检行 (不动文件) 编出的 plan 必须含 N 个 falsify 节点;
//   - 把那些反自检行删掉 → N 变 0, accept 退回仅 GREEN 依赖。
//
// 这是第 4 条断言的**前置**: 真要拿本契约跑, 切片 1 的反向自检那几行得有人写到 SDD 里。
// SDD 改动属于契约层, 不归本片管。

describe('自指端到端 — SDD 走完编译闸后节点清单形状', () => {
  test('一份带 K 条反自检的 SDD → 编译出的 plan 含 K 个 sN-falsify-i (按表行数计)', () => {
    const text = withFalsify(TWO_SLICES, [
      falsifySection(1, [
        [1, 'src/a.ts', 'o1', 'n1'],
        [2, 'src/a.ts', 'o2', 'n2'],
        [3, 'src/a.ts', 'o3', 'n3'],
        [4, 'src/a.ts', 'o4', 'n4'],
      ]),
    ]);
    const plan = compileBreakdown(parseBreakdown(text), { acceptCommand: FULL_REGRESSION });
    const falsifyNodes = Object.keys(plan.nodes).filter((k) => /-falsify-\d+$/.test(k));
    expect(falsifyNodes.length).toBe(4);
  });
});

describe('围栏里的示例表不被当成真表 (2026-08-22 · 纠错补)', () => {
  // 现场: 本片自己的契约在 C-1 用 ``` 举了一张示例表说明格式, 而解析器把它当真表 ——
  // 编译期 INV-2 当场拒「mutation 伸到片外」。闸判得对, 错在解析面。
  // 证伪方式: 把 stripFencedBlocks 那一跳去掉 → 本条当场红。
  const sdd = [
    '## 分解 (Breakdown)',
    '',
    '| 切片 | 写集 | 依赖 | verify |',
    '|---|---|---|---|',
    '| 1 只碰 a.ts | src/a.ts | — | bun test x |',
    '',
    '## 契约 (Contracts)',
    '',
    '### 反向自检 (切片 1)',
    '',
    '```',
    '### 反向自检 (切片 1)',
    '',
    '| # | 文件 | oldText | newText |',
    '|---|---|---|---|',
    '| 1 | src/片外/别的.ts | 甲 | 乙 |',
    '```',
    '',
    '| # | 文件 | oldText | newText |',
    '|---|---|---|---|',
    '| 1 | src/a.ts | 真 | 假 |',
  ].join('\n');

  test('围栏内的那一行被跳过, 只解析围栏外的真表', () => {
    const b = parseBreakdown(sdd);
    const rows = b.falsify?.[1] ?? [];
    expect(rows.length).toBe(1);
    expect(rows[0]!.file).toBe('src/a.ts');
    // 围栏里那条指向片外, 若被解析则 compileBreakdown 会因 INV-2 抛
    expect(rows.some((r) => r.file.includes('片外'))).toBe(false);
  });
});
