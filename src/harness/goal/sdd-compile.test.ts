/**
 * src/harness/goal/sdd-compile.test —— 平铺编译器 (内环 v2 切片 2)。
 *
 * SDD: docs/plan/2026-08-11-inner-loop-v2-control-inversion.md — D-1 (零 LLM 编译) ·
 * D-4 (定向 TDD) · G-1 (平铺, 零 conductor) · G-2 (RED/GREEN 即 verify 串, 全量回归恰一次) ·
 * G-6 (每闸配已知违规样本)。
 *
 * G-6 反向自检的统一形状 (同 delta-compare.test): 每条闸配一份**已知违规样本**, 断言它
 * throw 且判词指名问题所在; 证伪方式逐条写在 test 注释里 —— 把该闸删掉 (或改成 warn),
 * 对应 test 当场由绿转红。阴性对照 `阴性对照: 合法样本编译通过` 证明这批闸不是恒红。
 */
import { describe, expect, test } from 'bun:test';
import { parseBreakdown, type SddBreakdown } from './sdd-direct';
import { compileBreakdown, RED_EXPECT_EXIT } from './sdd-compile';
import { PlanSchema } from '../conductor-plan';

const FULL_REGRESSION = 'bunx tsc --noEmit && bun test';

/** 直接造结构 (绕开表文本), 用于给编译器喂精确的违规样本。 */
const bd = (slices: SddBreakdown['slices'], waves?: SddBreakdown['waves']): SddBreakdown =>
  waves ? { slices, waves } : { slices };

const slice = (
  id: number,
  over: string[],
  deps: number[],
  verify = `bun test src/s${id}.test.ts`,
): SddBreakdown['slices'][number] => ({ id, name: `切片 ${id}`, writeSet: over, deps, verify });

/** 两片: 2 依赖 1, 写集不相交, 波形 {1} → {2}。 */
const TWO: SddBreakdown = bd(
  [slice(1, ['src/a.ts', 'src/a.test.ts'], []), slice(2, ['src/b.ts'], [1])],
  [[1], [2]],
);

const compile = (b: SddBreakdown = TWO) => compileBreakdown(b, { acceptCommand: FULL_REGRESSION });

describe('compileBreakdown — G-1 平铺: 节点数 = 切片数 + RED/GREEN + accept, 零 conductor', () => {
  test('G-1: 2 切片 → 7 节点 (2×3 + accept), 台账无 conductor 节点', () => {
    // 证伪: 若编译器退回"让 conductor 现场展开" (哪怕只留一个 executor:'conductor' 节点),
    // 节点数与 kind 断言双红 —— ①号税 (contract 段 69.7% token) 正是从那个节点进来的。
    const plan = compile();
    expect(Object.keys(plan.nodes).sort()).toEqual(
      ['accept', 's1', 's1-green', 's1-red', 's2', 's2-green', 's2-red'].sort(),
    );
    expect(Object.values(plan.nodes).some((n) => n.executor === 'conductor')).toBe(false);
    expect(Object.values(plan.nodes).some((n) => n.executor === 'map')).toBe(false);
  });

  test('G-1: 依赖边 = 表中声明 (2 依赖 1 → s2-red 等 s1-green), TDD 链 red→impl→green', () => {
    const plan = compile();
    expect(plan.nodes['s1-red']!.depends_on).toEqual([]);
    expect(plan.nodes['s1']!.depends_on).toEqual(['s1-red']);
    expect(plan.nodes['s1-green']!.depends_on).toEqual(['s1']);
    // 表里 2 依赖 1 → 等的是 1 的 **GREEN** (1 的实装真绿了才轮到 2), 不是 1 的执行节点。
    expect(plan.nodes['s2-red']!.depends_on).toEqual(['s1-green']);
    expect(plan.nodes['accept']!.depends_on).toEqual(['s1-green', 's2-green']);
  });

  test('G-1: 无依赖的兄弟片保持平行 (不制造顺序边)', () => {
    // 证伪: 若编译器按 id 顺序串成链 → 本断言红。顺序偏好不是依赖 (/omd-contract 分解段纪律)。
    const plan = compileBreakdown(bd([slice(1, ['src/a.ts'], []), slice(2, ['src/b.ts'], [])]), {
      acceptCommand: FULL_REGRESSION,
    });
    expect(plan.nodes['s2-red']!.depends_on).toEqual([]);
  });

  test('D-2: 写集列填进 executor 节点的 write_set', () => {
    const plan = compile();
    expect(plan.nodes['s1']!.write_set).toEqual(['src/a.ts', 'src/a.test.ts']);
    expect(plan.nodes['s1']!.executor).toBe('agent');
    // MIRROR RULE: 只验证的 RED/GREEN 节点不声明产物 (声明了会被产物闸误杀)。
    expect(plan.nodes['s1-red']!.write_set).toBeUndefined();
    expect(plan.nodes['s1-green']!.write_set).toBeUndefined();
  });

  test('产物合法: 编译结果过 PlanSchema (弱模型不可信同款 —— 机器产的也过闸)', () => {
    expect(() => PlanSchema.parse(compile())).not.toThrow();
  });
});

describe('compileBreakdown — G-2/D-4 定向 TDD: RED/GREEN 同串, 全量回归恰一次', () => {
  test('G-2: verify 列 `bun test src/x.test.ts` → RED/GREEN 命令即该串', () => {
    const plan = compileBreakdown(bd([slice(1, ['src/x.ts'], [], 'bun test src/x.test.ts')]), {
      acceptCommand: FULL_REGRESSION,
    });
    expect(plan.nodes['s1-red']!.command).toBe('bun test src/x.test.ts');
    expect(plan.nodes['s1-green']!.command).toBe('bun test src/x.test.ts');
  });

  test('D-4: RED 期望非零退出, GREEN 期望 0 (同一命令串, 只差期望码)', () => {
    // 证伪: 若 RED 也期望 0 → "证明测试先是红的"这一步永远失败, TDD 的第一拍表达不出来
    // (conductor-plan expect_exit 的存在理由就是这个)。
    const plan = compile();
    expect(plan.nodes['s1-red']!.expect_exit).toBe(RED_EXPECT_EXIT);
    expect(RED_EXPECT_EXIT).not.toBe(0);
    expect(plan.nodes['s1-green']!.expect_exit).toBe(0);
  });

  test('G-2: 全量回归命令只在 accept 节点出现, 恰一次', () => {
    // 证伪: 若把全量回归也铺进每片的 GREEN → 命令计数 >1 当场红。那正是 D-4 要消掉的
    // 乘法项 (全量 bun test 分钟级 × 节点 × 轮)。
    const plan = compile();
    const hits = Object.values(plan.nodes).filter((n) => n.command === FULL_REGRESSION);
    expect(hits.length).toBe(1);
    expect(plan.nodes['accept']!.command).toBe(FULL_REGRESSION);
    expect(plan.nodes['accept']!.expect_exit).toBe(0);
  });

  test('accept 的期望退出码可由调用方给 (承 acceptance.expectExit)', () => {
    const plan = compileBreakdown(TWO, { acceptCommand: 'bun test', acceptExpectExit: 1 });
    expect(plan.nodes['accept']!.expect_exit).toBe(1);
  });
});

describe('compileBreakdown — G-6 反向自检: 已知违规样本必须拒', () => {
  test('闸① 乱序波形 (依赖指向后层) → 拒, 判词指名切片与层号', () => {
    // 违规样本: 波形声明 {1} → {2}, 而表里 **1 依赖 2** —— 1 在第 0 层却等着第 1 层的产物,
    // 跑起来第一层就死锁 (或更坏: 引擎按依赖调度, 波形那行成了骗人的文档)。
    // 证伪: 把 assertWaveOrder 那段删掉 → 本 test 由绿转红 (编译器照单产出错图)。
    const bad = bd([slice(1, ['src/a.ts'], [2]), slice(2, ['src/b.ts'], [])], [[1], [2]]);
    expect(() => compileBreakdown(bad, { acceptCommand: FULL_REGRESSION })).toThrow(/波形/);
    expect(() => compileBreakdown(bad, { acceptCommand: FULL_REGRESSION })).toThrow(/切片 1/);
  });

  test('闸① 同层互依赖 → 拒 (同层 = 声明可并行, 却又互相等)', () => {
    const bad = bd([slice(1, ['src/a.ts'], []), slice(2, ['src/b.ts'], [1])], [[1, 2]]);
    expect(() => compileBreakdown(bad, { acceptCommand: FULL_REGRESSION })).toThrow(/波形/);
  });

  test('闸① 波形漏掉某切片 → 拒 (漏掉的那片会被静默排除在层序校验外)', () => {
    const bad = bd([slice(1, ['src/a.ts'], []), slice(2, ['src/b.ts'], [1])], [[1]]);
    expect(() => compileBreakdown(bad, { acceptCommand: FULL_REGRESSION })).toThrow(/波形.*2|2.*波形/);
  });

  test('闸① 波形引用不存在的切片 → 拒', () => {
    const bad = bd([slice(1, ['src/a.ts'], [])], [[1], [9]]);
    expect(() => compileBreakdown(bad, { acceptCommand: FULL_REGRESSION })).toThrow(/9/);
  });

  test('闸② 写集相交 (两片写同一文件) → 拒, 判词指名两片与那个文件', () => {
    // 违规样本: 1 与 2 都写 src/shared.ts。两片并发跑 = 后写覆盖先写 (或半个文件),
    // 而读数上看起来两片都 done。/omd-contract: 「写集两两不相交 = 可并行的机器判据」。
    // 证伪: 把 assertDisjointWriteSets 删掉 → 本 test 由绿转红。
    const bad = bd([
      slice(1, ['src/shared.ts', 'src/a.ts'], []),
      slice(2, ['src/shared.ts'], []),
    ]);
    const run = () => compileBreakdown(bad, { acceptCommand: FULL_REGRESSION });
    expect(run).toThrow(/写集相交/);
    expect(run).toThrow(/src\/shared\.ts/);
    expect(run).toThrow(/1.*2|2.*1/);
  });

  test('闸② 串行依赖也不放行写集相交 (刻意从严)', () => {
    // 有依赖边 = 不会并发, 相交在调度上"安全"。仍然拒: 写集是切片划分的声明,
    // 交集说明这两片没划干净 (谁拥有那个文件说不清), 而 D-2 的写集对账下游要按它归属。
    const bad = bd([slice(1, ['src/shared.ts'], []), slice(2, ['src/shared.ts'], [1])], [[1], [2]]);
    expect(() => compileBreakdown(bad, { acceptCommand: FULL_REGRESSION })).toThrow(/写集相交/);
  });

  test('闸③ verify 列不是可跑命令 (G 点引用) → 拒, 判词指名切片与那串', () => {
    // 违规样本 = 本 SDD 自己 1 号切片的 verify 列 "G-1 前半、G-6" —— 人读的验收点引用,
    // 不是命令。编译成 command 节点 = 起跑即被命令闸拒 (退出码 -1) → **假红**:
    // 读数上看起来"这一步失败了", 实际是判据压根没写成可跑的东西。
    // 证伪: 把 assertRunnable 删掉 → 本 test 转红。
    const bad = bd([slice(1, ['src/a.ts'], [], 'G-1 前半、G-6')]);
    const run = () => compileBreakdown(bad, { acceptCommand: FULL_REGRESSION });
    expect(run).toThrow(/verify/);
    expect(run).toThrow(/G-1 前半/);
  });

  test('闸③ verify 首词不在命令白名单 (rm) → 拒', () => {
    const bad = bd([slice(1, ['src/a.ts'], [], 'rm -rf src')]);
    expect(() => compileBreakdown(bad, { acceptCommand: FULL_REGRESSION })).toThrow(/白名单|verify/);
  });

  test('闸④ 依赖指向不存在的切片 → 拒', () => {
    const bad = bd([slice(1, ['src/a.ts'], [7])]);
    expect(() => compileBreakdown(bad, { acceptCommand: FULL_REGRESSION })).toThrow(/7/);
  });

  test('闸⑤ 无波形时的依赖环 → 拒 (波形缺席不等于免检)', () => {
    // 证伪: 若只在有波形时校验层序 → 无波形的环一路编译到引擎, 图跑起来永远没有就绪节点。
    const bad = bd([slice(1, ['src/a.ts'], [2]), slice(2, ['src/b.ts'], [1])]);
    expect(() => compileBreakdown(bad, { acceptCommand: FULL_REGRESSION })).toThrow(/环/);
  });

  test('闸⑥ 全量回归命令出现在某片 verify → 拒 (G-2: 它只该在 accept 出现一次)', () => {
    // 证伪: 若不拦 → 全量回归被铺进每轮每片, D-4 说的乘法项原样回来, 而节点计数断言看不出来
    // (命令确实"只写了一次" —— 在表里)。
    const bad = bd([slice(1, ['src/a.ts'], [], FULL_REGRESSION)]);
    expect(() => compileBreakdown(bad, { acceptCommand: FULL_REGRESSION })).toThrow(/全量回归/);
  });

  test('闸⑦ 零切片 → 拒 (空图 = "什么都没干"被读成"跑完了")', () => {
    expect(() => compileBreakdown(bd([]), { acceptCommand: FULL_REGRESSION })).toThrow(/切片/);
  });

  test('阴性对照: 合法样本编译通过 (这批闸不是恒红)', () => {
    expect(() => compile()).not.toThrow();
    expect(() =>
      compileBreakdown(
        bd(
          [
            slice(1, ['src/a.ts'], []),
            slice(3, ['src/c.ts'], []),
            slice(2, ['src/b.ts'], [1, 3]),
          ],
          [[1, 3], [2]],
        ),
        { acceptCommand: FULL_REGRESSION },
      ),
    ).not.toThrow();
  });
});

describe('compileBreakdown — 端到端: 解析器 → 编译器 (切片 1+2 接缝)', () => {
  test('一份完整 SDD 文本走通 parse → compile, 节点/边与表一致', () => {
    const text = [
      '# t',
      '## 契约 (Contracts)',
      '- G-1',
      '## 分解 (Breakdown)',
      '| 切片 | 写集 | 依赖(带理由) | verify |',
      '|---|---|---|---|',
      '| 1 解析器 | src/a.ts + test | — | bun test src/a.test.ts |',
      '| 2 编译器 | `src/b.ts`(新) + test | 1(消费 1 的结构) | bun test src/b.test.ts |',
      '',
      '并行波形:`{1} → {2}`',
    ].join('\n');
    const plan = compileBreakdown(parseBreakdown(text), { acceptCommand: FULL_REGRESSION });
    expect(Object.keys(plan.nodes).length).toBe(7);
    expect(plan.nodes['s2']!.write_set).toEqual(['src/b.ts', 'src/b.test.ts']);
    expect(plan.nodes['s2-red']!.command).toBe('bun test src/b.test.ts');
    expect(plan.nodes['s2-red']!.depends_on).toEqual(['s1-green']);
    // 切片名进 goal —— 执行节点得知道自己在干哪一片 (SDD 全文注入与否由接线方 5 号切片裁)。
    expect(plan.nodes['s2']!.goal).toContain('编译器');
  });
});
