/**
 * bench 图审计 —— 纯函数半的闸。
 * 证伪记录 (2026-08-29): 把 auditPlans 的 `if (!(k in node) …)` 换回 truthy 判
 * (`if (!node[k])`) → ★expect_exit:0 那条当场红。恢复后绿。
 */
import { describe, expect, test } from 'bun:test';
import { auditPlans } from './bench-plan-audit';

const plan = (nodes: Record<string, unknown>): unknown => ({ name: 'p', nodes });

describe('auditPlans', () => {
  test('executor 分布 + 1 节点图占比', () => {
    const a = auditPlans([
      plan({ x: { executor: 'agent' } }),
      plan({ x: { executor: 'command', command: 'echo', expect_exit: 0 }, y: { goal: 'g' } }),
    ]);
    expect(a.plans).toBe(2);
    expect(a.singleNodeShare).toBe(0.5);
    expect(a.executors).toEqual({ agent: 1, command: 1, 'leaf(default)': 1 });
  });

  test('★ expect_exit: 0 必须被计数 (truthy 判会抹掉它 —— 首版审计的实坑)', () => {
    const a = auditPlans([plan({ x: { executor: 'command', expect_exit: 0 } })]);
    expect(a.features.expect_exit).toBe(1);
  });

  test('空数组/空对象/null 不计; 非空 write_set 计', () => {
    const a = auditPlans([plan({
      x: { write_set: ['src/a.ts'], map: {}, mcp: [], tier: null },
    })]);
    expect(a.features.write_set).toBe(1);
    expect(a.features.map ?? 0).toBe(0);
    expect(a.features.mcp ?? 0).toBe(0);
    expect(a.features.tier ?? 0).toBe(0);
  });

  test('坏形状 (nodes 缺席/是数组) 跳过不炸', () => {
    const a = auditPlans([{ junk: 1 }, { nodes: [1, 2] }, null]);
    expect(a.plans).toBe(0);
  });
});
