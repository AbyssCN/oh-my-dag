/**
 * src/harness/goal/flat-plan.test —— L1 平铺编译器闸 (SDD 2026-08-31, 片 1)
 *
 * 锚串 FLAT_PLAN_L1 (本仓 GWT 惯例: 闸判据逐字在本文件可定位)。
 *
 * 反向自检的统一形状 (本仓惯例, 同 sdd-compile.test):
 * 每条闸配一份**已知违规样本**, 断言它 throw 且判词指名问题所在;
 * 证伪方式写在 test 注释里 —— 把该闸删掉 (或改成 warn), 对应 test 当场由绿转红。
 * 阴性对照: 合法样本编译通过 (证明这批闸不是恒红)。
 *
 * INV-1 = GWT-1 + GWT-2:
 *   GWT-1: 3 个子任务 → 节点数 === 3 + 验收节点数, 每个子任务节点 depends_on 空, plan 过 PlanSchema
 *   GWT-2: 含「综合各子答案」合并子任务 → 编译器拒, 错误文本含「同源综合」
 *
 * INV-2 (complexity 字段, GWT-3) 与 INV-3/4/5 (opt-in / 升档 / 验收链零改动)
 * 的闸在**片 2/3** 的测试里 —— 不混进本片, 因为它们的写集在别处。
 */
import { describe, expect, test } from 'bun:test';
import {
  buildFlatPlanPrompt,
  compileFlatPlan,
  parseFlatPlanOutput,
  type FlatSubtask,
} from './flat-plan';
import { PlanSchema } from '../conductor-plan';

// FLAT_PLAN_L1 — GWT-1 锚串 (本仓闸判据逐字在本文件可定位)。
// 反向自检: 把这串挪走 → 「GWT-1: 3 子任务 → 节点数 + depends_on + PlanSchema」那条立刻红。
const FLAT_PLAN_L1 = 'FLAT_PLAN_L1';

const FULL_REGRESSION = 'bun test';

/** 直接造结构 (绕开表文本), 用于给编译器喂精确的违规样本。 */
const subs = (rows: ReadonlyArray<[string, string, FlatSubtask['visibility']]>): FlatSubtask[] =>
  rows.map(([text, kind, visibility]) => ({ text, kind, visibility }));

/** 三行样例 (合法形状, GWT-1 主用例)。 */
const THREE_OK = subs([
  ['在 src/parser.ts 的 parse() 函数加 try/catch', 'refactor', 'file'],
  ['补 src/parser.test.ts 的覆盖: 缺右括号、缺关键字、未闭合字符串各一条断言', 'test', 'file'],
  ['在 docs/plan/parser-try-catch.md 写一条新增契约不变量', 'docs', 'file'],
]);

const compile = (s: readonly FlatSubtask[] = THREE_OK) =>
  compileFlatPlan(s, { acceptCommand: FULL_REGRESSION });

describe('compileFlatPlan — GWT-1: 平铺编译纯函数, 节点全 agent + depends_on 空 + PlanSchema 过', () => {
  test(`GWT-1 (${FLAT_PLAN_L1}): 3 子任务 → 节点数 === 3 + 验收节点数, 每个子任务节点 depends_on 空, PlanSchema 过`, () => {
    // 证伪: 若编译器退回「让 conductor 现场展开」(哪怕只留一个 executor:'conductor' 节点),
    // 节点数与 kind 断言双红 —— D-2 「挂既有直执接缝, 不造新执行路」的反面。
    const plan = compile();
    expect(Object.keys(plan.nodes).sort()).toEqual(['accept', 's1', 's2', 's3'].sort());
    // 每个子任务节点 depends_on 必须为空数组 (D-1: 平铺 = 无依赖并行)。
    expect(plan.nodes['s1']!.depends_on).toEqual([]);
    expect(plan.nodes['s2']!.depends_on).toEqual([]);
    expect(plan.nodes['s3']!.depends_on).toEqual([]);
    // 节点类型 = 全 agent (D-1: 「N 个无依赖 agent leaf 并行」)。
    expect(plan.nodes['s1']!.executor).toBe('agent');
    expect(plan.nodes['s2']!.executor).toBe('agent');
    expect(plan.nodes['s3']!.executor).toBe('agent');
    // accept 节点 = 终局验收, command + depends_on 收全部子任务 (D-4 机械 fan-in)。
    expect(plan.nodes['accept']!.executor).toBe('command');
    expect(plan.nodes['accept']!.command).toBe(FULL_REGRESSION);
    expect(plan.nodes['accept']!.depends_on).toEqual(['s1', 's2', 's3']);
    // PlanSchema 解析通过 (弱模型不可信同款 —— 机器产的也过闸)。
    expect(() => PlanSchema.parse(plan)).not.toThrow();
    // complexity:'flat' 字段由编译器写入 (D-2: 路由权在 config, 不在模型);
    // 当前 PlanSchema 是 .passthrough(), 该写法照样过; 片 2 加枚举后被正式校验。
    expect((plan as unknown as { complexity?: string }).complexity).toBe('flat');
  });

  test('GWT-1 副: 子任务文本逐字进 agent leaf goal (不二次加工, 让模型看的就是原文)', () => {
    const plan = compile();
    expect(plan.nodes['s1']!.goal).toBe(THREE_OK[0]!.text);
    expect(plan.nodes['s2']!.goal).toBe(THREE_OK[1]!.text);
    expect(plan.nodes['s3']!.goal).toBe(THREE_OK[2]!.text);
  });

  test('GWT-1 副: 可见性 = output_type, leaf 类型 = template (执行期由 agent-templates 注册表按名选卡)', () => {
    const plan = compile();
    expect(plan.nodes['s1']!.output_type).toBe('file');
    expect(plan.nodes['s2']!.output_type).toBe('file');
    expect(plan.nodes['s3']!.output_type).toBe('file');
    expect(plan.nodes['s1']!.template).toBe('refactor');
    expect(plan.nodes['s2']!.template).toBe('test');
    expect(plan.nodes['s3']!.template).toBe('docs');
  });

  test('写集声明: opts.writeSet 给 → 每个 agent 节点都声明同一份 (D-2: 写集列声明面)', () => {
    const plan = compileFlatPlan(THREE_OK, {
      acceptCommand: FULL_REGRESSION,
      writeSet: ['src/parser.ts', 'src/parser.test.ts', 'docs/plan/parser-try-catch.md'],
    });
    expect(plan.nodes['s1']!.write_set).toEqual([
      'src/parser.ts',
      'src/parser.test.ts',
      'docs/plan/parser-try-catch.md',
    ]);
    expect(plan.nodes['s2']!.write_set).toEqual([
      'src/parser.ts',
      'src/parser.test.ts',
      'docs/plan/parser-try-catch.md',
    ]);
    // accept 节点不声明写集 (MIRROR RULE: 验证型节点不声明产物)。
    expect(plan.nodes['accept']!.write_set).toBeUndefined();
  });

  test('写集声明: opts.writeSet 缺席 → 节点 write_set 字段也缺席 (零回归, 与既有 sdd-compile 同源)', () => {
    const plan = compile();
    expect(plan.nodes['s1']!.write_set).toBeUndefined();
    expect(plan.nodes['s2']!.write_set).toBeUndefined();
    expect(plan.nodes['s3']!.write_set).toBeUndefined();
  });

  test('specAnchor 透传: opts.specAnchor 给 → 每个 agent 节点都盖章 (T-1b / S-51)', () => {
    const plan = compileFlatPlan(THREE_OK, {
      acceptCommand: FULL_REGRESSION,
      specAnchor: 'anchor-xyz',
    });
    expect(plan.nodes['s1']!.spec_anchor).toBe('anchor-xyz');
    expect(plan.nodes['s2']!.spec_anchor).toBe('anchor-xyz');
    expect(plan.nodes['s3']!.spec_anchor).toBe('anchor-xyz');
    // accept 节点不盖章 (与 sdd-compile 同款: command 节点 shouldSkip 恒不跳)。
    expect(plan.nodes['accept']!.spec_anchor).toBeUndefined();
  });

  test('accept 期望退出码可由调用方给 (与 compileBreakdown 同源)', () => {
    const plan = compileFlatPlan(THREE_OK, { acceptCommand: FULL_REGRESSION, acceptExpectExit: 1 });
    expect(plan.nodes['accept']!.expect_exit).toBe(1);
  });
});

describe('compileFlatPlan — GWT-2 / D-4: 合并步 schema_only, 同源自综合编译期拒', () => {
  test('GWT-2: 含「综合各子答案」合并子任务 → 拒, 错误文本含「同源综合」', () => {
    // 证伪: 把 assertNotSynthesis 整段删掉 (或把 SYNTHESIS_PATTERNS 改空数组)
    // → 本条当场红。GWT-2 逐字要求错误文本含「同源综合」。
    const bad = subs([
      ['改 src/a.ts 的实现', 'refactor', 'file'],
      ['改 src/b.ts 的实现', 'refactor', 'file'],
      ['综合各子答案, 产出最终融合版本', 'synthesis', 'file'],
    ]);
    expect(() => compileFlatPlan(bad, { acceptCommand: FULL_REGRESSION })).toThrow(/同源综合/);
  });

  test('闸 D-4 反例: 「综合上述两个子任务的输出」→ 拒 (同上, 关键词「综合」「上述」「子」同触发)', () => {
    const bad = subs([
      ['改 src/a.ts 的实现', 'refactor', 'file'],
      ['改 src/b.ts 的实现', 'refactor', 'file'],
      ['综合上述两个子任务的输出, 产出最终融合版本', 'synthesis', 'file'],
    ]);
    expect(() => compileFlatPlan(bad, { acceptCommand: FULL_REGRESSION })).toThrow(/同源综合/);
  });

  test('闸 D-4 反例: 「merge the sub-answers」英文形态 → 拒', () => {
    const bad = subs([
      ['改 src/a.ts 的实现', 'refactor', 'file'],
      ['改 src/b.ts 的实现', 'refactor', 'file'],
      ['merge the sub-answers into a final form', 'synthesis', 'file'],
    ]);
    expect(() => compileFlatPlan(bad, { acceptCommand: FULL_REGRESSION })).toThrow(/同源综合/);
  });

  test('闸 D-4 阴性对照: 合法表述含「综合」「合并」二字但不触发形态闸 → 不拒', () => {
    // 「综合测试结果」「合并 PR」「综合设计」「合并到 main」都是合法表述, 不该误杀。
    // 把 SYNTHESIS_PATTERNS 改成 /综合/ → 本条立刻红 (本仓其它契约也会写「合并」二字)。
    const ok = subs([
      ['综合 src/x.ts 现有测试结果, 列出未覆盖路径', 'refactor', 'file'],
      ['把当前分支合并到 main', 'docs', 'file'],
      ['补 src/x.test.ts 缺失断言', 'test', 'file'],
    ]);
    expect(() => compileFlatPlan(ok, { acceptCommand: FULL_REGRESSION })).not.toThrow();
  });
});

describe('compileFlatPlan — 闸: 已知违规样本必须拒 (G-6 同款反向自检)', () => {
  test('闸① 零子任务 → 拒 (空图 = "什么都没干"被读成"跑完了", 与 compileBreakdown 同款)', () => {
    // 证伪: 把 `if (!subtasks.length)` 摘掉 → 本 test 转红。
    expect(() => compileFlatPlan([], { acceptCommand: FULL_REGRESSION })).toThrow(/子任务/);
  });

  test('闸② opts.writeSet 含重复 → 拒 (写集是声明面, 重复 = 声明不清)', () => {
    // 证伪: 把 dupes 检查删掉 → 本条红。
    expect(() =>
      compileFlatPlan(THREE_OK, {
        acceptCommand: FULL_REGRESSION,
        writeSet: ['src/a.ts', 'src/a.ts'],
      }),
    ).toThrow(/重复/);
  });

  test('阴性对照: 合法样本编译通过 (这批闸不是恒红)', () => {
    expect(() => compile()).not.toThrow();
    expect(() => compileFlatPlan(subs([['一', '', 'file']]), { acceptCommand: FULL_REGRESSION })).not.toThrow();
    // visibility 全枚举都合法 (file / structured / git / none)。
    for (const v of ['file', 'structured', 'git', 'none'] as const) {
      expect(() => compileFlatPlan(subs([['x', '', v]]), { acceptCommand: FULL_REGRESSION })).not.toThrow();
    }
  });
});

describe('parseFlatPlanOutput — 三列表 (子任务文本 / leaf 类型 / 可见性) 解析', () => {
  test('合法三列表 → 三个 FlatSubtask, 字段逐字保留', () => {
    const text = [
      '| 子任务文本 | leaf 类型 | 可见性 |',
      '|---|---|---|',
      '| 在 src/a.ts 加 try/catch | refactor | file |',
      '| 补 src/a.test.ts 覆盖 | test | file |',
      '| 更新 docs/a.md | docs | file |',
    ].join('\n');
    const out = parseFlatPlanOutput(text);
    expect(out.length).toBe(3);
    expect(out[0]!.text).toBe('在 src/a.ts 加 try/catch');
    expect(out[0]!.kind).toBe('refactor');
    expect(out[0]!.visibility).toBe('file');
    expect(out[2]!.visibility).toBe('file');
  });

  test('表头英文别名 (subtask text / leaf type / visibility) → 也收 (sdd-direct 同款宽容)', () => {
    const text = [
      '| subtask text | leaf type | visibility |',
      '|---|---|---|',
      '| change src/a.ts | refactor | file |',
    ].join('\n');
    expect(() => parseFlatPlanOutput(text)).not.toThrow();
  });

  test('闸 parse-shape ①: 缺表头 → 拒, 判词指名期望表头', () => {
    // 证伪: 把 `if (headerIdx === -1)` 抛错删掉 → 本条红 (解析器在第一条数据行炸成列数错)。
    const text = '|---|---|---|\n| x | y | z |\n';
    expect(() => parseFlatPlanOutput(text)).toThrow(/表头/);
  });

  test('闸 parse-shape ②: 表头后缺分隔行 → 拒', () => {
    // 证伪: 把 `sepIdx === -1` 抛错删掉 → 本条红。
    const text = '| 子任务文本 | leaf 类型 | 可见性 |\n| x | y | z |\n';
    expect(() => parseFlatPlanOutput(text)).toThrow(/分隔/);
  });

  test('闸 parse-shape ③: 列数 != 3 → 拒, 判词指名行号与列数', () => {
    // 证伪: 把列数 != 3 抛错删掉 → 本条红。
    const text = ['| 子任务文本 | leaf 类型 | 可见性 |', '|---|---|---|', '| x | y |'].join('\n');
    expect(() => parseFlatPlanOutput(text)).toThrow(/列数/);
  });

  test('闸 parse-shape ④: 子任务文本列空 → 拒 (不接受空任务)', () => {
    // 证伪: 把空 text 抛错删掉 → 本条红。
    const text = ['| 子任务文本 | leaf 类型 | 可见性 |', '|---|---|---|', '|  | refactor | file |'].join('\n');
    expect(() => parseFlatPlanOutput(text)).toThrow(/子任务文本/);
  });

  test('闸 parse-shape ⑤: 可见性值不在 {file, structured, git, none} → 拒', () => {
    // 证伪: 把 parseVisibility 的 throw 摘掉 → 本条红 (后续 schema 校验兜不住, 数据行原样进 node)。
    const text = ['| 子任务文本 | leaf 类型 | 可见性 |', '|---|---|---|', '| x | y | banana |'].join('\n');
    expect(() => parseFlatPlanOutput(text)).toThrow(/可见性/);
  });

  test('闸 parse-shape ⑥: 数据行为 0 → 拒 (空表 = 空图, 同 compileFlatPlan 零子任务闸)', () => {
    // 证伪: 把空 out 抛错删掉 → 本条红。
    const text = '| 子任务文本 | leaf 类型 | 可见性 |\n|---|---|---|\n';
    expect(() => parseFlatPlanOutput(text)).toThrow(/数据行/);
  });
});

describe('buildFlatPlanPrompt — ① 轻规划 prompt 构造 (goal + 冻结判据 + 2 个平铺 few-shot)', () => {
  test('owner 裁 §3.3: few-shot 保留 —— prompt 内含 2 个平铺样例 + 表头 + 反例', () => {
    // 论文消融 LCB -9.4 (owner 裁保留); 把 FEW_SHOT_OK / FEW_SHOT_BAD 任一删掉 → 形态断言红。
    const p = buildFlatPlanPrompt('改 src/parser.ts 加 try/catch', {
      criteria: 'bun test src/parser.test.ts 退出码 0',
    });
    expect(p).toContain('改 src/parser.ts 加 try/catch');
    expect(p).toContain('bun test src/parser.test.ts 退出码 0');
    expect(p).toContain('子任务文本');
    expect(p).toContain('可见性');
    expect(p).toContain('例子 1');
    expect(p).toContain('例子 2');
    expect(p).toContain('不要');
    expect(p).toContain('同源综合');
  });

  test('空 goal → 仍构造出 prompt, 不抛 (D-3 轻规划 = 单发 generate, 不开 tool-loop, 不预检 goal 内容)', () => {
    // 反向自检: 把 goal.trim() 改成必非空 → 本条立刻红 (但本仓其它契约的 prompt 构造也都不预检,
    // 一致性优先, 故这里 fail-open)。
    const p = buildFlatPlanPrompt('', { criteria: 'x' });
    expect(p).toContain('x');
  });
});

describe('端到端: parseFlatPlanOutput → compileFlatPlan (片 1 自包含)', () => {
  test('一份完整轻规划输出走通 parse → compile, 节点/边与原文对齐', () => {
    const text = [
      '| 子任务文本 | leaf 类型 | 可见性 |',
      '|---|---|---|',
      '| 改 src/parser.ts 加 try/catch | refactor | file |',
      '| 补 src/parser.test.ts 覆盖 | test | file |',
      '| 更新 docs/plan/parser-try-catch.md | docs | file |',
    ].join('\n');
    const parsed = parseFlatPlanOutput(text);
    const plan = compileFlatPlan(parsed, { acceptCommand: FULL_REGRESSION });
    expect(Object.keys(plan.nodes).length).toBe(4); // 3 子任务 + accept
    expect(plan.nodes['s1']!.goal).toContain('try/catch');
    expect(plan.nodes['s2']!.template).toBe('test');
    expect(plan.nodes['s3']!.template).toBe('docs');
    expect(plan.nodes['accept']!.depends_on).toEqual(['s1', 's2', 's3']);
  });

  test('同一份解析结果过 PlanSchema, 零字节改动即可重入 (纯函数, INV-1)', () => {
    const text = [
      '| 子任务文本 | leaf 类型 | 可见性 |',
      '|---|---|---|',
      '| 一 | refactor | file |',
      '| 二 | test | file |',
      '| 三 | docs | file |',
    ].join('\n');
    const plan = compileFlatPlan(parseFlatPlanOutput(text), { acceptCommand: FULL_REGRESSION });
    expect(() => PlanSchema.parse(plan)).not.toThrow();
    // 二次解析同一份: 输入相同 → 输出相同 (纯函数不变量)。
    const plan2 = compileFlatPlan(parseFlatPlanOutput(text), { acceptCommand: FULL_REGRESSION });
    expect(plan2).toEqual(plan);
  });
});