/**
 * B1 判据:
 *  ① 判定映射与原 if-链逐条相同 (含三类 guard 的 fall-through 落 leaf)。
 *  ② 词表外 executor → null; 经引擎跑 = failed missing-capability (fail-closed 反向自检:
 *     B1 前它静默落 inproc leaf, 本测试钉住它再也回不去)。
 *  ③ 表完整性是编译期事实 (Record<NodeExecKind, …> 删一行 tsc 红), 这里只钉词表本身 7 员。
 */
import { describe, expect, test } from 'bun:test';
import type { ConductorPlan } from '../conductor-plan';
import type { ExecutorDagConfig } from './types';
import { runExecutorDagWithPlan } from './engine';
import { NODE_EXEC_KINDS, nodeExecKind } from './node-kind';

describe('nodeExecKind 判定映射 (忠实原 if-链)', () => {
  test('六类各归其位', () => {
    expect(nodeExecKind({ kind: 'primitive', primitive: 'parallel' })).toBe('primitive');
    expect(nodeExecKind({ executor: 'map', map: { over: 'x' } })).toBe('map');
    expect(nodeExecKind({ executor: 'await', await: { artifact: 'a' } })).toBe('await');
    expect(nodeExecKind({ executor: 'command' })).toBe('command');
    expect(nodeExecKind({ executor: 'research' })).toBe('research');
    expect(nodeExecKind({})).toBe('leaf');
    expect(nodeExecKind({ executor: 'agent' })).toBe('leaf');
    expect(nodeExecKind({ executor: 'leaf' })).toBe('leaf');
    expect(nodeExecKind({ executor: 'inproc' })).toBe('leaf');
  });

  test('guard fall-through: 缺配套字段的 map/await/primitive 落 leaf (原链语义)', () => {
    expect(nodeExecKind({ executor: 'map' })).toBe('leaf');
    expect(nodeExecKind({ executor: 'await' })).toBe('leaf');
    expect(nodeExecKind({ kind: 'primitive' })).toBe('leaf');
  });

  test('判定顺序: primitive 先于 executor (primitive 节点带 executor:command 仍走 command? 不 —— kind 判在先)', () => {
    // 原链顺序: kind==='primitive'&&primitive 在最前 → 即使还带 executor:'command' 也归 primitive
    expect(nodeExecKind({ kind: 'primitive', primitive: 'verify', executor: 'command' })).toBe('primitive');
  });

  test('词表外 executor → null', () => {
    expect(nodeExecKind({ executor: 'wasm' })).toBeNull();
    expect(nodeExecKind({ executor: 'AGENT' })).toBeNull();
  });

  test('词表绊线: 恰好 6 员 (加 kind 时同步动 engine 表 + 本字面量; conductor 类随 v1 于 2026-09-03 退役)', () => {
    expect([...NODE_EXEC_KINDS]).toEqual(['primitive', 'map', 'await', 'command', 'research', 'leaf']);
    // 证伪: 词表外 executor → null (fail-closed), 退役的 'conductor' 也走这里。
    expect(nodeExecKind({ executor: 'conductor' })).toBeNull();
  });
});

describe('引擎 fail-closed (B1 唯一刻意行为变化)', () => {
  test('预构造 plan 带词表外 executor → 节点 failed missing-capability, 不静默当 inproc', async () => {
    const plan = {
      name: 'b1-fail-closed',
      nodes: { x: { goal: '不会被执行', executor: 'wasm' } },
      outputs: ['x'],
    } as unknown as ConductorPlan;
    let generateCalls = 0;
    const config: ExecutorDagConfig = {
      conductorModel: 'test:conductor',
      leafModel: 'test:leaf',
      agentTemplates: new Map(),
      generate: async () => {
        generateCalls++;
        return { text: '不该被调', usage: { in: 0, out: 0 } };
      },
    };
    const run = await runExecutorDagWithPlan(plan, config);
    const leaf = run.results.x!;
    expect(leaf.status).toBe('failed');
    expect(leaf.failureKind).toBe('missing-capability');
    expect(leaf.output).toContain('词表外 executor');
    // 反向自检核心: fail-closed 意味着模型一发都没被打 (B1 前会静默当 inproc 真打一发)
    expect(generateCalls).toBe(0);
  });
});
