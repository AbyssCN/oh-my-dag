/**
 * arch/aposd-signals 测试 —— 两个确定性检测器的判据逐条钉死 + 反向自检
 * (每条"不报"的判据都有一个会红的对照样本: 判据松了当场红, 不是永绿闸)。
 */
import { describe, expect, test } from 'bun:test';
import { computeCoChange, scanPassThrough } from './aposd-signals';

// ── computeCoChange ──────────────────────────────────────────────────────────

/** 造一段 `git log --oneline --name-only` 文本: 每个 commit = 抬头行 + 文件行。 */
function fakeLog(commits: string[][]): string {
  return commits.map((files, i) => [`${(1000000 + i).toString(16)}abc msg ${i}`, ...files].join('\n')).join('\n\n');
}

describe('computeCoChange', () => {
  test('跨目录文件对同 commit 共现 ≥minCount → 报信号 (count 正确)', () => {
    const log = fakeLog([
      ['src/a/x.ts', 'src/b/y.ts'],
      ['src/a/x.ts', 'src/b/y.ts', 'src/a/z.ts'],
      ['src/a/x.ts', 'src/b/y.ts'],
    ]);
    const pairs = computeCoChange(log);
    expect(pairs).toEqual([{ a: 'src/a/x.ts', b: 'src/b/y.ts', count: 3 }]);
  });

  test('反向自检: 同目录共现刻意不报 (正常内聚 ≠ 泄露) — 去掉 moduleDir 过滤这条会红', () => {
    const log = fakeLog([
      ['src/a/x.ts', 'src/a/y.ts'],
      ['src/a/x.ts', 'src/a/y.ts'],
      ['src/a/x.ts', 'src/a/y.ts'],
    ]);
    expect(computeCoChange(log)).toEqual([]);
  });

  test('反向自检: 共现 2 次 < 默认门槛 3 不报; minCount:2 时报 — 门槛真实承重', () => {
    const log = fakeLog([
      ['src/a/x.ts', 'src/b/y.ts'],
      ['src/a/x.ts', 'src/b/y.ts'],
    ]);
    expect(computeCoChange(log)).toEqual([]);
    expect(computeCoChange(log, { minCount: 2 })).toEqual([{ a: 'src/a/x.ts', b: 'src/b/y.ts', count: 2 }]);
  });

  test('反向自检: 超 maxCommitFiles 的扫荡式 commit 整个跳过 (不灌 O(n²) 噪声)', () => {
    const sweep = Array.from({ length: 20 }, (_, i) => `src/m${i}/f.ts`);
    const log = fakeLog([sweep, sweep, sweep]);
    expect(computeCoChange(log)).toEqual([]);
    // 同样内容压进上限内 → 报 (证明上面空结果是"跳过"不是"解析不了")
    const small = [['src/m1/f.ts', 'src/m2/f.ts'], ['src/m1/f.ts', 'src/m2/f.ts'], ['src/m1/f.ts', 'src/m2/f.ts']];
    expect(computeCoChange(fakeLog(small)).length).toBe(1);
  });

  test('非代码文件默认不参与配对 (lock/md 不算耦合)', () => {
    const log = fakeLog([
      ['src/a/x.ts', 'docs/y.md', 'bun.lock'],
      ['src/a/x.ts', 'docs/y.md'],
      ['src/a/x.ts', 'docs/y.md'],
    ]);
    expect(computeCoChange(log)).toEqual([]);
  });

  test('排序: count 降序, 同 count 按 pair 字典序 (稳定可测)', () => {
    const p1 = ['src/a/x.ts', 'src/b/y.ts'];
    const p2 = ['src/c/u.ts', 'src/d/v.ts'];
    const log = fakeLog([p1, p1, p1, p1, p2, p2, p2]);
    const pairs = computeCoChange(log);
    expect(pairs.map((p) => p.count)).toEqual([4, 3]);
  });

  test('rename 行 (`a -> b`) 取新名', () => {
    const log = fakeLog([
      ['src/a/old.ts -> src/a/x.ts', 'src/b/y.ts'],
      ['src/a/x.ts', 'src/b/y.ts'],
      ['src/a/x.ts', 'src/b/y.ts'],
    ]);
    expect(computeCoChange(log)).toEqual([{ a: 'src/a/x.ts', b: 'src/b/y.ts', count: 3 }]);
  });
});

// ── scanPassThrough ──────────────────────────────────────────────────────────

describe('scanPassThrough', () => {
  test('函数声明透传 (带类型注解/返回类型) → 报 name/callee/line', () => {
    const src = [
      'const pad = 1;',
      'export function save(a: string, b: number): void {',
      '  return store.save(a, b);',
      '}',
    ].join('\n');
    expect(scanPassThrough(src)).toEqual([{ name: 'save', callee: 'store.save', line: 2 }]);
  });

  test('类方法透传 (this 链) → 报', () => {
    const src = 'class W {\n  doIt(x: number) { return this.inner.doIt(x); }\n}';
    expect(scanPassThrough(src)).toEqual([{ name: 'doIt', callee: 'this.inner.doIt', line: 2 }]);
  });

  test('spread 转发 (`...args`) → 报', () => {
    const src = 'function f(...args: unknown[]) { return g(...args); }';
    expect(scanPassThrough(src)).toEqual([{ name: 'f', callee: 'g', line: 1 }]);
  });

  test('箭头透传 (表达式体与块体) → 报', () => {
    const expr = 'export const f = (x: number) => inner.f(x);';
    expect(scanPassThrough(expr)).toEqual([{ name: 'f', callee: 'inner.f', line: 1 }]);
    const block = 'const h = (a, b) => { return impl.h(a, b); }';
    expect(scanPassThrough(block)).toEqual([{ name: 'h', callee: 'impl.h', line: 1 }]);
  });

  test('反向自检: 实参换序不是透传 (语义在换序里) — 去掉同序判据这条会红', () => {
    expect(scanPassThrough('function f(a, b) { return g(b, a); }')).toEqual([]);
  });

  test('反向自检: 实参有加工 (`a + 1` / 字面量 / 属性取值) 不是透传', () => {
    expect(scanPassThrough('function f(a) { return g(a + 1); }')).toEqual([]);
    expect(scanPassThrough('function f(a) { return g(a, 1); }')).toEqual([]);
    expect(scanPassThrough('function f(a) { return g(a.b); }')).toEqual([]);
  });

  test('反向自检: 函数体有额外逻辑不是透传 (单 return 判据承重)', () => {
    expect(scanPassThrough('function f(a) { log(a); return g(a); }')).toEqual([]);
  });

  test('反向自检: `catch (e) { return handle(e); }` 是惯用法不是透传 — 关键字栏承重', () => {
    const src = 'try { x(); } catch (e) { return handle(e); }';
    expect(scanPassThrough(src)).toEqual([]);
    expect(scanPassThrough('if (x) { return f(x); }')).toEqual([]);
  });

  test('反向自检: 0 参委托刻意不报 (facade 惯用法太常见, 报了淹信号)', () => {
    expect(scanPassThrough('function f() { return g(); }')).toEqual([]);
  });

  test('参数比实参多/少都不是透传', () => {
    expect(scanPassThrough('function f(a, b) { return g(a); }')).toEqual([]);
  });

  test('解构参数等解析不了的形态保守跳过 (宁漏勿误)', () => {
    expect(scanPassThrough('function f({ a }) { return g({ a }); }')).toEqual([]);
  });
});
