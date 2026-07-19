import { describe, expect, test } from 'bun:test';
import { compileSlice, regionIsClear } from './slice-compiler';
import { PlanSchema } from '../conductor-plan';
import type { PathMap, Ticket } from './types';

function ticket(partial: Partial<Ticket> & Pick<Ticket, 'id'>): Ticket {
  return { type: 'task', title: partial.id, blockedBy: [], status: 'ruled', ...partial };
}
function mapOf(tickets: Ticket[]): PathMap {
  return { destination: 'Ship feature X', slug: 'feat-x', tickets, decisionsLog: [] };
}

describe('compileSlice', () => {
  test('ruled task 票 → PlanNode + 边映射, 且过 PlanSchema', () => {
    const m = mapOf([
      ticket({ id: 'a', ruling: 'build module A', executorKind: 'agent' }),
      ticket({ id: 'b', ruling: 'build module B', executorKind: 'agent', blockedBy: ['a'] }),
    ]);
    const plan = compileSlice(m, ['a', 'b']);
    // schema 校验通过
    expect(PlanSchema.safeParse(plan).success).toBe(true);
    // 每票一节点
    expect(Object.keys(plan.nodes).sort()).toEqual(['a', 'b']);
    // goal = ruling
    expect(plan.nodes.a!.goal).toBe('build module A');
    // 边: b depends_on a
    expect(plan.nodes.b!.depends_on).toEqual(['a']);
    // executorKind 'agent' → PlanNode.executor 'agent'
    expect(plan.nodes.b!.executor).toBe('agent');
  });

  test('goal 缺 ruling 时回落 title; executorKind 缺省 inproc → leaf', () => {
    const m = mapOf([ticket({ id: 'a', title: 'do the thing', ruling: undefined, executorKind: undefined })]);
    // ruling 缺 但 status ruled — 这里显式不给 ruling 测回落
    const withRuled = mapOf([{ ...m.tickets[0]!, status: 'ruled' }]);
    const plan = compileSlice(withRuled, ['a']);
    expect(plan.nodes.a!.goal).toBe('do the thing');
    expect(plan.nodes.a!.executor).toBe('leaf'); // inproc → leaf
  });

  test('executorKind 映射: command/agent 直通, inproc/primitive/map → leaf (map/primitive 无 spec 降级)', () => {
    const m = mapOf([
      ticket({ id: 'c', ruling: 'r', executorKind: 'command' }),
      ticket({ id: 'ag', ruling: 'r', executorKind: 'agent' }),
      ticket({ id: 'mp', ruling: 'r', executorKind: 'map' }),
      ticket({ id: 'p', ruling: 'r', executorKind: 'primitive' }),
      ticket({ id: 'i', ruling: 'r', executorKind: 'inproc' }),
    ]);
    const plan = compileSlice(m, ['c', 'ag', 'mp', 'p', 'i']);
    expect(plan.nodes.c!.executor).toBe('command');
    expect(plan.nodes.ag!.executor).toBe('agent');
    expect(plan.nodes.mp!.executor).toBe('leaf'); // map 无 MapSpec → 降级
    expect(plan.nodes.p!.executor).toBe('leaf');
    expect(plan.nodes.i!.executor).toBe('leaf');
    expect(PlanSchema.safeParse(plan).success).toBe(true);
  });

  test('depends_on 只保留 region 内的边 (region 外前置被裁掉)', () => {
    const m = mapOf([
      ticket({ id: 'a', ruling: 'r' }),
      ticket({ id: 'b', ruling: 'r', blockedBy: ['a', 'outside'] }),
    ]);
    const plan = compileSlice(m, ['b']); // a 不在 region
    expect(plan.nodes.b!.depends_on ?? []).toEqual([]); // a 与 outside 都被过滤
  });

  test('抛错: region 含未裁票 (雾未散)', () => {
    const m = mapOf([ticket({ id: 'a', status: 'open', ruling: undefined })]);
    expect(() => compileSlice(m, ['a'])).toThrow(/ruled|裁/);
  });

  test('抛错: region 含非 task 票', () => {
    const m = mapOf([ticket({ id: 'a', type: 'grill', status: 'ruled', ruling: 'r' })]);
    expect(() => compileSlice(m, ['a'])).toThrow(/task/);
  });

  test('抛错: region 内依赖成环', () => {
    const m = mapOf([
      ticket({ id: 'a', ruling: 'r', blockedBy: ['b'] }),
      ticket({ id: 'b', ruling: 'r', blockedBy: ['a'] }),
    ]);
    expect(() => compileSlice(m, ['a', 'b'])).toThrow(/cycle|环/);
  });

  test('抛错: region 引用不存在的票', () => {
    const m = mapOf([ticket({ id: 'a', ruling: 'r' })]);
    expect(() => compileSlice(m, ['a', 'ghost'])).toThrow();
  });

  test('抛错: region 为空 (无节点)', () => {
    expect(() => compileSlice(mapOf([]), [])).toThrow();
  });
});

describe('regionIsClear', () => {
  test('全 ruled task 且前置都散 → clear', () => {
    const m = mapOf([
      ticket({ id: 'a', ruling: 'r' }),
      ticket({ id: 'b', ruling: 'r', blockedBy: ['a'] }),
    ]);
    expect(regionIsClear(m, ['a', 'b'])).toEqual({ clear: true });
  });

  test('含未裁票 → not clear + reason', () => {
    const m = mapOf([ticket({ id: 'a', status: 'open', ruling: undefined })]);
    const r = regionIsClear(m, ['a']);
    expect(r.clear).toBe(false);
    expect(r.reason).toBeTruthy();
  });

  test('含非 task 票 → not clear', () => {
    const m = mapOf([ticket({ id: 'a', type: 'research', status: 'ruled', ruling: 'r' })]);
    expect(regionIsClear(m, ['a']).clear).toBe(false);
  });

  test('前置 (region 内或外) 未裁 → not clear (open blocker 指进来)', () => {
    const m = mapOf([
      ticket({ id: 'dep', status: 'open', ruling: undefined }),
      ticket({ id: 'a', ruling: 'r', blockedBy: ['dep'] }),
    ]);
    expect(regionIsClear(m, ['a']).clear).toBe(false);
  });

  test('未知票 id → not clear', () => {
    expect(regionIsClear(mapOf([]), ['ghost']).clear).toBe(false);
  });
});
