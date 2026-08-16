/**
 * A4 跑前静态闸 (2026-07-31) —— 补 Fowler 2×2 里最空的那格: computational feedforward。
 *
 * 这条网盯两个方向:
 *  ① **该报的报**: 写竞争 (它不报错, 只是"有时候产物不对" —— 静默不确定性是最贵的一种);
 *  ② **不该报的一个都不许报**: 静态检查一旦开始猜, 它就是第三个 judge, 而且是个没有证据的。
 *  ③ **命令引用缺失**: executor:'command' 节点引用了 cwd 内不存在的脚本或未定义的 package script —— 同样跑之前就能判死。
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { staticLintPlan } from './static-lint';
import type { ConductorPlan } from '../conductor-plan';
import type { StaticFinding } from './static-lint';

const plan = (nodes: Record<string, unknown>): ConductorPlan => ({ name: 'p', nodes } as ConductorPlan);
/** 真实 command 节点形态: schema (conductor-plan) 里没有 type 字段, 判别键是 executor:'command'。 */
const cmdNode = (command: string, cwd?: string): Record<string, unknown> => ({ executor: 'command', command, ...(cwd ? { cwd } : {}) });

/** 内建临时目录 fixture: 每个用例一个独立 cwd, 不读仓内 package.json/scripts (hermetic)。 */
const tmpRoots: string[] = [];
const tmpFixture = (files: Record<string, string>): string => {
  const root = mkdtempSync(join(tmpdir(), 'static-lint-'));
  tmpRoots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content, 'utf8');
  }
  return root;
};
afterAll(() => { for (const r of tmpRoots) rmSync(r, { recursive: true, force: true }); });

/** 仓库根 (集成用例的 cwd): 读**真实** scripts/dag-slim.ts 与根 package.json, 不用复制 fixture。 */
const REPO_ROOT = join(import.meta.dir, '..', '..', '..');

describe('写竞争', () => {
  test('两个能并行的节点写同一个文件 → 报, 且**说清怎么改**', () => {
    const f = staticLintPlan(plan({
      a: { goal: '写', output_path: 'docs/x.md' },
      b: { goal: '也写', output_path: 'docs/x.md' },
    }));
    expect(f).toHaveLength(1);
    expect(f[0]!.kind).toBe('write-race');
    expect(f[0]!.nodes.sort()).toEqual(['a', 'b']);
    // Fowler: sensor 的信号要"为 LLM 消费优化" —— 只报"冲突"没用, 要给改法。
    expect(f[0]!.message).toContain('depends_on');
    expect(f[0]!.message).toContain('docs/x.md');
  });

  test('**有依赖边就不是竞争** (有序 ≠ 竞争) —— 这是最容易误报的一格', () => {
    expect(staticLintPlan(plan({
      a: { goal: '写', output_path: 'docs/x.md' },
      b: { goal: '改', output_path: 'docs/x.md', depends_on: ['a'] },
    }))).toHaveLength(0);
  });

  test('间接依赖也算有序 (祖先闭包, 不只看直接边)', () => {
    expect(staticLintPlan(plan({
      a: { goal: '写', output_path: 'docs/x.md' },
      mid: { goal: '中间', depends_on: ['a'] },
      b: { goal: '改', output_path: 'docs/x.md', depends_on: ['mid'] },
    }))).toHaveLength(0);
  });

  test('写不同文件 → 不报', () => {
    expect(staticLintPlan(plan({
      a: { goal: '写', output_path: 'docs/a.md' },
      b: { goal: '写', output_path: 'docs/b.md' },
    }))).toHaveLength(0);
  });

  test('三个并行写方 → 三对都报 (不合并成一条, 每对都是一个真冲突)', () => {
    const f = staticLintPlan(plan({
      a: { goal: 'w', output_path: 'x' }, b: { goal: 'w', output_path: 'x' }, c: { goal: 'w', output_path: 'x' },
    }));
    expect(f).toHaveLength(3);
  });
});

describe('缺输入', () => {
  const P = plan({ r: { goal: '读', input_paths: ['specs/api.md'] } });

  test('盘上没有、图里也没人产出 → 报', () => {
    const f = staticLintPlan(P, { fileExists: () => false });
    expect(f).toHaveLength(1);
    expect(f[0]!.kind).toBe('missing-input');
    expect(f[0]!.message).toContain('specs/api.md');
  });

  test('盘上有 → 不报', () => {
    expect(staticLintPlan(P, { fileExists: () => true })).toHaveLength(0);
  });

  test('图里有节点产出它 → 不报 (跑起来就有了)', () => {
    expect(staticLintPlan(plan({
      w: { goal: '写', output_path: 'specs/api.md' },
      r: { goal: '读', input_paths: ['specs/api.md'], depends_on: ['w'] },
    }), { fileExists: () => false })).toHaveLength(0);
  });

  test('**不给 fileExists → 一条都不报**: 拿不到文件系统时不猜, 而不是假设文件不存在', () => {
    expect(staticLintPlan(P)).toHaveLength(0);
  });

  test('绝对路径 / URL 不判 —— 我们对仓外一无所知, 猜了就是误报', () => {
    const f = staticLintPlan(plan({
      r: { goal: '读', input_paths: ['/etc/hosts', 'https://x.com/a.json'] },
    }), { fileExists: () => false });
    expect(f).toHaveLength(0);
  });

  test('探测抛错 → 当它存在 (失败方向安全: 漏报好过把所有 plan 报红)', () => {
    const f = staticLintPlan(P, { fileExists: () => { throw new Error('权限'); } });
    expect(f).toHaveLength(0);
  });
});

describe('缺命令目标', () => {
  test('引用 cwd 内不存在的脚本 → 恰一条, 只报不拦, 含节点 id、路径与改法', () => {
    const id = 'nope';
    const cwd = tmpFixture({}); // 空 cwd —— 任何相对脚本都不存在, 不依赖仓内实际文件
    let f: StaticFinding[] = [];
    expect(() => { f = staticLintPlan(plan({ [id]: cmdNode('scripts/nope.ts', cwd) })); }).not.toThrow();
    expect(f).toHaveLength(1);
    expect(f[0]!.kind as string).toBe('missing-command-target');
    expect(f[0]!.nodes).toEqual([id]);
    expect(f[0]!.message).toContain(id);
    expect(f[0]!.message).toContain('scripts/nope.ts');
    expect(f[0]!.message).toContain('改法');
  });

  test('引用真实存在的脚本 (fixture 里写好) → 不报', () => {
    const cwd = tmpFixture({ 'scripts/dag-slim.ts': "console.log('ok');\n" });
    expect(staticLintPlan(plan({ a: cmdNode('scripts/dag-slim.ts', cwd) }))).toHaveLength(0);
  });

  test('bun run 已定义的 package script (fixture scripts 里有) → 不报', () => {
    const cwd = tmpFixture({ 'package.json': JSON.stringify({ scripts: { 'dag-slim': 'bun run scripts/dag-slim.ts' } }) });
    expect(staticLintPlan(plan({ a: cmdNode('bun run dag-slim', cwd) }))).toHaveLength(0);
  });

  test('bun run 未定义的 package script → 报, 含节点 id、脚本名与改法', () => {
    const cwd = tmpFixture({ 'package.json': JSON.stringify({ scripts: { other: 'true' } }) });
    const f = staticLintPlan(plan({ a: cmdNode('bun run nosuchscript', cwd) }));
    expect(f).toHaveLength(1);
    expect(f[0]!.kind as string).toBe('missing-command-target');
    expect(f[0]!.nodes).toEqual(['a']);
    expect(f[0]!.message).toContain('a');
    expect(f[0]!.message).toContain('nosuchscript');
    expect(f[0]!.message).toContain('改法');
  });

  test('npm run 未定义的 package script → 报 (契约 2b 的 npm 半边)', () => {
    const cwd = tmpFixture({ 'package.json': JSON.stringify({ scripts: { other: 'true' } }) });
    const f = staticLintPlan(plan({ a: cmdNode('npm run nosuchscript', cwd) }));
    expect(f).toHaveLength(1);
    expect(f[0]!.kind as string).toBe('missing-command-target');
    expect(f[0]!.message).toContain('nosuchscript');
    expect(f[0]!.message).toContain('改法');
  });

  test('npm run 已定义的 package script → 不报', () => {
    const cwd = tmpFixture({ 'package.json': JSON.stringify({ scripts: { 'dag-slim': 'bun run scripts/dag-slim.ts' } }) });
    expect(staticLintPlan(plan({ a: cmdNode('npm run dag-slim', cwd) }))).toHaveLength(0);
  });

  test('type-only 防伪: 只有 type:"command" 没有 executor → 不报 (schema 无 type 字段, executor 是唯一真实判定)', () => {
    const cwd = tmpFixture({});
    expect(staticLintPlan(plan({ a: { type: 'command', command: 'scripts/nope.ts', cwd } }))).toHaveLength(0);
  });

  test('executor/type 冲突: type:"leaf" + executor:"command" → 报 (executor 赢, type 不参与判定)', () => {
    const cwd = tmpFixture({});
    const f = staticLintPlan(plan({ a: { type: 'leaf', executor: 'command', command: 'scripts/nope.ts', cwd } }));
    expect(f).toHaveLength(1);
    expect(f[0]!.kind as string).toBe('missing-command-target');
    expect(f[0]!.nodes).toEqual(['a']);
  });

  test('非 command executor 带 command 字段 (executor:"leaf") → 不报: 引擎不消费它, 不猜', () => {
    const cwd = tmpFixture({});
    expect(staticLintPlan(plan({ a: { executor: 'leaf', command: 'scripts/nope.ts', cwd } }))).toHaveLength(0);
  });

  test('白名单扩展名外 (scripts/nope.md) → 不报: 只认 .ts/.js/.sh/.py, 不确定的不猜', () => {
    const cwd = tmpFixture({});
    expect(staticLintPlan(plan({ a: cmdNode('node scripts/nope.md', cwd) }))).toHaveLength(0);
  });

  test('shell 变量/命令替换/管道/重定向/复合 → 整条跳过不报: 静态解析不了的不猜', () => {
    const skip: string[] = [
      'echo $FILE',
      'node scripts/x.ts ${FILE}',
      'bun run scripts/x.ts $(date)',
      'bun run `pwd`',
      'cat a | grep x',
      'node x.js > out.log',
      'a && b',
    ];
    for (const command of skip) {
      expect(staticLintPlan(plan({ a: cmdNode(command) })), command).toHaveLength(0);
    }
  });

  test('../x.ts 与 C:\\x.ts → 不报: 逃出 cwd / 盘符, 不是可判死的仓内相对脚本', () => {
    expect(staticLintPlan(plan({ a: cmdNode('node ../x.ts') }))).toHaveLength(0);
    expect(staticLintPlan(plan({ a: cmdNode('node C:\\x.ts') }))).toHaveLength(0);
  });

  test('裸 bin (rg foo) → 不报: 不是 cwd 内相对脚本, 不猜', () => {
    expect(staticLintPlan(plan({ a: cmdNode('rg foo') }))).toHaveLength(0);
  });

  test('绝对路径 (/usr/bin/foo) → 不报: 仓外无从判断', () => {
    expect(staticLintPlan(plan({ a: cmdNode('/usr/bin/foo') }))).toHaveLength(0);
  });
});

describe('缺命令目标 · 仓库真实集成 (cwd=REPO_ROOT, 真实 scripts/dag-slim.ts + 根 package.json)', () => {
  test('真实 scripts/dag-slim.ts 存在 → 不报', () => {
    expect(staticLintPlan(plan({ a: cmdNode('scripts/dag-slim.ts', REPO_ROOT) }))).toHaveLength(0);
  });

  test('真实 dag-slim script (根 package.json 定义 "bun run scripts/dag-slim.ts") → 不报', () => {
    expect(staticLintPlan(plan({ a: cmdNode('bun run dag-slim', REPO_ROOT) }))).toHaveLength(0);
  });

  test('仓库根下不存在的 scripts/nope.ts → 恰一条: 真实 executor 形态 + 真实 cwd, 不存在路径必须被检出', () => {
    const f = staticLintPlan(plan({ a: cmdNode('scripts/nope.ts', REPO_ROOT) }));
    expect(f).toHaveLength(1);
    expect(f[0]!.kind as string).toBe('missing-command-target');
    expect(f[0]!.nodes).toEqual(['a']);
    expect(f[0]!.message).toContain('a');
    expect(f[0]!.message).toContain('scripts/nope.ts');
    expect(f[0]!.message).toContain('改法');
  });
});

// ── serializeWriteRaces (2026-08-14, plana 夜报回流: 写竞争从只报升级成构造性消灭) ──
// 反向自检: 把 engine.ts applyPlanFilters 里 serializeWriteRaces 那段删掉 → 下面 engine 侧
// 接线测试红; 把本函数的补边逻辑删掉 → 第一条当场红。
import { declaredWriteSet, serializeWriteRaces } from './static-lint';

describe('serializeWriteRaces (写竞争硬闸: 程序化补边串行化)', () => {
  test('★ 两个互不可达的同文件写者 → 补一条边, 补完 lint 不再报竞争', () => {
    const p = plan({
      a: { goal: '写', output_path: 'docs/x.md' },
      b: { goal: '也写', output_path: 'docs/x.md' },
    });
    const { plan: fixed, added } = serializeWriteRaces(p);
    expect(added).toHaveLength(1);
    expect(added[0]!.path).toBe('docs/x.md');
    expect(fixed.nodes[added[0]!.to]!.depends_on).toContain(added[0]!.from);
    expect(staticLintPlan(fixed).filter((f) => f.kind === 'write-race')).toHaveLength(0);
    // 不改输入 plan (共享引用纪律)
    expect(p.nodes.b!.depends_on ?? []).toHaveLength(0);
  });

  test('已有依赖边 (有序) → 原对象原样返回, 零补边', () => {
    const p = plan({
      a: { goal: '写', output_path: 'docs/x.md' },
      b: { goal: '改', output_path: 'docs/x.md', depends_on: ['a'] },
    });
    const r = serializeWriteRaces(p);
    expect(r.added).toHaveLength(0);
    expect(r.plan).toBe(p);
  });

  test('写不同文件 → 不碰', () => {
    const p = plan({
      a: { goal: '写', output_path: 'docs/x.md' },
      b: { goal: '写', output_path: 'docs/y.md' },
    });
    expect(serializeWriteRaces(p).added).toHaveLength(0);
  });

  test('★ 三写者 + 既有反声明序边 → 按拓扑序补边, 不成环 (声明序 naive 链会把 a→b→c→a 连成环)', () => {
    // 声明 [a, b, c], 既有边 a depends_on c (c 先于 a)。声明序链会补 b←a 与 c←b → 环。
    const p = plan({
      a: { goal: '写', output_path: 'docs/x.md', depends_on: ['c'] },
      b: { goal: '写', output_path: 'docs/x.md' },
      c: { goal: '写', output_path: 'docs/x.md' },
    });
    const { plan: fixed, added } = serializeWriteRaces(p);
    expect(added.length).toBeGreaterThan(0);
    // 无环: 从每个节点沿 depends_on 走, 不会回到自己
    const reach = (id: string, seen = new Set<string>()): boolean => {
      if (seen.has(id)) return true; // 回到访问路径 = 环
      seen.add(id);
      return (fixed.nodes[id]!.depends_on ?? []).some((d) => reach(d, new Set(seen)));
    };
    for (const id of Object.keys(fixed.nodes)) expect(reach(id)).toBe(false);
    // 且全部写者两两有序
    expect(staticLintPlan(fixed).filter((f) => f.kind === 'write-race')).toHaveLength(0);
  });
});

/**
 * ④⑤ 引用完整性 (issue #25, 2026-08-14) —— 表驱动 + 两侧都钉。
 *
 * **反向自检** (仓规: 一条永远绿的闸不是闸 —— 下面三条都是 2026-08-14 实跑的读数, 不是预测):
 *  - 删掉 static-lint.ts 的 ④ 整段 → 46 pass 变 41 pass 5 fail, 而"不该报"的那几条仍绿
 *    (证明它们不是靠"什么都不报"混过去的)。
 *  - 只把 ④ 里 `if (opts.truncatedIds?.has(d))` 那个分支删掉 → 恰好 1 条红 (截断那条),
 *    也就是「两种语义分成两个 kind」这件事确实被测着。
 *  - 把 ⑤ 的 `req <= real.size` 改成 `req < real.size` → 恰好 1 条红 (requires 恰好等于依赖数),
 *    边界方向被钉住。
 */
describe('悬空依赖 / 不可能达标的配额', () => {
  const cases: {
    name: string;
    nodes: Record<string, unknown>;
    opts?: Parameters<typeof staticLintPlan>[1];
    expect: StaticFinding['kind'][];
  }[] = [
    {
      name: 'depends_on 拼错 → dangling (RFC 原样例: research 拼成 reserach)',
      nodes: { research: { goal: '调查' }, synthesis: { goal: '综合', depends_on: ['reserach'] } },
      expect: ['dangling-dependency'],
    },
    {
      name: '自依赖 → 这里不报 (它是环, 由 PlanSchema superRefine fail-closed 判死, 不重复)',
      nodes: { a: { goal: 'A', depends_on: ['a'] } },
      expect: [],
    },
    {
      name: '正常边 → 不报 (证明上面不是恒报的空转断言)',
      nodes: { a: { goal: 'A' }, b: { goal: 'B', depends_on: ['a'] } },
      expect: [],
    },
    {
      name: '重复依赖 → 不报 (调度器 indeg/dependents 各多记一次, 相消, 无害)',
      nodes: { a: { goal: 'A' }, b: { goal: 'B', depends_on: ['a', 'a'] } },
      expect: [],
    },
    {
      name: '同一条坏引用写两次 → 只报一条 (别让一个问题刷屏)',
      nodes: { a: { goal: 'A', depends_on: ['nope', 'nope'] } },
      expect: ['dangling-dependency'],
    },
    {
      name: '声明为图外真节点 → 不报 (子图引用父节点的外层上游, 设计允许)',
      nodes: { a: { goal: 'A', depends_on: ['outer-1'] } },
      opts: { knownExternal: new Set(['outer-1']) },
      expect: [],
    },
    {
      name: '生产者自报被截断 → truncated 而非 dangling (owner 判据③: 两种语义不混一个计数)',
      nodes: { a: { goal: 'A', depends_on: ['cut-sibling'] } },
      opts: { truncatedIds: new Set(['cut-sibling']) },
      expect: ['truncated-dependency'],
    },
    {
      name: 'requires 大于真实依赖数 → impossible-quorum',
      nodes: { a: { goal: 'A' }, b: { goal: 'B' }, j: { goal: '判', depends_on: ['a', 'b'], requires: 3 } },
      expect: ['impossible-quorum'],
    },
    {
      name: 'requires 恰好等于依赖数 → 不报 (边界: 达得到)',
      nodes: { a: { goal: 'A' }, b: { goal: 'B' }, j: { goal: '判', depends_on: ['a', 'b'], requires: 2 } },
      expect: [],
    },
    {
      name: 'typo 把配额顶成不可达 → 两条都报 (两种故障形状: 空跑 + 无声跳过)',
      nodes: { a: { goal: 'A' }, j: { goal: '判', depends_on: ['a', 'bee'], requires: 2 } },
      expect: ['dangling-dependency', 'impossible-quorum'],
    },
    {
      name: '零依赖 + requires:2 → 不报 (quorum 判定对零依赖直接放行, 那是死旋钮不是判死)',
      nodes: { a: { goal: 'A', requires: 2 } },
      expect: [],
    },
    {
      name: "requires:'any' → 不报 (非数值配额没有「够不着」这回事)",
      nodes: { a: { goal: 'A' }, b: { goal: 'B', depends_on: ['a'], requires: 'any' } },
      expect: [],
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      const f = staticLintPlan(plan(c.nodes), c.opts ?? {});
      expect(f.map((x) => x.kind).sort()).toEqual([...c.expect].sort());
    });
  }

  test('判词点名了坏引用、现有节点、以及怎么改 (读者是下一轮 conductor)', () => {
    const f = staticLintPlan(plan({ research: { goal: '调查' }, synthesis: { goal: '综合', depends_on: ['reserach'] } }));
    expect(f[0]!.nodes).toEqual(['synthesis']);
    expect(f[0]!.message).toContain('reserach');
    expect(f[0]!.message).toContain('research');   // 现有节点清单 —— 它得知道正确的名字长什么样
    expect(f[0]!.message).toContain('已满足');      // 说清后果, 不是只报一个"坏引用"
  });

  test('配额判词给出可执行的数 (≤N 或 any), 不是只说"不合法"', () => {
    const f = staticLintPlan(plan({ a: { goal: 'A' }, j: { goal: '判', depends_on: ['a'], requires: 3 } }));
    expect(f[0]!.message).toContain('requires:3');
    expect(f[0]!.message).toContain('≤1');
  });
});

describe('declaredWriteSet —— 写集输入面 (2026-08-16, #145 提议 2)', () => {
  test('write_set ∪ output_path, 且同一路径不算两个写者', () => {
    // 怎么让它红: 把 declaredWriteSet 改回只读 output_path → 第一条断言少两个路径。
    expect(declaredWriteSet({ output_path: 'a.ts', write_set: ['b.ts', 'c.ts'] } as never).sort()).toEqual(['a.ts', 'b.ts', 'c.ts']);
    // Set 去重: 两处写了同一路径, 别把它当成"这个节点写了它两次"。
    expect(declaredWriteSet({ output_path: 'a.ts', write_set: ['a.ts'] } as never)).toEqual(['a.ts']);
    expect(declaredWriteSet({} as never)).toEqual([]);
    // 脏值不猜: 非数组 / 非字符串项 / 空串一律丢。
    expect(declaredWriteSet({ write_set: 'a.ts' } as never)).toEqual([]);
    expect(declaredWriteSet({ write_set: [1, '', '  ', 'ok.ts'] } as never)).toEqual(['ok.ts']);
  });

  test('★ 只在 write_set 里声明的碰撞也被串行化 (此前完全看不见)', () => {
    // 两个节点各自的 output_path 不同, 但都在 write_set 里点名了同一个 routes.tsx ——
    // 这正是 run C 那两个 wire 节点的形状。怎么让它红: 把 serializeWriteRaces 的输入
    // 改回 declaredOutput → added 为空。
    const plan = {
      name: 'p',
      nodes: {
        wire_i18n: { goal: 'i18n', output_path: 'i18n.ts', write_set: ['shared/routes.tsx'] },
        wire_routes: { goal: 'routes', output_path: 'nav.ts', write_set: ['shared/routes.tsx'] },
      },
    } as unknown as ConductorPlan;
    const r = serializeWriteRaces(plan);
    expect(r.added).toEqual([{ from: 'wire_i18n', to: 'wire_routes', path: 'shared/routes.tsx' }]);
  });

  test('★ 诚实边界: 机器画的图上这条是 no-op (conductor 不写 write_set)', () => {
    // conductor-plan.ts:90 明写 write_set **刻意不进 conductor prompt**。所以只有 output_path
    // 的图 —— 也就是 run C 那类图 —— 行为与扩面前**逐字相同**。
    // 这条测的不是代码, 是**别把这次改动读成「共享文件竞写解决了」**。
    const machineGraph = {
      name: 'p',
      nodes: { a: { goal: 'a', output_path: 'x.ts' }, b: { goal: 'b', output_path: 'y.ts' } },
    } as unknown as ConductorPlan;
    expect(serializeWriteRaces(machineGraph).added).toEqual([]);
  });
});
