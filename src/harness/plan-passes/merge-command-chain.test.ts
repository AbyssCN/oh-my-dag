/**
 * src/harness/plan-passes/merge-command-chain.test —— #153② 验收尾链机械合并契约测试。
 * 事故形状来源: issue #153 (run 50e48b27 的 gate_types→gate_tests→gate_build 直线)。
 */
import { describe, expect, test } from 'bun:test';
import type { ConductorPlan } from '../conductor-plan';
import { mergeCommandChains } from './merge-command-chain';

/** 构造最小合法 plan 的测试夹具。 */
function makePlan(nodes: ConductorPlan['nodes'], outputs?: string[]): ConductorPlan {
  return { name: 't', nodes, ...(outputs === undefined ? {} : { outputs }) };
}

const cmd = (command: string, deps?: string[]): ConductorPlan['nodes'][string] => ({
  goal: `run ${command}`,
  executor: 'command',
  command,
  ...(deps ? { depends_on: deps } : {}),
});

describe('mergeCommandChains (#153②)', () => {
  // 证伪方式 (当场验过): mergeCommandChains 改成恒等返回 → 本条红; 恢复后绿。
  test('事故形状: gate 三连直线 → 合并为尾节点一条 && 命令, 下游依赖零触碰', () => {
    const plan = makePlan({
      impl: { goal: 'implement', executor: 'agent' },
      gate_types: cmd('bun run tsc --noEmit', ['impl']),
      gate_tests: cmd('bun test', ['gate_types']),
      gate_build: cmd('bun run build', ['gate_tests']),
      report: { goal: 'summarize', depends_on: ['gate_build'] },
    });
    const { plan: out, merged } = mergeCommandChains(plan);
    expect(merged).toEqual([{ into: 'gate_build', absorbed: ['gate_types', 'gate_tests'] }]);
    expect(Object.keys(out.nodes).sort()).toEqual(['gate_build', 'impl', 'report']);
    expect(out.nodes.gate_build?.command).toBe('bun run tsc --noEmit && bun test && bun run build');
    expect(out.nodes.gate_build?.depends_on).toEqual(['impl']);
    expect(out.nodes.report).toBe(plan.nodes.report); // 下游节点原对象
  });

  test('无链可并 → 恒等 (同一对象, 零拷贝)', () => {
    const plan = makePlan({
      a: cmd('tsc'),
      b: { goal: 'write', executor: 'agent', depends_on: ['a'] },
    });
    const { plan: out, merged } = mergeCommandChains(plan);
    expect(out).toBe(plan);
    expect(merged).toEqual([]);
  });

  test('expect_exit:1 (verify-red) 环不并 —— 合并会改「哪一环期望红」的语义', () => {
    const plan = makePlan({
      red: { ...cmd('bun test src/new.test.ts'), expect_exit: 1 },
      types: cmd('tsc', ['red']),
      tests: cmd('bun test', ['types']),
    });
    const { plan: out, merged } = mergeCommandChains(plan);
    // red 不可吸收; types→tests 仍是合法二连 → 只并这一段。
    expect(merged).toEqual([{ into: 'tests', absorbed: ['types'] }]);
    expect(out.nodes.red).toBe(plan.nodes.red);
    expect(out.nodes.tests?.depends_on).toEqual(['red']);
  });

  test('中间环在 plan.outputs → 该环不被吸收 (图外引用保命)', () => {
    const plan = makePlan(
      {
        a: cmd('one'),
        b: cmd('two', ['a']),
        c: cmd('three', ['b']),
      },
      ['b'],
    );
    const { plan: out, merged } = mergeCommandChains(plan);
    // b 被 outputs 引用 → a→b 可并 (b 是尾, 存活), b→c 不并 b。
    expect(merged).toEqual([{ into: 'b', absorbed: ['a'] }]);
    expect(out.nodes.c?.depends_on).toEqual(['b']);
  });

  test('中间环有第二消费者 (扇出) → 不并', () => {
    const plan = makePlan({
      a: cmd('one'),
      b: cmd('two', ['a']),
      side: { goal: 'reads a too', depends_on: ['a'] },
    });
    const { plan: out, merged } = mergeCommandChains(plan);
    expect(out).toBe(plan);
    expect(merged).toEqual([]);
  });

  test('产物声明 / write_set / detector 环不并 (宁窄勿宽)', () => {
    const plan = makePlan({
      a: { ...cmd('one'), output_type: 'file', output_path: 'out.txt' },
      b: cmd('two', ['a']),
      c: { ...cmd('three'), write_set: ['x.ts'] },
      d: cmd('four', ['c']),
      e: { ...cmd('five'), detector: true },
      f: cmd('six', ['e']),
    });
    const { plan: out, merged } = mergeCommandChains(plan);
    expect(out).toBe(plan);
    expect(merged).toEqual([]);
  });

  test('两条独立链各自合并', () => {
    const plan = makePlan({
      impl1: { goal: 'i1', executor: 'agent' },
      a1: cmd('t1', ['impl1']),
      b1: cmd('u1', ['a1']),
      impl2: { goal: 'i2', executor: 'agent' },
      a2: cmd('t2', ['impl2']),
      b2: cmd('u2', ['a2']),
    });
    const { merged } = mergeCommandChains(plan);
    expect(merged.map((m) => m.into).sort()).toEqual(['b1', 'b2']);
  });
});
