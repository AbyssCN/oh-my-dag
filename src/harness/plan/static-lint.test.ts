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
import { serializeWriteRaces } from './static-lint';

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
