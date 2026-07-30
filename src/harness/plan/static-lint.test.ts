/**
 * A4 跑前静态闸 (2026-07-31) —— 补 Fowler 2×2 里最空的那格: computational feedforward。
 *
 * 这条网盯两个方向:
 *  ① **该报的报**: 写竞争 (它不报错, 只是"有时候产物不对" —— 静默不确定性是最贵的一种);
 *  ② **不该报的一个都不许报**: 静态检查一旦开始猜, 它就是第三个 judge, 而且是个没有证据的。
 */
import { describe, expect, test } from 'bun:test';
import { staticLintPlan } from './static-lint';
import type { ConductorPlan } from '../conductor-plan';

const plan = (nodes: Record<string, unknown>): ConductorPlan => ({ name: 'p', nodes } as ConductorPlan);

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
